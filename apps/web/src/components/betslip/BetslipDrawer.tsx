'use client';

import type { BetView, OddsChangePolicy, UnavailableReason } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { bettingApi } from '@/lib/api/betting';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { placeOnce, sameSelections } from '@/lib/betslip/placement';
import { getPlacement, setPlacement, usePendingPlacement } from '@/lib/betslip/placement-store';
import { formatOddsMilli, formatSantim, formatTotalOdds } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { useUserStream } from '@/lib/user-stream/useUserStream';
import { useBetslip } from '@/providers/BetslipProvider';
import { useSession } from '@/providers/SessionProvider';
import { BookingCodePanel } from './BookingCodePanel';
import {
  bonusPercent,
  oddsChangesFromDetails,
  PLACE_BET_ERROR_KEYS,
  placeBetRequest,
  policyCoversChanges,
  QUICK_STAKES,
  slipErrorKey,
  slipErrorsFromDetails,
  stakeFromInput,
  stakeToInput,
  unavailableFromDetails,
} from './requests';
import { useSlipQuote } from './useSlipQuote';

/**
 * The betslip: a bottom sheet on phones (the default export, loaded lazily by
 * BetslipHost when the slip opens) and a docked column on wide sportsbook pages
 * (BetslipPanel, loaded by BetslipDock). Legs with remove, stake with quick stakes, a live quote (total odds,
 * potential win, multi bonus, tax, net payout), odds-change handling, bet
 * placement with an idempotency key, and booking codes.
 *
 * The placement key lives outside this component (module state +
 * sessionStorage, src/lib/betslip/placement-store.ts): the drawer unmounts
 * when it closes. See src/lib/betslip/placement.ts for why a retry can never
 * place a bet twice.
 */

const POLICIES: readonly OddsChangePolicy[] = ['none', 'higher', 'any'];
/** A live bet waits for its acceptance delay (6 s by default): follow it this long. */
// The player's push stream (bet.accepted / bet.rejected) answers at once; polling is the fallback.
const ACCEPTANCE_POLL_MS = 4_000;
const ACCEPTANCE_POLL_MAX = 10;

/** The login page, coming back here afterwards (the login page checks `next`). */
function loginHref(): string {
  const here = `${window.location.pathname}${window.location.search}`;
  return here === routes.home ? routes.login : `${routes.login}?next=${encodeURIComponent(here)}`;
}

interface PlaceError {
  key: MessageKey;
  topUp: boolean;
  /** Link to My Bets (the bet was placed by an earlier attempt). */
  myBets?: boolean;
}

interface Placed {
  bet: BetView;
  /** The bet comes from an earlier attempt whose answer was lost. */
  earlier: boolean;
  /** The slip was emptied when the bet was placed. */
  cleared: boolean;
}

/**
 * The betslip itself: title bar, then the slip or the bet just placed. Shared by
 * the drawer (phones, `onClose` adds the close button) and the docked column of
 * wide sportsbook pages (BetslipDock).
 */
export function BetslipPanel({ titleId, onClose }: { titleId: string; onClose?: () => void }) {
  const t = useT();
  const slip = useBetslip();
  const [stored, setPlaced] = useState<Placed | null>(null);
  // In the docked column the player can pick again right away: the new slip then
  // takes over from the confirmation of the last bet.
  const placed = stored !== null && stored.cleared && slip.count > 0 ? null : stored;
  return (
    <>
      <header className="flex flex-none items-center gap-2 border-b border-line bg-surface px-3 py-2.5">
        <h2 id={titleId} className="text-base font-extrabold">
          {t('sportsbook.betslip.title')}
        </h2>
        {placed === null && slip.count > 0 ? (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-extrabold text-accent-ink">
            {slip.count === 1
              ? t('sportsbook.betslip.single')
              : t('sportsbook.betslip.multi', { count: slip.count })}
          </span>
        ) : null}
        {onClose !== undefined ? (
          <button
            type="button"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-raised text-xl leading-none"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {placed !== null ? (
          <PlacedBet
            bet={placed.bet}
            earlier={placed.earlier}
            onDone={() => {
              setPlaced(null);
              onClose?.();
            }}
          />
        ) : (
          <SlipBody onPlaced={setPlaced} />
        )}
      </div>
    </>
  );
}

