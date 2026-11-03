import { fairProbabilities, isValidDecimalPrice, type DevigMethod } from './devig';

/**
 * The market consensus: one set of fair probabilities from many bookmakers'
 * prices for the same market (docs/odds-api-integration-plan.md §4).
 *
 * 1. Quotes that are malformed or older than `notBefore` are ignored.
 * 2. Each bookmaker's margin is removed (power method by default).
 * 3. With three or more books, a book that strays too far from the median on
 *    any outcome is dropped as an outlier (a stale or mistaken price).
 * 4. The remaining fair probabilities are averaged with per-book weights
 *    (sharp books count more).
 * 5. The result is refused when too few books are left, when no sharp book
 *    is left and one is required, or when the books still disagree widely
 *    (usually news some books have not priced yet). Refused markets are not
 *    offered: suspended is better than wrong.
 */

/** One bookmaker's current prices for one market. */
export interface BookQuote {
  /** Bookmaker key ('pinnacle', 'betfair_ex_eu', …). */
  bookmaker: string;
  /** When the bookmaker last changed this market. */
  updatedAt: Date;
  /** Decimal prices, one per outcome, in the market's selection order. */
  prices: readonly number[];
}

/**
 * The sharpest books The Odds API carries: Pinnacle (a low-margin,
 * high-limit book whose prices lead the market) and the betting exchanges.
 */
export const SHARP_BOOKS: ReadonlySet<string> = new Set([
  'pinnacle',
  'betfair_ex_eu',
  'betfair_ex_uk',
  'betfair_ex_au',
  'matchbook',
  'smarkets',
]);

/**
 * Default consensus weights; any other book counts 1. Exchanges count less
 * than Pinnacle because their prices are thin on small leagues.
 */
export const DEFAULT_BOOK_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  pinnacle: 3,
  betfair_ex_eu: 2,
  betfair_ex_uk: 2,
  betfair_ex_au: 2,
  matchbook: 2,
  smarkets: 2,
});

export const DEFAULT_MIN_BOOKS = 2;
/** A book is an outlier beyond this many robust standard deviations (1.4826 × MAD)… */
export const DEFAULT_OUTLIER_MADS = 3;
/** …and never closer than this to the median (3 percentage points). */
export const DEFAULT_MIN_OUTLIER_BAND = 0.03;
/** The widest gap (8 pp) between a used book and the consensus that is still priced. */
export const DEFAULT_MAX_DISAGREEMENT = 0.08;
/** Scales the median absolute deviation to a standard deviation for normal data. */
const MAD_TO_SD = 1.4826;

export interface ConsensusOptions {
  /** Quotes last changed before this instant are stale and ignored. */
  notBefore: Date;
  /** Fewest books that must remain (default 2). */
  minBooks?: number;
  /** Weight per bookmaker key; books not listed weigh 1 (default DEFAULT_BOOK_WEIGHTS). */
  weights?: Readonly<Record<string, number>>;
  method?: DevigMethod;
  outlierMads?: number;
  minOutlierBand?: number;
  maxDisagreement?: number;
  /** Books that count as sharp (default SHARP_BOOKS). */
  sharpBooks?: ReadonlySet<string>;
  /** Refuse the market unless a sharp book is among those used. */
  requireSharp?: boolean;
}

export type ConsensusRejection = 'too_few_books' | 'no_sharp_book' | 'books_disagree';

export interface ConsensusExclusions {
  /** Quotes with the wrong number of prices or a price that is not above 1. */
  invalid: number;
  /** Quotes older than `notBefore`. */
  stale: number;
  /** Books dropped as outliers. */
  outliers: string[];
}

export type ConsensusResult =
  | {
      ok: true;
      /** Fair probabilities in outcome order, summing to 1. */
      probabilities: number[];
      /** The books used, in input order. */
      books: string[];
      sharpBooks: number;
      /** Largest gap between a used book's fair probability and the consensus. */
      disagreement: number;
      /** The most recent change among the books used. */
      newest: Date;
      excluded: ConsensusExclusions;
    }
  | {
      ok: false;
      reason: ConsensusRejection;
      /** The books that were still in play when the market was refused. */
      books: string[];
      excluded: ConsensusExclusions;
    };

interface FairBook {
  bookmaker: string;
  updatedAt: Date;
  fair: number[];
}

/**
 * The consensus of `quotes` for a market with `outcomes` outcomes. When a
 * bookmaker appears more than once, its most recent quote is used.
 */
