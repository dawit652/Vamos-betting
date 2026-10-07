import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type JackpotGameResult,
  type JackpotPicks,
  type Outcome1X2,
  type TierPayout,
  combinationCount,
  computeTierPayouts,
  correctDistribution,
  entryPrize,
  jackpotTierWinners,
  validateJackpotEntry,
} from './jackpot';
import { birr } from './money';
import { DEFAULT_JACKPOTS, type JackpotCancelledRule, type JackpotPrizeTier } from './rules';

const DAILY = DEFAULT_JACKPOTS.daily9;
const WEEKLY = DEFAULT_JACKPOTS.weekly13;
const ALL_WIN: JackpotCancelledRule = 'all_win';

const singles = (n: number, pick: Outcome1X2 = '1'): Outcome1X2[][] =>
  Array.from({ length: n }, () => [pick]);

/** Brute force: enumerate every combination and count its correct predictions. */
function bruteForceDistribution(
  picks: JackpotPicks,
  results: readonly JackpotGameResult[],
): bigint[] {
  const dist: bigint[] = new Array<bigint>(picks.length + 1).fill(0n);
  const walk = (game: number, correct: number): void => {
    if (game === picks.length) {
      dist[correct] = dist[correct]! + 1n;
      return;
    }
    for (const pick of picks[game]!) {
      const result = results[game]!;
      walk(game + 1, correct + (result === 'cancelled' || result === pick ? 1 : 0));
    }
  };
  walk(0, 0);
  return dist;
}

const outcomeArb = fc.constantFrom<Outcome1X2>('1', 'X', '2');
const resultArb = fc.constantFrom<JackpotGameResult>('1', 'X', '2', 'cancelled');
const gamePicksArb = fc.shuffledSubarray<Outcome1X2>(['1', 'X', '2'], {
  minLength: 1,
  maxLength: 3,
});
/** Picks (1..3 unique outcomes per game) with a matching results array. */
const entryArb = (minGames: number, maxGames: number) =>
  fc
    .integer({ min: minGames, max: maxGames })
    .chain((n) =>
      fc.tuple(
        fc.array(gamePicksArb, { minLength: n, maxLength: n }),
        fc.array(resultArb, { minLength: n, maxLength: n }),
      ),
    );

describe('combinationCount', () => {
  it('is the product of the pick counts', () => {
    expect(combinationCount(singles(9))).toBe(1);
    expect(combinationCount([['1', 'X'], ['2'], ['1', 'X', '2']])).toBe(6);
    expect(combinationCount(Array.from({ length: 13 }, () => ['1', 'X', '2'] as const))).toBe(
      1_594_323,
    );
  });

  it('is 0 when any game has no pick', () => {
    expect(combinationCount([['1'], [], ['X', '2']])).toBe(0);
  });

  it('is 1 for an empty list (empty product)', () => {
    expect(combinationCount([])).toBe(1);
  });

  it('throws when the count is not a safe integer', () => {
    const triples = (n: number) => Array.from({ length: n }, () => ['1', 'X', '2'] as const);
    expect(combinationCount(triples(33))).toBe(3 ** 33);
    expect(() => combinationCount(triples(34))).toThrow(RangeError);
  });
});

