import { BPS_DENOMINATOR, type Santim, floorDiv, minSantim } from './money';
import { ODDS_SCALE, type OddsMilli, VOID_ODDS_MILLI, grossReturn, isValidOddsMilli } from './odds';
import type { CashOutConfig } from './rules';

/**
 * Betika-style cash-out: the house offers to settle a still-running bet early
 * for its fair value (potential return discounted by the live odds of the legs
 * that are still open) minus a margin.
 *
 * The multi (accumulator) bonus is deliberately NOT part of the cash-out value:
 * the bonus is only earned by a bet that is settled as won, so a cashed-out
 * bet forfeits it. `potentialReturn` is likewise the return before any bonus.
 */

export interface CashOutLeg {
  /** Odds the leg was accepted at. Ignored for void legs (they count as 1.000). */
  placedOddsMilli: OddsMilli;
  state: 'open' | 'won' | 'lost' | 'void';
  /**
   * Current live odds of the selection. `null` means the market is suspended
   * or unavailable. Only relevant for open legs.
   */
  currentOddsMilli: OddsMilli | null;
}

export type CashOutUnavailableReason =
  'disabled' | 'no_legs' | 'leg_lost' | 'leg_suspended' | 'all_legs_settled' | 'below_minimum';

export interface CashOutOffer {
  available: boolean;
  /** Offered amount in santim; always 0n when the offer is unavailable. */
  amount: Santim;
  reason?: CashOutUnavailableReason;
  /** min(maxPayout, stake × Π effective placed odds), before any bonus. 0n for a lost bet. */
  potentialReturn: Santim;
}

const LEG_STATES: ReadonlySet<string> = new Set(['open', 'won', 'lost', 'void']);

/**
 * Computes the cash-out offer for a bet.
 *
 * Checks, in order: cash-out disabled → `disabled`; no legs → `no_legs`; any
 * lost leg → `leg_lost`; any open leg without valid live odds → `leg_suspended`;
 * no open legs left → `all_legs_settled` (the bet awaits normal settlement).
 *
 * Fair value = stake × Π effective placed odds × Π_open (1 / current odds),
 * where void legs count as 1.000 and won legs keep their placed odds. The offer
 * is floor(fair × (10 000 − marginBps) / 10 000), computed exactly as one
 * bigint fraction and rounded down once, then capped at `potentialReturn`.
 * Offers below `config.minOffer` are unavailable (`below_minimum`).
 */
export function cashOutOffer(input: {
  stake: Santim;
  legs: readonly CashOutLeg[];
  config: CashOutConfig;
  maxPayout: Santim;
}): CashOutOffer {
  const { stake, legs, config, maxPayout } = input;
  if (stake < 0n) throw new RangeError(`stake must not be negative (got ${stake})`);
  if (maxPayout < 0n) throw new RangeError(`maxPayout must not be negative (got ${maxPayout})`);
  const { marginBps } = config;
  if (!Number.isSafeInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new RangeError(`marginBps must be an integer in 0..10000 (got ${marginBps})`);
  }
  for (const leg of legs) {
    if (!LEG_STATES.has(leg.state)) throw new RangeError(`invalid leg state: ${String(leg.state)}`);
    if (leg.state !== 'void' && !isValidOddsMilli(leg.placedOddsMilli)) {
      throw new RangeError(`invalid placed odds (milli): ${leg.placedOddsMilli}`);
    }
  }

  const anyLost = legs.some((leg) => leg.state === 'lost');
  const potentialReturn =
    legs.length === 0 || anyLost
      ? 0n
      : minSantim(maxPayout, grossReturn(stake, legs.map(effectivePlacedOdds)));
  const unavailable = (reason: CashOutUnavailableReason): CashOutOffer => ({
    available: false,
    amount: 0n,
    reason,
    potentialReturn,
  });

  if (!config.enabled) return unavailable('disabled');
  if (legs.length === 0) return unavailable('no_legs');
  if (anyLost) return unavailable('leg_lost');
  const openLegs = legs.filter((leg) => leg.state === 'open');
  if (openLegs.some((leg) => !hasLiveOdds(leg))) return unavailable('leg_suspended');
  if (openLegs.length === 0) return unavailable('all_legs_settled');

  // numerator   = stake × Π(non-void placed) × 1000^open × (10000 − margin)
  // denominator = 1000^nonVoid × Π(open current) × 10000
  // The 1000 factors of open legs cancel exactly (floor(a·k / b·k) = floor(a / b)),
  // so an open leg contributes placed / current and a won leg placed / 1000.
  let numerator = stake * (BPS_DENOMINATOR - BigInt(marginBps));
  let denominator = BPS_DENOMINATOR;
  for (const leg of legs) {
    if (leg.state === 'void') continue;
    numerator *= BigInt(leg.placedOddsMilli);
    // Open legs were checked above to have valid live odds; `?? 0` is unreachable.
    denominator *= leg.state === 'open' ? BigInt(leg.currentOddsMilli ?? 0) : ODDS_SCALE;
  }
  const offer = floorDiv(numerator, denominator);
  const amount = minSantim(offer, potentialReturn);
  if (amount < config.minOffer) return unavailable('below_minimum');
  return { available: true, amount, potentialReturn };
}

function effectivePlacedOdds(leg: CashOutLeg): OddsMilli {
  return leg.state === 'void' ? VOID_ODDS_MILLI : leg.placedOddsMilli;
}

function hasLiveOdds(leg: CashOutLeg): boolean {
  return leg.currentOddsMilli !== null && isValidOddsMilli(leg.currentOddsMilli);
}
