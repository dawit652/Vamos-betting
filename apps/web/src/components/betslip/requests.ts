import type {
  BookingCodeResponse,
  CreateBookingCodeRequest,
  EventDetail,
  OddsChangePolicy,
  PlaceBetRequest,
  QuoteRequest,
  QuoteResponse,
  SlipErrorView,
  UnavailableReason,
} from '@vamos/contracts';
import { parseBirr } from '@vamos/core';
import type { MessageKey } from '@vamos/i18n/translate';
import { eventRef, slipLeg } from '@/components/sportsbook/events';
import type { NewSlipLeg, SlipLeg } from '@/lib/betslip/state';

/**
 * Pure betslip helpers for the drawer: slip → API request mapping, stake
 * input parsing, and reading the API's quote / error details. Money stays a
 * santim string or bigint throughout; never a float.
 */

/** Quick stakes in santim: 10, 50, 100 and 500 ETB. */
export const QUICK_STAKES = ['1000', '5000', '10000', '50000'] as const;

/** A positive santim string ("1000") from what the player typed ("10", "12.50"); null otherwise. */
export function stakeFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    const santim = parseBirr(trimmed);
    return santim > 0n ? santim.toString() : null;
  } catch {
    return null;
  }
}

/** The stake input's text for a santim string: "10" for 1000, "12.5" for 1250, "0.05" for 5. */
export function stakeToInput(santim: string): string {
  if (!/^\d+$/.test(santim)) return '';
  const value = BigInt(santim);
  const whole = (value / 100n).toString();
  const cents = value % 100n;
  if (cents === 0n) return whole;
  const fraction = cents.toString().padStart(2, '0').replace(/0$/, '');
  return `${whole}.${fraction}`;
}

function isPositiveSantim(stake: string): boolean {
  return /^\d+$/.test(stake) && /[1-9]/.test(stake);
}

/** POST /betslip/quote body, or null when there is nothing to quote (no legs or no stake). */
export function quoteRequest(legs: readonly SlipLeg[], stake: string): QuoteRequest | null {
  if (legs.length === 0 || !isPositiveSantim(stake)) return null;
  return {
    legs: legs.map((leg) => ({ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli })),
    stake,
  };
}

/** POST /bets body: the prices on the slip, the stake and the odds-change policy. */
export function placeBetRequest(
  legs: readonly SlipLeg[],
  stake: string,
  oddsChangePolicy: OddsChangePolicy,
): PlaceBetRequest {
  return {
    legs: legs.map((leg) => ({ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli })),
    stake,
    oddsChangePolicy,
  };
}

/** POST /booking-codes body. */
export function bookingCodeRequest(legs: readonly SlipLeg[]): CreateBookingCodeRequest {
  return { legs: legs.map((leg) => ({ selectionId: leg.selectionId })) };
}

/** Legs whose current price differs from the slip's, from a quote. */
export function quoteOddsChanges(
  quote: Pick<QuoteResponse, 'legs'>,
): { selectionId: string; oddsMilli: number }[] {
  return quote.legs.flatMap((leg) =>
    leg.available && leg.oddsChanged && leg.oddsMilli !== null
      ? [{ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli }]
      : [],
  );
}

/** Unavailable legs of a quote, by selection id. */
export function quoteUnavailable(
  quote: Pick<QuoteResponse, 'legs'>,
): Map<string, UnavailableReason> {
  const unavailable = new Map<string, UnavailableReason>();
  for (const leg of quote.legs) {
    if (!leg.available) unavailable.set(leg.selectionId, leg.reason ?? 'not_found');
  }
  return unavailable;
}

function records(value: unknown, key: string): Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return [];
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      )
    : [];
}

const UNAVAILABLE_REASONS: readonly string[] = [
  'not_found',
  'inactive',
  'event_started',
  'event_closed',
  'suspended',
  'market_closed',
];

/** 409 `odds_changed` details → the new prices. */
export function oddsChangesFromDetails(
  details: unknown,
): { selectionId: string; oddsMilli: number }[] {
  return records(details, 'changes').flatMap((change) =>
    typeof change.selectionId === 'string' &&
    typeof change.currentOddsMilli === 'number' &&
    Number.isInteger(change.currentOddsMilli)
      ? [{ selectionId: change.selectionId, oddsMilli: change.currentOddsMilli }]
      : [],
  );
}

