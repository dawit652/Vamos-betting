import { describe, expect, it } from 'vitest';
import { type Rng, createRng } from '../random';
import { priceBook } from './book';
import {
  type BookDropReason,
  type BookQuote,
  type ConsensusOptions,
  type ConsensusResult,
  DEFAULT_BOOK_WEIGHTS,
  HIGH_CONFIDENCE_MAX_DISPERSION,
  HIGH_CONFIDENCE_MIN_BOOKS,
  LOW_CONFIDENCE_MAX_BOOKS,
  LOW_CONFIDENCE_MIN_DISPERSION,
  MIN_CONSENSUS_BOOKS,
  OUTLIER_MAX_GAP,
  OVERROUND_BOOK_MAX,
  OVERROUND_BOOK_MIN,
  PINNACLE_HIGH_LIMIT_USD,
  PINNACLE_LOW_LIMIT_USD,
  bookFairProbabilities,
  consensus,
} from './consensus';

/*
 * Property tests run over seeded random cases (createRng) rather than
 * fast-check, which @vamos/feed cannot resolve: same idea, deterministic.
 */
const CASES = 400;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const OUTCOMES = ['home', 'draw', 'away'];
/** Exactly representable, so a book at zero margin has an overround of exactly 1. */
const FAIR = { home: 0.5, draw: 0.25, away: 0.25 };
const HEALTHY: ReadonlySet<number> = new Set([3, 32, 7, 9, 19]);

/** Implied probabilities: the fair ones plus a margin (an overround of 1 + margin). */
function withMargin(
  fair: Readonly<Record<string, number>>,
  margin: number,
): Record<string, number> {
  return Object.fromEntries(Object.entries(fair).map(([code, p]) => [code, p * (1 + margin)]));
}

type QuoteOverrides = Partial<BookQuote> & { margin?: number };

/** A fresh, complete, healthy-looking quote of `bookId` at the given fair probabilities. */
function quote(
  bookId: number,
  fair: Readonly<Record<string, number>> = FAIR,
  overrides: QuoteOverrides = {},
): BookQuote {
  const { margin = 0.05, ...rest } = overrides;
  return {
    bookId,
    probabilities: withMargin(fair, margin),
    updatedAt: NOW,
    liquidityUsd: null,
    ...rest,
  };
}

function options(overrides: Partial<ConsensusOptions> = {}): ConsensusOptions {
  return {
    outcomes: OUTCOMES,
    anchors: [3, 32],
    now: NOW,
    maxBookAgeMs: 6 * HOUR,
    healthyBooks: HEALTHY,
    ...overrides,
  };
}

type Used = Extract<ConsensusResult, { ok: true }>;
type Refused = Extract<ConsensusResult, { ok: false }>;

function expectOk(result: ConsensusResult): Used {
  if (!result.ok) throw new Error(`expected a consensus, got ${result.reason}`);
  return result;
}

function expectRefused(result: ConsensusResult): Refused {
  if (result.ok) throw new Error('expected a refusal, got a consensus');
  return result;
}

/** The three good books 3, 32 and 7. */
const good = (): BookQuote[] => [quote(3), quote(32), quote(7)];

/** `bad` joins the good books: they are used, and `bad` is listed once, for `reason`. */
function expectDropped(
  bad: BookQuote,
  reason: BookDropReason,
  overrides: Partial<ConsensusOptions> = {},
): void {
  const result = expectOk(consensus([...good(), bad], options(overrides)));
  expect(result.booksUsed).toEqual([3, 7, 32]);
  expect(result.dropped).toEqual([{ bookId: bad.bookId, reason }]);
}

describe('constants', () => {
  it('are the starting values of rules P4 and P5', () => {
    expect(OVERROUND_BOOK_MIN).toBe(1);
    expect(OVERROUND_BOOK_MAX).toBe(1.2);
    expect(OUTLIER_MAX_GAP).toBe(0.04);
    expect(MIN_CONSENSUS_BOOKS).toBe(2);
    expect(LOW_CONFIDENCE_MAX_BOOKS).toBe(2);
    expect(HIGH_CONFIDENCE_MIN_BOOKS).toBe(4);
    expect(HIGH_CONFIDENCE_MAX_DISPERSION).toBe(0.015);
    expect(LOW_CONFIDENCE_MIN_DISPERSION).toBe(0.03);
    expect(PINNACLE_LOW_LIMIT_USD).toBe(250);
    expect(PINNACLE_HIGH_LIMIT_USD).toBe(1000);
  });

  it('give Pinnacle 3 and Circa, BookMaker and BetCRIS 2, frozen', () => {
    expect(DEFAULT_BOOK_WEIGHTS).toEqual({ 3: 3, 32: 2, 7: 2, 9: 2 });
    expect(Object.isFrozen(DEFAULT_BOOK_WEIGHTS)).toBe(true);
  });
});

