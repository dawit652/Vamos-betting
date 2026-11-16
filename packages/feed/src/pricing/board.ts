import { canonicalLine, type MarketTypeCode, MARKET_TYPES, selectionsFor } from '@vamos/core';
import type { FeedMarket } from '../types';
import { buildMarket, defaultMarginBps } from './book';

/**
 * A competitor's markets with OUR margin (docs/plans/hulusport-feed.md).
 *
 * A board quotes prices with its own margin. For each market the implied probabilities (1/price)
 * are scaled to the market's fair total, which removes the board's margin proportionally, and the
 * book is priced again with our margin (buildMarket, defaultMarginBps): our prices follow the
 * board's view of the match, never its margin. The fair total is 1 for markets whose selections
 * exclude each other, and 2 for double chance (each outcome of the match is in two selections).
 *
 * A market is left out when it is not a complete book of its type (a selection missing, extra or
 * twice), its line is not valid for the type, a price is outside 1.01 to 1000, its overround is
 * below the fair total (the board would be paying out more than it takes) or above 1.5 times it
 * (more likely a mapping error than a price), or buildMarket cannot price it.
 */

export interface BoardMarketInput {
  type: MarketTypeCode;
  line: string | null;
  prices: ReadonlyArray<{ code: string; priceMilli: number }>;
}

const MIN_PRICE_MILLI = 1010;
const MAX_PRICE_MILLI = 1_000_000;
/** The largest board overround accepted, as a multiple of the fair total. */
export const MAX_BOARD_OVERROUND = 1.5;

const fairTotal = (type: MarketTypeCode): number => (type === 'dc' ? 2 : 1);

/** One board market with our margin, or null when it cannot be used (see the module notes). */
export function priceBoardMarket(
  market: BoardMarketInput,
  marginBps: number = defaultMarginBps(market.type, false),
): FeedMarket | null {
  if (!Object.hasOwn(MARKET_TYPES, market.type)) return null;
  let line: string | null;
  try {
    line = canonicalLine(market.type, market.line);
  } catch {
    return null;
  }
  const codes = selectionsFor(market.type);
  if (market.prices.length !== codes.length) return null;
  const implied = new Map<string, number>();
  for (const { code, priceMilli } of market.prices) {
    if (!codes.includes(code) || implied.has(code)) return null;
    if (
      !Number.isInteger(priceMilli) ||
      priceMilli < MIN_PRICE_MILLI ||
      priceMilli > MAX_PRICE_MILLI
    ) {
      return null;
    }
    implied.set(code, 1000 / priceMilli);
  }
  const total = fairTotal(market.type);
  const overround = [...implied.values()].reduce((sum, p) => sum + p, 0);
  if (!(overround >= total && overround <= total * MAX_BOARD_OVERROUND)) return null;
  const probabilities: Record<string, number> = {};
  for (const [code, p] of implied) probabilities[code] = (p * total) / overround;
  return buildMarket(market.type, line, probabilities, marginBps);
}

/** Every usable board market with our margin, in the order given. */
export function priceBoardMarkets(markets: readonly BoardMarketInput[]): FeedMarket[] {
  return markets.flatMap((market) => {
    const priced = priceBoardMarket(market);
    return priced === null ? [] : [priced];
  });
}
