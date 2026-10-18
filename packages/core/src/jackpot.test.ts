import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type JackpotGameResult,
  type JackpotPicks,
  type Outcome1X2,
  type TierPayout,
  bestCorrect,
  combinationCount,
  computeTierPayouts,
  correctDistribution,
  entryPrize,
  isJackpotDrawVoid,
  jackpotPickHit,
  jackpotTierWinners,
  settleJackpotDraw,
  settleJackpotEntry,
  validateJackpotEntry,
} from './jackpot';
import { birr } from './money';
import {
  DEFAULT_JACKPOTS,
  DEFAULT_TAX,
  type JackpotCancelledRule,
  type JackpotPrizeTier,
  type TaxConfig,
} from './rules';

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

describe('isJackpotDrawVoid', () => {
  const draw = (games: number, cancelled: number): JackpotGameResult[] =>
    Array.from({ length: games }, (_, i) => (i < cancelled ? 'cancelled' : '1'));

  it('is void only when more than half of the games are cancelled', () => {
    expect(isJackpotDrawVoid(draw(9, 4), ALL_WIN)).toBe(false);
    expect(isJackpotDrawVoid(draw(9, 5), ALL_WIN)).toBe(true);
    expect(isJackpotDrawVoid(draw(13, 6), ALL_WIN)).toBe(false);
    expect(isJackpotDrawVoid(draw(13, 7), ALL_WIN)).toBe(true);
    // Exactly half is not more than half.
    expect(isJackpotDrawVoid(draw(4, 2), ALL_WIN)).toBe(false);
    expect(isJackpotDrawVoid(draw(4, 3), ALL_WIN)).toBe(true);
    expect(isJackpotDrawVoid(draw(1, 1), ALL_WIN)).toBe(true);
    expect(isJackpotDrawVoid([], ALL_WIN)).toBe(false);
  });

  it('throws on an unknown rule', () => {
    expect(() => isJackpotDrawVoid(draw(3, 0), 'refund' as JackpotCancelledRule)).toThrow(
      RangeError,
    );
  });

  it('is 2 × cancelled > games (property)', () => {
    fc.assert(
      fc.property(fc.array(resultArb, { maxLength: 30 }), (results) => {
        const cancelled = results.filter((r) => r === 'cancelled').length;
        expect(isJackpotDrawVoid(results, ALL_WIN)).toBe(cancelled * 2 > results.length);
      }),
    );
  });
});

describe('jackpotPickHit', () => {
  it('is null without a result, true for a picked or cancelled result, else false', () => {
    expect(jackpotPickHit(['1', 'X'], null, ALL_WIN)).toBeNull();
    expect(jackpotPickHit(['1', 'X'], 'X', ALL_WIN)).toBe(true);
    expect(jackpotPickHit(['1', 'X'], '2', ALL_WIN)).toBe(false);
    expect(jackpotPickHit(['2'], 'cancelled', ALL_WIN)).toBe(true);
  });
});

describe('bestCorrect', () => {
  it('is the highest bucket with a combination', () => {
    expect(bestCorrect([0n, 0n, 1n])).toBe(2);
    expect(bestCorrect([0n, 2n, 0n, 0n])).toBe(1);
    expect(bestCorrect([3n, 0n])).toBe(0);
    expect(bestCorrect([1n])).toBe(0);
    expect(bestCorrect([])).toBe(0);
  });
});

/** The winnings tax of a prize, written out from the tax rules (not computeWinningsTax). */
function expectedTax(cost: bigint, gross: bigint, config: TaxConfig): bigint {
  const winnings = gross > cost ? gross - cost : 0n;
  const base = config.base === 'net_winnings' ? winnings : gross;
  if (winnings === 0n || base < config.exemptBelow) return 0n;
  const tax = (base * BigInt(config.rateBps)) / 10_000n;
  return tax < winnings ? tax : winnings;
}