export function marketConsensus(
  quotes: readonly BookQuote[],
  outcomes: number,
  options: ConsensusOptions,
): ConsensusResult {
  if (!Number.isSafeInteger(outcomes) || outcomes < 2) {
    throw new RangeError(`a market has at least two outcomes, got ${outcomes}`);
  }
  const minBooks = options.minBooks ?? DEFAULT_MIN_BOOKS;
  if (!Number.isSafeInteger(minBooks) || minBooks < 1) {
    throw new RangeError(`minBooks must be a positive integer, got ${minBooks}`);
  }
  const weights = options.weights ?? DEFAULT_BOOK_WEIGHTS;
  const sharp = options.sharpBooks ?? SHARP_BOOKS;
  const excluded: ConsensusExclusions = { invalid: 0, stale: 0, outliers: [] };

  const latest = new Map<string, BookQuote>();
  for (const quote of quotes) {
    const seen = latest.get(quote.bookmaker);
    if (seen === undefined || quote.updatedAt.getTime() > seen.updatedAt.getTime()) {
      latest.set(quote.bookmaker, quote);
    }
  }

  let books: FairBook[] = [];
  for (const quote of latest.values()) {
    if (
      quote.prices.length !== outcomes ||
      !quote.prices.every(isValidDecimalPrice) ||
      Number.isNaN(quote.updatedAt.getTime())
    ) {
      excluded.invalid++;
      continue;
    }
    if (quote.updatedAt.getTime() < options.notBefore.getTime()) {
      excluded.stale++;
      continue;
    }
    books.push({
      bookmaker: quote.bookmaker,
      updatedAt: quote.updatedAt,
      fair: fairProbabilities(quote.prices, options.method),
    });
  }

  if (books.length >= 3) {
    const outliers = outlierBooks(
      books,
      outcomes,
      options.outlierMads ?? DEFAULT_OUTLIER_MADS,
      options.minOutlierBand ?? DEFAULT_MIN_OUTLIER_BAND,
    );
    excluded.outliers = books.filter((_, i) => outliers.has(i)).map((book) => book.bookmaker);
    books = books.filter((_, i) => !outliers.has(i));
  }

  const names = books.map((book) => book.bookmaker);
  if (books.length < minBooks || books.length === 0) {
    return { ok: false, reason: 'too_few_books', books: names, excluded };
  }
  const sharpBooks = books.filter((book) => sharp.has(book.bookmaker)).length;
  if (options.requireSharp === true && sharpBooks === 0) {
    return { ok: false, reason: 'no_sharp_book', books: names, excluded };
  }

  const probabilities = weightedMean(books, outcomes, weights);
  let disagreement = 0;
  for (const book of books) {
    for (let j = 0; j < outcomes; j++) {
      disagreement = Math.max(
        disagreement,
        Math.abs((book.fair[j] ?? 0) - (probabilities[j] ?? 0)),
      );
    }
  }
  if (disagreement > (options.maxDisagreement ?? DEFAULT_MAX_DISAGREEMENT)) {
    return { ok: false, reason: 'books_disagree', books: names, excluded };
  }
  const newest = new Date(Math.max(...books.map((book) => book.updatedAt.getTime())));
  return { ok: true, probabilities, books: names, sharpBooks, disagreement, newest, excluded };
}

/** Indexes of the books more than the robust band away from the median on any outcome. */
function outlierBooks(
  books: readonly FairBook[],
  outcomes: number,
  mads: number,
  minBand: number,
): Set<number> {
  const outliers = new Set<number>();
  for (let j = 0; j < outcomes; j++) {
    const values = books.map((book) => book.fair[j] ?? 0);
    const center = median(values);
    const mad = median(values.map((value) => Math.abs(value - center)));
    const band = Math.max(minBand, mads * MAD_TO_SD * mad);
    values.forEach((value, i) => {
      if (Math.abs(value - center) > band) outliers.add(i);
    });
  }
  return outliers;
}

function weightedMean(
  books: readonly FairBook[],
  outcomes: number,
  weights: Readonly<Record<string, number>>,
): number[] {
  const sums = new Array<number>(outcomes).fill(0);
  let total = 0;
  for (const book of books) {
    const listed = Object.hasOwn(weights, book.bookmaker) ? weights[book.bookmaker] : undefined;
    const weight = listed !== undefined && Number.isFinite(listed) && listed > 0 ? listed : 1;
    total += weight;
    for (let j = 0; j < outcomes; j++) sums[j] = (sums[j] ?? 0) + weight * (book.fair[j] ?? 0);
  }
  const mean = sums.map((sum) => sum / total);
  const sum = mean.reduce((acc, value) => acc + value, 0);
  return mean.map((value) => value / sum);
}

/** The median of a non-empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
