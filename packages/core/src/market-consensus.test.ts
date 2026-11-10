import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONSENSUS_MAX_OVERROUND,
  CONSENSUS_MIN_BOOKS,
  CONSENSUS_MIN_PRICE_MILLI,
  type ConsensusMarketType,
  type MarketConsensus,
  type MarketPriceRow,
  bookFairProbabilities,
  marketConsensus,
} from './market-consensus';

const CODES = { '1x2': ['1', 'X', '2'], ou: ['over', 'under'] } as const;

function bookRows(
  bookmaker: string,
  market: ConsensusMarketType,
  prices: readonly number[],
  line: string | null = market === 'ou' ? '2.5' : null,
): MarketPriceRow[] {
  return CODES[market].map((selection, i) => ({
    bookmaker,
    market,
    line,
    selection,
    priceMilli: prices[i]!,
  }));
}

function find(
  consensus: MarketConsensus[],
  market: ConsensusMarketType,
  line: string | null = market === 'ou' ? '2.5' : null,
): MarketConsensus | undefined {
  return consensus.find((c) => c.market === market && c.line === line);
}

/** Fair probabilities of a book, by hand. */
function fair(prices: readonly number[]): number[] {
  const implied = prices.map((o) => 1000 / o);
  const total = implied.reduce((a, b) => a + b, 0);
  return implied.map((q) => q / total);
}

/**
 * A sane book: a fair probability vector marked up by a margin, prices rounded
 * down to an integer (as a bookmaker would shade them).
 */
function bookArb(size: 2 | 3, maxMargin = 0.2): fc.Arbitrary<number[]> {
  return fc
    .record({
      weights: fc.array(fc.integer({ min: 10, max: 100 }), { minLength: size, maxLength: size }),
      margin: fc.double({ min: 0, max: maxMargin, noNaN: true }),
    })
    .map(({ weights, margin }) => {
      const total = weights.reduce((a, b) => a + b, 0);
      return weights.map((w) => Math.floor(1000 / ((w / total) * (1 + margin))));
    })
    .filter((prices) => bookFairProbabilities(prices) !== null);
}

const MANY_BOOKS = { minLength: 1, maxLength: 8 } as const;

/** Rows of several 1X2 and over/under 2.5 books, each with its own bookmaker. */
const marketRowsArb = fc
  .record({
    x12: fc.array(bookArb(3), MANY_BOOKS),
    ou: fc.array(bookArb(2), MANY_BOOKS),
  })
  .map(({ x12, ou }) => [
    ...x12.flatMap((prices, i) => bookRows(`b${i}`, '1x2', prices)),
    ...ou.flatMap((prices, i) => bookRows(`b${i}`, 'ou', prices)),
  ]);

describe('bookFairProbabilities', () => {
  it('removes the margin proportionally', () => {
    const priced = bookFairProbabilities([2000, 3400, 3800])!;
    const implied = [0.5, 1 / 3.4, 1 / 3.8];
    const total = implied[0]! + implied[1]! + implied[2]!;
    expect(priced.overround).toBeCloseTo(total, 12);
    priced.probabilities.forEach((p, i) => expect(p).toBeCloseTo(implied[i]! / total, 12));
  });

  it('rejects absurd books', () => {
    // Arbitrage (overround below 1) and a margin no real market charges.
    expect(bookFairProbabilities([2100, 2100])).toBeNull();
    expect(bookFairProbabilities([1500, 1500])).toBeNull();
    // Prices outside the sane range or not integers.
    expect(bookFairProbabilities([1005, 100_000])).toBeNull();
    expect(bookFairProbabilities([1900, 1_000_001])).toBeNull();
    expect(bookFairProbabilities([1900.5, 1900])).toBeNull();
    expect(bookFairProbabilities([2000])).toBeNull();
    // Exactly fair is accepted.
    expect(bookFairProbabilities([2000, 2000])?.probabilities).toEqual([0.5, 0.5]);
  });
});