/** The betslip as a bottom sheet over the page (phones and narrow screens). */
export default function BetslipDrawer() {
  const t = useT();
  const { close } = useBetslip();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label={t('common.actions.close')}
        className="absolute inset-0 bg-black/45"
        onClick={close}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="betslip-title"
        tabIndex={-1}
        className="relative mx-auto flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border-t border-line bg-page shadow-2xl outline-none"
      >
        <BetslipPanel titleId="betslip-title" onClose={close} />
      </div>
    </div>
  );
}

function SlipBody({ onPlaced }: { onPlaced: (placed: Placed) => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const slip = useBetslip();
  const session = useSession();

  const [stakeText, setStakeText] = useState(() => stakeToInput(slip.stake));
  const stake = stakeFromInput(stakeText);
  const quoteState = useSlipQuote(slip.legs, stake, slip.updateOdds);
  const { quote } = quoteState;

  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<PlaceError | null>(null);
  const [placeUnavailable, setPlaceUnavailable] = useState<ReadonlyMap<string, UnavailableReason>>(
    new Map(),
  );

  // A fresh quote supersedes what a failed placement reported.
  useEffect(() => {
    setPlaceUnavailable(new Map());
  }, [quote]);

  const unavailable = new Map([...quoteState.unavailable, ...placeUnavailable]);
  const unavailableLegs = slip.legs.filter((leg) => unavailable.has(leg.selectionId));
  const needsAccept = slip.oddsChanged && !policyCoversChanges(slip.oddsChangePolicy, slip.legs);
  const quoteErrors = quote?.errors ?? [];
  const unresolved = (usePendingPlacement()?.unresolved.length ?? 0) > 0;

  const setStakeFromText = (text: string) => {
    setStakeText(text);
    setPlaceError(null);
    const santim = stakeFromInput(text);
    if (santim !== null) slip.setStake(santim);
  };

  async function place() {
    if (session.status !== 'authenticated') {
      slip.close();
      router.push(loginHref());
      return;
    }
    if (stake === null || slip.count === 0) return;
    const body = placeBetRequest(slip.legs, stake, slip.oddsChangePolicy);
    setPlacing(true);
    setPlaceError(null);
    // One key until a bet comes back for it, whatever changed since the last
    // attempt (odds, legs, stake); see src/lib/betslip/placement.ts.
    const result = await placeOnce({
      body,
      pending: getPlacement(),
      newKey: () => newIdempotencyKey('bet'),
      send: (request, key) => bettingApi.place(request, key),
      save: setPlacement,
    });
    setPlacing(false);

    if (result.kind === 'placed') {
      const cleared =
        result.earlier === null || sameSelections(result.earlier, slip.legs, slip.stake);
      if (cleared) slip.clear();
      onPlaced({ bet: result.bet, earlier: result.earlier !== null, cleared });
      void session.refreshWallet();
      return;
    }
    if (result.kind === 'placedEarlier') {
      setPlaceError({ key: 'sportsbook.betslip.errors.earlierPlaced', topUp: false, myBets: true });
      void session.refreshWallet();
      return;
    }
    const { error } = result;
    if (isApiClientError(error)) {
      if (error.status === 401) {
        slip.close();
        router.push(loginHref());
        return;
      }
      if (error.code === 'odds_changed') {
        slip.updateOdds(oddsChangesFromDetails(error.details));
      } else if (error.code === 'selection_unavailable') {
        setPlaceUnavailable(unavailableFromDetails(error.details));
      } else if (error.code === 'slip_invalid') {
        const [first] = slipErrorsFromDetails(error.details);
        if (first !== undefined) {
          setPlaceError({ key: slipErrorKey(first.code), topUp: false });
          return;
        }
      }
    }
    setPlaceError({
      key: errorMessageKey(error, PLACE_BET_ERROR_KEYS),
      topUp: isApiClientError(error) && error.code === 'insufficient_funds',
    });
  }

  if (slip.count === 0) {
    return (
      <div className="space-y-3 p-3">
        <div className="card space-y-2 py-6 text-center text-muted">
          <svg
            viewBox="0 0 24 24"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="mx-auto opacity-60"
          >
            <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />
          </svg>
          <p>{t('sportsbook.betslip.empty')}</p>
        </div>
        <BookingCodePanel />
      </div>
    );
  }

  const canPlace =
    !placing &&
    stake !== null &&
    unavailableLegs.length === 0 &&
    // Only with a quote for these selections and stake: the player sees what they bet.
    quote !== null &&
    quoteErrors.length === 0 &&
    session.status !== 'loading';

  return (
    <div className="space-y-2 p-2">
      <ul className="panel">
        {slip.legs.map((leg) => {
          const reason = unavailable.get(leg.selectionId);
          const selection = localName(leg.selectionName, locale);
          const moved =
            leg.previousOddsMilli === null
              ? null
              : leg.oddsMilli > leg.previousOddsMilli
                ? 'up'
                : 'down';
          return (
            <li
              key={leg.selectionId}
              className={`flex items-start gap-2 border-b border-line px-3 py-2 last:border-b-0 ${
                reason !== undefined ? 'bg-page text-muted' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 font-semibold">
                  {leg.live ? (
                    <span className="rounded-full bg-live px-1.5 text-xxs font-bold text-white">
                      {t('sportsbook.match.live')}
                    </span>
                  ) : null}
                  <span className="truncate">{selection}</span>
                </p>
                <p className="truncate text-xxs text-muted">{localName(leg.marketName, locale)}</p>
                <p className="truncate text-xxs text-muted">
                  {t('sportsbook.match.versus', {
                    home: localName(leg.home, locale),
                    away: localName(leg.away, locale),
                  })}{' '}
                  · {t('sportsbook.list.gameId', { id: leg.gameId })}
                </p>
                {reason !== undefined ? (
                  <p className="text-xxs font-semibold text-down">
                    {t(`sportsbook.betslip.unavailable.${reason}`)}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-none flex-col items-end">
                <span
                  className={`font-bold tabular-nums ${
                    moved === 'up' ? 'text-up' : moved === 'down' ? 'text-down' : ''
                  }`}
                >
                  {moved === 'up' ? '▲ ' : moved === 'down' ? '▼ ' : ''}
                  {formatOddsMilli(leg.oddsMilli)}
                </span>
                {leg.previousOddsMilli !== null ? (
                  <span className="text-xxs text-muted line-through tabular-nums">
                    {formatOddsMilli(leg.previousOddsMilli)}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-raised text-base leading-none text-muted"
                aria-label={t('sportsbook.betslip.remove', { name: selection })}
                onClick={() => slip.remove(leg.selectionId)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2 px-1 text-xs">
        {unavailableLegs.length > 0 ? (
          <button
            type="button"
            className="font-semibold text-down"
            onClick={() => {
              for (const leg of unavailableLegs) slip.remove(leg.selectionId);
            }}
          >
            {t('sportsbook.betslip.removeUnavailable')}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="font-semibold text-muted" onClick={slip.clear}>
          {t('sportsbook.betslip.clear')}
        </button>
      </div>

      {slip.oddsChanged ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-xl bg-demo-bg px-3 py-2 text-demo-ink"
        >
          <span className="text-xs font-semibold">{t('sportsbook.betslip.oddsChanged')}</span>
          <button
            type="button"
            className="btn btn-outline min-h-8 px-3 text-xs"
            onClick={slip.acceptOddsChanges}
          >
            {t('sportsbook.betslip.acceptOdds')}
          </button>
        </div>
      ) : null}

      <section className="card space-y-2">
        <label className="block">
          <span className="text-xs font-semibold text-muted">{t('sportsbook.betslip.stake')}</span>
          <input
            className="input mt-1 text-lg font-extrabold tabular-nums"
            inputMode="decimal"
            autoComplete="off"
            value={stakeText}
            aria-invalid={stake === null}
            onChange={(event) => setStakeFromText(event.target.value)}
          />
        </label>
        <div role="group" aria-label={t('sportsbook.betslip.quickStakes')} className="flex gap-1.5">
          {QUICK_STAKES.map((value) => (
            <button
              key={value}
              type="button"
              className="chip flex-1 justify-center font-bold tabular-nums"
              aria-pressed={stake === value}
              onClick={() => setStakeFromText(stakeToInput(value))}
            >
              {stakeToInput(value)}
            </button>
          ))}
        </div>

        <dl className="space-y-1 pt-1 text-sm">
          <SummaryRow
            label={t('sportsbook.betslip.totalOdds')}
            value={quote === null ? '–' : formatTotalOdds(quote.totalOddsMilli)}
          />
          <SummaryRow
            label={t('sportsbook.betslip.potentialWin')}
            value={quote === null ? '–' : formatSantim(quote.grossReturn)}
          />
          {quote !== null && quote.bonusPercentBps > 0 ? (
            <SummaryRow
              label={t('sportsbook.betslip.bonus', {
                percent: bonusPercent(quote.bonusPercentBps),
              })}
              value={formatSantim(quote.bonusAmount)}
              className="text-up"
            />
          ) : null}
          <SummaryRow
            label={t('sportsbook.betslip.tax')}
            value={quote === null ? '–' : formatSantim(quote.taxAmount)}
          />
          <SummaryRow
            label={t('sportsbook.betslip.netPayout')}
            value={quote === null ? '–' : formatSantim(quote.netPayout, { currency: true })}
            className="border-t border-line pt-2 text-base font-extrabold text-brand"
          />
        </dl>
        {quote?.cappedByMaxPayout === true ? (
          <p className="text-xxs text-muted">{t('sportsbook.betslip.capped')}</p>
        ) : null}
        <p aria-live="polite" className="min-h-4 text-xxs text-muted">
          {quoteState.pending ? t('sportsbook.betslip.updating') : ''}
        </p>
        {quoteState.error !== null && !quoteState.pending ? (
          <p role="alert" className="flex items-center justify-between gap-2 text-xs text-down">
            <span className="font-semibold">{t('sportsbook.betslip.quoteFailed')}</span>
            <button
              type="button"
              className="btn btn-outline min-h-8 px-3 text-xs"
              onClick={quoteState.retry}
            >
              {t('common.actions.retry')}
            </button>
          </p>
        ) : null}
        {quoteErrors.length > 0 ? (
          <ul className="space-y-0.5 text-xs font-semibold text-down">
            {[...new Set(quoteErrors.map((error) => slipErrorKey(error.code)))].map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <label className="flex items-center justify-between gap-2 px-1 text-xs">
        <span className="font-semibold text-muted">{t('sportsbook.betslip.policy.label')}</span>
        <select
          className="rounded-lg border border-line bg-raised px-2 py-1.5 text-sm"
          value={slip.oddsChangePolicy}
          onChange={(event) => slip.setOddsChangePolicy(event.target.value as OddsChangePolicy)}
        >
          {POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {t(`sportsbook.betslip.policy.${policy}`)}
            </option>
          ))}
        </select>
      </label>

      {placeError !== null ? (
        <div
          role="alert"
          className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm font-semibold text-down"
        >
          {t(placeError.key)}
          {placeError.topUp ? (
            <Link
              href={routes.wallet}
              prefetch={false}
              onClick={slip.close}
              className="ml-2 text-brand underline"
            >
              {t('sportsbook.betslip.topUp')}
            </Link>
          ) : null}
          {placeError.myBets === true ? (
            <Link
              href={routes.myBets}
              prefetch={false}
              onClick={slip.close}
              className="ml-2 text-brand underline"
            >
              {t('sportsbook.betslip.success.myBets')}
            </Link>
          ) : null}
        </div>
      ) : unresolved && !placing ? (
        <p role="status" className="px-1 text-xs text-muted">
          {t('sportsbook.betslip.unresolved')}
        </p>
      ) : null}

      {session.status === 'anonymous' ? (
        <button
          type="button"
          className="btn btn-primary w-full"
          onClick={() => {
            slip.close();
            router.push(loginHref());
          }}
        >
          {t('sportsbook.betslip.loginToBet')}
        </button>
      ) : needsAccept ? (
        <button type="button" className="btn btn-accent w-full" onClick={slip.acceptOddsChanges}>
          {t('sportsbook.betslip.acceptOdds')}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-accent min-h-12 w-full text-base font-extrabold"
          disabled={!canPlace}
          onClick={() => void place()}
        >
          {placing
            ? t('sportsbook.betslip.placing')
            : `${t('sportsbook.betslip.place')}${
                stake === null ? '' : ` · ${formatSantim(stake, { currency: true })}`
              }`}
        </button>
      )}

      <BookingCodePanel />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-2 ${className}`}>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** After placement: the bet's short id and, for a live bet, its acceptance. */
function PlacedBet({
  bet: initial,
  earlier,
  onDone,
}: {
  bet: BetView;
  earlier: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { refreshWallet } = useSession();
  const [bet, setBet] = useState(initial);

  useEffect(() => {
    if (initial.status !== 'pending_acceptance') return;
    const controller = new AbortController();
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > ACCEPTANCE_POLL_MAX) {
        clearInterval(timer);
        return;
      }
      bettingApi
        .bet(initial.id, controller.signal)
        .then((next) => {
          if (next.status === 'pending_acceptance') return;
          clearInterval(timer);
          setBet(next);
          if (next.status === 'rejected') void refreshWallet();
        })
        .catch(() => undefined);
    }, ACCEPTANCE_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [initial.id, initial.status, refreshWallet]);

  // The worker pushes the outcome of a live bet as soon as it is decided.
  useUserStream((message) => {
    if (initial.status !== 'pending_acceptance') return;
    if (message.type !== 'bet.accepted' && message.type !== 'bet.rejected') return;
    if (message.data.betId !== initial.id) return;
    bettingApi
      .bet(initial.id)
      .then((next) => {
        if (next.status === 'pending_acceptance') return;
        setBet(next);
        if (next.status === 'rejected') void refreshWallet();
      })
      .catch(() => undefined);
  });

  return (
    <div className="space-y-3 p-3 text-center">
      <div className="card space-y-1 py-5">
        <p
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-2xl font-bold text-up"
          aria-hidden="true"
        >
          ✓
        </p>
        <p className="text-lg font-bold">{t('sportsbook.betslip.success.title')}</p>
        {earlier ? (
          <p className="text-xs text-muted">{t('sportsbook.betslip.success.earlier')}</p>
        ) : null}
        <p className="font-mono text-sm font-semibold">
          {t('sportsbook.betslip.success.betId', { id: bet.shortId })}
        </p>
        <dl className="mx-auto max-w-xs space-y-1 pt-2 text-left text-sm">
          <SummaryRow label={t('sportsbook.betslip.stake')} value={formatSantim(bet.stake)} />
          <SummaryRow
            label={t('sportsbook.betslip.totalOdds')}
            value={formatTotalOdds(bet.totalOddsMilli)}
          />
          <SummaryRow
            label={t('sportsbook.betslip.netPayout')}
            value={formatSantim(bet.potentialNet, { currency: true })}
            className="font-bold"
          />
        </dl>
        <p role="status" className="pt-1 text-xs font-semibold">
          {bet.status === 'pending_acceptance' ? (
            <span className="text-muted">{t('sportsbook.betslip.success.pending')}</span>
          ) : bet.status === 'rejected' ? (
            <span className="text-down">{t('sportsbook.betslip.success.rejected')}</span>
          ) : (
            <span className="text-up">{t('sportsbook.betslip.success.accepted')}</span>
          )}
        </p>
      </div>
      <div className="flex gap-2">
        <Link
          href={routes.myBets}
          prefetch={false}
          className="btn btn-outline flex-1"
          onClick={onDone}
        >
          {t('sportsbook.betslip.success.myBets')}
        </Link>
        <button type="button" className="btn btn-primary flex-1" onClick={onDone}>
          {t('sportsbook.betslip.success.done')}
        </button>
      </div>
    </div>
  );
}