describe('bookFairProbabilities', () => {
  it('divides by the sum: the proportional de-margin', () => {
    const result = bookFairProbabilities({ home: 0.55, draw: 0.3, away: 0.25 }, OUTCOMES)!;
    expect(result.overround).toBeCloseTo(1.1, 12);
    expect(result.fair.home).toBeCloseTo(0.5, 12);
    expect(result.fair.draw).toBeCloseTo(0.3 / 1.1, 12);
    expect(result.fair.away).toBeCloseTo(0.25 / 1.1, 12);
    expect(Object.keys(result.fair)).toEqual(OUTCOMES);
  });

  it('works for a two-way market', () => {
    const result = bookFairProbabilities({ over: 0.55, under: 0.5 }, ['over', 'under'])!;
    expect(result.overround).toBeCloseTo(1.05, 12);
    expect(result.fair.over! + result.fair.under!).toBeCloseTo(1, 12);
    expect(result.fair.over).toBeCloseTo(0.55 / 1.05, 12);
  });

  it('is null when an outcome is missing', () => {
    expect(bookFairProbabilities({ home: 0.5, draw: 0.3 }, OUTCOMES)).toBeNull();
    expect(bookFairProbabilities({}, OUTCOMES)).toBeNull();
    // An inherited property is not an entry.
    expect(bookFairProbabilities({ home: 0.5 }, ['home', 'toString'])).toBeNull();
    expect(bookFairProbabilities({ home: 0.5 }, [])).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['one', 1],
    ['negative', -0.2],
    ['above one', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '0.5' as unknown as number],
  ])('is null when a probability is %s', (_name, bad) => {
    expect(bookFairProbabilities({ home: 0.5, draw: 0.3, away: bad }, OUTCOMES)).toBeNull();
  });

  it('ignores keys that are not outcomes', () => {
    const result = bookFairProbabilities({ home: 0.5, draw: 0.3, away: 0.3, other: 9 }, OUTCOMES);
    expect(result?.overround).toBeCloseTo(1.1, 12);
  });

  it('gives back the probabilities a book made with priceBook was priced from', () => {
    const fair = [0.45, 0.28, 0.27];
    const odds = priceBook(fair, 600)!;
    const result = bookFairProbabilities(
      { home: 1000 / odds[0]!, draw: 1000 / odds[1]!, away: 1000 / odds[2]! },
      OUTCOMES,
    )!;
    // Prices are whole hundredths, so each probability is only recovered to about a step.
    expect(result.overround).toBeCloseTo(1.06, 1);
    expect(result.fair.home).toBeCloseTo(fair[0]!, 2);
    expect(result.fair.draw).toBeCloseTo(fair[1]!, 2);
    expect(result.fair.away).toBeCloseTo(fair[2]!, 2);
  });
});

