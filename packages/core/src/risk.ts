import { type Santim, SANTIM_PER_BIRR } from './money';

/**
 * House liability caps (rule L1 of docs/therundown-plan/README.md): the most the house is
 * willing to owe if one outcome, or every open bet on one match, wins.
 *
 * Liability here is what the Risk page already shows: the sum of the potential gross payouts of
 * the open bets with an open leg on the selection (or the match). A multiple counts its whole
 * potential payout on each of its selections, so the figure is an upper bound. A match's
 * liability counts each bet once, however many of its legs are on that match, and adds up every
 * market, which over-states what one result can cost: a deliberately cautious figure.
 *
 * Pure: no I/O. Money is bigint santim.
 */
export interface RiskLimits {
  /** Largest liability on one selection; null = no cap. */
  maxSelectionLiability: Santim | null;
  /** Largest liability on one match; null = no cap. */
  maxEventLiability: Santim | null;
}

/** No caps: the demo's behaviour. Staff set the caps in the back office (settings `risk_limits`). */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxSelectionLiability: null,
  maxEventLiability: null,
};

/** True when at least one cap is set (otherwise placing a bet needs no exposure check). */
export function hasRiskLimits(limits: RiskLimits): boolean {
  return limits.maxSelectionLiability !== null || limits.maxEventLiability !== null;
}

export type LiabilityScope = 'selection' | 'event';

/** The open liability of one selection or match, before the new bet. */
export interface LiabilityExposure {
  id: string;
  current: Santim;
}

export interface LiabilityBreach {
  scope: LiabilityScope;
  id: string;
  cap: Santim;
  current: Santim;
  /** cap − current, never below 0: what is left for a new bet's payout. */
  headroom: Santim;
}

/**
 * The scope with the least room left when the new bet's `payout` does not fit in it, else null.
 * A payout fits when `current + payout <= cap` for every scope it touches. Ties go to a
 * selection, then to the lower id, so the answer does not depend on the order of the input.
 * A cap already exceeded (for instance one lowered after bets were taken) has no room at all.
 */
export function liabilityBreach(input: {
  payout: Santim;
  selections: readonly LiabilityExposure[];
  events: readonly LiabilityExposure[];
  limits: RiskLimits;
}): LiabilityBreach | null {
  const { payout, selections, events, limits } = input;
  if (payout < 0n) throw new RangeError(`payout must not be negative (got ${payout})`);
  let tightest: LiabilityBreach | null = null;
  const consider = (
    scope: LiabilityScope,
    exposures: readonly LiabilityExposure[],
    cap: Santim | null,
  ): void => {
    if (cap === null) return;
    for (const { id, current } of exposures) {
      if (current + payout <= cap) continue;
      const headroom = cap > current ? cap - current : 0n;
      const candidate: LiabilityBreach = { scope, id, cap, current, headroom };
      if (tightest === null || isTighter(candidate, tightest)) tightest = candidate;
    }
  };
  consider('selection', selections, limits.maxSelectionLiability);
  consider('event', events, limits.maxEventLiability);
  return tightest;
}

function isTighter(a: LiabilityBreach, b: LiabilityBreach): boolean {
  if (a.headroom !== b.headroom) return a.headroom < b.headroom;
  if (a.scope !== b.scope) return a.scope === 'selection';
  return a.id < b.id;
}

/**
 * The largest stake in [minStake, maxStake] whose payout is at most `headroom`, or null when
 * even the minimum stake pays too much. `payoutOf` must not decrease as the stake grows (true of
 * quoteBet: the payout is the stake times fixed odds, rounded down, plus a bonus, capped).
 * The answer is rounded down to whole birr when that still reaches `minStake`, so a player is
 * offered "up to 40 ETB" rather than "39.87 ETB".
 */
export function largestStakeWithin(input: {
  headroom: Santim;
  minStake: Santim;
  maxStake: Santim;
  payoutOf: (stake: Santim) => Santim;
}): Santim | null {
  const { headroom, minStake, maxStake, payoutOf } = input;
  if (minStake > maxStake || payoutOf(minStake) > headroom) return null;
  let low = minStake; // always fits
  let high = maxStake;
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    if (payoutOf(mid) <= headroom) low = mid;
    else high = mid - 1n;
  }
  const whole = (low / SANTIM_PER_BIRR) * SANTIM_PER_BIRR;
  return whole >= minStake ? whole : low;
}
