import type { Santim } from './money';
import type { JackpotCancelledRule, JackpotPrizeTier, JackpotTemplate, TaxConfig } from './rules';
import { computeWinningsTax } from './tax';

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
  template: Pick<JackpotTemplate, 'gameCount' | 'maxCombinations' | 'costPerCombination'>,
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

/**
 * Whether a draw is void, so that every entry is refunded instead of
 * settled: more than half of its games are cancelled (2 × cancelled >
 * games). This holds under every cancelled rule: with `all_win` a cancelled
 * game counts every pick as correct, so a draw that is mostly cancelled
 * would no longer test any prediction. Throws on an unknown rule.
 */
export function isJackpotDrawVoid(
  results: readonly JackpotGameResult[],
  rule: JackpotCancelledRule,
): boolean {
  switch (rule) {
    case 'all_win': {
      const cancelled = results.filter((result) => result === 'cancelled').length;
      return 2 * cancelled > results.length;
    }
    default: {
      const unknown: never = rule;
      throw new RangeError(`unknown jackpot cancelled rule: ${String(unknown)}`);
    }
  }
}

/**
 * Whether one game's picks hit its result: null while the game has no
 * result; under `all_win` a cancelled game is a hit for any pick.
 */
export function jackpotPickHit(
  gamePicks: readonly Outcome1X2[],
  result: JackpotGameResult | null,
  rule: JackpotCancelledRule,
): boolean | null {
  if (result === null) return null;
  if (result === 'cancelled') return cancelledMatches(gamePicks, rule) > 0;
  return gamePicks.includes(result);
}

/** The most correct predictions any combination of the entry has (the highest non-empty bucket). */
export function bestCorrect(distribution: readonly bigint[]): number {
  for (let k = distribution.length - 1; k > 0; k -= 1) {
    if ((distribution[k] ?? 0n) > 0n) return k;
  }
  return 0;
}

/** One entry of a draw, as settleJackpotDraw takes it. */
export interface JackpotDrawEntry {
  picks: JackpotPicks;
  /** What the entry cost (its stake): positive. Tax applies to the prize above it. */
  cost: Santim;
}

/** How one entry of a draw ends (settleJackpotDraw). */
export interface JackpotEntrySettlement {
  /** won: a prize above zero; lost: none; void: the draw is void and the cost is refunded. */
  status: 'won' | 'lost' | 'void';
  /** Combinations by exact number of correct predictions (null when the draw is void). */
  distribution: bigint[] | null;
  /** The most correct predictions of any combination (null when void). */
  bestCorrect: number | null;
  /** The prize before tax: Σ over tiers of its combinations at that tier × the prize per combination. */
  gross: Santim;
  /** Winnings tax on the prize (computeWinningsTax with the entry's cost as the stake). */
  tax: Santim;
  /** gross − tax: what the player is paid. */
  net: Santim;
  /** The cost given back when the draw is void, else 0. */
  refund: Santim;
}

export interface JackpotDrawTotals {
  /** Σ cost of the entries. */
  stakes: Santim;
  gross: Santim;
  tax: Santim;
  net: Santim;
  refunds: Santim;
  /** Entries with a prize above zero. */
  winners: number;
  /** Shared-pool money nobody won (or lost to rounding): it stays with the house. */
  undistributed: Santim;
}

export interface JackpotDrawSettlement {
  void: boolean;
  /** Games whose result is `cancelled`. */
  cancelledGames: number;
  /** The prize of every tier, in tier order (computeTierPayouts); empty when the draw is void. */
  payouts: TierPayout[];
  /** One per entry, in the order given. */
  entries: JackpotEntrySettlement[];
  totals: JackpotDrawTotals;
}

/**
 * Settles every entry of a draw once all of its games have a result.
 *
 * - Void draw (isJackpotDrawVoid): every entry is refunded its cost; no
 *   prize is paid and nothing is taxed.
 * - Otherwise each entry's correct distribution (correctDistribution with
 *   the draw's cancelled rule) is added up over all entries into the
 *   winning combinations per tier (jackpotTierWinners); computeTierPayouts
 *   gives the prize per winning combination (shared pools split equally
 *   and rounded down, fixed prizes per combination) and entryPrize the
 *   entry's gross prize. The winnings tax is that of a bet: computeWinningsTax
 *   with the entry's cost as the stake, so only the prize above the cost is
 *   winnings (with the configured base and exemption) and a prize never
 *   pays back less than min(prize, cost).
 *
 * Throws RangeError when an entry's picks do not cover every game, a cost is
 * not positive, or the tiers or results are invalid.
 */
export function settleJackpotDraw(input: {
  entries: readonly JackpotDrawEntry[];
  results: readonly JackpotGameResult[];
  cancelledRule: JackpotCancelledRule;
  prizeTiers: readonly JackpotPrizeTier[];
  tax: TaxConfig;
}): JackpotDrawSettlement {
  const { entries, results, cancelledRule, prizeTiers, tax } = input;
  for (const entry of entries) {
    if (typeof entry.cost !== 'bigint' || entry.cost <= 0n) {
      throw new RangeError(`a jackpot entry cost must be positive (got ${String(entry.cost)})`);
    }
  }
  const cancelledGames = results.filter((result) => result === 'cancelled').length;
  const stakes = entries.reduce((sum, entry) => sum + entry.cost, 0n);

  if (isJackpotDrawVoid(results, cancelledRule)) {
    // Still check that every entry matches the games (a bug otherwise).
    for (const entry of entries) {
      if (entry.picks.length !== results.length) {
        throw new RangeError(
          `expected ${results.length} jackpot picks but got ${entry.picks.length}`,
        );
      }
    }
    return {
      void: true,
      cancelledGames,
      payouts: [],
      entries: entries.map(
        (entry): JackpotEntrySettlement => ({
          status: 'void',
          distribution: null,
          bestCorrect: null,
          gross: 0n,
          tax: 0n,
          net: 0n,
          refund: entry.cost,
        }),
      ),
      totals: {
        stakes,
        gross: 0n,
        tax: 0n,
        net: 0n,
        refunds: stakes,
        winners: 0,
        undistributed: 0n,
      },
    };
  }

  const distributions = entries.map((entry) =>
    correctDistribution(entry.picks, results, cancelledRule),
  );
  const payouts = computeTierPayouts(prizeTiers, jackpotTierWinners(distributions));
  const settled = entries.map((entry, i): JackpotEntrySettlement => {
    const distribution = distributions[i] ?? [];
    const gross = entryPrize(distribution, payouts);
    const { amount } = computeWinningsTax({ stake: entry.cost, grossPayout: gross, config: tax });
    return {
      status: gross > 0n ? 'won' : 'lost',
      distribution,
      bestCorrect: bestCorrect(distribution),
      gross,
      tax: amount,
      net: gross - amount,
      refund: 0n,
    };
  });
  const sum = (pick: (entry: JackpotEntrySettlement) => Santim) =>
    settled.reduce((total, entry) => total + pick(entry), 0n);
  return {
    void: false,
    cancelledGames,
    payouts,
    entries: settled,
    totals: {
      stakes,
      gross: sum((entry) => entry.gross),
      tax: sum((entry) => entry.tax),
      net: sum((entry) => entry.net),
      refunds: 0n,
      winners: settled.filter((entry) => entry.status === 'won').length,
      undistributed: payouts.reduce((total, payout) => total + payout.undistributed, 0n),
    },
  };
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