describe('settleJackpotDraw', () => {
  const allOnes = (n: number): JackpotGameResult[] => Array<JackpotGameResult>(n).fill('1');

  it('splits the shared pool, pays fixed prizes and taxes each prize above its cost', () => {
    // Every game ends 1. A: 9 correct (1 combination). B: 1/X on game 1 →
    // one combination with 9 correct, one with 8. C: 8 correct. D: none.
    const entries = [
      { picks: singles(9, '1'), cost: birr(10) },
      { picks: [['1', 'X'], ...singles(8, '1')] as Outcome1X2[][], cost: birr(20) },
      { picks: [['X'], ...singles(8, '1')] as Outcome1X2[][], cost: birr(10) },
      { picks: singles(9, '2'), cost: birr(10) },
    ];
    const draw = settleJackpotDraw({
      entries,
      results: allOnes(9),
      cancelledRule: ALL_WIN,
      prizeTiers: DAILY.prizeTiers,
      tax: DEFAULT_TAX,
    });
    expect(draw.void).toBe(false);
    expect(draw.cancelledGames).toBe(0);
    // 2 winning combinations at 9 correct share 100,000 ETB; 2 at 8 get 200 ETB each.
    expect(
      draw.payouts.map((p) => [p.correct, p.winningCombinations, p.prizePerCombination]),
    ).toEqual([
      [9, 2n, birr(50_000)],
      [8, 2n, birr(200)],
    ]);
    expect(draw.entries.map((e) => [e.status, e.bestCorrect, e.gross, e.tax, e.net])).toEqual([
      // 20% of (50,000 − 10) = 9,998.
      ['won', 9, birr(50_000), birr(9_998), birr(40_002)],
      // 20% of (50,200 − 20) = 10,036.
      ['won', 9, birr(50_200), birr(10_036), birr(40_164)],
      // 190 ETB of winnings is above the 100 ETB exemption: 38 ETB tax.
      ['won', 8, birr(200), birr(38), birr(162)],
      ['lost', 0, 0n, 0n, 0n],
    ]);
    expect(draw.entries[1]?.distribution).toEqual([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 1n, 1n]);
    expect(draw.entries.every((e) => e.refund === 0n)).toBe(true);
    expect(draw.totals).toEqual({
      stakes: birr(50),
      gross: birr(100_400),
      tax: birr(20_072),
      net: birr(80_328),
      refunds: 0n,
      winners: 3,
      undistributed: 0n,
    });
  });

  it('counts a cancelled game as correct for every pick and rounds shared pools down', () => {
    // Game 1 cancelled, the others end 1. E1: 13 correct. E2: 3 picks on the
    // cancelled game, 1/X on game 2 → 3 combinations with 13, 3 with 12.
    const results: JackpotGameResult[] = ['cancelled', ...allOnes(12)];
    const entries = [
      { picks: [['2'], ...singles(12, '1')] as Outcome1X2[][], cost: birr(10) },
      {
        picks: [['1', 'X', '2'], ['1', 'X'], ...singles(11, '1')] as Outcome1X2[][],
        cost: birr(60),
      },
    ];
    const draw = settleJackpotDraw({
      entries,
      results,
      cancelledRule: ALL_WIN,
      prizeTiers: WEEKLY.prizeTiers,
      tax: DEFAULT_TAX,
    });
    expect(draw.void).toBe(false);
    expect(draw.cancelledGames).toBe(1);
    const [top, second] = draw.payouts;
    expect(top).toMatchObject({ winningCombinations: 4n, prizePerCombination: birr(250_000) });
    // 100,000 ETB over 3 combinations: 3,333,333 santim each, 1 santim left over.
    expect(second).toMatchObject({
      winningCombinations: 3n,
      prizePerCombination: 3_333_333n,
      undistributed: 1n,
    });
    const [e1, e2] = draw.entries;
    expect(e1).toMatchObject({ gross: birr(250_000), tax: 4_999_800n, net: 20_000_200n });
    const gross2 = 3n * birr(250_000) + 3n * 3_333_333n;
    expect(e2).toMatchObject({ gross: gross2, bestCorrect: 13 });
    expect(e2?.tax).toBe(((gross2 - birr(60)) * 2_000n) / 10_000n);
    expect(e2?.net).toBe(gross2 - (e2?.tax ?? 0n));
    expect(draw.totals.undistributed).toBe(1n);
  });

  it('refunds every entry when more than half of the games are cancelled', () => {
    const results: JackpotGameResult[] = [...Array(5).fill('cancelled'), ...allOnes(4)];
    const draw = settleJackpotDraw({
      entries: [
        { picks: singles(9), cost: birr(10) },
        { picks: [['1', 'X'], ...singles(8)] as Outcome1X2[][], cost: birr(20) },
      ],
      results,
      cancelledRule: ALL_WIN,
      prizeTiers: DAILY.prizeTiers,
      tax: DEFAULT_TAX,
    });
    expect(draw.void).toBe(true);
    expect(draw.cancelledGames).toBe(5);
    expect(draw.payouts).toEqual([]);
    expect(draw.entries).toEqual([
      {
        status: 'void',
        distribution: null,
        bestCorrect: null,
        gross: 0n,
        tax: 0n,
        net: 0n,
        refund: birr(10),
      },
      {
        status: 'void',
        distribution: null,
        bestCorrect: null,
        gross: 0n,
        tax: 0n,
        net: 0n,
        refund: birr(20),
      },
    ]);
    expect(draw.totals).toMatchObject({ stakes: birr(30), refunds: birr(30), gross: 0n });
  });

  it('keeps the whole shared pool with the house when nobody wins it', () => {
    const draw = settleJackpotDraw({
      entries: [{ picks: singles(9, 'X'), cost: birr(10) }],
      results: allOnes(9),
      cancelledRule: ALL_WIN,
      prizeTiers: DAILY.prizeTiers,
      tax: DEFAULT_TAX,
    });
    expect(draw.entries[0]).toMatchObject({ status: 'lost', gross: 0n, net: 0n, bestCorrect: 0 });
    expect(draw.totals).toMatchObject({ gross: 0n, winners: 0, undistributed: birr(100_000) });
  });

  it('does not tax a prize below the entry cost, and taxes the gross when configured', () => {
    const tiers: JackpotPrizeTier[] = [{ correct: 2, kind: 'fixed', amount: birr(5) }];
    const wide = [
      ['1', 'X', '2'],
      ['1', 'X', '2'],
    ] as Outcome1X2[][];
    const cheapWin = settleJackpotDraw({
      entries: [{ picks: wide, cost: birr(90) }],
      results: ['1', '1'],
      cancelledRule: ALL_WIN,
      prizeTiers: tiers,
      tax: DEFAULT_TAX,
    });
    expect(cheapWin.entries[0]).toMatchObject({ status: 'won', gross: birr(5), tax: 0n });

    const grossBase: TaxConfig = { rateBps: 2_000, base: 'gross_payout', exemptBelow: 0n };
    const big = settleJackpotDraw({
      entries: [{ picks: [['1'], ['1']], cost: birr(10) }],
      results: ['1', '1'],
      cancelledRule: ALL_WIN,
      prizeTiers: [{ correct: 2, kind: 'shared', amount: birr(1_000) }],
      tax: grossBase,
    });
    // 20% of the whole 1,000 ETB prize (below the 990 ETB of winnings).
    expect(big.entries[0]).toMatchObject({ gross: birr(1_000), tax: birr(200), net: birr(800) });
  });

  it('rejects a non-positive cost and picks that do not cover every game', () => {
    const base = {
      results: allOnes(9),
      cancelledRule: ALL_WIN,
      prizeTiers: DAILY.prizeTiers,
      tax: DEFAULT_TAX,
    };
    expect(() =>
      settleJackpotDraw({ ...base, entries: [{ picks: singles(9), cost: 0n }] }),
    ).toThrow(RangeError);
    expect(() =>
      settleJackpotDraw({ ...base, entries: [{ picks: singles(8), cost: birr(10) }] }),
    ).toThrow(RangeError);
    const voidDraw = { ...base, results: Array<JackpotGameResult>(9).fill('cancelled') };
    expect(() =>
      settleJackpotDraw({ ...voidDraw, entries: [{ picks: singles(8), cost: birr(10) }] }),
    ).toThrow(RangeError);
  });

  const taxArb: fc.Arbitrary<TaxConfig> = fc.record({
    rateBps: fc.integer({ min: 0, max: 10_000 }),
    base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
    exemptBelow: fc.bigInt({ min: 0n, max: birr(1_000) }),
  });
  /** A draw of n games: tiers, entries (picks and a positive cost) and results. */
  const drawArb = fc.integer({ min: 1, max: 6 }).chain((n) =>
    fc.record({
      results: fc.array(resultArb, { minLength: n, maxLength: n }),
      entries: fc.array(
        fc.record({
          picks: fc.array(gamePicksArb, { minLength: n, maxLength: n }),
          cost: fc.bigInt({ min: 1n, max: birr(1_000) }),
        }),
        { maxLength: 6 },
      ),
      prizeTiers: fc
        .uniqueArray(
          fc.record({
            correct: fc.integer({ min: 0, max: n }),
            kind: fc.constantFrom('shared' as const, 'fixed' as const),
            amount: fc.bigInt({ min: 0n, max: birr(1_000_000) }),
          }),
          { selector: (t) => t.correct, maxLength: 4 },
        )
        .map((tiers) => [...tiers].sort((a, b) => b.correct - a.correct)),
      tax: taxArb,
    }),
  );

  it('pays every entry what the prize formula gives, taxed like a bet (property)', () => {
    fc.assert(
      fc.property(drawArb, ({ results, entries, prizeTiers, tax }) => {
        const draw = settleJackpotDraw({
          entries,
          results,
          cancelledRule: ALL_WIN,
          prizeTiers,
          tax,
        });
        const cancelled = results.filter((r) => r === 'cancelled').length;
        expect(draw.cancelledGames).toBe(cancelled);
        expect(draw.entries).toHaveLength(entries.length);
        const stakes = entries.reduce((sum, e) => sum + e.cost, 0n);
        expect(draw.totals.stakes).toBe(stakes);
        if (2 * cancelled > results.length) {
          expect(draw.void).toBe(true);
          draw.entries.forEach((settled, i) => {
            expect(settled).toMatchObject({ status: 'void', gross: 0n, tax: 0n, net: 0n });
            expect(settled.refund).toBe(entries[i]!.cost);
          });
          expect(draw.totals).toMatchObject({ refunds: stakes, gross: 0n, net: 0n, winners: 0 });
          return;
        }
        expect(draw.void).toBe(false);
        // Independent of correctDistribution / computeTierPayouts / entryPrize.
        const dists = entries.map((e) => bruteForceDistribution(e.picks, results));
        const winners = (correct: number) => dists.reduce((sum, d) => sum + (d[correct] ?? 0n), 0n);
        const perCombination = prizeTiers.map((tier) => {
          if (tier.kind === 'fixed') return tier.amount;
          const w = winners(tier.correct);
          return w === 0n ? 0n : tier.amount / w;
        });
        let paid = 0n;
        draw.entries.forEach((settled, i) => {
          const entry = entries[i]!;
          const dist = dists[i]!;
          const gross = prizeTiers.reduce(
            (sum, tier, t) => sum + (dist[tier.correct] ?? 0n) * perCombination[t]!,
            0n,
          );
          const expectedTaxAmount = expectedTax(entry.cost, gross, tax);
          expect(settled.distribution).toEqual(dist);
          expect(settled.bestCorrect).toBe(bestCorrect(dist));
          expect(settled.gross).toBe(gross);
          expect(settled.tax).toBe(expectedTaxAmount);
          expect(settled.net).toBe(gross - expectedTaxAmount);
          expect(settled.status).toBe(gross > 0n ? 'won' : 'lost');
          expect(settled.refund).toBe(0n);
          // A prize never pays back less than min(prize, cost).
          expect(settled.net >= (gross < entry.cost ? gross : entry.cost)).toBe(true);
          paid += gross;
        });
        expect(draw.totals.gross).toBe(paid);
        expect(draw.totals.net + draw.totals.tax).toBe(paid);
        // A shared tier never pays out more than its pool; what is left stays with the house.
        prizeTiers.forEach((tier, t) => {
          const tierPaid = winners(tier.correct) * perCombination[t]!;
          if (tier.kind === 'shared') expect(tierPaid <= tier.amount).toBe(true);
        });
        const undistributed = prizeTiers.reduce(
          (sum, tier, t) =>
            tier.kind === 'shared'
              ? sum + tier.amount - winners(tier.correct) * perCombination[t]!
              : sum,
          0n,
        );
        expect(draw.totals.undistributed).toBe(undistributed);
      }),
    );
  });

  it('an entry wins what its single combinations would win together (property)', () => {
    fc.assert(
      fc.property(drawArb, ({ results, entries, prizeTiers, tax }) => {
        fc.pre(2 * results.filter((r) => r === 'cancelled').length <= results.length);
        const expand = (picks: JackpotPicks): Outcome1X2[][][] =>
          picks.reduce<Outcome1X2[][][]>(
            (combos, game) => combos.flatMap((combo) => game.map((pick) => [...combo, [pick]])),
            [[]],
          );
        const draw = settleJackpotDraw({
          entries,
          results,
          cancelledRule: ALL_WIN,
          prizeTiers,
          tax,
        });
        const singlesDraw = settleJackpotDraw({
          entries: entries.flatMap((e) => expand(e.picks).map((picks) => ({ picks, cost: 1n }))),
          results,
          cancelledRule: ALL_WIN,
          prizeTiers,
          tax,
        });
        expect(singlesDraw.payouts).toEqual(draw.payouts);
        let offset = 0;
        entries.forEach((entry, i) => {
          const count = combinationCount(entry.picks);
          const parts = singlesDraw.entries.slice(offset, offset + count);
          offset += count;
          expect(parts.reduce((sum, p) => sum + p.gross, 0n)).toBe(draw.entries[i]!.gross);
        });
      }),
    );
  });

  it('settles each entry exactly as the whole draw does (property)', () => {
    fc.assert(
      fc.property(drawArb, ({ results, entries, prizeTiers, tax }) => {
        const draw = settleJackpotDraw({
          entries,
          results,
          cancelledRule: ALL_WIN,
          prizeTiers,
          tax,
        });
        entries.forEach((entry, i) => {
          expect(
            settleJackpotEntry({
              entry,
              results,
              cancelledRule: ALL_WIN,
              payouts: draw.payouts,
              tax,
            }),
          ).toEqual(draw.entries[i]);
        });
      }),
    );
  });
});