describe('validateJackpotEntry', () => {
  it('accepts a single-combination daily entry', () => {
    expect(validateJackpotEntry(singles(9), DAILY)).toEqual({
      ok: true,
      errors: [],
      combinations: 1,
      cost: birr(10),
    });
  });

  it('prices a multi-pick entry per combination', () => {
    const picks: Outcome1X2[][] = [['1', 'X'], ['1', 'X', '2'], ...singles(7, 'X')];
    expect(validateJackpotEntry(picks, DAILY)).toEqual({
      ok: true,
      errors: [],
      combinations: 6,
      cost: birr(60),
    });
  });

  it('accepts exactly maxCombinations and rejects one game more', () => {
    const doubles = (n: number): Outcome1X2[][] => Array.from({ length: n }, () => ['1', '2']);
    const weeklyMax = validateJackpotEntry(doubles(12).concat(singles(1)), WEEKLY);
    expect(weeklyMax).toMatchObject({ ok: true, combinations: 4_096, cost: birr(40_960) });

    const weeklyOver = validateJackpotEntry(doubles(13), WEEKLY);
    expect(weeklyOver.ok).toBe(false);
    expect(weeklyOver.combinations).toBe(8_192);
    expect(weeklyOver.cost).toBe(birr(81_920));
    expect(weeklyOver.errors).toEqual(['Too many combinations: 8192 (the maximum is 4096).']);

    const triples: Outcome1X2[][] = Array.from({ length: 7 }, () => ['1', 'X', '2']);
    const dailyOver = validateJackpotEntry(triples.concat(singles(2)), DAILY);
    expect(dailyOver.ok).toBe(false);
    expect(dailyOver.combinations).toBe(2_187);
  });

  it('rejects the wrong number of games with cost 0n', () => {
    const check = validateJackpotEntry(singles(8), DAILY);
    expect(check.ok).toBe(false);
    expect(check.cost).toBe(0n);
    expect(check.combinations).toBe(1);
    expect(check.errors).toEqual(['Expected picks for 9 games but got 8.']);

    expect(validateJackpotEntry(singles(13), DAILY).errors).toEqual([
      'Expected picks for 9 games but got 13.',
    ]);
    expect(validateJackpotEntry([], WEEKLY)).toMatchObject({ ok: false, cost: 0n });
  });

  it('rejects games with no picks, too many picks, duplicates and unknown outcomes', () => {
    const picks = [
      [],
      ['1', 'X', '2', '1'],
      ['X', 'X'],
      ['3'],
      ...singles(5),
    ] as unknown as JackpotPicks;
    const check = validateJackpotEntry(picks, DAILY);
    expect(check.ok).toBe(false);
    expect(check.combinations).toBe(0);
    expect(check.cost).toBe(0n);
    expect(check.errors).toEqual([
      'Game 1: pick at least one outcome.',
      'Game 2: at most 3 picks are allowed.',
      'Game 2: "1" is picked more than once.',
      'Game 3: "X" is picked more than once.',
      'Game 4: "3" is not a valid pick (use 1, X or 2).',
    ]);
  });

  it('reports a repeated pick once per game', () => {
    const picks = [['2', '2', '2'], ['Y', 'Y'], ...singles(7)] as unknown as JackpotPicks;
    expect(validateJackpotEntry(picks, DAILY).errors).toEqual([
      'Game 1: "2" is picked more than once.',
      'Game 2: "Y" is not a valid pick (use 1, X or 2).',
    ]);
  });

  it('collects every error at once', () => {
    const doubles = Array.from({ length: 13 }, (): Outcome1X2[] => ['1', 'X']);
    const picks: Outcome1X2[][] = [[], ['1', '1'], ...doubles];
    const check = validateJackpotEntry(picks, WEEKLY);
    expect(check.ok).toBe(false);
    expect(check.errors).toHaveLength(3);
    expect(check.errors[0]).toBe('Expected picks for 13 games but got 15.');
    expect(check.errors).toContain('Game 1: pick at least one outcome.');
    expect(check.errors).toContain('Game 2: "1" is picked more than once.');
  });

  it('reports absurd combination counts without throwing', () => {
    const picks = Array.from({ length: 40 }, () => ['1', 'X', '2'] as const);
    const check = validateJackpotEntry(picks, { ...WEEKLY, gameCount: 40 });
    expect(check.ok).toBe(false);
    expect(check.combinations).toBe(Number.MAX_SAFE_INTEGER);
    expect(check.cost).toBe(0n);
    expect(check.errors).toEqual([`Too many combinations: ${3n ** 40n} (the maximum is 4096).`]);
  });

  it('valid entries cost combinations × costPerCombination (property)', () => {
    fc.assert(
      fc.property(fc.array(gamePicksArb, { minLength: 9, maxLength: 9 }), (picks) => {
        const check = validateJackpotEntry(picks, DAILY);
        const combinations = combinationCount(picks);
        expect(check.combinations).toBe(combinations);
        expect(check.cost).toBe(BigInt(combinations) * DAILY.costPerCombination);
        expect(check.ok).toBe(combinations <= DAILY.maxCombinations);
        expect(check.ok).toBe(check.errors.length === 0);
      }),
    );
  });
});

