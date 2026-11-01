import { parseLine } from './markets';

/**
 * Consensus of a licensed bookmaker-odds feed (docs/scraper-plan/10-market-odds-feed.md, M1):
 * the fair probabilities several bookmakers agree on for one event.
 *
 * Per bookmaker and market (and line), only a complete book counts: '1', 'X'
 * and '2' for the 1X2, 'over' and 'under' of one half-point line for
 * over/under. Each book's margin is removed by proportional normalisation,
 * then each selection takes the median of the books' fair probabilities and
 * the medians are renormalised to sum to 1.
 *
 * Why proportional and not Shin (or the power / odds-ratio methods): those
 * need a per-book solve and model how a bookmaker loads the margin onto the
 * longshots, which differs between bookmakers and is not knowable from one
 * snapshot. Proportional normalisation is closed form, exact on a fair book,
 * invariant to the size of the margin (scaling every implied probability of a
 * book leaves its fair probabilities unchanged), and the bias it leaves on the
 * longshots of a 1X2 or a 2.5 goals line is small (well under a percentage
 * point at the overrounds this accepts). The median across books then
 * matters far more than the de-margining method: it is what keeps one stale
 * or mistyped book from moving the consensus.
 *
 * Pure: no I/O. Floats are fine: these are probabilities, never money.
 */

export type ConsensusMarketType = '1x2' | 'ou';

/** One bookmaker's price for one selection, as an odds feed reports it. */
export interface MarketPriceRow {
  bookmaker: string;
  market: ConsensusMarketType;
  /** Half-point line for 'ou' ("2.5"); ignored (and output as null) for '1x2'. */
  line: string | null;
  /** '1' | 'X' | '2' for '1x2', 'over' | 'under' for 'ou'. */
  selection: string;
  /** Decimal odds × 1000, an integer. */
  priceMilli: number;
}

export interface MarketConsensus {
  market: ConsensusMarketType;
  /** Canonical half-point line for 'ou', null for '1x2'. */
  line: string | null;
  /** Fair probability of each selection: each in (0, 1), summing to 1. */
  probabilities: Readonly<Record<string, number>>;
  /** Complete, sane books the consensus is the median of. */
  books: number;
  /** Median overround (Σ 1/odds) of those books. */
  overroundMedian: number;
}

export interface MarketConsensusOptions {
  /** Fewest complete books for a consensus (default CONSENSUS_MIN_BOOKS); an integer ≥ 1. */
  minBooks?: number;
}

export const CONSENSUS_MIN_BOOKS = 2;
/**
 * Prefix of the key an event priced from the market is stamped with (marketPricingKey in
 * @vamos/feed), so a market key never equals a ratings key (which starts with "[").
 */
export const MARKET_PRICING_KEY_PREFIX = 'mkt1';
/** A book whose overround is below this is an arbitrage or a feed error and is dropped. */
export const CONSENSUS_MIN_OVERROUND = 1;
/** A book whose overround is above this is not a real market price and is dropped. */
export const CONSENSUS_MAX_OVERROUND = 1.25;
/** Prices outside [CONSENSUS_MIN_PRICE_MILLI, CONSENSUS_MAX_PRICE_MILLI] are dropped. */
export const CONSENSUS_MIN_PRICE_MILLI = 1010;
export const CONSENSUS_MAX_PRICE_MILLI = 1_000_000;

/** The selections of a complete book, in display order. */
export const CONSENSUS_SELECTIONS: Readonly<Record<ConsensusMarketType, readonly string[]>> =
  Object.freeze({
    '1x2': Object.freeze(['1', 'X', '2']),
    ou: Object.freeze(['over', 'under']),
  });

/**
 * One book's fair probabilities: implied probabilities 1000 / price divided
 * by their sum (the overround), in the order given. Null when a price is not
 * a sane integer price or the overround is outside
 * [CONSENSUS_MIN_OVERROUND, CONSENSUS_MAX_OVERROUND].
 */
export function bookFairProbabilities(
  pricesMilli: readonly number[],
): { probabilities: number[]; overround: number } | null {
  if (pricesMilli.length < 2) return null;
  const implied: number[] = [];
  for (const price of pricesMilli) {
    if (!isSanePrice(price)) return null;
    implied.push(1000 / price);
  }
  const overround = implied.reduce((sum, q) => sum + q, 0);
  if (overround < CONSENSUS_MIN_OVERROUND || overround > CONSENSUS_MAX_OVERROUND) return null;
  return { probabilities: implied.map((q) => q / overround), overround };
}