describe('settleJackpotEntry', () => {
  it('pays one entry from fixed prizes per combination, tax withheld as for a bet', () => {
    const payouts: TierPayout[] = [
      {
        correct: 3,
        kind: 'fixed',
        winningCombinations: 1n,
        prizePerCombination: birr(100),
        total: birr(100),
        undistributed: 0n,
      },
      {
        correct: 2,
        kind: 'fixed',
        winningCombinations: 1n,
        prizePerCombination: birr(10),
        total: birr(10),
        undistributed: 0n,
      },
    ];
    // ['1','X'] on a '1': one combination has 3 correct, one has 2.
    const settled = settleJackpotEntry({
      entry: { picks: [['1', 'X'], ['1'], ['1']], cost: birr(20) },
      results: ['1', '1', '1'],
      cancelledRule: ALL_WIN,
      payouts,
      tax: DEFAULT_TAX,
    });
    expect(settled.status).toBe('won');
    expect(settled.distribution).toEqual([0n, 0n, 1n, 1n]);
    expect(settled.bestCorrect).toBe(3);
    expect(settled.gross).toBe(birr(110));
    expect(settled.net + settled.tax).toBe(birr(110));
    expect(settled.net).toBeGreaterThanOrEqual(birr(20));
  });

  it('refunds the cost in a void draw and rejects a non-positive cost', () => {
    const entry = { picks: singles(3), cost: birr(5) };
    expect(
      settleJackpotEntry({
        entry,
        results: ['cancelled', 'cancelled', '1'],
        cancelledRule: ALL_WIN,
        payouts: [],
        tax: DEFAULT_TAX,
      }),
    ).toMatchObject({ status: 'void', refund: birr(5), gross: 0n, net: 0n });
    expect(() =>
      settleJackpotEntry({
        entry: { picks: singles(3), cost: 0n },
        results: ['1', '1', '1'],
        cancelledRule: ALL_WIN,
        payouts: [],
        tax: DEFAULT_TAX,
      }),
    ).toThrow(RangeError);
  });
});