describe('marketConsensus', () => {
  it('takes the median of the fair probabilities and renormalises', () => {
    const books = [
      [2000, 3400, 3800],
      [2100, 3300, 3600],
      [1950, 3500, 4000],
    ];
    const rows = books.flatMap((prices, i) => bookRows(`book${i}`, '1x2', prices));
    const [consensus] = marketConsensus(rows);
    const fairs = books.map(fair);
    const medians = [0, 1, 2].map((i) => fairs.map((f) => f[i]!).sort((a, b) => a - b)[1]!);
    const total = medians[0]! + medians[1]! + medians[2]!;
    expect(consensus).toBeDefined();
    expect(consensus!.market).toBe('1x2');
    expect(consensus!.line).toBeNull();
    expect(consensus!.books).toBe(3);
    expect(consensus!.probabilities['1']).toBeCloseTo(medians[0]! / total, 12);
    expect(consensus!.probabilities.X).toBeCloseTo(medians[1]! / total, 12);
    expect(consensus!.probabilities['2']).toBeCloseTo(medians[2]! / total, 12);
    const overrounds = books.map((b) => b.reduce((s, o) => s + 1000 / o, 0)).sort((a, b) => a - b);
    expect(consensus!.overroundMedian).toBeCloseTo(overrounds[1]!, 12);
  });

  it('averages the middle two of an even number of books', () => {
    const rows = [...bookRows('a', 'ou', [1800, 2050]), ...bookRows('b', 'ou', [1900, 1950])];
    const over = (fair([1800, 2050])[0]! + fair([1900, 1950])[0]!) / 2;
    expect(find(marketConsensus(rows), 'ou')!.probabilities.over).toBeCloseTo(over, 12);
  });

  it('needs minBooks complete books (default 2)', () => {
    expect(CONSENSUS_MIN_BOOKS).toBe(2);
    const one = bookRows('a', '1x2', [2000, 3400, 3800]);
    expect(marketConsensus(one)).toEqual([]);
    expect(marketConsensus(one, { minBooks: 1 })).toHaveLength(1);
    const two = [...one, ...bookRows('b', '1x2', [2100, 3300, 3600])];
    expect(marketConsensus(two, { minBooks: 3 })).toEqual([]);
    expect(() => marketConsensus(two, { minBooks: 0 })).toThrow(RangeError);
    expect(() => marketConsensus(two, { minBooks: 1.5 })).toThrow(RangeError);
  });

  it('counts only complete books', () => {
    const rows = [
      ...bookRows('a', '1x2', [2000, 3400, 3800]),
      ...bookRows('b', '1x2', [2100, 3300, 3600]),
      // No draw price.
      ...bookRows('c', '1x2', [1500, 3300, 5000]).filter((r) => r.selection !== 'X'),
      // Over and under of different lines are not one book.
      ...bookRows('a', 'ou', [1900, 1900], '2.5').slice(0, 1),
      ...bookRows('a', 'ou', [1900, 1900], '3.5').slice(1),
    ];
    const consensus = marketConsensus(rows);
    expect(consensus).toHaveLength(1);
    expect(find(consensus, '1x2')!.books).toBe(2);
    expect(find(consensus, '1x2')!.bookmakers).toEqual(['a', 'b']);
  });

  it('names the books it used, sorted, and only those', () => {
    const rows = [
      ...bookRows('pinnacle', '1x2', [2000, 3400, 3800]),
      ...bookRows('betsson', '1x2', [2100, 3300, 3600]),
      ...bookRows('unibet', '1x2', [1500, 2500, 2800]), // overround too high: dropped
    ];
    expect(find(marketConsensus(rows), '1x2')!.bookmakers).toEqual(['betsson', 'pinnacle']);
  });

  it('drops absurd books and prices', () => {
    const good = [
      ...bookRows('a', '1x2', [2000, 3400, 3800]),
      ...bookRows('b', '1x2', [2100, 3300, 3600]),
    ];
    const base = find(marketConsensus(good), '1x2')!;
    for (const prices of [
      [2400, 3900, 4400], // overround below 1 (an arbitrage or a feed error)
      [1500, 2500, 2800], // overround far above CONSENSUS_MAX_OVERROUND
      [1005, 30_000, 40_000], // a price below the sane range
      [1100, 9000, 1_000_001], // a price above it
      [2000.5, 3400, 3800], // not an integer
    ]) {
      const consensus = find(marketConsensus([...good, ...bookRows('z', '1x2', prices)]), '1x2');
      expect(consensus).toEqual(base);
    }
    expect(CONSENSUS_MAX_OVERROUND).toBe(1.25);
    expect(CONSENSUS_MIN_PRICE_MILLI).toBe(1010);
  });

  it('drops a book that gives one selection two prices, keeps an exact repeat', () => {
    const good = [
      ...bookRows('a', '1x2', [2000, 3400, 3800]),
      ...bookRows('b', '1x2', [2100, 3300, 3600]),
    ];
    const repeat = [...good, { ...good[0]! }];
    expect(marketConsensus(repeat)).toEqual(marketConsensus(good));
    const conflict = [...good, { ...good[0]!, priceMilli: 2050 }];
    expect(marketConsensus(conflict)).toEqual([]);
  });

  it('reads lines and selections leniently but never a line that can push', () => {
    const rows: MarketPriceRow[] = [
      ...bookRows('a', 'ou', [1900, 1900], '02.5'),
      ...bookRows('b', 'ou', [1850, 1950], ' 2.5 '),
      ...bookRows('a', 'ou', [1900, 1900], '2'),
      ...bookRows('b', 'ou', [1900, 1900], '2'),
      ...bookRows('a', 'ou', [1900, 1900], '2.25'),
      ...bookRows('b', 'ou', [1900, 1900], '2.25'),
      ...bookRows('a', 'ou', [1900, 1900], null),
      // 1X2 ignores the line; selection case does not matter.
      { bookmaker: 'a', market: '1x2', line: '2.5', selection: '1', priceMilli: 2000 },
      { bookmaker: 'a', market: '1x2', line: null, selection: 'x', priceMilli: 3400 },
      { bookmaker: 'a', market: '1x2', line: null, selection: '2', priceMilli: 3800 },
      ...bookRows('b', '1x2', [2100, 3300, 3600]),
      // Unreadable rows are ignored.
      { bookmaker: ' ', market: '1x2', line: null, selection: '1', priceMilli: 2000 },
      { bookmaker: 'a', market: 'ah' as never, line: '0.5', selection: '1', priceMilli: 2000 },
      { bookmaker: 'a', market: '1x2', line: null, selection: 'home', priceMilli: 2000 },
    ];
    const consensus = marketConsensus(rows);
    expect(consensus.map((c) => [c.market, c.line, c.books])).toEqual([
      ['1x2', null, 2],
      ['ou', '2.5', 2],
    ]);
  });

  it('lists 1X2 first, then over/under by ascending line', () => {
    const rows = ['4.5', '0.5', '2.5', '10.5'].flatMap((line) => [
      ...bookRows('a', 'ou', [1900, 1900], line),
      ...bookRows('b', 'ou', [1900, 1900], line),
    ]);
    rows.push(...bookRows('a', '1x2', [2000, 3400, 3800]));
    rows.push(...bookRows('b', '1x2', [2000, 3400, 3800]));
    expect(marketConsensus(rows).map((c) => c.line)).toEqual([null, '0.5', '2.5', '4.5', '10.5']);
  });

  it('gives probabilities in (0, 1) summing to 1 (property)', () => {
    fc.assert(
      fc.property(marketRowsArb, (rows) => {
        const consensus = marketConsensus(rows, { minBooks: 1 });
        expect(consensus).toHaveLength(2);
        for (const c of consensus) {
          const values = Object.values(c.probabilities);
          expect(values).toHaveLength(CODES[c.market].length);
          for (const p of values) {
            expect(p).toBeGreaterThan(0);
            expect(p).toBeLessThan(1);
          }
          expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
          expect(c.bookmakers).toHaveLength(c.books);
          expect(new Set(c.bookmakers).size).toBe(c.books);
          expect([...c.bookmakers].sort()).toEqual(c.bookmakers);
          expect(c.overroundMedian).toBeGreaterThanOrEqual(1);
          expect(c.overroundMedian).toBeLessThanOrEqual(CONSENSUS_MAX_OVERROUND);
        }
      }),
    );
  });

  it('does not depend on the order of the rows (property)', () => {
    fc.assert(
      fc.property(
        marketRowsArb.chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }),
          ),
        ),
        ([rows, shuffled]) => {
          expect(marketConsensus(shuffled, { minBooks: 1 })).toEqual(
            marketConsensus(rows, { minBooks: 1 }),
          );
        },
      ),
    );
  });

  it('a single absurd book cannot move the median past the honest books (property)', () => {
    const honest = { minLength: 3, maxLength: 7 } as const;
    fc.assert(
      fc.property(
        fc.array(bookArb(2), honest),
        fc.array(bookArb(3), honest),
        bookArb(2, 0.25),
        bookArb(3, 0.25),
        (ouBooks, x12Books, ouOutlier, x12Outlier) => {
          const rows = [
            ...ouBooks.flatMap((prices, i) => bookRows(`b${i}`, 'ou', prices)),
            ...x12Books.flatMap((prices, i) => bookRows(`b${i}`, '1x2', prices)),
            ...bookRows('outlier', 'ou', ouOutlier),
            ...bookRows('outlier', '1x2', x12Outlier),
          ];
          const consensus = marketConsensus(rows);
          // Two-way: the median of the overs is the consensus itself.
          const overs = ouBooks.map((b) => fair(b)[0]!);
          const over = find(consensus, 'ou')!.probabilities.over!;
          expect(over).toBeGreaterThanOrEqual(Math.min(...overs) - 1e-12);
          expect(over).toBeLessThanOrEqual(Math.max(...overs) + 1e-12);
          // Three-way: each median is within the honest range; renormalising divides by a
          // total within the sum of those ranges.
          const fairs = x12Books.map(fair);
          const lo = [0, 1, 2].map((i) => Math.min(...fairs.map((f) => f[i]!)));
          const hi = [0, 1, 2].map((i) => Math.max(...fairs.map((f) => f[i]!)));
          const sumLo = lo.reduce((a, b) => a + b, 0);
          const sumHi = hi.reduce((a, b) => a + b, 0);
          const x12 = find(consensus, '1x2')!;
          CODES['1x2'].forEach((code, i) => {
            const p = x12.probabilities[code]!;
            expect(p).toBeGreaterThanOrEqual(lo[i]! / sumHi - 1e-12);
            expect(p).toBeLessThanOrEqual(hi[i]! / sumLo + 1e-12);
          });
        },
      ),
    );
  });

  it("scaling a book's margin leaves its fair probabilities unchanged (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 10, max: 100 }), { minLength: 3, maxLength: 3 }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.integer({ min: 17, max: 20 }),
        (weights, margin, k) => {
          const total = weights.reduce((a, b) => a + b, 0);
          // Prices in steps of 20 so that scaling them by k / 20 keeps them integers.
          const base = weights.map(
            (w) => 20 * Math.round(1000 / ((w / total) * (1 + margin)) / 20),
          );
          const scaled = base.map((o) => (o / 20) * k);
          fc.pre(bookFairProbabilities(base) !== null && bookFairProbabilities(scaled) !== null);
          const a = find(marketConsensus(bookRows('a', '1x2', base), { minBooks: 1 }), '1x2')!;
          const b = find(marketConsensus(bookRows('a', '1x2', scaled), { minBooks: 1 }), '1x2')!;
          for (const code of CODES['1x2']) {
            expect(b.probabilities[code]).toBeCloseTo(a.probabilities[code]!, 12);
          }
          expect(b.overroundMedian).toBeCloseTo((a.overroundMedian * 20) / k, 12);
        },
      ),
    );
  });
});