describe('consensus: which books count (P4)', () => {
  it('uses books that pass every check and drops none', () => {
    const result = expectOk(consensus(good(), options()));
    expect(result.booksUsed).toEqual([3, 7, 32]);
    expect(result.dropped).toEqual([]);
  });

  it('lists the books used ascending, whatever the order of the quotes', () => {
    const result = expectOk(
      consensus([quote(32), quote(9), quote(3), quote(19), quote(7)], options()),
    );
    expect(result.booksUsed).toEqual([3, 7, 9, 19, 32]);
  });

  describe('incomplete', () => {
    it.each([
      ['an outcome missing', { home: 0.5, draw: 0.25 }],
      ['no probabilities', {}],
      ['an outcome undefined', { home: 0.5, draw: 0.25, away: undefined as unknown as number }],
      ['an outcome null', { home: 0.5, draw: 0.25, away: null as unknown as number }],
      ['the probabilities null', null as unknown as Record<string, number>],
      // A missing outcome wins over an invalid one, wherever they are.
      ['an invalid outcome and a missing one', { home: Number.NaN, draw: 0.3 }],
      ['a missing outcome after an invalid one', { home: 2, away: 0.3 }],
    ])('drops a book with %s', (_name, probabilities) => {
      expectDropped(quote(9, FAIR, { probabilities }), 'incomplete');
    });
  });

  describe('invalid', () => {
    it.each([
      ['zero', 0],
      ['one', 1],
      ['negative', -0.2],
      ['above one', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a string', '0.5' as unknown as number],
    ])('drops a book with a probability that is %s', (_name, bad) => {
      expectDropped(
        quote(9, FAIR, { probabilities: { home: 0.5, draw: 0.3, away: bad } }),
        'invalid',
      );
    });

    it('drops the repeats of a book ID and judges the first quote on its own', () => {
      const other = { home: 0.52, draw: 0.24, away: 0.24 };
      const repeated = consensus([quote(3), quote(3, other), quote(32), quote(7)], options());
      const alone = consensus([quote(3), quote(32), quote(7)], options());
      expect(expectOk(repeated).dropped).toEqual([{ bookId: 3, reason: 'invalid' }]);
      expect(expectOk(repeated).fair).toEqual(expectOk(alone).fair);
    });

    it('keeps the first quote of an ID even when it is the bad one', () => {
      const broken = quote(3, FAIR, { probabilities: { home: 0.5 } });
      const result = expectOk(consensus([broken, quote(3), quote(32), quote(7)], options()));
      expect(result.booksUsed).toEqual([7, 32]);
      expect(result.dropped).toEqual([
        { bookId: 3, reason: 'incomplete' },
        { bookId: 3, reason: 'invalid' },
      ]);
    });

    it.each([
      ['a fraction', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('drops a book whose ID is %s', (_name, bookId) => {
      const result = expectOk(consensus([...good(), quote(bookId)], options()));
      expect(result.booksUsed).toEqual([3, 7, 32]);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0]?.reason).toBe('invalid');
    });
  });

  describe('overround', () => {
    it('drops a book below 1: a sure win inside one book', () => {
      expectDropped(quote(9, FAIR, { margin: -0.02 }), 'overround');
      expectDropped(quote(9, FAIR, { margin: -1e-6 }), 'overround');
    });

    it('drops a book above 1.2', () => {
      expectDropped(quote(9, FAIR, { margin: 0.25 }), 'overround');
      expectDropped(quote(9, FAIR, { margin: 0.2 + 1e-6 }), 'overround');
    });

    it('keeps a book exactly on a limit', () => {
      for (const margin of [0, 0.2]) {
        const result = expectOk(consensus([...good(), quote(9, FAIR, { margin })], options()));
        expect(result.booksUsed).toEqual([3, 7, 9, 32]);
      }
    });

    it('keeps a book exactly on a limit in decimals, though its float sum is a hair outside it', () => {
      // 0.35 + 0.3 + 0.35 is 0.9999999999999999 and 0.12 + 0.54 + 0.54 is 1.2000000000000002.
      const cases = [
        {
          fair: { home: 0.35, draw: 0.3, away: 0.35 },
          margin: 0,
          outside: (sum: number) => sum < 1,
        },
        {
          fair: { home: 0.1, draw: 0.45, away: 0.45 },
          margin: 0.2,
          outside: (sum: number) => sum > 1.2,
        },
      ];
      for (const { fair, margin, outside } of cases) {
        const sum = Object.values(withMargin(fair, margin)).reduce((a, b) => a + b, 0);
        expect(outside(sum)).toBe(true);
        const quotes = [3, 32, 7].map((id) => quote(id, fair, { margin }));
        const result = expectOk(consensus(quotes, options()));
        expect(result.booksUsed).toEqual([3, 7, 32]);
        expect(result.dropped).toEqual([]);
      }
    });

    it('measures the overround as the sum, whatever the outcomes are called', () => {
      const result = expectOk(
        consensus(
          [3, 32, 7].map((id) => ({
            bookId: id,
            probabilities: { over: 0.55, under: 0.5 },
            updatedAt: NOW,
            liquidityUsd: null,
          })),
          options({ outcomes: ['over', 'under'] }),
        ),
      );
      expect(result.dropped).toEqual([]);
    });
  });

  describe('stale', () => {
    it('keeps a price exactly as old as the limit and drops one a millisecond older', () => {
      const maxBookAgeMs = 30 * MINUTE;
      const atLimit = quote(9, FAIR, { updatedAt: new Date(NOW.getTime() - maxBookAgeMs) });
      const over = quote(9, FAIR, { updatedAt: new Date(NOW.getTime() - maxBookAgeMs - 1) });
      const used = expectOk(consensus([...good(), atLimit], options({ maxBookAgeMs })));
      expect(used.booksUsed).toEqual([3, 7, 9, 32]);
      expectDropped(over, 'stale', { maxBookAgeMs });
    });

    it('drops a book whose time is not a valid date', () => {
      expectDropped(quote(9, FAIR, { updatedAt: new Date(Number.NaN) }), 'stale');
      expectDropped(
        quote(9, FAIR, { updatedAt: '2026-11-01T11:59:00Z' as unknown as Date }),
        'stale',
      );
      expectDropped(quote(9, FAIR, { updatedAt: undefined as unknown as Date }), 'stale');
    });

    it('counts only a price time older than the limit: a time in the future is fresh', () => {
      const future = quote(9, FAIR, { updatedAt: new Date(NOW.getTime() + HOUR) });
      const result = expectOk(consensus([...good(), future], options()));
      expect(result.booksUsed).toEqual([3, 7, 9, 32]);
    });

    it('allows a limit of 0: only a price made this instant counts', () => {
      const result = expectOk(consensus(good(), options({ maxBookAgeMs: 0 })));
      expect(result.booksUsed).toEqual([3, 7, 32]);
      const old = quote(9, FAIR, { updatedAt: new Date(NOW.getTime() - 1) });
      expectDropped(old, 'stale', { maxBookAgeMs: 0 });
    });
  });

  describe('unhealthy', () => {
    it('drops a book the healthy set does not list', () => {
      expectDropped(quote(9), 'unhealthy', { healthyBooks: new Set([3, 32, 7]) });
    });

    it('drops every book when the healthy set is empty, which is not the same as unknown', () => {
      const result = expectRefused(consensus(good(), options({ healthyBooks: new Set() })));
      expect(result.reason).toBe('no_books');
      expect(result.dropped).toEqual([
        { bookId: 3, reason: 'unhealthy' },
        { bookId: 7, reason: 'unhealthy' },
        { bookId: 32, reason: 'unhealthy' },
      ]);
    });

    it('lets every book count when health is unknown', () => {
      const result = expectOk(consensus([...good(), quote(77)], options({ healthyBooks: null })));
      expect(result.booksUsed).toEqual([3, 7, 32, 77]);
    });
  });

  it('applies the checks in order: incomplete, invalid, overround, stale, unhealthy', () => {
    const stale = new Date(NOW.getTime() - 7 * HOUR);
    const unhealthy = new Set([3, 32, 7]);
    const quotes = [
      ...good(),
      // Everything wrong at once: the first check names it.
      quote(1, FAIR, { probabilities: { home: 0.5 }, updatedAt: stale, margin: 0.5 }),
      // Invalid, over the overround and stale: invalid.
      quote(2, FAIR, {
        probabilities: { home: 0, draw: 0.9, away: 0.9 },
        updatedAt: stale,
      }),
      // Over the overround, stale and unhealthy: overround.
      quote(4, FAIR, { margin: 0.5, updatedAt: stale }),
      // Stale and unhealthy: stale.
      quote(5, FAIR, { updatedAt: stale }),
      // Only unhealthy.
      quote(6),
    ];
    const result = expectOk(consensus(quotes, options({ healthyBooks: unhealthy })));
    expect(result.booksUsed).toEqual([3, 7, 32]);
    expect(result.dropped).toEqual([
      { bookId: 1, reason: 'incomplete' },
      { bookId: 2, reason: 'invalid' },
      { bookId: 4, reason: 'overround' },
      { bookId: 5, reason: 'stale' },
      { bookId: 6, reason: 'unhealthy' },
    ]);
  });
});

describe('consensus: outliers (P5)', () => {
  const near = (home: number): Record<string, number> => ({
    home,
    draw: 0.25,
    away: 0.75 - home,
  });

  it('drops a book more than 4 pp from the median on any outcome', () => {
    expectDropped(quote(9, { home: 0.6, draw: 0.25, away: 0.15 }), 'outlier');
    // Only the draw is off.
    expectDropped(quote(9, { home: 0.5, draw: 0.35, away: 0.15 }), 'outlier');
    // Draw and away are a hair more than 4 pp off.
    expectDropped(quote(9, { home: 0.5, draw: 0.25 - 0.0401, away: 0.25 + 0.0401 }), 'outlier');
  });

  it('keeps a book exactly 4 pp from the median', () => {
    const result = expectOk(
      consensus([...good(), quote(9, near(0.5 + OUTLIER_MAX_GAP))], options()),
    );
    expect(result.booksUsed).toEqual([3, 7, 9, 32]);
    expect(result.dropped).toEqual([]);
  });

  it('takes the mean of the two middle values as the median of an even count', () => {
    // Home values 0.46, 0.46, 0.54, 0.54: the median 0.50 is 4 pp from every book, so all stay.
    const quotes = [
      quote(3, near(0.46)),
      quote(32, near(0.46)),
      quote(7, near(0.54)),
      quote(9, near(0.54)),
    ];
    const result = expectOk(consensus(quotes, options()));
    expect(result.booksUsed).toEqual([3, 7, 9, 32]);
    expect(result.fair.home).toBeCloseTo(0.5, 12);
    // The same four books 0.001 further apart are all more than 4 pp from the median.
    const apart = [
      quote(3, near(0.4595)),
      quote(32, near(0.4595)),
      quote(7, near(0.5405)),
      quote(9, near(0.5405)),
    ];
    expect(expectRefused(consensus(apart, options())).reason).toBe('too_few_books');
  });

  it('compares every book with the same medians in one pass', () => {
    // Home 0.40 .. 0.60 in steps of 5 pp: the median is 0.50, so four books are 5 pp or more from it.
    // Dropping the extremes first and re-taking the median would keep more of them.
    const quotes = [
      quote(3, near(0.4)),
      quote(32, near(0.45)),
      quote(7, near(0.5)),
      quote(9, near(0.55)),
      quote(19, near(0.6)),
    ];
    const result = expectRefused(consensus(quotes, options({ anchors: [3, 32, 7] })));
    expect(result.reason).toBe('too_few_books');
    expect(result.dropped).toEqual([
      { bookId: 3, reason: 'outlier' },
      { bookId: 9, reason: 'outlier' },
      { bookId: 19, reason: 'outlier' },
      { bookId: 32, reason: 'outlier' },
    ]);
  });

  it('does not let one book shift the median far enough to save itself', () => {
    const quotes = [
      ...good(),
      quote(9, { home: 0.8, draw: 0.1, away: 0.1 }),
      quote(19, { home: 0.1, draw: 0.1, away: 0.8 }),
    ];
    const result = expectOk(consensus(quotes, options()));
    expect(result.booksUsed).toEqual([3, 7, 32]);
    expect(result.dropped).toEqual([
      { bookId: 9, reason: 'outlier' },
      { bookId: 19, reason: 'outlier' },
    ]);
  });
});

describe('consensus: when there is none', () => {
  it('is no_books without quotes', () => {
    expect(consensus([], options())).toEqual({ ok: false, reason: 'no_books', dropped: [] });
  });

  it('is no_books when no quote passes the checks', () => {
    const stale = new Date(NOW.getTime() - 7 * HOUR);
    const result = expectRefused(
      consensus(
        [quote(3, FAIR, { updatedAt: stale }), quote(32, FAIR, { margin: -0.1 })],
        options(),
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'no_books',
      dropped: [
        { bookId: 3, reason: 'stale' },
        { bookId: 32, reason: 'overround' },
      ],
    });
  });

  it('is too_few_books with one book left', () => {
    expect(consensus([quote(3)], options())).toEqual({
      ok: false,
      reason: 'too_few_books',
      dropped: [],
    });
    const result = expectRefused(
      consensus([quote(3), quote(32, FAIR, { margin: 0.5 })], options()),
    );
    expect(result.reason).toBe('too_few_books');
    expect(result.dropped).toEqual([{ bookId: 32, reason: 'overround' }]);
  });

  it('is too_few_books when two books disagree so much that both are outliers', () => {
    const result = expectRefused(
      consensus(
        [
          quote(3, { home: 0.7, draw: 0.2, away: 0.1 }),
          quote(32, { home: 0.3, draw: 0.3, away: 0.4 }),
        ],
        options(),
      ),
    );
    expect(result.reason).toBe('too_few_books');
    expect(result.dropped).toEqual([
      { bookId: 3, reason: 'outlier' },
      { bookId: 32, reason: 'outlier' },
    ]);
  });

  it('is no_anchor when no used book is an anchor', () => {
    const quotes = [quote(7), quote(9), quote(19)];
    expect(consensus(quotes, options())).toEqual({ ok: false, reason: 'no_anchor', dropped: [] });
  });

  it('is no_anchor when the anchors were dropped', () => {
    const stale = new Date(NOW.getTime() - 7 * HOUR);
    const quotes = [
      quote(3, FAIR, { updatedAt: stale }),
      quote(32, { home: 0.8, draw: 0.1, away: 0.1 }),
      quote(7),
      quote(9),
      quote(19),
    ];
    const result = expectRefused(consensus(quotes, options()));
    expect(result.reason).toBe('no_anchor');
    expect(result.dropped).toEqual([
      { bookId: 3, reason: 'stale' },
      { bookId: 32, reason: 'outlier' },
    ]);
  });

  it('is no_anchor for every set of books when there are no anchors', () => {
    expect(expectRefused(consensus(good(), options({ anchors: [] }))).reason).toBe('no_anchor');
  });

  it('asks for two books before it asks for an anchor', () => {
    expect(consensus([quote(7)], options()).ok).toBe(false);
    expect(expectRefused(consensus([quote(7)], options())).reason).toBe('too_few_books');
  });

  it('works with the anchor being any listed ID', () => {
    const result = expectOk(consensus([quote(7), quote(9), quote(19)], options({ anchors: [19] })));
    expect(result.booksUsed).toEqual([7, 9, 19]);
  });
});

describe('consensus: the value', () => {
  const A = { home: 0.48, draw: 0.3, away: 0.22 };
  const B = { home: 0.46, draw: 0.3, away: 0.24 };
  const C = { home: 0.44, draw: 0.3, away: 0.26 };

  it('is the mean of the books when no weights are given, and the margins do not matter', () => {
    const quotes = [
      quote(3, A, { margin: 0.02 }),
      quote(32, B, { margin: 0.08 }),
      quote(7, C, { margin: 0.12 }),
    ];
    const result = expectOk(consensus(quotes, options()));
    expect(result.fair.home).toBeCloseTo(0.46, 12);
    expect(result.fair.draw).toBeCloseTo(0.3, 12);
    expect(result.fair.away).toBeCloseTo(0.24, 12);
    expect(result.dispersion).toBeCloseTo(0.02, 12);
  });

  it('weights every book 1 when no weights are given, even Pinnacle', () => {
    const plain = expectOk(consensus([quote(3, A), quote(32, B), quote(19, C)], options()));
    expect(plain.fair.home).toBeCloseTo(0.46, 12);
  });

  it('weights the books as told, and a book that is not listed counts 1', () => {
    const quotes = [quote(3, A), quote(32, B), quote(19, C)];
    const result = expectOk(consensus(quotes, options({ weights: DEFAULT_BOOK_WEIGHTS })));
    expect(result.fair.home).toBeCloseTo((3 * 0.48 + 2 * 0.46 + 0.44) / 6, 12);
    expect(result.fair.draw).toBeCloseTo(0.3, 12);
    expect(result.fair.away).toBeCloseTo((3 * 0.22 + 2 * 0.24 + 0.26) / 6, 12);
    // The book furthest from the mean is the 0.44 one, 2.7 pp away on home (and 2.7 pp on away).
    expect(result.dispersion).toBeCloseTo((3 * 0.48 + 2 * 0.46 + 0.44) / 6 - 0.44, 12);
  });

  it('weights only by the IDs it is given', () => {
    const quotes = [quote(3, A), quote(32, B), quote(7, C)];
    const result = expectOk(consensus(quotes, options({ weights: { 7: 8 } })));
    expect(result.fair.home).toBeCloseTo((0.48 + 0.46 + 8 * 0.44) / 10, 12);
  });

  it('sums to 1 and has the outcomes in the order given', () => {
    const quotes = [quote(3, A), quote(32, B), quote(7, C)];
    const result = expectOk(consensus(quotes, options({ weights: DEFAULT_BOOK_WEIGHTS })));
    const total = Object.values(result.fair).reduce((sum, value) => sum + value, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-12);
    expect(Object.keys(result.fair)).toEqual(OUTCOMES);
  });

  it('works for a two-way market', () => {
    const over = (p: number): Record<string, number> => ({ over: p, under: 1 - p });
    const quotes = [quote(3, over(0.55)), quote(32, over(0.53)), quote(7, over(0.51))];
    const result = expectOk(consensus(quotes, options({ outcomes: ['over', 'under'] })));
    expect(result.fair.over).toBeCloseTo(0.53, 12);
    expect(result.fair.under).toBeCloseTo(0.47, 12);
    expect(Object.keys(result.fair)).toEqual(['over', 'under']);
  });

  it('ignores outcomes the market does not have', () => {
    const withExtra = [3, 32, 7].map((id) =>
      quote(id, FAIR, { probabilities: { ...withMargin(FAIR, 0.05), corners: 0.9 } }),
    );
    const result = expectOk(consensus(withExtra, options()));
    expect(Object.keys(result.fair)).toEqual(OUTCOMES);
    expect(result.dropped).toEqual([]);
  });

  it('does not change its inputs and accepts frozen ones', () => {
    const quotes = Object.freeze(good().map((q) => Object.freeze({ ...q })));
    const opts = options({ anchors: Object.freeze([3]) });
    expect(() => consensus(quotes, opts)).not.toThrow();
  });
});

describe('consensus: confidence', () => {
  const confidenceOf = (quotes: BookQuote[], overrides: Partial<ConsensusOptions> = {}) =>
    expectOk(consensus(quotes, options(overrides))).confidence;

  /** Four books 3, 32, 7, 9 at `d` either side of home 0.5 and away 0.25 (equal weights): a dispersion of d. */
  function split(d: number, liquidityUsd: number | null = null): BookQuote[] {
    const low = { home: 0.5 - d, draw: 0.25, away: 0.25 + d };
    const high = { home: 0.5 + d, draw: 0.25, away: 0.25 - d };
    return [quote(3, low, { liquidityUsd }), quote(32, low), quote(7, high), quote(9, high)];
  }

  const four = (liquidityUsd: number | null = null): BookQuote[] => [
    quote(3, FAIR, { liquidityUsd }),
    quote(32),
    quote(7),
    quote(9),
  ];

  describe('low', () => {
    it('with 2 books', () => {
      expect(confidenceOf([quote(3), quote(32)])).toBe('low');
    });

    it('with a dispersion over 3 pp', () => {
      const result = expectOk(consensus(split(0.035), options()));
      expect(result.dispersion).toBeCloseTo(0.035, 12);
      expect(result.confidence).toBe('low');
    });

    it('with unknown book health, however good the books are', () => {
      expect(confidenceOf(four(), { healthyBooks: null })).toBe('low');
    });

    it('with Pinnacle used and its max stake known and under 250 USD', () => {
      expect(confidenceOf(four(249.99))).toBe('low');
      expect(confidenceOf(four(0))).toBe('low');
    });

    it('reads the max stake of the book it is told is Pinnacle', () => {
      expect(confidenceOf(four(100))).toBe('low');
      expect(confidenceOf(four(100), { pinnacleBookId: 32 })).toBe('high');
      const second = [quote(3), quote(32, FAIR, { liquidityUsd: 100 }), quote(7), quote(9)];
      expect(confidenceOf(second, { pinnacleBookId: 32 })).toBe('low');
      expect(confidenceOf(second)).toBe('high');
    });

    it('does not look at the max stake of a Pinnacle quote that is not used', () => {
      const stale = new Date(NOW.getTime() - 7 * HOUR);
      const quotes = [
        quote(3, FAIR, { liquidityUsd: 10, updatedAt: stale }),
        quote(32),
        quote(7),
        quote(9),
        quote(19),
      ];
      const result = expectOk(consensus(quotes, options()));
      expect(result.dropped).toEqual([{ bookId: 3, reason: 'stale' }]);
      expect(result.confidence).toBe('high');
    });
  });

  describe('high', () => {
    it('with 4 books that agree and a Pinnacle max stake that is unknown', () => {
      expect(confidenceOf(four())).toBe('high');
    });

    it('with Pinnacle not among the books', () => {
      expect(confidenceOf([quote(32), quote(7), quote(9), quote(19)])).toBe('high');
    });

    it('with a Pinnacle max stake of 1000 USD or more', () => {
      expect(confidenceOf(four(1000))).toBe('high');
      expect(confidenceOf(four(25_000))).toBe('high');
    });

    it('with a dispersion under 1.5 pp', () => {
      expect(confidenceOf(split(0.014))).toBe('high');
    });
  });

  describe('normal', () => {
    it('with 3 books that agree', () => {
      expect(confidenceOf(good())).toBe('normal');
      expect(confidenceOf([quote(3), quote(32), quote(7)], { weights: DEFAULT_BOOK_WEIGHTS })).toBe(
        'normal',
      );
    });

    it('with a Pinnacle max stake from 250 up to 1000 USD', () => {
      expect(confidenceOf(four(250))).toBe('normal');
      expect(confidenceOf(four(999.99))).toBe('normal');
    });

    it('with a dispersion from 1.5 to 3 pp', () => {
      expect(confidenceOf(split(0.02))).toBe('normal');
    });

    it('with a dispersion exactly on 1.5 pp: not under it', () => {
      const result = expectOk(consensus(split(0.015), options()));
      expect(result.dispersion).toBeCloseTo(0.015, 12);
      expect(result.confidence).toBe('normal');
    });

    it('with a dispersion exactly on 1.5 pp, even where float noise makes it a hair under', () => {
      // Three books together and a fourth 2 pp away: the furthest from the mean is 3/4 of 2 pp, which
      // floats give as 0.014999999999999986.
      const together = { home: 0.492, draw: 0.25, away: 0.258 };
      const apart = { home: 0.512, draw: 0.25, away: 0.238 };
      const quotes = [quote(3, together), quote(32, together), quote(7, together), quote(9, apart)];
      const result = expectOk(consensus(quotes, options()));
      expect(result.dispersion).toBeCloseTo(0.015, 12);
      expect(result.confidence).toBe('normal');
    });

    it('with a Pinnacle max stake that is not a number: not good news', () => {
      expect(confidenceOf(four(Number.NaN))).toBe('normal');
    });

    it('with a dispersion exactly on 3 pp: not over it', () => {
      const result = expectOk(consensus(split(0.03), options()));
      expect(result.dispersion).toBeCloseTo(0.03, 12);
      expect(result.confidence).toBe('normal');
    });
  });

  it('keeps books exactly 4 pp from the median and rates them low', () => {
    const result = expectOk(consensus(split(OUTLIER_MAX_GAP), options()));
    expect(result.booksUsed).toEqual([3, 7, 9, 32]);
    expect(result.dispersion).toBeCloseTo(0.04, 12);
    expect(result.confidence).toBe('low');
  });

  it('is low when anything says low, whatever else says high', () => {
    // 4 books that agree, but unknown health and a thin Pinnacle book.
    expect(confidenceOf(four(10), { healthyBooks: null })).toBe('low');
  });
});

describe('consensus: invalid options', () => {
  const throwsFor = (overrides: Partial<ConsensusOptions>): void => {
    expect(() => consensus(good(), options(overrides))).toThrow(RangeError);
  };

  it('needs at least 2 outcomes', () => {
    throwsFor({ outcomes: [] });
    throwsFor({ outcomes: ['home'] });
  });

  it('needs distinct outcomes', () => {
    throwsFor({ outcomes: ['home', 'draw', 'home'] });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '2' as unknown as number],
  ])('needs a finite weight above 0, not %s', (_name, weight) => {
    throwsFor({ weights: { 3: weight } });
    // Even for a book that is not among the quotes.
    throwsFor({ weights: { 3: 2, 999: weight } });
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '60000' as unknown as number],
  ])('needs a finite maxBookAgeMs of at least 0, not %s', (_name, maxBookAgeMs) => {
    throwsFor({ maxBookAgeMs });
  });

  it('needs a valid now: an invalid one would make every price look fresh', () => {
    throwsFor({ now: new Date(Number.NaN) });
    throwsFor({ now: '2026-11-01T12:00:00Z' as unknown as Date });
  });

  it('does not throw for bad quotes, only for bad options', () => {
    const junk = [
      quote(3, FAIR, { probabilities: {} }),
      quote(3),
      quote(Number.NaN),
      quote(32, FAIR, { updatedAt: new Date(Number.NaN) }),
    ];
    expect(() => consensus(junk, options())).not.toThrow();
  });
});