/** 409 `selection_unavailable` details → the unavailable selections. */
export function unavailableFromDetails(details: unknown): Map<string, UnavailableReason> {
  const unavailable = new Map<string, UnavailableReason>();
  for (const item of records(details, 'selections')) {
    if (typeof item.selectionId !== 'string') continue;
    const reason =
      typeof item.reason === 'string' && UNAVAILABLE_REASONS.includes(item.reason)
        ? (item.reason as UnavailableReason)
        : 'not_found';
    unavailable.set(item.selectionId, reason);
  }
  return unavailable;
}

/** 422 `slip_invalid` details → the slip errors. */
export function slipErrorsFromDetails(details: unknown): Pick<SlipErrorView, 'code'>[] {
  return records(details, 'errors').flatMap((error) =>
    typeof error.code === 'string' ? [{ code: error.code }] : [],
  );
}

const SLIP_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  duplicate_event: 'sportsbook.betslip.errors.duplicateEvent',
  duplicate_selection: 'sportsbook.betslip.errors.duplicateEvent',
  too_many_legs: 'sportsbook.betslip.errors.tooManyLegs',
  no_selections: 'sportsbook.betslip.empty',
  invalid_odds: 'sportsbook.betslip.errors.oddsChanged',
  odds_below_minimum: 'sportsbook.betslip.errors.oddsBelowMinimum',
  invalid_stake: 'sportsbook.betslip.errors.invalidStake',
  stake_below_minimum: 'sportsbook.betslip.errors.stakeBelowMinimum',
  stake_above_maximum: 'sportsbook.betslip.errors.stakeAboveMaximum',
  total_odds_above_maximum: 'sportsbook.betslip.errors.totalOddsAboveMaximum',
};

/** The message for a slip validation error code (quote `errors[]` or 422 `slip_invalid`). */
export function slipErrorKey(code: string): MessageKey {
  return SLIP_ERROR_KEYS[code] ?? 'sportsbook.betslip.errors.invalid';
}

/** Placement error codes the drawer explains itself (for errorMessageKey). */
export const PLACE_BET_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  odds_changed: 'sportsbook.betslip.errors.oddsChanged',
  selection_unavailable: 'sportsbook.betslip.errors.unavailable',
  slip_invalid: 'sportsbook.betslip.errors.invalid',
  insufficient_funds: 'sportsbook.betslip.insufficientFunds',
  stake_limit_exceeded: 'sportsbook.betslip.errors.stakeLimit',
  loss_limit_exceeded: 'sportsbook.betslip.errors.lossLimit',
  self_excluded: 'sportsbook.betslip.errors.excluded',
  cooling_off: 'sportsbook.betslip.errors.excluded',
  account_disabled: 'sportsbook.betslip.errors.excluded',
};

export const BOOKING_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  booking_code_not_found: 'sportsbook.betslip.booking.notFound',
  booking_code_expired: 'sportsbook.betslip.booking.expired',
  not_found: 'sportsbook.betslip.booking.notFound',
};

/** "3", "12.5": a bonus in basis points as a percentage, without floats. */
export function bonusPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps <= 0) return '0';
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? `${whole}` : `${whole}.${rest.toString().padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * Turns a loaded booking code into slip legs, using the event pages for team
 * names and start times. Legs that are unavailable, or whose event or
 * selection is gone, are skipped and counted.
 */
export function legsFromBooking(
  booking: Pick<BookingCodeResponse, 'legs'>,
  events: ReadonlyMap<string, EventDetail>,
): { legs: NewSlipLeg[]; skipped: number } {
  const legs: NewSlipLeg[] = [];
  let skipped = 0;
  for (const leg of booking.legs) {
    const event = leg.eventId === null ? undefined : events.get(leg.eventId);
    let added = false;
    if (leg.available && leg.oddsMilli !== null && event !== undefined) {
      for (const market of event.markets) {
        const selection = market.selections.find((s) => s.id === leg.selectionId);
        if (selection === undefined) continue;
        legs.push(slipLeg(eventRef(event), market, selection, leg.oddsMilli));
        added = true;
        break;
      }
    }
    if (!added) skipped += 1;
  }
  return { legs, skipped };
}

/** True when the policy will take every price change on the slip (so no confirmation is needed). */
export function policyCoversChanges(policy: OddsChangePolicy, legs: readonly SlipLeg[]): boolean {
  const changed = legs.filter((leg) => leg.previousOddsMilli !== null);
  if (changed.length === 0) return true;
  if (policy === 'any') return true;
  if (policy === 'none') return false;
  return changed.every((leg) => leg.oddsMilli > (leg.previousOddsMilli ?? 0));
}
