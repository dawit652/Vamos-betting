import {
  CONSENSUS_MIN_BOOKS,
  MARKET_PRICING_KEY_PREFIX,
  MARKET_TYPES,
  marketConsensus,
  type MarketTypeCode,
  type ScrapePricingSource,
} from '@vamos/core';
import { consensusRows, latestMarketOdds, listEventPricing, type DbExecutor } from '@vamos/db';
import { markets as marketsTable } from '@vamos/db/schema';
import {
  fitGoalsToMarket,
  MAX_MARKET_FIT_RESIDUAL,
  marketPricingKey,
  priceFixture,
  priceFootballFromMarket,
  type FeedMarket,
  type TeamRatings,
} from '@vamos/feed';
import {
  checkMarkets,
  isCalibrated,
  isHalfTimeMarket,
  MARKET_ODDS_MAX_AGE_MS,
  marketBacksOpening,
  ratingsKey,
  withoutHalfTimeMarkets,
} from '@vamos/scraper';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Rule O5, where an event's prices come from. One function for every place that prices a scraped
 * football event (creation, re-pricing, the hand-over to a trader), so they cannot disagree.
 *
 * - The competition's policy says 'market' AND the event exists AND the licensed bookmaker feed
 *   has a fresh 1X2 consensus from at least CONSENSUS_MIN_BOOKS books AND an over/under consensus
 *   on a goal line to fit the goals to (2.5, or an x.5 line from 1.5 to 4.5 in its place: rules T1
 *   and T2 of docs/theoddsapi-plan/README.md; fitted to the 1X2 alone, over 2.5 comes out five to
 *   nine points short) AND the model fitted to them explains them (fit residual at most
 *   MAX_MARKET_FIT_RESIDUAL): prices come from the market
 *   (priceFootballFromMarket), the key is marketPricingKey, and the event counts as calibrated
 *   for re-pricing (O1 is about team ratings; market prices do not use them). Opening betting on
 *   it without calibrated ratings needs more: O1m (`backsOpening`, `backedByMarket`).
 * - Anything else: the team-rating model, exactly as before (ratingsKey, O1).
 *
 * A new event (no id yet) is always priced by the model; the next re-pricing pass moves it to the
 * market prices (through the same bounds as any re-price). Pure apart from the one read.
 *
 * Rule O6 (S-2) is applied here too, so creation and re-pricing agree on the markets: with
 * `halfTimeMarkets: false` (the competition has no half-time source under the setting `covered`,
 * see halfTimeCheck) the half-time markets are left out of the prices, unless the event already
 * has one (any status), which is never taken away: it keeps being priced, and its result keeps
 * needing a half time (a person settles it when no source gives one).
 */

export type EventPriceSource = 'market' | 'model';

/**
 * Why a competition that asked for market prices got the model for an event: no 1X2 consensus, no
 * over/under consensus on any goal line the fit can use (`no_totals`), or a fit too poor to trust.
 */
export type MarketFallback = 'no_consensus' | 'no_totals' | 'poor_fit';

export interface EventPriceInput {
  competitionPricingSource: ScrapePricingSource;
  /** The event's id; null for a fixture that has no event yet (always the model). */
  eventId: string | null;
  homeRatings: TeamRatings | null | undefined;
  awayRatings: TeamRatings | null | undefined;
  /** Matches a team's ratings need behind them (O1); config scraper.minRatingMatches. */
  minRatingMatches: number;
  now: Date;
  /** Bookmaker prices last listed longer ago than this are not used (default MARKET_ODDS_MAX_AGE_MS). */
  maxAgeMs?: number;
  /**
   * Rule O6: the competition may have half-time markets (halfTimeCheck). Default true (every
   * market, as before); false leaves them out unless the event already has one.
   */
  halfTimeMarkets?: boolean;
}

export interface EventPrice {
  source: EventPriceSource;
  markets: FeedMarket[];
  /** What the prices come from, as stamped on the event: marketPricingKey or ratingsKey. */
  key: string;
  /** O1 for the model; always true for the market (its prices do not use the ratings). */
  calibrated: boolean;
  /** O2 on every market of these prices. */
  pricesSane: boolean;
  /** Market only: the fit residual (largest probability error), at most MAX_MARKET_FIT_RESIDUAL. */
  residual?: number;
  /** Market only: books behind the 1X2 consensus. */
  books?: number;
  /** Market only: their names (`<upstream>:<bookmaker>`, sorted). */
  bookmakers?: readonly string[];
  /**
   * O1m: true for market prices whose 1X2 books back opening betting without calibrated team
   * ratings (marketBacksOpening: 3 distinct books, one sharp); false for the model.
   */
  backsOpening: boolean;
  /** Market only: books behind the over/under 2.5 consensus (0 when it has none). */
  booksOu25?: number;
  /** Market only: the goal line the expected goals were fitted to ('2.5', or the line in its place). */
  totalsLine?: string;
  /** Model only, and only when the policy asked for the market: why it could not be used. */
  fallback?: MarketFallback;
  /** Rule O6 left the half-time markets out of these prices. */
  halfTimeOmitted?: true;
}