// --- properties -----------------------------------------------------------------------------

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** n positive probabilities summing to 1, none tiny. */
function randomFair(rng: Rng, n: number): number[] {
  const raw = Array.from({ length: n }, () => 0.05 + rng.next());
  const total = sum(raw);
  return raw.map((x) => x / total);
}

const toRecord = (outcomes: readonly string[], values: readonly number[]): Record<string, number> =>
  Object.fromEntries(outcomes.map((outcome, i) => [outcome, values[i]!]));

const BOOK_POOL = [3, 32, 7, 9, 19, 5, 11, 40];

/** Quotes with distinct IDs, mostly sane, some broken in the ways the checks look for. */
function messyQuotes(rng: Rng, outcomes: readonly string[]): BookQuote[] {
  const ids = rng.shuffle(BOOK_POOL).slice(0, rng.int(0, BOOK_POOL.length));
  const center = randomFair(rng, outcomes.length);
  return ids.map((bookId) => {
    const near = rng.next() < 0.75;
    const raw = near
      ? center.map((c) => Math.max(0.02, c + (rng.next() - 0.5) * 0.08))
      : randomFair(rng, outcomes.length);
    const total = sum(raw);
    // Mostly a normal margin; now and then outside [0, 0.2].
    const margin = rng.next() < 0.85 ? rng.next() * 0.15 : -0.05 + rng.next() * 0.4;
    const probabilities = toRecord(
      outcomes,
      raw.map((p) => (p / total) * (1 + margin)),
    );
    const roll = rng.next();
    if (roll < 0.04) delete probabilities[rng.pick(outcomes)];
    else if (roll < 0.07) probabilities[rng.pick(outcomes)] = rng.pick([0, 1, 1.5, Number.NaN]);
    return {
      bookId,
      probabilities,
      updatedAt: new Date(NOW.getTime() - rng.int(0, 8 * HOUR)),
      liquidityUsd: rng.next() < 0.5 ? null : rng.int(0, 3000),
    };
  });
}

