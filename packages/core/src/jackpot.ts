import type { Santim } from './money';
import type { JackpotCancelledRule, JackpotPrizeTier, JackpotTemplate } from './rules';

/**
 * Betika-style 1X2 jackpots (daily 9-game, weekly 13-game). A player may pick
 * one, two or all three outcomes per game; the entry is then the full
 * "combination" system of every way to choose one pick per game, and each
 * combination costs `costPerCombination`.
 *
 * Prize tiers are not cumulative: a combination wins only the tier whose
 * `correct` equals its exact number of correct predictions.
 */

export type Outcome1X2 = '1' | 'X' | '2';

export type JackpotGameResult = Outcome1X2 | 'cancelled';

/** One array of picked outcomes per game, in game order. */
export type JackpotPicks = readonly (readonly Outcome1X2[])[];

export interface JackpotEntryCheck {
  ok: boolean;
  errors: string[];
  combinations: number;
  cost: Santim;
}

export interface TierWinners {
  correct: number;
  combinations: bigint;
}

export interface TierPayout {
  correct: number;
  kind: 'shared' | 'fixed';
  winningCombinations: bigint;
  prizePerCombination: Santim;
  total: Santim;
  undistributed: Santim;
}

const OUTCOMES: ReadonlySet<string> = new Set<Outcome1X2>(['1', 'X', '2']);
const MAX_PICKS_PER_GAME = 3;

/**
 * Number of combinations of an entry: the product of the pick counts of every
 * game (0 if any game has no pick; 1 for an empty list, the empty product).
 * Throws a RangeError if the count does not fit a safe integer.
 */
export function combinationCount(picks: JackpotPicks): number {
  const count = countCombinations(picks);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`too many jackpot combinations: ${count}`);
  }
  return Number(count);
}

/**
 * Validates an entry against a jackpot template, collecting every problem as
 * a plain English message. `cost` is combinations × costPerCombination; it is
 * 0n when the number of games is wrong (or the count is absurdly large).
 */
export function validateJackpotEntry(
  picks: JackpotPicks,
  template: JackpotTemplate,
): JackpotEntryCheck {
  const errors: string[] = [];
  const countOk = picks.length === template.gameCount;
  if (!countOk) {
    errors.push(`Expected picks for ${template.gameCount} games but got ${picks.length}.`);
  }

  picks.forEach((gamePicks, index) => {
    const game = `Game ${index + 1}`;
    if (gamePicks.length === 0) {
      errors.push(`${game}: pick at least one outcome.`);
    } else if (gamePicks.length > MAX_PICKS_PER_GAME) {
      errors.push(`${game}: at most ${MAX_PICKS_PER_GAME} picks are allowed.`);
    }
    // A Set so a pick repeated several times is reported once.
    const pickErrors = new Set<string>();
    const seen = new Set<string>();
    for (const pick of gamePicks) {
      if (!OUTCOMES.has(pick)) {
        pickErrors.add(`${game}: "${String(pick)}" is not a valid pick (use 1, X or 2).`);
      } else if (seen.has(pick)) {
        pickErrors.add(`${game}: "${pick}" is picked more than once.`);
      }
      seen.add(pick);
    }
    errors.push(...pickErrors);
  });

  const exact = countCombinations(picks);
  const safe = exact <= BigInt(Number.MAX_SAFE_INTEGER);
  const combinations = safe ? Number(exact) : Number.MAX_SAFE_INTEGER;
  if (exact > BigInt(template.maxCombinations)) {
    errors.push(`Too many combinations: ${exact} (the maximum is ${template.maxCombinations}).`);
  }

  const cost = countOk && safe ? BigInt(combinations) * template.costPerCombination : 0n;
  return { ok: errors.length === 0, errors, combinations, cost };
}

/**
 * Distribution of correct predictions over an entry's combinations: index k
 * is the number of combinations with exactly k correct predictions (length
 * picks.length + 1). Computed as the product of per-game generating functions
 * (non-matching + matching·x), so it never enumerates the combinations.
 *
 * Under the `all_win` rule a cancelled game counts every pick as correct.
 */
