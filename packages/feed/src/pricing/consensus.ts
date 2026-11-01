/**
 * The consensus of several sportsbooks' prices for one market: rule P4 (which
 * books count) and rule P5 (outliers, the weighted mean, dispersion and
 * confidence) of docs/therundown-plan/README.md section 5.5.
 *
 * Pure: no I/O, no clock (`now` is an option) and no randomness. Probabilities
 * are plain numbers in [0, 1], never money. A book is de-margined by
 * proportional scaling, the same model `priceBook` (book.ts) uses to add a
 * margin, so a book priced with `priceBook` gives back the probabilities it
 * was made from.
 *
 * Fail closed: a book that fails any check does not count, and everything that
 * is not clearly a consensus (too few books, no anchor, books that disagree)
 * is a refusal with a reason, never a guess.
 */

/** P4: the least a book's overround (the sum of its implied probabilities) may be. Below it is a sure win inside one book: an error. */
export const OVERROUND_BOOK_MIN = 1.0;
/** P4: the most a book's overround may be. */
export const OVERROUND_BOOK_MAX = 1.2;
/** P5: a book with any outcome more than this (0.04 = 4 percentage points) from the median of the books is an outlier. */
export const OUTLIER_MAX_GAP = 0.04;
/** P5: the fewest books that make a consensus. */
export const MIN_CONSENSUS_BOOKS = 2;
/** P5: with this many books or fewer the confidence is low. */
export const LOW_CONFIDENCE_MAX_BOOKS = 2;
/** P5: high confidence needs at least this many books. */
export const HIGH_CONFIDENCE_MIN_BOOKS = 4;
/** P5: high confidence needs the dispersion under this. */
export const HIGH_CONFIDENCE_MAX_DISPERSION = 0.015;
/** P5: a dispersion over this makes the confidence low. */
export const LOW_CONFIDENCE_MIN_DISPERSION = 0.03;
/** P5: Pinnacle's max stake under this (USD) makes the confidence low. */
export const PINNACLE_LOW_LIMIT_USD = 250;
/** P5: high confidence needs Pinnacle's max stake, when known, at least this (USD). */
export const PINNACLE_HIGH_LIMIT_USD = 1000;

/**
 * P5: the weight of each book in the mean, by TheRundown's affiliate ID:
 * Pinnacle (3) 3; Circa (32), BookMaker (7) and BetCRIS (9) 2. A book that is
 * not listed weighs 1. `consensus` weighs every book 1 unless it is given
 * weights: pass these to get P5's.
 */
export const DEFAULT_BOOK_WEIGHTS: Readonly<Record<number, number>> = Object.freeze({
  3: 3,
  32: 2,
  7: 2,
  9: 2,
});

/** Pinnacle's affiliate ID at TheRundown. */
const PINNACLE_BOOK_ID = 3;

/**
 * Float noise allowed where a computed value meets a limit written as a
 * decimal: a value of 0.04 (computed as 0.04000000000000003) is on the limit
 * of 0.04, not over it. Far below anything a price can resolve.
 */
const LIMIT_EPSILON = 1e-9;

/** One sportsbook's prices for one market of one event. */
export interface BookQuote {
  bookId: number;
  /** Implied probability per outcome code, with the book's margin (their sum is the book's overround). */
  probabilities: Readonly<Record<string, number>>;
  /** Newest price time of this book in this market. */
  updatedAt: Date;
  /** The book's max stake in USD (Pinnacle publishes one); null when unknown. */
  liquidityUsd: number | null;
}

/** Why a book's quote was left out (P4 and P5). */
export type BookDropReason =
  'incomplete' | 'invalid' | 'overround' | 'stale' | 'unhealthy' | 'outlier';

export type ConsensusConfidence = 'high' | 'normal' | 'low';