/** True for a pricing key that comes from the market (the stamp column holds either form). */
export const isMarketKey = (key: string | null | undefined): boolean =>
  typeof key === 'string' && key.startsWith(`${MARKET_PRICING_KEY_PREFIX}|`);

export async function priceEvent(exec: DbExecutor, input: EventPriceInput): Promise<EventPrice> {
  const price = await priceBook(exec, input);
  if (input.halfTimeMarkets !== false) return price;
  // O6: never take a half-time market away from an event that has one.
  if (input.eventId !== null && (await hasHalfTimeMarket(exec, input.eventId))) return price;
  const markets = withoutHalfTimeMarkets(price.markets);
  if (markets.length === price.markets.length) return price;
  return { ...price, markets, pricesSane: checkMarkets(markets).ok, halfTimeOmitted: true };
}

const HALF_TIME_TYPES = (Object.keys(MARKET_TYPES) as MarketTypeCode[]).filter(isHalfTimeMarket);

/** The event has a half-time market, whatever its status (open, suspended, closed, settled, void). */
async function hasHalfTimeMarket(exec: DbExecutor, eventId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: marketsTable.id })
    .from(marketsTable)
    .where(and(eq(marketsTable.eventId, eventId), inArray(marketsTable.type, HALF_TIME_TYPES)))
    .limit(1);
  return row !== undefined;
}

/** Rule O5 (every market): the market's prices when they can be used, else the model's. */
async function priceBook(exec: DbExecutor, input: EventPriceInput): Promise<EventPrice> {
  let fallback: EventPrice['fallback'];
  if (input.competitionPricingSource === 'market' && input.eventId !== null) {
    const market = await marketPrice(
      exec,
      input.eventId,
      input.now,
      input.maxAgeMs ?? MARKET_ODDS_MAX_AGE_MS,
    );
    if (market.kind === 'priced') return market.price;
    fallback = market.reason;
  }
  const markets = priceFixture('football', input.homeRatings ?? null, input.awayRatings ?? null);
  return {
    source: 'model',
    markets,
    key: ratingsKey(input.homeRatings, input.awayRatings),
    calibrated:
      isCalibrated(input.homeRatings ?? null, input.minRatingMatches) &&
      isCalibrated(input.awayRatings ?? null, input.minRatingMatches),
    pricesSane: checkMarkets(markets).ok,
    backsOpening: false,
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/**
 * Rule O1m: whether an event whose teams are not calibrated (O1) may still open betting because
 * its prices come from a strong market. All of: the competition takes market prices; the event is
 * priced from the market NOW (fresh 1X2 consensus, an over/under line, a good fit: O5); those 1X2
 * books back opening (marketBacksOpening); and the stored prices are these very prices (the stamp
 * equals the market key, so no held or skipped re-price stands between them). One read of the
 * market and one of the stamp.
 */
export async function backedByMarket(exec: DbExecutor, input: EventPriceInput): Promise<boolean> {
  if (input.competitionPricingSource !== 'market' || input.eventId === null) return false;
  const price = await priceEvent(exec, input);
  if (price.source !== 'market' || !price.backsOpening) return false;
  const stamp = (await listEventPricing(exec, [input.eventId])).get(input.eventId);
  return stamp?.ratingsKey === price.key;
}

/**
 * The market prices of an event, or why there are none. The fresh rows come from latestMarketOdds
 * (maxAge MARKET_ODDS_MAX_AGE_MS unless the caller asks for fresher); a bookmaker counts once even
 * when two sources of one upstream list it (one voice, as for results), the newest sighting winning.
 */
async function marketPrice(
  exec: DbExecutor,
  eventId: string,
  now: Date,
  maxAgeMs: number,
): Promise<{ kind: 'priced'; price: EventPrice } | { kind: 'none'; reason: MarketFallback }> {
  const rows = await latestMarketOdds(exec, { eventIds: [eventId], now, maxAgeMs });
  const consensus = marketConsensus(consensusRows(rows), { minBooks: CONSENSUS_MIN_BOOKS });
  const x12 = consensus.find((c) => c.market === '1x2');
  if (x12 === undefined) return { kind: 'none', reason: 'no_consensus' };
  const fit = fitGoalsToMarket(consensus);
  if (fit === null) return { kind: 'none', reason: 'no_consensus' };
  if (fit.totalsLine === null) return { kind: 'none', reason: 'no_totals' };
  if (!(fit.residual <= MAX_MARKET_FIT_RESIDUAL)) return { kind: 'none', reason: 'poor_fit' };
  const priced = priceFootballFromMarket(consensus);
  if (priced === null) return { kind: 'none', reason: 'no_consensus' };
  return {
    kind: 'priced',
    price: {
      source: 'market',
      markets: priced.markets,
      key: marketPricingKey(consensus),
      calibrated: true,
      pricesSane: checkMarkets(priced.markets).ok,
      residual: priced.residual,
      books: priced.source.books1x2,
      bookmakers: x12.bookmakers,
      backsOpening: marketBacksOpening(x12.bookmakers),
      booksOu25: priced.source.booksOu25,
      totalsLine: priced.totalsLine,
    },
  };
}