describe('correctDistribution', () => {
  it('counts combinations by number of correct predictions', () => {
    // game 1: 1 hit / 1 miss, game 2: 0 / 1, game 3: 1 / 2 → (1 + x)(1)(2 + x) = 2 + 3x + x²
    const picks: JackpotPicks = [['1', 'X'], ['2'], ['1', 'X', '2']];
    expect(correctDistribution(picks, ['1', '1', 'X'], ALL_WIN)).toEqual([2n, 3n, 1n, 0n]);
  });

  it('a perfect single-combination entry lands in the top bucket', () => {
    const dist = correctDistribution(
      singles(9, 'X'),
      Array<JackpotGameResult>(9).fill('X'),
      ALL_WIN,
    );
    expect(dist).toHaveLength(10);
    expect(dist[9]).toBe(1n);
    expect(dist.slice(0, 9).every((d) => d === 0n)).toBe(true);
  });

  it('counts every pick of a cancelled game as correct under all_win', () => {
    expect(correctDistribution([['1', 'X'], ['2']], ['cancelled', '1'], ALL_WIN)).toEqual([
      0n,
      2n,
      0n,
    ]);
    expect(correctDistribution([['1', 'X', '2']], ['cancelled'], ALL_WIN)).toEqual([0n, 3n]);
  });

  it('a full-cover weekly entry has binomial-like buckets', () => {
    // Every game picks 1, X, 2: per game 1 hit and 2 misses → (2 + x)^13.
    const picks = Array.from({ length: 13 }, () => ['1', 'X', '2'] as const);
    const dist = correctDistribution(picks, Array<JackpotGameResult>(13).fill('2'), ALL_WIN);
    const binom = (n: number, k: number): bigint => {
      let r = 1n;
      for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
      return r;
    };
    dist.forEach((ways, k) => expect(ways).toBe(binom(13, k) * 2n ** BigInt(13 - k)));
    expect(dist[13]).toBe(1n);
  });

  it('returns zeros when a game has no picks', () => {
    expect(correctDistribution([['1'], []], ['1', '1'], ALL_WIN)).toEqual([0n, 0n, 0n]);
  });

  it('returns [1n] for an empty entry', () => {
    expect(correctDistribution([], [], ALL_WIN)).toEqual([1n]);
  });

  it('throws when results do not match the games', () => {
    expect(() => correctDistribution(singles(9), Array(8).fill('1'), ALL_WIN)).toThrow(RangeError);
    expect(() => correctDistribution(singles(2), ['1', '1', '1'], ALL_WIN)).toThrow(RangeError);
  });

  it('throws on an unknown result or rule', () => {
    expect(() => correctDistribution(singles(2), ['1', 'Y' as JackpotGameResult], ALL_WIN)).toThrow(
      RangeError,
    );
    expect(() =>
      correctDistribution(singles(1), ['cancelled'], 'refund' as JackpotCancelledRule),
    ).toThrow(RangeError);
  });

  it('sums to combinationCount (property)', () => {
    fc.assert(
      fc.property(entryArb(0, 13), ([picks, results]) => {
        const dist = correctDistribution(picks, results, ALL_WIN);
        expect(dist).toHaveLength(picks.length + 1);
        expect(dist.reduce((a, b) => a + b, 0n)).toBe(BigInt(combinationCount(picks)));
        expect(dist.every((d) => d >= 0n)).toBe(true);
      }),
    );
  });

  it('matches brute-force enumeration (property)', () => {
    fc.assert(
      fc.property(entryArb(0, 7), ([picks, results]) => {
        expect(correctDistribution(picks, results, ALL_WIN)).toEqual(
          bruteForceDistribution(picks, results),
        );
      }),
    );
  });

  it('a single-combination entry has exactly one non-zero bucket equal to 1n (property)', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 13 })
          .chain((n) =>
            fc.tuple(
              fc.array(outcomeArb, { minLength: n, maxLength: n }),
              fc.array(resultArb, { minLength: n, maxLength: n }),
            ),
          ),
        ([choices, results]) => {
          const picks = choices.map((c) => [c]);
          const dist = correctDistribution(picks, results, ALL_WIN);
          const nonZero = dist.flatMap((d, k) => (d === 0n ? [] : [k]));
          expect(nonZero).toHaveLength(1);
          const correct = choices.filter((c, i) => results[i] === 'cancelled' || results[i] === c);
          expect(nonZero[0]).toBe(correct.length);
          expect(dist[correct.length]).toBe(1n);
        },
      ),
    );
  });
});