/**
 * The consensus of each market (and over/under line) with at least `minBooks`
 * complete, sane books: 1X2 first, then over/under by ascending line. Rows
 * that cannot be read (unknown market or selection, invalid line, empty
 * bookmaker, a price that is not an integer in the sane range) are ignored;
 * a book that ends up incomplete, gives one selection two different prices
 * or has an overround outside the sane range is dropped as a whole. The
 * result does not depend on the order of the rows.
 */
export function marketConsensus(
  rows: readonly MarketPriceRow[],
  options: MarketConsensusOptions = {},
): MarketConsensus[] {
  const minBooks = options.minBooks ?? CONSENSUS_MIN_BOOKS;
  if (!Number.isSafeInteger(minBooks) || minBooks < 1) {
    throw new RangeError(`minBooks must be an integer >= 1, got ${String(minBooks)}`);
  }

  // market key → bookmaker → selection → price (NaN once two prices conflict).
  const byMarket = new Map<string, Map<string, Map<string, number>>>();
  for (const row of rows) {
    const read = readRow(row);
    if (read === null) continue;
    let books = byMarket.get(read.key);
    if (books === undefined)
      byMarket.set(read.key, (books = new Map<string, Map<string, number>>()));
    let book = books.get(read.bookmaker);
    if (book === undefined) books.set(read.bookmaker, (book = new Map<string, number>()));
    const seen = book.get(read.selection);
    book.set(
      read.selection,
      seen === undefined || seen === read.priceMilli ? read.priceMilli : Number.NaN,
    );
  }

  const out: MarketConsensus[] = [];
  for (const [key, books] of byMarket) {
    const { market, line } = splitKey(key);
    const codes = CONSENSUS_SELECTIONS[market];
    const fair: number[][] = codes.map(() => []);
    const overrounds: number[] = [];
    for (const book of books.values()) {
      const prices = codes.map((code) => book.get(code) ?? Number.NaN);
      const priced = bookFairProbabilities(prices);
      if (priced === null) continue;
      priced.probabilities.forEach((p, i) => fair[i]!.push(p));
      overrounds.push(priced.overround);
    }
    if (overrounds.length < minBooks) continue;
    const medians = fair.map(median);
    const total = medians.reduce((sum, p) => sum + p, 0);
    const probabilities: Record<string, number> = {};
    codes.forEach((code, i) => {
      probabilities[code] = medians[i]! / total;
    });
    out.push({
      market,
      line,
      probabilities,
      books: overrounds.length,
      overroundMedian: median(overrounds),
    });
  }
  return out.sort(compareConsensus);
}

function isSanePrice(price: unknown): price is number {
  return (
    typeof price === 'number' &&
    Number.isSafeInteger(price) &&
    price >= CONSENSUS_MIN_PRICE_MILLI &&
    price <= CONSENSUS_MAX_PRICE_MILLI
  );
}

function readRow(
  row: MarketPriceRow,
): { key: string; bookmaker: string; selection: string; priceMilli: number } | null {
  if (typeof row !== 'object' || row === null) return null;
  const bookmaker = typeof row.bookmaker === 'string' ? row.bookmaker.trim() : '';
  if (bookmaker === '' || typeof row.selection !== 'string') return null;
  if (!isSanePrice(row.priceMilli)) return null;
  const raw = row.selection.trim();
  if (row.market === '1x2') {
    const selection = raw.toUpperCase();
    if (!CONSENSUS_SELECTIONS['1x2'].includes(selection)) return null;
    return { key: '1x2', bookmaker, selection, priceMilli: row.priceMilli };
  }
  if (row.market === 'ou') {
    const selection = raw.toLowerCase();
    if (!CONSENSUS_SELECTIONS.ou.includes(selection)) return null;
    const line = canonicalLine(row.line);
    if (line === null) return null;
    return { key: `ou:${line}`, bookmaker, selection, priceMilli: row.priceMilli };
  }
  return null;
}

/** "02.5" → "2.5"; null for anything but a half-point line (whole and quarter lines can push). */
function canonicalLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  try {
    return String(parseLine(line.trim()));
  } catch {
    return null;
  }
}

function splitKey(key: string): { market: ConsensusMarketType; line: string | null } {
  return key === '1x2' ? { market: '1x2', line: null } : { market: 'ou', line: key.slice(3) };
}

/** Median of a non-empty list (mean of the middle two for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function compareConsensus(a: MarketConsensus, b: MarketConsensus): number {
  if (a.market !== b.market) return a.market === '1x2' ? -1 : 1;
  return Number(a.line) - Number(b.line);
}
