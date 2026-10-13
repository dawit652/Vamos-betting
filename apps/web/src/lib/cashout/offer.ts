import type { BetView, CashOutOfferView, CashOutUnavailableReason } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { isApiClientError } from '@/lib/api/errors';

/**
 * Cash-out rules of the web app (pure): what a bet shows, how server errors
 * map to the confirm sheet's states, and how fresh offers are merged into a
 * list of bets. Money stays santim wire strings; only `formatSantim` shows it.
 */

/** GET /me/cash-out-offers takes at most this many bet ids. */
export const MAX_OFFER_BETS = 50;
/** The live stream follows at most this many events. */
export const MAX_LIVE_EVENTS = 50;
/** Offers are re-fetched at most this often while live deltas arrive. */
export const OFFER_REFRESH_MS = 2_000;

export const UNAVAILABLE_REASON_KEY: Readonly<Record<CashOutUnavailableReason, MessageKey>> = {
  bet_not_open: 'account.myBets.cashOut.reason.bet_not_open',
  disabled: 'account.myBets.cashOut.reason.disabled',
  no_legs: 'account.myBets.cashOut.reason.no_legs',
  leg_lost: 'account.myBets.cashOut.reason.leg_lost',
  leg_suspended: 'account.myBets.cashOut.reason.leg_suspended',
  all_legs_settled: 'account.myBets.cashOut.reason.all_legs_settled',
  below_minimum: 'account.myBets.cashOut.reason.below_minimum',
};

const REASONS = Object.keys(UNAVAILABLE_REASON_KEY);

export function isUnavailableReason(value: unknown): value is CashOutUnavailableReason {
  return typeof value === 'string' && REASONS.includes(value);
}

const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value);

/** Narrow shape check of an offer in an error body (zod stays out of the browser). */
export function isOfferView(value: unknown): value is CashOutOfferView {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.betId === 'string' &&
    typeof o.available === 'boolean' &&
    isAmount(o.gross) &&
    isAmount(o.tax) &&
    isAmount(o.net) &&
    (o.reason === null || isUnavailableReason(o.reason))
  );
}

export type CashOutState =
  /** Nothing to show: not an open bet, or cash-out is switched off. */
  | { kind: 'none' }
  | { kind: 'offer'; offer: CashOutOfferView }
  | { kind: 'unavailable'; reason: CashOutUnavailableReason };

/** What an open bet shows in place of a cash-out button. */
export function cashOutState(bet: Pick<BetView, 'status' | 'cashOutOffer'>): CashOutState {
  const offer = bet.cashOutOffer;
  if (bet.status !== 'open' || offer === null) return { kind: 'none' };
  if (offer.available) return { kind: 'offer', offer };
  const reason = offer.reason ?? 'bet_not_open';
  return reason === 'disabled' || reason === 'bet_not_open'
    ? { kind: 'none' }
    : { kind: 'unavailable', reason };
}

/** True when the offer carries winnings tax (a cash-out above the stake). */
export function offerHasTax(offer: Pick<CashOutOfferView, 'tax'>): boolean {
  return /[1-9]/.test(offer.tax);
}

/** Same money in both offers (the quote time may differ). */
export function sameOffer(
  a: Pick<CashOutOfferView, 'gross' | 'tax' | 'net'>,
  b: Pick<CashOutOfferView, 'gross' | 'tax' | 'net'>,
): boolean {
  return a.gross === b.gross && a.tax === b.tax && a.net === b.net;
}

/** Whether `fresh` pays the player less than `shown` (compares net, then gross). */
export function isWorse(
  fresh: Pick<CashOutOfferView, 'gross' | 'net'>,
  shown: Pick<CashOutOfferView, 'gross' | 'net'>,
): boolean {
  const net = compareAmounts(fresh.net, shown.net);
  return net !== 0 ? net < 0 : compareAmounts(fresh.gross, shown.gross) < 0;
}

/** Compares two santim wire strings without floats or BigInt-parse errors. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

export type CashOutFailure =
  /** 409 cashout_offer_changed: show `offer` and ask again. */
  | { kind: 'changed'; offer: CashOutOfferView }
  /** 409 cashout_unavailable. */
  | { kind: 'unavailable'; reason: CashOutUnavailableReason }
  /** Anything else (network, 404, 422, 429, 5xx…). */
  | { kind: 'error'; error: unknown };

export function classifyCashOutError(error: unknown): CashOutFailure {
  if (isApiClientError(error) && error.status === 409) {
    const details = error.details as Record<string, unknown> | null | undefined;
    if (error.code === 'cashout_offer_changed' && isOfferView(details?.offer)) {
      return { kind: 'changed', offer: details.offer };
    }
    if (error.code === 'cashout_unavailable') {
      const reason = details?.reason;
      return { kind: 'unavailable', reason: isUnavailableReason(reason) ? reason : 'bet_not_open' };
    }
  }
  return { kind: 'error', error };
}

/** Ids of the open bets that can have an offer (at most the endpoint's limit). */
export function openBetIds(bets: readonly Pick<BetView, 'id' | 'status'>[]): string[] {
  return bets
    .filter((bet) => bet.status === 'open')
    .map((bet) => bet.id)
    .slice(0, MAX_OFFER_BETS);
}

/** Events with an undecided leg in an open bet: the ones whose live deltas move offers. */
export function openBetEventIds(
  bets: readonly Pick<BetView, 'status' | 'legs'>[],
  max: number = MAX_LIVE_EVENTS,
): string[] {
  const ids = new Set<string>();
  for (const bet of bets) {
    if (bet.status !== 'open') continue;
    for (const leg of bet.legs) {
      if (leg.state === 'open') ids.add(leg.eventId);
    }
  }
  return [...ids].slice(0, max);
}

/**
 * Puts fresh offers on the matching open bets. Returns the same array when
 * nothing changed, so a React state update can be skipped.
 */
export function mergeOffers<T extends Pick<BetView, 'id' | 'status' | 'cashOutOffer'>>(
  bets: T[],
  offers: readonly CashOutOfferView[],
): T[] {
  if (offers.length === 0) return bets;
  const byBet = new Map(offers.map((offer) => [offer.betId, offer]));
  let changed = false;
  const next = bets.map((bet) => {
    const offer = byBet.get(bet.id);
    if (offer === undefined || bet.status !== 'open') return bet;
    const current = bet.cashOutOffer;
    if (
      current !== null &&
      current.available === offer.available &&
      current.reason === offer.reason &&
      sameOffer(current, offer) &&
      current.potentialReturn === offer.potentialReturn
    ) {
      return bet;
    }
    changed = true;
    return { ...bet, cashOutOffer: offer };
  });
  return changed ? next : bets;
}
