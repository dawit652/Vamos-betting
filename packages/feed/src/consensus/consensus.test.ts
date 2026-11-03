import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { marketConsensus, median, type BookQuote } from './consensus';
import { fairProbabilities, overround } from './devig';
import { formatLine, groupByLine, isHalfPointLine, mainLine } from './lines';

const NOW = new Date('2026-11-07T12:00:00Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const quote = (bookmaker: string, prices: number[], age = 1): BookQuote => ({
  bookmaker,
  updatedAt: minutesAgo(age),
  prices,
});
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const options = { notBefore: minutesAgo(60) };

describe('fairProbabilities', () => {
  it('returns the implied probabilities of a book without margin', () => {
    for (const method of ['power', 'multiplicative'] as const) {
      const fair = fairProbabilities([2, 4, 4], method);
      expect(fair[0]).toBeCloseTo(0.5, 12);
      expect(fair[1]).toBeCloseTo(0.25, 12);
      expect(fair[2]).toBeCloseTo(0.25, 12);
    }
  });

  it('takes more of the margin from long shots with the power method', () => {
    const prices = [1.25, 6, 12];
    const power = fairProbabilities(prices, 'power');
    const even = fairProbabilities(prices, 'multiplicative');
    expect(power[0]).toBeGreaterThan(even[0] ?? 1);
    expect(power[2]).toBeLessThan(even[2] ?? 0);
  });

  it('handles a book below 100% (exchange prices)', () => {
    const fair = fairProbabilities([2.1, 2.1]);
    expect(fair[0]).toBeCloseTo(0.5, 12);
    expect(sum(fair)).toBeCloseTo(1, 12);
  });

  it('refuses fewer than two prices and prices that are not above 1', () => {
    expect(() => fairProbabilities([2])).toThrow(RangeError);
    expect(() => fairProbabilities([1, 3])).toThrow(RangeError);
    expect(() => fairProbabilities([Number.NaN, 3])).toThrow(RangeError);
  });

  it('measures the overround', () => {
    expect(overround([1.9, 1.9])).toBeCloseTo(1.0526, 4);
  });

  it('gives probabilities that sum to 1 and keep the order of the prices (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1.01, max: 60, noNaN: true }), { minLength: 2, maxLength: 6 }),
        fc.constantFrom('power' as const, 'multiplicative' as const),
        (prices, method) => {
          const fair = fairProbabilities(prices, method);
          expect(sum(fair)).toBeCloseTo(1, 9);
          for (let i = 0; i < prices.length; i++) {
            expect(fair[i]).toBeGreaterThan(0);
            expect(fair[i]).toBeLessThan(1);
            for (let j = 0; j < prices.length; j++) {
              if ((prices[i] ?? 0) < (prices[j] ?? 0)) {
                expect(fair[i]).toBeGreaterThanOrEqual((fair[j] ?? 0) - 1e-12);
              }
            }
          }
        },
      ),
    );
  });
});