describe('jackpotTierWinners', () => {
  it('adds up the buckets of every entry', () => {
    expect(
      jackpotTierWinners([
        [0n, 1n, 2n],
        [3n, 0n, 1n, 4n],
      ]),
    ).toEqual([
      { correct: 0, combinations: 3n },
      { correct: 1, combinations: 1n },
      { correct: 2, combinations: 3n },
      { correct: 3, combinations: 4n },
    ]);
  });

  it('omits empty counts and handles no entries', () => {
    expect(jackpotTierWinners([[0n, 0n, 2n]])).toEqual([{ correct: 2, combinations: 2n }]);
    expect(jackpotTierWinners([])).toEqual([]);
  });

  it('rejects negative counts', () => {
    expect(() => jackpotTierWinners([[1n, -1n]])).toThrow(RangeError);
  });
});

describe('computeTierPayouts', () => {
  it('splits shared pools rounding down and pays fixed prizes per combination', () => {
    const payouts = computeTierPayouts(DAILY.prizeTiers, [
      { correct: 9, combinations: 3n },
      { correct: 8, combinations: 10n },
      { correct: 7, combinations: 99n },
    ]);
    expect(payouts).toEqual([
      {
        correct: 9,
        kind: 'shared',
        winningCombinations: 3n,
        prizePerCombination: 3_333_333n,
        total: 9_999_999n,
        undistributed: 1n,
      },
      {
        correct: 8,
        kind: 'fixed',
        winningCombinations: 10n,
        prizePerCombination: birr(200),
        total: birr(2_000),
        undistributed: 0n,
      },
    ]);
  });

  it('leaves the whole shared pool undistributed when nobody wins', () => {
    const payouts = computeTierPayouts(WEEKLY.prizeTiers, []);
    expect(payouts.map((p) => p.correct)).toEqual([13, 12, 11, 10]);
    expect(payouts[0]).toEqual({
      correct: 13,
      kind: 'shared',
      winningCombinations: 0n,
      prizePerCombination: 0n,
      total: 0n,
      undistributed: birr(1_000_000),
    });
    expect(payouts[2]).toMatchObject({
      kind: 'fixed',
      prizePerCombination: birr(500),
      total: 0n,
      undistributed: 0n,
    });
  });

  it('sums repeated winner entries for the same count', () => {
    const [top] = computeTierPayouts(DAILY.prizeTiers, [
      { correct: 9, combinations: 1n },
      { correct: 9, combinations: 1n },
    ]);
    expect(top).toMatchObject({ winningCombinations: 2n, prizePerCombination: birr(50_000) });
  });

  it('rejects duplicate tiers, negative amounts and negative winners', () => {
    const tier: JackpotPrizeTier = { correct: 9, kind: 'shared', amount: birr(1) };
    expect(() => computeTierPayouts([tier, { ...tier, kind: 'fixed' }], [])).toThrow(RangeError);
    expect(() => computeTierPayouts([{ ...tier, amount: -1n }], [])).toThrow(RangeError);
    expect(() => computeTierPayouts([tier], [{ correct: 9, combinations: -1n }])).toThrow(
      RangeError,
    );
  });

  it('returns nothing for no tiers', () => {
    expect(computeTierPayouts([], [{ correct: 9, combinations: 1n }])).toEqual([]);
  });

  it('keeps shared totals within the pool and fixed totals exact (property)', () => {
    const tierArb: fc.Arbitrary<JackpotPrizeTier> = fc.record({
      correct: fc.integer({ min: 0, max: 13 }),
      kind: fc.constantFrom('shared' as const, 'fixed' as const),
      amount: fc.bigInt({ min: 0n, max: birr(10_000_000) }),
    });
    const tiersArb = fc.uniqueArray(tierArb, { selector: (t) => t.correct, maxLength: 6 });
    const winnersArb = fc.array(
      fc.record({
        correct: fc.integer({ min: 0, max: 13 }),
        combinations: fc.bigInt({ min: 0n, max: 10_000_000n }),
      }),
      { maxLength: 10 },
    );
    fc.assert(
      fc.property(tiersArb, winnersArb, (tiers, winners) => {
        const payouts = computeTierPayouts(tiers, winners);
        expect(payouts).toHaveLength(tiers.length);
        payouts.forEach((p, i) => {
          const tier = tiers[i]!;
          const expectedWinners = winners
            .filter((w) => w.correct === tier.correct)
            .reduce((a, w) => a + w.combinations, 0n);
          expect(p.correct).toBe(tier.correct);
          expect(p.kind).toBe(tier.kind);
          expect(p.winningCombinations).toBe(expectedWinners);
          expect(p.prizePerCombination >= 0n).toBe(true);
          expect(p.total).toBe(p.prizePerCombination * p.winningCombinations);
          if (tier.kind === 'shared') {
            expect(p.total + p.undistributed).toBe(tier.amount);
            expect(p.total <= tier.amount).toBe(true);
            expect(p.undistributed >= 0n).toBe(true);
            // Rounding loses less than one santim per winning combination.
            if (p.winningCombinations > 0n) {
              expect(p.undistributed < p.winningCombinations).toBe(true);
            } else {
              expect(p.undistributed).toBe(tier.amount);
            }
          } else {
            expect(p.prizePerCombination).toBe(tier.amount);
            expect(p.total).toBe(tier.amount * p.winningCombinations);
            expect(p.undistributed).toBe(0n);
          }
        });
      }),
    );
  });
});

