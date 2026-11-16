import {
  CONSENSUS_MAX_PRICE_MILLI,
  CONSENSUS_MIN_PRICE_MILLI,
  CONSENSUS_SELECTIONS,
  type ConsensusMarketType,
  type MarketPriceRow,
} from './market-consensus';

/**
 * Rule O7 (docs/scraper.md, P-3 of docs/feed-quality-plan.md): never easier to beat than the
 * market. Our price for a selection the bookmakers quote (the 1X2 and the over/under lines) should
 * not be above the best price any fresh book offers for that very market, line and selection: a
 * price above it is an arbitrage against the books. Markets the books do not quote have no best
 * price and are left alone. Integer milli odds throughout; pure.
 */

/** The best price the books offer for one selection, and the book that offers it. */
export interface BestBookPrice {
  oddsMilli: number;
  /** `<upstream>:<bookmaker>`; the first by name when several books offer the same price. */
  bookmaker: string;
}

/** Best book prices by bestPriceKey(market, line, selection). */
export type BestBookPrices = ReadonlyMap<string, BestBookPrice>;

/** A market as we price it: a market type code, its line, and its selections in integer milli. */
export interface CappableMarket {
  type: string;
  line: string | null;
  selections: ReadonlyArray<{ code: string; oddsMilli: number }>;
}

/** A selection we priced above the best book price. */
export interface OutOfLineSelection {
  market: ConsensusMarketType;
  /** Canonical half-point line for 'ou' ("2.5"), null for '1x2'. */
  line: string | null;
  selection: string;
  /** Our price before any cap. */
  ourOddsMilli: number;
  bestOddsMilli: number;
  bestBookmaker: string;
}

export interface CapResult<M extends CappableMarket> {
  /** The markets with every quoted selection at most the best book price (others as they were). */
  markets: M[];
  /** The selections whose price was above the best book price, with both prices (input order). */
  outOfLine: OutOfLineSelection[];
}

/**
 * "2.5", "02.50" → "2.5"; null for anything but a half-point line (whole and quarter lines can
 * push; a database numeric may carry trailing zeros the books' line does not).
 */
function canonicalLine(line: unknown): string | null {
  if (typeof line !== 'string' || !/^\d{1,3}(\.\d{1,4})?$/.test(line.trim())) return null;
  const value = Number(line.trim());
  return Number.isInteger(value * 2) && !Number.isInteger(value) ? String(value) : null;
}

/**
 * The key of one selection of a market the books quote, or null for anything else (another market
 * type, a selection code the market does not have, a line that is not a half-point line).
 */
export function bestPriceKey(
  market: string,
  line: string | null,
  selection: string,
): string | null {
  if (market === '1x2') {
    const code = selection.trim().toUpperCase();
    return CONSENSUS_SELECTIONS['1x2'].includes(code) ? `1x2||${code}` : null;
  }
  if (market === 'ou') {
    const code = selection.trim().toLowerCase();
    const canon = canonicalLine(line);
    return canon !== null && CONSENSUS_SELECTIONS.ou.includes(code) ? `ou|${canon}|${code}` : null;
  }
  return null;
}

const isSanePrice = (price: unknown): price is number =>
  typeof price === 'number' &&
  Number.isSafeInteger(price) &&
  price >= CONSENSUS_MIN_PRICE_MILLI &&
  price <= CONSENSUS_MAX_PRICE_MILLI;

/**
 * The highest price any book offers per market, line and selection, from rows that are already
 * fresh (one voice per book: consensusRows). Prices outside the consensus bounds
 * ([CONSENSUS_MIN_PRICE_MILLI, CONSENSUS_MAX_PRICE_MILLI]) and rows of other markets are ignored.
 */
export function bestBookPrices(rows: readonly MarketPriceRow[]): Map<string, BestBookPrice> {
  const best = new Map<string, BestBookPrice>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !isSanePrice(row.priceMilli)) continue;
    if (typeof row.selection !== 'string' || typeof row.bookmaker !== 'string') continue;
    const bookmaker = row.bookmaker.trim();
    if (bookmaker === '') continue;
    const key = bestPriceKey(row.market, row.market === '1x2' ? null : row.line, row.selection);
    if (key === null) continue;
    const seen = best.get(key);
    if (
      seen === undefined ||
      row.priceMilli > seen.oddsMilli ||
      (row.priceMilli === seen.oddsMilli && bookmaker < seen.bookmaker)
    ) {
      best.set(key, { oddsMilli: row.priceMilli, bookmaker });
    }
  }
  return best;
}

/**
 * Compares our markets with the best book prices: every selection of a market the books quote
 * whose price is above the best book price is listed (with both prices), and with `cap` it is
 * lowered to that price (integer min). Every other selection and market is returned unchanged.
 * Capping never raises a price, leaves no quoted selection above its best book price, and is
 * idempotent; without `cap` the markets are returned as they are.
 */
export function capAtBestPrice<M extends CappableMarket>(
  markets: readonly M[],
  best: BestBookPrices,
  options: { cap: boolean },
): CapResult<M> {
  const outOfLine: OutOfLineSelection[] = [];
  const out = markets.map((market) => {
    if (market.type !== '1x2' && market.type !== 'ou') return market;
    let changed = false;
    const selections = market.selections.map((s) => {
      const key = bestPriceKey(market.type, market.line, s.code);
      const top = key === null ? undefined : best.get(key);
      if (top === undefined || !(s.oddsMilli > top.oddsMilli)) return s;
      outOfLine.push({
        market: market.type as ConsensusMarketType,
        line: market.type === 'ou' ? canonicalLine(market.line) : null,
        selection: s.code,
        ourOddsMilli: s.oddsMilli,
        bestOddsMilli: top.oddsMilli,
        bestBookmaker: top.bookmaker,
      });
      if (!options.cap) return s;
      changed = true;
      return { ...s, oddsMilli: top.oddsMilli };
    });
    return changed ? { ...market, selections } : market;
  });
  return { markets: options.cap ? out : [...markets], outOfLine };
}

/**
 * Marks the part of a pricing key (the stamp of an event's prices) that rule O7 adds when the cap
 * lowered prices: `<key>|cap:1x2|1=2000,ou2.5|under=1950` (the capped selections at their capped
 * prices), so a move of the best book price alone makes the key, and so the prices, change.
 */
export const CAP_KEY_MARKER = '|cap:';

/** The pricing key with the capped selections (O7) appended; the key itself when none was capped. */
export function cappedPricingKey(key: string, capped: readonly OutOfLineSelection[]): string {
  if (capped.length === 0) return key;
  const parts = capped.map((o) => `${o.market}${o.line ?? ''}|${o.selection}=${o.bestOddsMilli}`);
  return `${key}${CAP_KEY_MARKER}${parts.join(',')}`;
}

/** The pricing key without its O7 cap part (what the ratings or the market alone price). */
export function uncappedPricingKey(key: string): string {
  const at = key.indexOf(CAP_KEY_MARKER);
  return at < 0 ? key : key.slice(0, at);
}

/**
 * Marks the part of a pricing key added when some markets of the event take a competitor board's
 * prices (Hulusport, docs/plans/hulusport-feed.md): `<key>|hl:<digest of those markets>`, before
 * any O7 cap part. A move of the board alone then changes the key, and so the prices.
 */
export const BOARD_KEY_MARKER = '|hl:';

/** True for a pricing key whose prices include a competitor board's (BOARD_KEY_MARKER). */
export function hasBoardPrices(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.includes(BOARD_KEY_MARKER);
}
