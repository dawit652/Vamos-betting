'use client';

import type {
  EventListResponse,
  EventSummary,
  ShopBookingResponse,
  ShopDeskResponse,
  ShopPicksResponse,
  ShopSellTicketRequest,
  ShopTicketCheckResponse,
  ShopTicketResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { positiveCashToSantim } from '@/lib/forms';
import { formatDateTime, formatEtb } from '@/lib/format';
import { filterMatchesByTeam, MATCHES_PAGE, sellableMatches } from '@/lib/matches';
import { TEXT } from '@/lib/text';
import {
  formatOddsMilli,
  legReasonText,
  newTicketKey,
  parsePickText,
  refusalText,
  ticketPath,
  type PickInput,
} from '@/lib/tickets';

/** One match on the slip: only what the API needs; names come back with each check. */
interface SlipLeg {
  selectionId: string;
  oddsMilli: number;
}

/** A price preview needs some stake; the real check uses the one typed. */
const PREVIEW_STAKE = '1000';

/** What a check was made for: the legs with their prices, the stake and the phone. */
function slipSignature(legs: SlipLeg[], stake: string | null): string {
  return `${legs.map((l) => `${l.selectionId}@${l.oddsMilli}`).join(',')}|${stake ?? ''}`;
}

interface Quote {
  signature: string;
  /** Made with the typed stake (the Check button); a preview only fills in names and prices. */
  real: boolean;
  data: ShopTicketCheckResponse;
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
  const shift = desk.data.shift;
  if (shift === null) {
    return (
      <div data-testid="sell-page">
        <h1>{TEXT.sellTitle}</h1>
        <p className="card">
          {TEXT.sellNeedShift}. <Link href="/">{TEXT.sellNeedShiftLink}</Link>
        </p>
      </div>
    );
  }
  return <Seller shiftId={shift.id} />;
}

function Seller({ shiftId }: { shiftId: string }) {
  const router = useRouter();
  const [legs, setLegs] = useState<SlipLeg[]>([]);
  const [stakeText, setStakeText] = useState('');
  const [phone, setPhone] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [checking, setChecking] = useState(false);
  const [selling, setSelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<{ signature: string; value: string } | null>(null);

  const stake = positiveCashToSantim(stakeText);
  const signature = slipSignature(legs, stake);
  const phoneDigits = phone.replace(/[\s-]/g, '');
  const phoneValid = phoneDigits === '' || /^\+?[0-9]{9,15}$/.test(phoneDigits);

  /** Adds legs (skipping ones already there) and fetches a preview so names and prices show. */
  function addLegs(add: SlipLeg[]) {
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
    void runCheck(next, stake, false);
  }

  async function runCheck(slip: SlipLeg[], santim: string | null, real: boolean) {
    if (slip.length === 0) {
      setQuote(null);
      return;
    }
    if (real && santim === null) {
      setError(TEXT.stakeInvalid);
      return;
    }
    setChecking(true);
    try {
      const data = await api<ShopTicketCheckResponse>('/shop/desk/tickets/check', {
        method: 'POST',
        body: { legs: slip, stake: santim ?? PREVIEW_STAKE },
      });
      setQuote({ signature: slipSignature(slip, santim), real, data });
      if (real) setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setChecking(false);
    }
  }

  function removeLeg(selectionId: string) {
    const next = legs.filter((l) => l.selectionId !== selectionId);
    setLegs(next);
    setQuote(null);
    void runCheck(next, stake, false);
  }

  const startedIds =
    quote === null
      ? []
      : quote.data.legs.filter((l) => l.reason === 'event_started').map((l) => l.selectionId);

  function removeStarted() {
    const next = legs.filter((l) => !startedIds.includes(l.selectionId));
    setLegs(next);
    setQuote(null);
    void runCheck(next, stake, false);
  }

  /** Takes the current prices as the slip's (after the cashier saw them) and checks again. */
  function acceptNewOdds() {
    if (quote === null) return;
    const prices = new Map(quote.data.legs.map((l) => [l.selectionId, l.oddsMilli]));
    const next = legs.map((l) => ({ ...l, oddsMilli: prices.get(l.selectionId) ?? l.oddsMilli }));
    setLegs(next);
    void runCheck(next, stake, true);
  }

  const current = quote !== null && quote.signature === signature ? quote : null;
  const clean =
    current !== null &&
    current.real &&
    current.data.errors.length === 0 &&
    current.data.legs.every((l) => l.available && !l.oddsChanged);
  const oddsChanged = current?.data.legs.some((l) => l.oddsChanged) === true;

  async function sell() {
    if (!clean || stake === null || !phoneValid) return;
    // One key per exact ticket, kept through retries; a changed ticket gets a new one.
    const signatureNow = `${signature}|${phoneDigits}`;
    if (key.current === null || key.current.signature !== signatureNow) {
      key.current = { signature: signatureNow, value: newTicketKey() };
    }
    const body: ShopSellTicketRequest = {
      shiftId,
      legs,
      stake,
      oddsChangePolicy: 'none',
      idempotencyKey: key.current.value,
    };
    if (phoneDigits !== '') body.customerPhone = phoneDigits;
    setSelling(true);
    setError(null);
    try {
      const res = await api<ShopTicketResponse>('/shop/desk/tickets', { method: 'POST', body });
      router.push(ticketPath(res.ticket.id, true));
    } catch (e) {
      setError(describeError(e, TEXT.sellErrors));
      setSelling(false);
    }
  }

  return (
    <div data-testid="sell-page">
      <h1>{TEXT.sellTitle}</h1>
      <AddByGame onAdd={addLegs} />
      <AddByBooking onAdd={addLegs} />
      <MatchesPanel onAdd={addLegs} />

      <section className="card" aria-labelledby="slip">
        <h2 id="slip">{TEXT.slipTitle}</h2>
        {legs.length === 0 ? (
          <p className="muted">{TEXT.slipEmpty}</p>
        ) : (
          <ul className="slip">
            {legs.map((leg) => {
              const view = quote?.data.legs.find((l) => l.selectionId === leg.selectionId);
              const bad = view !== undefined && !view.available;
              return (
                <li
                  key={leg.selectionId}
                  className={bad ? 'slip-leg slip-bad' : 'slip-leg'}
                  data-testid="slip-leg"
                >
                  <div>
                    <strong>{view?.eventName ?? leg.selectionId}</strong>
                    {view?.gameId !== null && view?.gameId !== undefined && (
                      <span className="muted"> · #{view.gameId}</span>
                    )}
                  </div>
                  <div>
                    {view?.marketName?.en ?? ''} · <strong>{view?.selectionName?.en ?? ''}</strong>{' '}
                    @{' '}
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
            <button type="button" data-testid="remove-started" onClick={removeStarted}>
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
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        {!phoneValid && <p className="error">{TEXT.customerPhoneInvalid}</p>}

        <p>
          <button
            type="button"
            data-testid="slip-check"
            disabled={checking || legs.length === 0}
            onClick={() => void runCheck(legs, stake, true)}
          >
            {checking ? TEXT.checking : TEXT.checkButton}
          </button>{' '}
          {oddsChanged && (
            <button type="button" data-testid="slip-accept-odds" onClick={acceptNewOdds}>
              {TEXT.acceptOdds}
            </button>
          )}
        </p>

        {current !== null && current.real && (
          <>
            {current.data.errors.map((e, i) => (
              <p key={`${e.code}-${i}`} className="error" role="alert" data-testid="slip-error">
                {e.message}
              </p>
            ))}
            <dl className="summary">
              <div>
                <dt>{TEXT.totalOdds}</dt>
                <dd data-testid="slip-total">{formatOddsMilli(current.data.totalOddsMilli)}</dd>
              </div>
              <div>
                <dt>{TEXT.possibleWin}</dt>
                <dd>{formatEtb(current.data.grossPayout)}</dd>
              </div>
              <div>
                <dt>{TEXT.tax}</dt>
                <dd>{formatEtb(current.data.taxAmount)}</dd>
              </div>
              <div>
                <dt>{TEXT.netPay}</dt>
                <dd data-testid="slip-net">{formatEtb(current.data.netPayout)}</dd>
              </div>
            </dl>
          </>
        )}
        <p className="muted small">{clean ? TEXT.checkClean : TEXT.checkNeeded}</p>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary"
          data-testid="sell-submit"
          disabled={!clean || !phoneValid || selling}
          onClick={() => void sell()}
        >
          {selling ? TEXT.selling : TEXT.sellButton}
        </button>
      </section>
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

/** A booking code a player made online: its matches come with the prices stored in it. */
function AddByBooking({ onAdd }: { onAdd: (legs: SlipLeg[]) => void }) {
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
      onAdd(res.legs);
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
        <button type="submit" data-testid="booking-load" disabled={busy}>
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