export interface ConsensusOptions {
  /** The outcome codes of the market, e.g. ['home', 'draw', 'away'] or ['over', 'under']: at least 2, distinct. */
  outcomes: readonly string[];
  /** Book IDs of which at least one must be among the books used (Pinnacle 3, Circa 32). */
  anchors: readonly number[];
  /**
   * Weight per book ID, each finite and above 0. A book with no entry weighs 1,
   * and so does every book when this is omitted (P5's weights: DEFAULT_BOOK_WEIGHTS).
   */
  weights?: Readonly<Record<number, number>>;
  now: Date;
  /** A book whose newest price is older than this does not count (P4: 6 h, 30 min in the last 3 h). */
  maxBookAgeMs: number;
  /**
   * The books `GET /api/v2/affiliates` calls healthy. A book outside the set is left out. null means
   * unknown: every book may count, but the confidence is at most 'low'.
   */
  healthyBooks: ReadonlySet<number> | null;
  /** The book whose `liquidityUsd` is read for the confidence. Default 3 (Pinnacle). */
  pinnacleBookId?: number;
}

type Dropped = { bookId: number; reason: BookDropReason };

export type ConsensusResult =
  | {
      ok: true;
      /** Per outcome, the fair probability; they sum to 1. */
      fair: Record<string, number>;
      /** The IDs of the books used, ascending. */
      booksUsed: number[];
      /**
       * The quotes left out, by book ID. A repeated ID has its first quote judged on its own and every other
       * quote of that ID listed here as 'invalid'.
       */
      dropped: Array<{ bookId: number; reason: BookDropReason }>;
      /** The largest gap between a used book's fair probability and the consensus, over books and outcomes. */
      dispersion: number;
      confidence: ConsensusConfidence;
    }
  | {
      ok: false;
      /**
       * no_books: no quote passed the checks (or there were none); too_few_books: fewer than
       * MIN_CONSENSUS_BOOKS were left after the outliers; no_anchor: none of them is an anchor.
       */
      reason: 'no_books' | 'too_few_books' | 'no_anchor';
      dropped: Array<{ bookId: number; reason: BookDropReason }>;
    };

type ProbabilityCheck =
  | { ok: true; fair: Record<string, number>; overround: number }
  | { ok: false; reason: 'incomplete' | 'invalid' };

/**
 * Checks one book's implied probabilities and de-margins them. A missing
 * outcome (no entry, undefined or null) is 'incomplete' and wins over a bad
 * value; a value that is not a finite number in (0, 1) is 'invalid'. Keys that
 * are not outcomes are ignored.
 */
function checkProbabilities(probabilities: unknown, outcomes: readonly string[]): ProbabilityCheck {
  if (typeof probabilities !== 'object' || probabilities === null || outcomes.length === 0) {
    return { ok: false, reason: 'incomplete' };
  }
  const record = probabilities as Readonly<Record<string, unknown>>;
  const values: number[] = [];
  let invalid = false;
  for (const outcome of outcomes) {
    const value = Object.hasOwn(record, outcome) ? record[outcome] : undefined;
    if (value === undefined || value === null) return { ok: false, reason: 'incomplete' };
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1) {
      values.push(value);
    } else {
      invalid = true;
    }
  }
  if (invalid) return { ok: false, reason: 'invalid' };
  const overround = values.reduce((sum, value) => sum + value, 0);
  const fair = Object.fromEntries(outcomes.map((outcome, i) => [outcome, values[i]! / overround]));
  return { ok: true, fair, overround };
}

/**
 * One book's fair probabilities: its implied probabilities divided by their
 * sum (the proportional de-margin, the model of `priceBook`), with that sum as
 * the overround. Null when an outcome is missing or a probability is not a
 * finite number in (0, 1). Keys that are not in `outcomes` are ignored.
 */
export function bookFairProbabilities(
  probabilities: Readonly<Record<string, number>>,
  outcomes: readonly string[],
): { fair: Record<string, number>; overround: number } | null {
  const checked = checkProbabilities(probabilities, outcomes);
  return checked.ok ? { fair: checked.fair, overround: checked.overround } : null;
}

/** The middle value; with an even count the mean of the two middle ones. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Ascending; a number that is not a number (NaN) sorts last, so any list has one order. */
function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
  if (Number.isNaN(b)) return -1;
  return a < b ? -1 : 1;
}