function messyOptions(
  rng: Rng,
  outcomes: readonly string[],
  ids: readonly number[],
): ConsensusOptions {
  return {
    outcomes,
    anchors: [3, 32],
    ...(rng.next() < 0.5 ? { weights: DEFAULT_BOOK_WEIGHTS } : {}),
    now: NOW,
    maxBookAgeMs: 6 * HOUR,
    healthyBooks: rng.next() < 0.2 ? null : new Set(ids.filter(() => rng.next() < 0.85)),
  };
}

const MARKETS: ReadonlyArray<readonly string[]> = [
  ['home', 'draw', 'away'],
  ['over', 'under'],
];

describe('consensus: properties', () => {
  it('holds its invariants for any mix of sane and broken books', () => {
    const rng = createRng('consensus-invariants');
    let consensuses = 0;
    for (let i = 0; i < CASES; i++) {
      const outcomes = rng.pick(MARKETS);
      const quotes = messyQuotes(rng, outcomes);
      const ids = quotes.map((q) => q.bookId);
      const opts = messyOptions(rng, outcomes, ids);
      const result = consensus(quotes, opts);

      // The drops are listed by book, each book at most once, and only books that were given.
      const droppedIds = result.dropped.map((d) => d.bookId);
      expect(droppedIds).toEqual([...droppedIds].sort((a, b) => a - b));
      expect(new Set(droppedIds).size).toBe(droppedIds.length);
      for (const id of droppedIds) expect(ids).toContain(id);
      if (!result.ok) {
        // Without a book that passed the checks, every book was dropped.
        if (result.reason === 'no_books') expect(droppedIds).toHaveLength(ids.length);
        continue;
      }
      consensuses++;

      // Every book is accounted for exactly once: used or dropped.
      expect([...result.booksUsed, ...droppedIds].sort((a, b) => a - b)).toEqual(
        [...ids].sort((a, b) => a - b),
      );

      // The fair probabilities sum to 1 and are probabilities.
      expect(Object.keys(result.fair)).toEqual([...outcomes]);
      expect(Math.abs(sum(Object.values(result.fair)) - 1)).toBeLessThan(1e-12);
      for (const p of Object.values(result.fair)) {
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }

      // Each value lies within the used books' own range, and the dispersion is the widest gap.
      const usedFair = quotes
        .filter((q) => result.booksUsed.includes(q.bookId))
        .map((q) => bookFairProbabilities(q.probabilities, outcomes)!.fair);
      expect(usedFair).toHaveLength(result.booksUsed.length);
      let widest = 0;
      for (const outcome of outcomes) {
        const values = usedFair.map((fair) => fair[outcome]!);
        expect(result.fair[outcome]!).toBeGreaterThanOrEqual(Math.min(...values));
        expect(result.fair[outcome]!).toBeLessThanOrEqual(Math.max(...values));
        for (const value of values)
          widest = Math.max(widest, Math.abs(value - result.fair[outcome]!));
      }
      expect(result.dispersion).toBeCloseTo(widest, 12);

      // Books ascending, at least two, one an anchor.
      expect(result.booksUsed).toEqual([...result.booksUsed].sort((a, b) => a - b));
      expect(result.booksUsed.length).toBeGreaterThanOrEqual(MIN_CONSENSUS_BOOKS);
      expect(result.booksUsed.some((id) => opts.anchors.includes(id))).toBe(true);

      // Confidence never exceeds what the books allow.
      if (opts.healthyBooks === null || result.booksUsed.length <= LOW_CONFIDENCE_MAX_BOOKS) {
        expect(result.confidence).toBe('low');
      }
      if (result.confidence === 'high') {
        expect(result.booksUsed.length).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_MIN_BOOKS);
        expect(result.dispersion).toBeLessThan(HIGH_CONFIDENCE_MAX_DISPERSION);
      }
    }
    // The cases are not vacuous: a good share of them produce a consensus.
    expect(consensuses).toBeGreaterThan(CASES * 0.2);
  });

  it('does not depend on the order of the quotes', () => {
    const rng = createRng('consensus-order');
    for (let i = 0; i < CASES; i++) {
      const outcomes = rng.pick(MARKETS);
      const quotes = messyQuotes(rng, outcomes);
      const opts = messyOptions(
        rng,
        outcomes,
        quotes.map((q) => q.bookId),
      );
      const expected = consensus(quotes, opts);
      for (let k = 0; k < 3; k++) {
        expect(consensus(rng.shuffle(quotes), opts)).toEqual(expected);
      }
    }
  });

  it('is not moved by one wild book among at least 3 sane ones (it is dropped)', () => {
    const rng = createRng('consensus-wild-book');
    const outcomes = OUTCOMES;
    for (let i = 0; i < CASES; i++) {
      // The books' common view, and books within 0.5 pp of it on every outcome (1 pp apart at most).
      const raw = randomFair(rng, 3);
      const center = raw.map((p) => 0.5 * p + 0.5 / 3);
      const baseIds = [3, ...rng.shuffle([32, 7, 9, 19]).slice(0, rng.int(2, 4))];
      const base = baseIds.map((bookId) => {
        const e1 = (rng.next() * 2 - 1) * 0.0025;
        const e2 = (rng.next() * 2 - 1) * 0.0025;
        const fair = [center[0]! + e1, center[1]! + e2, center[2]! - e1 - e2];
        const margin = 0.02 + rng.next() * 0.1;
        return {
          bookId,
          probabilities: toRecord(
            outcomes,
            fair.map((p) => p * (1 + margin)),
          ),
          updatedAt: new Date(NOW.getTime() - rng.int(0, HOUR)),
          liquidityUsd: null,
        } satisfies BookQuote;
      });

      // One outcome moved by more than 2 * OUTLIER_MAX_GAP; the others share what is left.
      const k = rng.int(0, 2);
      const down = rng.next() < 0.5;
      const size = 2 * OUTLIER_MAX_GAP + 0.001 + rng.next() * 0.1;
      const moved = down
        ? center[k]! - Math.min(size, center[k]! - 0.03)
        : center[k]! + Math.min(size, 0.85 - center[k]!);
      expect(Math.abs(moved - center[k]!)).toBeGreaterThan(2 * OUTLIER_MAX_GAP);
      const wildFair = center.map((p, j) =>
        j === k ? moved : (p * (1 - moved)) / (1 - center[k]!),
      );
      const wildMargin = 0.02 + rng.next() * 0.08;
      const wild: BookQuote = {
        bookId: 99,
        probabilities: toRecord(
          outcomes,
          wildFair.map((p) => p * (1 + wildMargin)),
        ),
        updatedAt: NOW,
        liquidityUsd: null,
      };

      const opts = options({
        anchors: [3],
        healthyBooks: new Set([...baseIds, 99]),
        ...(rng.next() < 0.5 ? { weights: DEFAULT_BOOK_WEIGHTS } : {}),
      });
      const without = expectOk(consensus(base, opts));
      const withWild = expectOk(consensus(rng.shuffle([...base, wild]), opts));

      expect(withWild.dropped).toEqual([{ bookId: 99, reason: 'outlier' }]);
      expect(withWild.booksUsed).toEqual(without.booksUsed);
      for (const outcome of outcomes) {
        expect(Math.abs(withWild.fair[outcome]! - without.fair[outcome]!)).toBeLessThanOrEqual(
          1e-9,
        );
      }
      expect(Math.abs(withWild.dispersion - without.dispersion)).toBeLessThanOrEqual(1e-9);
      expect(withWild.confidence).toBe(without.confidence);
    }
  });

  it('never uses a book whose overround is below 1', () => {
    const rng = createRng('consensus-sure-win');
    for (let i = 0; i < CASES; i++) {
      const outcomes = rng.pick(MARKETS);
      const quotes = messyQuotes(rng, outcomes).filter((q) => q.bookId !== 50);
      const fair = randomFair(rng, outcomes.length);
      // An overround from 0.8 up to just under 1 (at least 1e-4 under it).
      const overround = 0.8 + rng.next() * (0.2 - 1e-4);
      const sureWin: BookQuote = {
        bookId: 50,
        probabilities: toRecord(
          outcomes,
          fair.map((p) => p * overround),
        ),
        updatedAt: NOW,
        liquidityUsd: null,
      };
      expect(overround).toBeLessThan(OVERROUND_BOOK_MIN);
      const ids = [...quotes.map((q) => q.bookId), 50];
      const opts = { ...messyOptions(rng, outcomes, ids), healthyBooks: null };
      const result = consensus(rng.shuffle([...quotes, sureWin]), opts);
      expect(result.dropped).toContainEqual({ bookId: 50, reason: 'overround' });
      if (result.ok) expect(result.booksUsed).not.toContain(50);
    }
  });
});