export function correctDistribution(
  picks: JackpotPicks,
  results: readonly JackpotGameResult[],
  rule: JackpotCancelledRule,
): bigint[] {
  if (results.length !== picks.length) {
    throw new RangeError(`expected ${picks.length} jackpot results but got ${results.length}`);
  }
  // dist[k] = combinations of the games processed so far with exactly k correct.
  let dist: bigint[] = [1n];
  picks.forEach((gamePicks, index) => {
    const result = results[index];
    let matching: number;
    if (result === 'cancelled') {
      matching = cancelledMatches(gamePicks, rule);
    } else if (result !== undefined && OUTCOMES.has(result)) {
      matching = gamePicks.filter((pick) => pick === result).length;
    } else {
      throw new RangeError(`invalid jackpot result for game ${index + 1}: ${String(result)}`);
    }
    const hit = BigInt(matching);
    const miss = BigInt(gamePicks.length - matching);
    const next: bigint[] = new Array<bigint>(dist.length + 1).fill(0n);
    dist.forEach((ways, k) => {
      next[k] = (next[k] ?? 0n) + ways * miss;
      next[k + 1] = (next[k + 1] ?? 0n) + ways * hit;
    });
    dist = next;
  });
  return dist;
}

/**
 * Adds up the correct distributions of all entries in a draw into winning
 * combinations per exact correct count (index k of every distribution),
 * ready for `computeTierPayouts`. Counts with no combinations are omitted.
 */
export function jackpotTierWinners(distributions: readonly (readonly bigint[])[]): TierWinners[] {
  const totals: bigint[] = [];
  for (const distribution of distributions) {
    distribution.forEach((ways, k) => {
      if (ways < 0n) throw new RangeError(`combination count must not be negative (got ${ways})`);
      totals[k] = (totals[k] ?? 0n) + ways;
    });
  }
  const winners: TierWinners[] = [];
  totals.forEach((combinations, correct) => {
    if (combinations > 0n) winners.push({ correct, combinations });
  });
  return winners;
}

/**
 * Prize per winning combination for every tier, in tier order. `winners` holds
 * the number of winning combinations per exact correct count across all
 * entries (a missing count means 0; repeated counts are summed).
 *
 * - shared: the pool is split equally and rounded down; the remainder (or the
 *   whole pool when nobody wins) is reported as `undistributed`.
 * - fixed: every winning combination receives `amount`.
 */
export function computeTierPayouts(
  tiers: readonly JackpotPrizeTier[],
  winners: readonly TierWinners[],
): TierPayout[] {
  const seen = new Set<number>();
  for (const tier of tiers) {
    if (seen.has(tier.correct)) {
      throw new RangeError(`duplicate jackpot prize tier for ${tier.correct} correct`);
    }
    seen.add(tier.correct);
    if (tier.amount < 0n) {
      throw new RangeError(`jackpot prize amount must not be negative (got ${tier.amount})`);
    }
  }
  for (const w of winners) {
    if (w.combinations < 0n) {
      throw new RangeError(`winning combinations must not be negative (got ${w.combinations})`);
    }
  }

  return tiers.map((tier): TierPayout => {
    const winningCombinations = winners
      .filter((w) => w.correct === tier.correct)
      .reduce((sum, w) => sum + w.combinations, 0n);
    if (tier.kind === 'fixed') {
      return {
        correct: tier.correct,
        kind: 'fixed',
        winningCombinations,
        prizePerCombination: tier.amount,
        total: tier.amount * winningCombinations,
        undistributed: 0n,
      };
    }
    // Both operands are non-negative, so bigint division already rounds down.
    const prizePerCombination = winningCombinations > 0n ? tier.amount / winningCombinations : 0n;
    const total = prizePerCombination * winningCombinations;
    return {
      correct: tier.correct,
      kind: 'shared',
      winningCombinations,
      prizePerCombination,
      total,
      undistributed: tier.amount - total,
    };
  });
}

/**
 * Total prize of one entry: Σ over tiers of (combinations of the entry with
 * exactly `tier.correct` correct) × prize per combination.
 */
export function entryPrize(
  distribution: readonly bigint[],
  payouts: readonly TierPayout[],
): Santim {
  let prize = 0n;
  for (const payout of payouts) {
    prize += (distribution[payout.correct] ?? 0n) * payout.prizePerCombination;
  }
  return prize;
}

function countCombinations(picks: JackpotPicks): bigint {
  let count = 1n;
  for (const gamePicks of picks) count *= BigInt(gamePicks.length);
  return count;
}

function cancelledMatches(gamePicks: readonly Outcome1X2[], rule: JackpotCancelledRule): number {
  switch (rule) {
    case 'all_win':
      return gamePicks.length;
    default: {
      const unknown: never = rule;
      throw new RangeError(`unknown jackpot cancelled rule: ${String(unknown)}`);
    }
  }
}