/** By book ID, then reason: the same list whatever the order of the quotes. */
function sortedDropped(dropped: readonly Dropped[]): Dropped[] {
  return [...dropped].sort(
    (a, b) =>
      compareNumbers(a.bookId, b.bookId) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
}

function checkOptions(options: ConsensusOptions): void {
  const { outcomes, weights, maxBookAgeMs, now } = options;
  if (!Array.isArray(outcomes) || outcomes.length < 2) {
    throw new RangeError('outcomes needs at least 2 outcome codes');
  }
  if (new Set<string>(outcomes).size !== outcomes.length) {
    throw new RangeError('outcomes must be distinct');
  }
  if (weights !== undefined) {
    for (const [bookId, weight] of Object.entries(weights)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        throw new RangeError(`the weight of book ${bookId} must be a finite number above 0`);
      }
    }
  }
  if (typeof maxBookAgeMs !== 'number' || !Number.isFinite(maxBookAgeMs) || maxBookAgeMs < 0) {
    throw new RangeError('maxBookAgeMs must be a finite number of at least 0');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('now must be a valid Date');
  }
}

interface Candidate {
  bookId: number;
  liquidityUsd: unknown;
  fair: Record<string, number>;
}

/**
 * The consensus of the books' prices for one market.
 *
 * Per book, in this order (P4): a repeated `bookId` keeps its first quote and
 * drops the others as 'invalid' (so does an ID that is not an integer); an
 * outcome with no probability is 'incomplete'; a probability that is not a
 * finite number in (0, 1) is 'invalid'; an overround outside
 * [OVERROUND_BOOK_MIN, OVERROUND_BOOK_MAX] is 'overround'; a newest price
 * older than `maxBookAgeMs` (or `updatedAt` not a valid Date) is 'stale'; a
 * book `healthyBooks` does not list is 'unhealthy'. Books on a limit pass.
 *
 * Outliers (P5), one pass: per outcome the median of the remaining books' fair
 * probabilities, and every book with any outcome further than OUTLIER_MAX_GAP
 * from its median is dropped as 'outlier'. Fewer than MIN_CONSENSUS_BOOKS left
 * is 'too_few_books'; no anchor among them is 'no_anchor'.
 *
 * The consensus is the weighted mean of the used books' fair probabilities per
 * outcome, scaled to sum to 1 and kept within the books' range. It does not
 * depend on the order of `quotes` (except which quote of a repeated ID is
 * first).
 *
 * Confidence: 'low' with 2 books, a dispersion over LOW_CONFIDENCE_MIN_DISPERSION,
 * unknown book health, or Pinnacle used with a known max stake under
 * PINNACLE_LOW_LIMIT_USD. Else 'high' with at least HIGH_CONFIDENCE_MIN_BOOKS
 * books, a dispersion under HIGH_CONFIDENCE_MAX_DISPERSION and Pinnacle not
 * used, its max stake unknown or at least PINNACLE_HIGH_LIMIT_USD. Else 'normal'.
 *
 * @throws RangeError for invalid options only: fewer than 2 outcomes,
 * repeated outcomes, a weight that is not finite and above 0, `maxBookAgeMs`
 * not a finite number of at least 0, or an invalid `now`.
 */
