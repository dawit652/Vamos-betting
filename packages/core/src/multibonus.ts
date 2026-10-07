import { type Santim, applyBps, maxSantim, minSantim } from './money';
import type { OddsMilli } from './odds';
import type { MultiBonusConfig, MultiBonusTier } from './rules';

/**
 * Accumulator ("multi") bonus: a percentage of the WINNINGS (gross return −
 * stake) paid on top of a winning multi bet. The percentage is chosen from a
 * ladder of tiers by the number of qualifying legs (legs whose odds are at
 * least `config.minLegOddsMilli`). The bonus is never applied to the stake.
 */

export interface MultiBonusResult {
  /** Bonus rate applied to the winnings, in basis points (0 when none). */
  percentBps: number;
  /** Number of legs whose odds reach `config.minLegOddsMilli`. */
  qualifyingLegs: number;
  /** Bonus in santim, rounded down and capped at `config.maxBonus`. */
  amount: Santim;
}

/** Number of legs whose odds are at least `config.minLegOddsMilli`. */
export function qualifyingLegCount(
  legOdds: readonly OddsMilli[],
  config: MultiBonusConfig,
): number {
  let count = 0;
  for (const odds of legOdds) {
    if (odds >= config.minLegOddsMilli) count += 1;
  }
  return count;
}

/**
 * Bonus rate (bps) for a number of qualifying legs: the `percentBps` of the
 * highest tier whose `minLegs` is reached, or 0 when the bonus is disabled or
 * the lowest tier is not reached. Tiers do not need to be sorted and the
 * config is never mutated. Throws `RangeError` on a malformed tier.
 */
export function multiBonusPercentBps(qualifyingLegs: number, config: MultiBonusConfig): number {
  if (!config.enabled) return 0;
  let best: MultiBonusTier | undefined;
  for (const tier of config.tiers) {
    assertValidTier(tier);
    if (tier.minLegs > qualifyingLegs) continue;
    if (
      best === undefined ||
      tier.minLegs > best.minLegs ||
      (tier.minLegs === best.minLegs && tier.percentBps > best.percentBps)
    ) {
      best = tier;
    }
  }
  return best?.percentBps ?? 0;
}

/**
 * Multi bonus for a bet. Singles (fewer than two legs) never get a bonus.
 * amount = min(floor(max(0, grossReturn − stake) × percentBps / 10 000), maxBonus).
 */
export function computeMultiBonus(args: {
  stake: Santim;
  grossReturn: Santim;
  legOdds: readonly OddsMilli[];
  config: MultiBonusConfig;
}): MultiBonusResult {
  const { stake, grossReturn, legOdds, config } = args;
  const qualifyingLegs = qualifyingLegCount(legOdds, config);
  if (legOdds.length < 2) return { percentBps: 0, qualifyingLegs, amount: 0n };

  const percentBps = multiBonusPercentBps(qualifyingLegs, config);
  if (percentBps === 0) return { percentBps: 0, qualifyingLegs, amount: 0n };
  if (config.maxBonus < 0n) {
    throw new RangeError(`multi bonus maxBonus must not be negative (got ${config.maxBonus})`);
  }

  const winnings = maxSantim(0n, grossReturn - stake);
  const amount = minSantim(applyBps(winnings, percentBps), config.maxBonus);
  return { percentBps, qualifyingLegs, amount };
}

function assertValidTier(tier: MultiBonusTier): void {
  if (!Number.isSafeInteger(tier.minLegs) || tier.minLegs < 0) {
    throw new RangeError(
      `multi bonus tier minLegs must be a non-negative integer (got ${tier.minLegs})`,
    );
  }
  if (!Number.isSafeInteger(tier.percentBps) || tier.percentBps < 0) {
    throw new RangeError(
      `multi bonus tier percentBps must be a non-negative integer (got ${tier.percentBps})`,
    );
  }
}
