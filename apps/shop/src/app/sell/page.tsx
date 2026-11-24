'use client';

import type {
  EventListResponse,
  EventSummary,
  ShopBookingResponse,
  ShopDeskResponse,
  ShopPicksResponse,
  ShopSellTicketRequest,
  ShopTicketCheckResponse,
  ShopSellTicketResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { useFetch } from '@/components/hooks';
import { TopUpCard } from '@/components/topup';
import { api } from '@/lib/api';
import { ApiClientError, describeError } from '@/lib/errors';
import { positiveCashToSantim } from '@/lib/forms';
import { formatDateTime, formatEtb } from '@/lib/format';
import { filterMatchesByTeam, MATCHES_PAGE, sellableMatches } from '@/lib/matches';
import { TEXT, ticketBarLabel } from '@/lib/text';
import { stakeAboveBalance } from '@/lib/topup';
import {
  formatOddsMilli,
  legReasonText,
  newTicketKey,
  parsePickText,
  refusalText,
  handOverPayoutCode,
  ticketPath,
  ticketSellable,
  type PickInput,
} from '@/lib/tickets';

/** One match on the slip: only what the API needs; names come back with each check. */
interface SlipLeg {
  selectionId: string;
  oddsMilli: number;
}

/** A price preview needs some stake; the real check uses the one typed. */
const PREVIEW_STAKE = '1000';
/** The pause after the last change before the ticket is checked with the typed stake. */
const AUTO_CHECK_MS = 500;
/** After this long the page says the sale is still waiting for the server. */
const SELL_SLOW_MS = 8_000;
/** How long the app's own navigation to the sold ticket may take before the browser loads it. */
const OPEN_FALLBACK_MS = 4_000;

/** What a check was made for: the legs with their prices, the stake and the phone. */
function slipSignature(legs: SlipLeg[], stake: string | null): string {
  return `${legs.map((l) => `${l.selectionId}@${l.oddsMilli}`).join(',')}|${stake ?? ''}`;
}

interface Quote {
  signature: string;
  /** Made with the typed stake; a preview (no stake yet) only fills in names and prices. */
  real: boolean;
  data: ShopTicketCheckResponse;
}

/** idle, or what Sell and print is doing: checking the odds, selling, opening the ticket. */
type Busy = 'idle' | 'checking' | 'selling' | 'opening';

/** A santim string as the ETB a cashier types: "3000" → "30", "2050" → "20.50". */
function santimToCashText(value: string): string {
  const santim = BigInt(value);
  const birr = santim / 100n;
  const cents = santim % 100n;
  return cents === 0n ? birr.toString() : `${birr}.${cents.toString().padStart(2, '0')}`;
}

/** A failed sale in words; when no answer came, pressing again is safe (the same key). */
function sellErrorText(error: unknown): string {
  const text = describeError(error, TEXT.sellErrors);
  if (error instanceof ApiClientError && (error.status === 0 || error.status >= 500)) {
    return `${text} ${TEXT.sellRetry}`;
  }
  return text;
}

/** Whether the element shows on the screen (the ticket bar shows while the ticket does not). */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      { threshold: 0.05 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

export default function SellPage() {
  const desk = useFetch<ShopDeskResponse>('/shop/desk');
  if (desk.data === null) {
    return (
      <div className="card">
        {desk.error === null ? (
          <p className="muted" role="status">
            {TEXT.loading}
          </p>
        ) : (
          <p className="error" role="alert">
            {desk.error}
          </p>
        )}
      </div>
    );
  }
  const { shift, agentBalance, agentBalanceLowAt } = desk.data;
  if (shift === null) {
    return (
      <div data-testid="sell-page">
        <h1>{TEXT.sellTitle}</h1>
        <TopUpCard balance={agentBalance} lowAt={agentBalanceLowAt} />
        <p className="card">
          {TEXT.sellNeedShift}. <Link href="/">{TEXT.sellNeedShiftLink}</Link>
        </p>
      </div>
    );
  }
  return (
    <Seller
      shiftId={shift.id}
      agentBalance={agentBalance}
      agentBalanceLowAt={agentBalanceLowAt}
      onBalanceStale={desk.reload}
    />
  );
}

/**
 * The Sell page (owner, 24 Nov 2026): the customer's booking code or slip ID first, the ticket
 * right under it (beside the ways to add matches on a wide screen), and one press of Sell and
 * print: it checks the odds with the stake typed and, when nothing changed, sells and opens the
 * ticket to print. A check that finds a change stops and shows it on the ticket.
 */
function Seller({
  shiftId,
  agentBalance,
  agentBalanceLowAt,
  onBalanceStale,
}: {
  shiftId: string;
  agentBalance: string | null;
  agentBalanceLowAt: string | null;
  onBalanceStale: () => void;
}) {
  const router = useRouter();
  const [legs, setLegs] = useState<SlipLeg[]>([]);
  const [stakeText, setStakeText] = useState('');
  const [phone, setPhone] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<Busy>('idle');
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const key = useRef<{ signature: string; value: string } | null>(null);
  const [booked, setBooked] = useState<{ code: string; ids: string[] } | null>(null);
  // Only the newest check may set the quote: an older answer arriving late is dropped.
  const checkSeq = useRef(0);
  const fallback = useRef<number | null>(null);
  const ticketRef = useRef<HTMLElement | null>(null);
  const ticketInView = useInView(ticketRef);

  const stake = positiveCashToSantim(stakeText);
  const signature = slipSignature(legs, stake);
  const phoneDigits = phone.replace(/[\s-]/g, '');
  const phoneValid = phoneDigits === '' || /^\+?[0-9]{9,15}$/.test(phoneDigits);
  const idle = busy === 'idle';

  // The timer that loads the sold ticket directly is cleared in the commit that leaves this page,
  // so the app's own navigation and the direct load never both open it.
  useLayoutEffect(
    () => () => {
      if (fallback.current !== null) window.clearTimeout(fallback.current);
    },
    [],
  );

  /** Checks the slip (with the typed stake when `real`); the quote it made, or null on an error. */
  async function runCheck(
    slip: SlipLeg[],
    santim: string | null,
    real: boolean,
  ): Promise<Quote | null> {
    if (slip.length === 0) {
      checkSeq.current += 1;
      setQuote(null);
      setChecking(false);
      return null;
    }
    if (real && santim === null) {
      setError(TEXT.stakeInvalid);
      return null;
    }
    checkSeq.current += 1;
    const seq = checkSeq.current;
    setChecking(true);
    try {
      const data = await api<ShopTicketCheckResponse>('/shop/desk/tickets/check', {
        method: 'POST',
        body: { legs: slip, stake: santim ?? PREVIEW_STAKE },
      });
      const result: Quote = { signature: slipSignature(slip, santim), real, data };
      if (seq === checkSeq.current) {
        setQuote(result);
        if (real) setError(null);
      }
      return result;
    } catch (e) {
      if (seq === checkSeq.current) setError(describeError(e));
      return null;
    } finally {
      if (seq === checkSeq.current) setChecking(false);
    }
  }

  // The automatic check below calls the newest runCheck without restarting its timer each render.
  const runCheckRef = useRef(runCheck);
  useEffect(() => {
    runCheckRef.current = runCheck;
  });

  const current = quote !== null && quote.signature === signature ? quote : null;
  const checkedNow = current !== null && current.real ? current : null;
  const clean = checkedNow !== null && ticketSellable(checkedNow.data);
  const oddsChanged = current?.data.legs.some((l) => l.oddsChanged) === true;

  // Checked with the typed stake a moment after the last change: the possible win shows, and Sell
  // and print usually sells at once.
  useEffect(() => {
    if (legs.length === 0 || stake === null || busy !== 'idle') return;
    if (quote !== null && quote.real && quote.signature === signature) return;
    const timer = window.setTimeout(
      () => void runCheckRef.current(legs, stake, true),
      AUTO_CHECK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [legs, stake, signature, quote, busy]);

  /**
   * Adds legs (skipping ones already there) and checks the slip so names and prices show. Legs
   * from a booking code remember it: the ticket prints it when it has exactly those matches.
   */
  function addLegs(add: SlipLeg[], bookingCode?: string, bookedStake?: string | null) {
    if (!idle) return;
    let santim = stake;
    if (bookingCode !== undefined) {
      setBooked({ code: bookingCode, ids: add.map((l) => l.selectionId) });
    }
    // A visitor's slip ID carries the stake they chose (GS3): filled in, the cashier may change it.
    if (
      bookedStake !== undefined &&
      bookedStake !== null &&
      /^\d{1,15}$/.test(bookedStake) &&
      BigInt(bookedStake) > 0n
    ) {
      setStakeText(santimToCashText(bookedStake));
      santim = BigInt(bookedStake).toString();
    }
    const known = new Set(legs.map((l) => l.selectionId));
    const fresh = add.filter(
      (l, i) =>
        !known.has(l.selectionId) && add.findIndex((x) => x.selectionId === l.selectionId) === i,
    );
    if (fresh.length < add.length) setError(TEXT.alreadyOnSlip);
    else setError(null);
    if (fresh.length === 0) return;
    const next = [...legs, ...fresh];
    setLegs(next);
    void runCheck(next, santim, santim !== null);
    // On a phone the ticket sits under the code box: bring it into view once a code is loaded.
    if (bookingCode !== undefined && !ticketInView) {
      ticketRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function removeLeg(selectionId: string) {
    if (!idle) return;
    const next = legs.filter((l) => l.selectionId !== selectionId);
    setLegs(next);
    setQuote(null);
    void runCheck(next, stake, stake !== null);
  }

  const startedIds =
    quote === null
      ? []
      : quote.data.legs.filter((l) => l.reason === 'event_started').map((l) => l.selectionId);

  function removeStarted() {
    if (!idle) return;
    const next = legs.filter((l) => !startedIds.includes(l.selectionId));
    setLegs(next);
    setQuote(null);
    void runCheck(next, stake, stake !== null);
  }

  /** Takes the current prices as the slip's (after the cashier saw them) and checks again. */
  function acceptNewOdds() {
    if (quote === null || !idle) return;
    const prices = new Map(quote.data.legs.map((l) => [l.selectionId, l.oddsMilli]));
    const next = legs.map((l) => ({ ...l, oddsMilli: prices.get(l.selectionId) ?? l.oddsMilli }));
    setLegs(next);
    void runCheck(next, stake, true);
  }

  /** Opens the sold ticket to print; the browser loads it directly if the app's navigation stalls. */
  function openTicket(id: string) {
    const path = ticketPath(id, true);
    setBusy('opening');
    setOpened(path);
    router.push(path);
    fallback.current = window.setTimeout(() => window.location.assign(path), OPEN_FALLBACK_MS);
  }

  async function sell() {
    if (!idle || legs.length === 0 || !phoneValid) return;
    if (stake === null) {
      setError(TEXT.stakeInvalid);
      return;
    }
    const slip = legs;
    const santim = stake;
    const signatureNow = slipSignature(slip, santim);
    setError(null);
    let checked = quote !== null && quote.real && quote.signature === signatureNow ? quote : null;
    if (checked === null) {
      setBusy('checking');
      checked = await runCheck(slip, santim, true);
      if (checked === null) {
        setBusy('idle');
        return;
      }
    }
    if (!ticketSellable(checked.data)) {
      setBusy('idle');
      setError(TEXT.sellStopped);
      return;
    }
    // One key per exact ticket, kept through retries; a changed ticket gets a new one.
    const keySignature = `${signatureNow}|${phoneDigits}`;
    if (key.current === null || key.current.signature !== keySignature) {
      key.current = { signature: keySignature, value: newTicketKey() };
    }
    const body: ShopSellTicketRequest = {
      shiftId,
      legs: slip,
      stake: santim,
      oddsChangePolicy: 'none',
      idempotencyKey: key.current.value,
    };
    if (phoneDigits !== '') body.customerPhone = phoneDigits;
    if (booked !== null && sameSelections(slip, booked.ids)) body.bookingCode = booked.code;
    setBusy('selling');
    const slowTimer = window.setTimeout(() => setSlow(true), SELL_SLOW_MS);
    try {
      const res = await api<ShopSellTicketResponse>('/shop/desk/tickets', {
        method: 'POST',
        body,
      });
      // The payout code is printed on this ticket's original, and nowhere else.
      handOverPayoutCode(res.ticket.id, res.payoutCode);
      openTicket(res.ticket.id);
    } catch (e) {
      setBusy('idle');
      setError(sellErrorText(e));
      const code = e instanceof ApiClientError ? e.code : null;
      // Show on the ticket what changed since the check.
      if (code === 'odds_changed' || code === 'selection_unavailable') {
        void runCheck(slip, santim, true);
      }
      if (code === 'agent_balance_low') onBalanceStale();
    } finally {
      window.clearTimeout(slowTimer);
      setSlow(false);
    }
  }

  const blocker =
    legs.length === 0
      ? TEXT.sellNeedLegs
      : stake === null
        ? TEXT.sellNeedStake
        : !phoneValid
          ? TEXT.customerPhoneInvalid
          : null;
  const aboveBalance = stakeAboveBalance(stake, agentBalance);
  const sellLabel =
    busy === 'checking'
      ? TEXT.checking
      : busy === 'selling'
        ? TEXT.selling
        : busy === 'opening'
          ? TEXT.sellOpening
          : TEXT.sellButton;

  return (
    <div data-testid="sell-page">
      <h1>{TEXT.sellTitle}</h1>
      <TopUpCard balance={agentBalance} lowAt={agentBalanceLowAt} />
      <div className="sell-grid">
        <div className="sell-booking">
          <AddByBooking onAdd={addLegs} disabled={!idle} />
        </div>

        <section
          ref={ticketRef}
          className="card sell-ticket"
          aria-labelledby="slip"
          data-testid="sell-ticket"
        >
          <h2 id="slip">{TEXT.slipTitle}</h2>
          {legs.length === 0 ? (
            <p className="muted">{TEXT.slipEmpty}</p>
          ) : (
            <ul className="slip">
              {legs.map((leg) => {
                const view = quote?.data.legs.find((l) => l.selectionId === leg.selectionId);
                const bad = view !== undefined && !view.available;
                const about = [
                  view?.competitionName?.en ?? null,
                  view?.gameId === null || view?.gameId === undefined ? null : `#${view.gameId}`,
                  view?.startTime === null || view?.startTime === undefined
                    ? null
                    : formatDateTime(view.startTime),
                ].filter((part): part is string => part !== null);
                return (
                  <li
                    key={leg.selectionId}
                    className={bad ? 'slip-leg slip-bad' : 'slip-leg'}
                    data-testid="slip-leg"
                  >
                    {about.length > 0 && (
                      <div className="muted small" data-testid="slip-leg-about">
                        {about.join(' · ')}
                      </div>
                    )}
                    <div>
                      <strong data-testid="slip-leg-match">
                        {view?.eventName ?? TEXT.loading}
                      </strong>
                    </div>
                    <div data-testid="slip-leg-pick">
                      {view?.marketName?.en ?? ''} ·{' '}
                      <strong>{view?.selectionName?.en ?? ''}</strong> @{' '}
                      <span className={view?.oddsChanged === true ? 'odds-changed' : undefined}>
                        {formatOddsMilli(view?.oddsMilli ?? leg.oddsMilli)}
                      </span>
                      {view?.oddsChanged === true && (
                        <span className="muted small">
                          {' '}
                          ({TEXT.oddsWas} {formatOddsMilli(leg.oddsMilli)})
                        </span>
                      )}
                    </div>
                    {bad && <div className="error small">{legReasonText(view.reason)}</div>}
                    <button
                      type="button"
                      data-testid="leg-remove"
                      disabled={!idle}
                      onClick={() => removeLeg(leg.selectionId)}
                    >
                      {TEXT.legRemove}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {startedIds.length > 0 && (
            <p>
              <button
                type="button"
                data-testid="remove-started"
                disabled={!idle}
                onClick={removeStarted}
              >
                {TEXT.removeStarted}
              </button>
            </p>
          )}

          <label htmlFor="slip-stake">
            {TEXT.stakeLabel}
            <input
              id="slip-stake"
              data-testid="slip-stake"
              inputMode="decimal"
              autoComplete="off"
              disabled={!idle}
              value={stakeText}
              onChange={(e) => setStakeText(e.target.value)}
            />
          </label>
          <label htmlFor="slip-phone">
            {TEXT.customerPhoneLabel}
            <input
              id="slip-phone"
              data-testid="slip-phone"
              inputMode="tel"
              autoComplete="off"
              disabled={!idle}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          {!phoneValid && <p className="error">{TEXT.customerPhoneInvalid}</p>}

          <p>
            <button
              type="button"
              data-testid="slip-check"
              disabled={!idle || checking || legs.length === 0}
              aria-busy={checking}
              onClick={() => void runCheck(legs, stake, true)}
            >
              {checking ? TEXT.checking : TEXT.checkButton}
            </button>{' '}
            {oddsChanged && (
              <button
                type="button"
                data-testid="slip-accept-odds"
                disabled={!idle}
                onClick={acceptNewOdds}
              >
                {TEXT.acceptOdds}
              </button>
            )}
          </p>

          {checkedNow !== null && (
            <>
              {checkedNow.data.errors.map((e, i) => (
                <p key={`${e.code}-${i}`} className="error" role="alert" data-testid="slip-error">
                  {e.message}
                </p>
              ))}
              <dl className="summary">
                <div>
                  <dt>{TEXT.totalOdds}</dt>
                  <dd data-testid="slip-total">
                    {formatOddsMilli(checkedNow.data.totalOddsMilli)}
                  </dd>
                </div>
                <div>
                  <dt>{TEXT.possibleWin}</dt>
                  <dd>{formatEtb(checkedNow.data.grossPayout)}</dd>
                </div>
                <div>
                  <dt>{TEXT.tax}</dt>
                  <dd>{formatEtb(checkedNow.data.taxAmount)}</dd>
                </div>
                <div>
                  <dt>{TEXT.netPay}</dt>
                  <dd data-testid="slip-net">{formatEtb(checkedNow.data.netPayout)}</dd>
                </div>
              </dl>
            </>
          )}
          {aboveBalance && (
            <p className="error" data-testid="sell-above-balance">
              {TEXT.topUpAboveStake}
            </p>
          )}
          {error !== null && (
            <p className="error" role="alert" data-testid="sell-error">
              {error}
            </p>
          )}
          {busy === 'selling' && slow && (
            <p className="notice" role="status" data-testid="sell-slow">
              {TEXT.sellSlow}
            </p>
          )}
          {busy === 'opening' && opened !== null && (
            <p className="notice" role="status" data-testid="sell-opening">
              {TEXT.sellOpening} <a href={opened}>{TEXT.sellOpenTicket}</a>
            </p>
          )}
          <button
            type="button"
            className="primary sell-button"
            data-testid="sell-submit"
            disabled={!idle || blocker !== null}
            aria-busy={!idle}
            onClick={() => void sell()}
          >
            {sellLabel}
          </button>
          <p className="muted small" data-testid="sell-hint">
            {blocker ?? (clean ? TEXT.checkClean : TEXT.sellHint)}
          </p>
        </section>

        <div className="sell-game">
          <AddByGame onAdd={addLegs} />
        </div>
        <div className="sell-matches">
          <MatchesPanel onAdd={addLegs} />
        </div>
      </div>

      {legs.length > 0 && !ticketInView && (
        <div className="ticket-bar no-print" data-testid="ticket-bar">
          <span>
            {ticketBarLabel(
              legs.length,
              checkedNow === null ? null : formatOddsMilli(checkedNow.data.totalOddsMilli),
            )}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() =>
              ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {TEXT.ticketBarShow}
          </button>
        </div>
      )}
    </div>
  );
}

/** Game ID + pick, and the free-text box; each pick is resolved by the API. */
function AddByGame({ onAdd }: { onAdd: (legs: SlipLeg[]) => void }) {
  const [gameId, setGameId] = useState('');
  const [pick, setPick] = useState('');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function resolve(picks: PickInput[]) {
    setBusy(true);
    const found: string[] = [];
    try {
      const res = await api<ShopPicksResponse>('/shop/desk/tickets/picks', {
        method: 'POST',
        body: { picks },
      });
      const legs: SlipLeg[] = [];
      for (const leg of res.legs) {
        if (leg.refusal !== null || leg.selectionId === null || leg.oddsMilli === null) {
          found.push(
            `${leg.gameId} ${leg.pick}: ${refusalText(leg.refusal ?? 'pick_unavailable')}`,
          );
        } else {
          legs.push({ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli });
        }
      }
      if (legs.length > 0) onAdd(legs);
    } catch (e) {
      found.push(describeError(e));
    } finally {
      setProblems(found);
      setBusy(false);
    }
  }

  async function addOne(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePickText(`${gameId} ${pick}`);
    if (parsed.picks.length !== 1 || parsed.invalid.length > 0) {
      setProblems([TEXT.pickNeedBoth]);
      return;
    }
    await resolve(parsed.picks);
    setGameId('');
    setPick('');
  }

  async function addText() {
    const parsed = parsePickText(text);
    const bad = parsed.invalid.map((w) => `${TEXT.pickInvalid} ${w}`);
    if (parsed.picks.length === 0) {
      setProblems(bad.length > 0 ? bad : [TEXT.pickNeedBoth]);
      return;
    }
    await resolve(parsed.picks);
    setProblems((now) => [...bad, ...now]);
    setText('');
  }

  return (
    <section className="card" aria-labelledby="add-game">
      <h2 id="add-game">{TEXT.addByGame}</h2>
      <form onSubmit={(e) => void addOne(e)} aria-label={TEXT.addByGame}>
        <div className="row">
          <label htmlFor="pick-game">
            {TEXT.gameId}
            <input
              id="pick-game"
              data-testid="pick-game"
              inputMode="numeric"
              autoComplete="off"
              value={gameId}
              onChange={(e) => setGameId(e.target.value)}
            />
          </label>
          <label htmlFor="pick-code">
            {TEXT.pick}
            <input
              id="pick-code"
              data-testid="pick-code"
              autoComplete="off"
              placeholder={TEXT.pickPlaceholder}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            />
          </label>
        </div>
        <button type="submit" className="primary" data-testid="pick-add" disabled={busy}>
          {TEXT.addPick}
        </button>
      </form>
      <label htmlFor="picks-text">
        {TEXT.picksTextLabel}
        <textarea
          id="picks-text"
          data-testid="picks-text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button type="button" disabled={busy} onClick={() => void addText()}>
        {TEXT.picksTextAdd}
      </button>
      {problems.map((p) => (
        <p key={p} className="error" role="alert">
          {p}
        </p>
      ))}
    </section>
  );
}

/** True when the slip holds exactly these selections (a booking code's, to print its code). */
function sameSelections(legs: readonly SlipLeg[], ids: readonly string[]): boolean {
  const slip = new Set(legs.map((l) => l.selectionId));
  return slip.size === new Set(ids).size && ids.every((id) => slip.has(id));
}

/** A booking code a player made online: its matches come with the prices stored in it. */
function AddByBooking({
  onAdd,
  disabled,
}: {
  onAdd: (legs: SlipLeg[], bookingCode: string, stake: string | null) => void;
  disabled: boolean;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function load(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (value === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ShopBookingResponse>(
        `/shop/desk/booking-codes/${encodeURIComponent(value)}`,
      );
      onAdd(res.legs, value, res.stake);
      setCode('');
    } catch (e) {
      if (mounted.current) setError(describeError(e, TEXT.bookingErrors));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="add-booking">
      <h2 id="add-booking">{TEXT.bookingTitle}</h2>
      <form onSubmit={(e) => void load(e)} aria-label={TEXT.bookingTitle}>
        <label htmlFor="booking-code">
          {TEXT.bookingLabel}
          <input
            id="booking-code"
            data-testid="booking-code"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="primary"
          data-testid="booking-load"
          disabled={busy || disabled}
        >
          {TEXT.bookingLoad}
        </button>
      </form>
    </section>
  );
}

/** Upcoming prematch football (the next 48 hours): a pick button adds that selection. */
function MatchesPanel({ onAdd }: { onAdd: (legs: SlipLeg[]) => void }) {
  const list = useFetch<EventListResponse>('/shop/desk/matches');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(MATCHES_PAGE);
  // Read once per load: a list left open is re-filtered by the check, which refuses started matches.
  const [now] = useState(() => Date.now());
  const matches = filterMatchesByTeam(sellableMatches(list.data?.items ?? [], now), search);

  return (
    <section className="card" aria-labelledby="matches" data-testid="matches-panel">
      <h2 id="matches">{TEXT.matchesTitle}</h2>
      <p className="muted small">{TEXT.matchesNote}</p>
      <label htmlFor="matches-search">
        {TEXT.matchesSearch}
        <input
          id="matches-search"
          data-testid="matches-search"
          autoComplete="off"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setShown(MATCHES_PAGE);
          }}
        />
      </label>
      {list.error !== null && (
        <p className="error" role="alert">
          {list.error}
        </p>
      )}
      {list.data === null && list.error === null && (
        <p className="muted" role="status">
          {TEXT.matchesLoading}
        </p>
      )}
      {list.data !== null && matches.length === 0 && <p className="muted">{TEXT.matchesNone}</p>}
      <ul className="slip">
        {matches.slice(0, shown).map((e) => (
          <MatchRow key={e.id} event={e} onAdd={onAdd} />
        ))}
      </ul>
      {matches.length > shown && (
        <button
          type="button"
          data-testid="matches-more"
          onClick={() => setShown(shown + MATCHES_PAGE)}
        >
          {TEXT.matchesShowMore}
        </button>
      )}
    </section>
  );
}

function MatchRow({ event, onAdd }: { event: EventSummary; onAdd: (legs: SlipLeg[]) => void }) {
  const picks = (event.mainMarket?.selections ?? []).filter((s) => s.open);
  return (
    <li className="slip-leg" data-testid="match-row">
      <div className="muted small">
        {event.competition.name.en} · #{event.gameId} · {formatDateTime(event.startTime)}
      </div>
      <div>
        <strong>
          {event.home.name.en} - {event.away.name.en}
        </strong>
      </div>
      <div className="row">
        {picks.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid="match-pick"
            onClick={() => onAdd([{ selectionId: s.id, oddsMilli: s.oddsMilli }])}
          >
            {s.code} · {formatOddsMilli(s.oddsMilli)}
          </button>
        ))}
      </div>
    </li>
  );
}