describe('entryPrize', () => {
  const payouts: TierPayout[] = computeTierPayouts(DAILY.prizeTiers, [
    { correct: 9, combinations: 4n },
    { correct: 8, combinations: 20n },
  ]);

  it('multiplies each bucket by the prize of its exact tier', () => {
    // 1 combination with 9 correct, 2 with 8 correct, 5 with 7 correct (no prize).
    const dist = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 5n, 2n, 1n];
    expect(entryPrize(dist, payouts)).toBe(birr(25_000) + 2n * birr(200));
  });

  it('is not cumulative: a perfect single entry only wins the top tier', () => {
    const dist = correctDistribution(singles(9), Array<JackpotGameResult>(9).fill('1'), ALL_WIN);
    expect(entryPrize(dist, payouts)).toBe(birr(25_000));
  });

  it('is 0 when no bucket reaches a tier or the index is missing', () => {
    expect(entryPrize([1n, 0n, 0n], payouts)).toBe(0n);
    expect(entryPrize([], payouts)).toBe(0n);
    expect(entryPrize([0n, 1n], [])).toBe(0n);
  });

  it('entry prizes are non-negative and add up to the tier totals (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(gamePicksArb, { minLength: 9, maxLength: 9 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(resultArb, { minLength: 9, maxLength: 9 }),
        (entries, results) => {
          const distributions = entries.map((picks) =>
            correctDistribution(picks, results, DAILY.cancelledRule),
          );
          const tierPayouts = computeTierPayouts(
            DAILY.prizeTiers,
            jackpotTierWinners(distributions),
          );
          const prizes = distributions.map((d) => entryPrize(d, tierPayouts));
          expect(prizes.every((p) => p >= 0n)).toBe(true);
          const paid = prizes.reduce((a, b) => a + b, 0n);
          expect(paid).toBe(tierPayouts.reduce((a, p) => a + p.total, 0n));
          const shared = tierPayouts.find((p) => p.kind === 'shared')!;
          expect(shared.total <= birr(100_000)).toBe(true);
        },
      ),
    );
  });
});