describe('marketConsensus', () => {
  it('averages the fair probabilities of the books, sharp books weighted up', () => {
    const result = marketConsensus(
      [
        quote('pinnacle', [2.0, 3.6, 4.2]),
        quote('williamhill', [1.95, 3.4, 4.0]),
        quote('onexbet', [2.05, 3.5, 3.9]),
      ],
      3,
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books).toEqual(['pinnacle', 'williamhill', 'onexbet']);
    expect(result.sharpBooks).toBe(1);
    expect(sum(result.probabilities)).toBeCloseTo(1, 12);
    const pinnacle = fairProbabilities([2.0, 3.6, 4.2]);
    const unweighted = marketConsensus(
      [
        quote('pinnacle', [2.0, 3.6, 4.2]),
        quote('williamhill', [1.95, 3.4, 4.0]),
        quote('onexbet', [2.05, 3.5, 3.9]),
      ],
      3,
      { ...options, weights: {} },
    );
    if (!unweighted.ok) throw new Error('expected a consensus');
    const gap = (probabilities: number[]): number =>
      Math.abs((probabilities[0] ?? 0) - (pinnacle[0] ?? 0));
    expect(gap(result.probabilities)).toBeLessThan(gap(unweighted.probabilities));
    expect(result.newest).toEqual(minutesAgo(1));
  });

  it('ignores stale and malformed quotes, and uses the newest quote of a book', () => {
    const result = marketConsensus(
      [
        quote('pinnacle', [1.9, 1.95], 90),
        quote('pinnacle', [1.8, 2.05], 5),
        quote('williamhill', [1.85, 1.95]),
        quote('onexbet', [1.85]),
        quote('marathonbet', [1.0, 9]),
        quote('betsson', [1.9, 1.9], 61),
      ],
      2,
      options,
    );
    expect(result.excluded).toEqual({ invalid: 2, stale: 1, outliers: [] });
    expect(result.books).toEqual(['pinnacle', 'williamhill']);
  });

  it('drops a book that strays from the median', () => {
    const result = marketConsensus(
      [
        quote('pinnacle', [2.0, 3.5, 4.0]),
        quote('williamhill', [2.0, 3.4, 4.1]),
        quote('onexbet', [2.05, 3.5, 3.9]),
        quote('marathonbet', [1.98, 3.55, 4.05]),
        quote('stalebook', [2.9, 3.3, 2.6]),
      ],
      3,
      options,
    );
    expect(result.ok).toBe(true);
    expect(result.excluded.outliers).toEqual(['stalebook']);
    expect(result.books).not.toContain('stalebook');
  });

  it('refuses too few books, no sharp book when one is required, and wide disagreement', () => {
    const two = [quote('williamhill', [1.9, 1.9]), quote('onexbet', [1.92, 1.88])];
    expect(marketConsensus(two, 2, { ...options, minBooks: 3 })).toMatchObject({
      ok: false,
      reason: 'too_few_books',
    });
    expect(marketConsensus(two, 2, { ...options, requireSharp: true })).toMatchObject({
      ok: false,
      reason: 'no_sharp_book',
    });
    expect(
      marketConsensus([quote('pinnacle', [1.9, 1.9]), ...two], 2, {
        ...options,
        requireSharp: true,
      }).ok,
    ).toBe(true);
    // Two books cannot outvote each other: a wide gap refuses the market.
    expect(
      marketConsensus([quote('pinnacle', [1.5, 2.6]), quote('onexbet', [2.4, 1.6])], 2, options),
    ).toMatchObject({ ok: false, reason: 'books_disagree' });
    expect(marketConsensus([], 2, options)).toMatchObject({ ok: false, reason: 'too_few_books' });
  });

  it('stays within the range of the books it used (property)', () => {
    const book = fc.record({
      bookmaker: fc.constantFrom(
        'pinnacle',
        'betfair_ex_eu',
        'williamhill',
        'onexbet',
        'marathonbet',
        'unibet_eu',
      ),
      noise: fc.array(fc.double({ min: -0.03, max: 0.03, noNaN: true }), {
        minLength: 3,
        maxLength: 3,
      }),
      margin: fc.double({ min: 0, max: 0.1, noNaN: true }),
      age: fc.integer({ min: 0, max: 90 }),
    });
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.08, max: 0.8, noNaN: true }), { minLength: 3, maxLength: 3 }),
        fc.array(book, { minLength: 1, maxLength: 8 }),
        (weights, books) => {
          const truth = weights.map((w) => w / sum(weights));
          const quotes = books.map((b) => ({
            bookmaker: b.bookmaker,
            updatedAt: minutesAgo(b.age),
            prices: truth.map(
              (p, i) =>
                1 / Math.min(0.97, Math.max(0.02, (p + (b.noise[i] ?? 0)) * (1 + b.margin))),
            ),
          }));
          const result = marketConsensus(quotes, 3, options);
          if (!result.ok) return;
          expect(sum(result.probabilities)).toBeCloseTo(1, 9);
          const newest = new Map<string, BookQuote>();
          for (const q of quotes) {
            const seen = newest.get(q.bookmaker);
            if (seen === undefined || q.updatedAt > seen.updatedAt) newest.set(q.bookmaker, q);
          }
          const used = [...newest.values()].filter((q) => result.books.includes(q.bookmaker));
          for (let j = 0; j < 3; j++) {
            const values = used.map((q) => fairProbabilities(q.prices)[j] ?? 0);
            expect(result.probabilities[j]).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
            expect(result.probabilities[j]).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
          }
        },
      ),
    );
  });

  it('takes the median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('lines', () => {
  it('accepts half-point lines only', () => {
    expect([2.5, -1.5, 224.5, 0.5].map(isHalfPointLine)).toEqual([true, true, true, true]);
    expect([2, 2.25, 2.75, -1, Number.NaN].map(isHalfPointLine)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(formatLine(2.5)).toBe('2.5');
    expect(formatLine(-1.5)).toBe('-1.5');
    expect(() => formatLine(3)).toThrow(RangeError);
  });

  it('groups quotes by line and drops whole and quarter lines', () => {
    const at = minutesAgo(1);
    const groups = groupByLine([
      { bookmaker: 'pinnacle', updatedAt: at, prices: [1.9, 1.95], line: 2.5 },
      { bookmaker: 'onexbet', updatedAt: at, prices: [1.7, 2.1], line: 2.25 },
      { bookmaker: 'williamhill', updatedAt: at, prices: [2.6, 1.5], line: 3.5 },
      { bookmaker: 'williamhill', updatedAt: at, prices: [1.85, 1.95], line: 2.5 },
    ]);
    expect([...groups.keys()]).toEqual([2.5, 3.5]);
    expect(groups.get(2.5)?.map((q) => q.bookmaker)).toEqual(['pinnacle', 'williamhill']);
  });

  it('chooses the line most books quote, then the most even one, then the lower one', () => {
    expect(mainLine([])).toBeNull();
    expect(
      mainLine([
        { line: 2.5, books: 5, probability: 0.6 },
        { line: 3.5, books: 2, probability: 0.5 },
      ]),
    ).toBe(2.5);
    expect(
      mainLine([
        { line: 2.5, books: 3, probability: 0.6 },
        { line: 3.5, books: 3, probability: 0.45 },
      ]),
    ).toBe(3.5);
    expect(
      mainLine([
        { line: 3.5, books: 3, probability: 0.45 },
        { line: 2.5, books: 3, probability: 0.55 },
      ]),
    ).toBe(2.5);
  });
});