export function consensus(
  quotes: readonly BookQuote[],
  options: ConsensusOptions,
): ConsensusResult {
  checkOptions(options);
  const { outcomes, anchors, weights, healthyBooks, maxBookAgeMs } = options;
  const pinnacleBookId = options.pinnacleBookId ?? PINNACLE_BOOK_ID;
  const nowMs = options.now.getTime();

  const dropped: Dropped[] = [];
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const quote of quotes) {
    const { bookId } = quote;
    if (!Number.isSafeInteger(bookId) || seen.has(bookId)) {
      dropped.push({ bookId, reason: 'invalid' });
      continue;
    }
    seen.add(bookId);
    const checked = checkProbabilities(quote.probabilities, outcomes);
    if (!checked.ok) {
      dropped.push({ bookId, reason: checked.reason });
      continue;
    }
    if (
      checked.overround < OVERROUND_BOOK_MIN - LIMIT_EPSILON ||
      checked.overround > OVERROUND_BOOK_MAX + LIMIT_EPSILON
    ) {
      dropped.push({ bookId, reason: 'overround' });
      continue;
    }
    const updatedMs = quote.updatedAt instanceof Date ? quote.updatedAt.getTime() : Number.NaN;
    // Written so that an invalid date (NaN) is stale too: NaN is never <=.
    if (!(nowMs - updatedMs <= maxBookAgeMs)) {
      dropped.push({ bookId, reason: 'stale' });
      continue;
    }
    if (healthyBooks !== null && !healthyBooks.has(bookId)) {
      dropped.push({ bookId, reason: 'unhealthy' });
      continue;
    }
    candidates.push({ bookId, liquidityUsd: quote.liquidityUsd, fair: checked.fair });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_books', dropped: sortedDropped(dropped) };
  }

  // P5 outliers: every book against the same medians, in one pass.
  const medians = outcomes.map((outcome) => median(candidates.map((c) => c.fair[outcome]!)));
  const used: Candidate[] = [];
  for (const candidate of candidates) {
    const outlier = outcomes.some(
      (outcome, i) =>
        Math.abs(candidate.fair[outcome]! - medians[i]!) > OUTLIER_MAX_GAP + LIMIT_EPSILON,
    );
    if (outlier) dropped.push({ bookId: candidate.bookId, reason: 'outlier' });
    else used.push(candidate);
  }
  if (used.length < MIN_CONSENSUS_BOOKS) {
    return { ok: false, reason: 'too_few_books', dropped: sortedDropped(dropped) };
  }
  if (!used.some((c) => anchors.includes(c.bookId))) {
    return { ok: false, reason: 'no_anchor', dropped: sortedDropped(dropped) };
  }

  // Ascending by book, so that the sums below run in the same order whatever the order of the quotes.
  used.sort((a, b) => a.bookId - b.bookId);
  const weightOf = (bookId: number): number =>
    weights !== undefined && Object.hasOwn(weights, bookId) ? (weights[bookId] ?? 1) : 1;
  const totalWeight = used.reduce((sum, c) => sum + weightOf(c.bookId), 0);
  const means = outcomes.map(
    (outcome) =>
      used.reduce((sum, c) => sum + weightOf(c.bookId) * c.fair[outcome]!, 0) / totalWeight,
  );
  const meansTotal = means.reduce((sum, mean) => sum + mean, 0);
  // Scaled to sum to 1, then clamped: float noise must not take a value outside the books' own range.
  const fair = Object.fromEntries(
    outcomes.map((outcome, i) => {
      const values = used.map((c) => c.fair[outcome]!);
      const scaled = means[i]! / meansTotal;
      return [outcome, Math.min(Math.max(...values), Math.max(Math.min(...values), scaled))];
    }),
  );

  let dispersion = 0;
  for (const candidate of used) {
    for (const outcome of outcomes) {
      dispersion = Math.max(dispersion, Math.abs(candidate.fair[outcome]! - fair[outcome]!));
    }
  }

  // Pinnacle's max stake counts only while its quote is used and the figure is known (a number).
  const pinnacle = used.find((c) => c.bookId === pinnacleBookId);
  const liquidity = typeof pinnacle?.liquidityUsd === 'number' ? pinnacle.liquidityUsd : null;
  let confidence: ConsensusConfidence;
  if (
    used.length <= LOW_CONFIDENCE_MAX_BOOKS ||
    dispersion > LOW_CONFIDENCE_MIN_DISPERSION + LIMIT_EPSILON ||
    healthyBooks === null ||
    (liquidity !== null && liquidity < PINNACLE_LOW_LIMIT_USD)
  ) {
    confidence = 'low';
  } else if (
    used.length >= HIGH_CONFIDENCE_MIN_BOOKS &&
    dispersion < HIGH_CONFIDENCE_MAX_DISPERSION - LIMIT_EPSILON &&
    (liquidity === null || liquidity >= PINNACLE_HIGH_LIMIT_USD)
  ) {
    confidence = 'high';
  } else {
    confidence = 'normal';
  }

  return {
    ok: true,
    fair,
    booksUsed: used.map((c) => c.bookId),
    dropped: sortedDropped(dropped),
    dispersion,
    confidence,
  };
}
