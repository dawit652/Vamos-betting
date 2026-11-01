import {
  CONSENSUS_MIN_BOOKS,
  MARKET_PRICING_KEY_PREFIX,
  marketConsensus,
  type MarketPriceRow,
  type ScrapePricingSource,
} from '@vamos/core';
import { latestMarketOdds, type DbExecutor, type LatestMarketOdd } from '@vamos/db';
import {
  fitGoalsToMarket,
  MAX_MARKET_FIT_RESIDUAL,
  marketPricingKey,
  priceFixture,
  priceFootballFromMarket,
  type FeedMarket,
  type TeamRatings,
} from '@vamos/feed';
import { checkMarkets, isCalibrated, MARKET_ODDS_MAX_AGE_MS, ratingsKey } from '@vamos/scraper';

/**
 * Rule O4, where an event's prices come from. One function for every place that prices a scraped
 * football event (creation, re-pricing, the hand-over to a trader), so they cannot disagree.
 *
 * - The competition's policy says 'market' AND the event exists AND the licensed bookmaker feed
 *   has a fresh 1X2 consensus from at least CONSENSUS_MIN_BOOKS books AND the model fitted to it
 *   explains it (fit residual at most MAX_MARKET_FIT_RESIDUAL): prices come from the market
 *   (priceFootballFromMarket), the key is marketPricingKey, and the event counts as calibrated
 *   (O1 is about team ratings; a market-priced event does not need them).
 * - Anything else: the team-rating model, exactly as before (ratingsKey, O1).
 *
 * A new event (no id yet) is always priced by the model; the next re-pricing pass moves it to the
 * market prices (through the same bounds as any re-price). Pure apart from the one read.
 */

export type EventPriceSource = 'market' | 'model';

export interface EventPriceInput {
  competitionPricingSource: ScrapePricingSource;
  /** The event's id; null for a fixture that has no event yet (always the model). */
  eventId: string | null;
  homeRatings: TeamRatings | null | undefined;
  awayRatings: TeamRatings | null | undefined;
  /** Matches a team's ratings need behind them (O1); config scraper.minRatingMatches. */
  minRatingMatches: number;
  now: Date;
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
  /** Market only: books behind the over/under 2.5 consensus (0 when it has none). */
  booksOu25?: number;
  /** Model only, and only when the policy asked for the market: why it could not be used. */
  fallback?: 'no_consensus' | 'poor_fit';
}

/** True for a pricing key that comes from the market (the stamp column holds either form). */
export const isMarketKey = (key: string | null | undefined): boolean =>
  typeof key === 'string' && key.startsWith(`${MARKET_PRICING_KEY_PREFIX}|`);

export async function priceEvent(exec: DbExecutor, input: EventPriceInput): Promise<EventPrice> {
  let fallback: EventPrice['fallback'];
  if (input.competitionPricingSource === 'market' && input.eventId !== null) {
    const market = await marketPrice(exec, input.eventId, input.now);
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
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/**
 * The market prices of an event, or why there are none. The fresh rows come from latestMarketOdds
 * (maxAge MARKET_ODDS_MAX_AGE_MS); a bookmaker counts once even when two sources of one upstream
 * list it (one voice, as for results), the newest sighting winning.
 */
async function marketPrice(
  exec: DbExecutor,
  eventId: string,
  now: Date,
): Promise<
  { kind: 'priced'; price: EventPrice } | { kind: 'none'; reason: 'no_consensus' | 'poor_fit' }
> {
  const rows = await latestMarketOdds(exec, {
    eventIds: [eventId],
    now,
    maxAgeMs: MARKET_ODDS_MAX_AGE_MS,
  });
  const consensus = marketConsensus(oneVoicePerBook(rows), { minBooks: CONSENSUS_MIN_BOOKS });
  const x12 = consensus.find((c) => c.market === '1x2');
  if (x12 === undefined) return { kind: 'none', reason: 'no_consensus' };
  const fit = fitGoalsToMarket(consensus);
  if (fit === null) return { kind: 'none', reason: 'no_consensus' };
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
      booksOu25: priced.source.booksOu25,
    },
  };
}

/**
 * The rows as consensus input, one bookmaker per (upstream, bookmaker): if several sources of one
 * upstream list the same bookmaker, only the source that saw it last is read (ties: the lowest
 * source id), so one feed never counts twice.
 */
function oneVoicePerBook(rows: readonly LatestMarketOdd[]): MarketPriceRow[] {
  const winner = new Map<string, { sourceId: string; observedAt: number }>();
  for (const row of rows) {
    const key = `${row.upstream}\u0000${row.bookmaker}`;
    const seen = winner.get(key);
    const at = row.observedAt.getTime();
    if (
      seen === undefined ||
      at > seen.observedAt ||
      (at === seen.observedAt && row.sourceId < seen.sourceId)
    ) {
      winner.set(key, { sourceId: row.sourceId, observedAt: at });
    }
  }
  return rows
    .filter((row) => winner.get(`${row.upstream}\u0000${row.bookmaker}`)?.sourceId === row.sourceId)
    .map((row) => ({
      bookmaker: `${row.upstream}:${row.bookmaker}`,
      market: row.market,
      line: row.line,
      selection: row.selection,
      priceMilli: row.priceMilli,
    }));
}
