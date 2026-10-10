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
import { formatOddsMilli, formatSantim, formatTotalOdds } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { useBetslip } from '@/providers/BetslipProvider';
import { useSession } from '@/providers/SessionProvider';
import { BookingCodePanel } from './BookingCodePanel';
import {
  bonusPercent,
  oddsChangesFromDetails,
  PLACE_BET_ERROR_KEYS,
  placeBetRequest,
  placementFingerprint,
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
 * The betslip drawer (bottom sheet), loaded lazily by BetslipHost when the slip
 * opens. Legs with remove, stake with quick stakes, a live quote (total odds,
 * potential win, multi bonus, tax, net payout), odds-change handling, bet
 * placement with an idempotency key, and booking codes.
 */

const POLICIES: readonly OddsChangePolicy[] = ['none', 'higher', 'any'];
/** A live bet waits for its acceptance delay (6 s by default): follow it this long. */
const ACCEPTANCE_POLL_MS = 2_000;
const ACCEPTANCE_POLL_MAX = 15;

/** The login page, coming back here afterwards (the login page checks `next`). */
function loginHref(): string {
  const here = `${window.location.pathname}${window.location.search}`;
  return here === routes.home ? routes.login : `${routes.login}?next=${encodeURIComponent(here)}`;
}

interface PlaceError {
  key: MessageKey;
  topUp: boolean;
}

export default function BetslipDrawer() {
  const t = useT();
  const slip = useBetslip();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<BetView | null>(null);

  const { close } = slip;
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
        className="relative mx-auto flex max-h-[88dvh] w-full max-w-2xl flex-col rounded-t-lg bg-page shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t-lg bg-brand px-3 py-2 text-brand-ink">
          <h2 id="betslip-title" className="font-bold">
            {t('sportsbook.betslip.title')}
          </h2>
          {placed === null && slip.count > 0 ? (
            <span className="rounded-full bg-accent px-2 text-xs font-bold text-accent-ink">
              {slip.count === 1
                ? t('sportsbook.betslip.single')
                : t('sportsbook.betslip.multi', { count: slip.count })}
            </span>
          ) : null}
          <button
            type="button"
            className="ml-auto px-2 text-xl leading-none"
            aria-label={t('common.actions.close')}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {placed !== null ? (
            <PlacedBet bet={placed} onDone={close} />
          ) : (
            <SlipBody onPlaced={setPlaced} />
          )}
        </div>
      </div>
    </div>
  );
}

function SlipBody({ onPlaced }: { onPlaced: (bet: BetView) => void }) {
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
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);

  // A fresh quote supersedes what a failed placement reported.
  useEffect(() => {
    setPlaceUnavailable(new Map());
  }, [quote]);

  const unavailable = new Map([...quoteState.unavailable, ...placeUnavailable]);
  const unavailableLegs = slip.legs.filter((leg) => unavailable.has(leg.selectionId));
  const needsAccept = slip.oddsChanged && !policyCoversChanges(slip.oddsChangePolicy, slip.legs);
  const quoteErrors = quote?.errors ?? [];

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
    const fingerprint = placementFingerprint(body);
    // One key per intent: a retry of the same slip reuses it, a changed slip gets a new one.
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = { fingerprint, key: newIdempotencyKey('bet') };
    }
    setPlacing(true);
    setPlaceError(null);
    try {
      const bet = await bettingApi.place(body, intent.current.key);
      intent.current = null;
      slip.clear();
      onPlaced(bet);
      void session.refreshWallet();
    } catch (error) {
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
    } finally {
      setPlacing(false);
    }
  }

  if (slip.count === 0) {
    return (
      <div className="space-y-3 p-3">
        <p className="card text-center text-muted">{t('sportsbook.betslip.empty')}</p>
        <BookingCodePanel />
      </div>
    );
  }

  const canPlace =
    !placing &&
    stake !== null &&
    unavailableLegs.length === 0 &&
    quoteErrors.length === 0 &&
    session.status !== 'loading';

  return (
    <div className="space-y-2 p-2">
      <ul className="overflow-hidden rounded-md bg-surface">
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
                    <span className="rounded-sm bg-live px-1 text-xxs font-bold text-white">
                      {t('sportsbook.match.live')}
                    </span>
                  ) : null}
                  <span className="truncate">{selection}</span>
                </p>
                <p className="truncate text-xxs text-muted">{localName(leg.marketName, locale)}</p>
                <p className="truncate text-xxs text-muted">
                  {localName(leg.home, locale)} v {localName(leg.away, locale)} ·{' '}
                  {t('sportsbook.list.gameId', { id: leg.gameId })}
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
                className="-mr-2 flex-none px-2 text-lg leading-none text-muted"
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
          className="flex items-center justify-between gap-2 rounded-md bg-demo-bg px-3 py-2 text-demo-ink"
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
            className="input mt-1 font-bold tabular-nums"
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
              className={`chip flex-1 justify-center ${stake === value ? 'border-brand text-brand' : ''}`}
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
            className="border-t border-line pt-1 text-base font-bold"
          />
        </dl>
        {quote?.cappedByMaxPayout === true ? (
          <p className="text-xxs text-muted">{t('sportsbook.betslip.capped')}</p>
        ) : null}
        <p aria-live="polite" className="min-h-4 text-xxs text-muted">
          {quoteState.pending ? t('sportsbook.betslip.updating') : ''}
        </p>
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
          className="rounded-sm border border-line bg-surface px-2 py-1.5 text-sm"
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
          className="rounded-md bg-surface px-3 py-2 text-sm font-semibold text-down"
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
        </div>
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
          className="btn btn-accent w-full text-base"
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
function PlacedBet({ bet: initial, onDone }: { bet: BetView; onDone: () => void }) {
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

  return (
    <div className="space-y-3 p-3 text-center">
      <div className="card space-y-1">
        <p className="text-3xl text-up" aria-hidden="true">
          ✓
        </p>
        <p className="text-lg font-bold">{t('sportsbook.betslip.success.title')}</p>
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
