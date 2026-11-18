import { createHash } from 'node:crypto';
import {
  anyMarketKey,
  BOARD_KEY_MARKER,
  BOARD_PRICING_KEY_PREFIX,
  isBoardPricedKey,
  bestBookPrices,
  capAtBestPrice,
  cappedPricingKey,
  CONSENSUS_MIN_BOOKS,
  type FactoryPricingPlan,
  HALF_TIME_MARKET_TYPES,
  MARKET_PRICING_KEY_PREFIX,
  marketConsensus,
  type MarketPriceRow,
  type OutOfLineSelection,
  type ScrapePricingSource,
} from '@vamos/core';
import {
  consensusRows,
  getHulusportPricing,
  latestBoardOdds,
  type LatestBoardOdds,
  latestMarketOdds,
  listEventPricing,
  loadFactoryPricingPlan,
  type DbExecutor,
} from '@vamos/db';
import { markets as marketsTable } from '@vamos/db/schema';
import {
  fitGoalsToMarket,
  MAX_MARKET_FIT_RESIDUAL,
  marketPricingKey,
  matchStrengths,
  priceBoardMarkets,
  priceFactoryMarkets,
  boardConsensus,
  boardGoalsFit,
  priceFixture,
  priceFootball,
  priceFootballFromMarket,
  type BoardMarketInput,
  type TeamRatings,
} from '@vamos/feed';
import {
  BOARD_PRICES_MAX_AGE_MS,
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
 *
 * Rule O7 (P-3) last, on the final markets of either source: every selection of the 1X2 and of the
 * over/under lines the books quote is compared with the best price a fresh book offers for it (the
 * same fresh rows as O5, one voice per book: bestBookPrices). The selections priced above it are
 * always listed (`outOfLine`, for the odds_out_of_line alarm: reprice.ts); with `capAtBestPrice`
 * (SCRAPER_CAP_AT_BEST_PRICE=on) they are lowered to it before O2 (`pricesSane`) is checked, so a
 * book the cap pushes out of the overround bounds is handled as any other O2 failure. Markets the
 * books do not quote are never touched. When the cap lowers a price, the key carries the capped
 * selections (cappedPricingKey), so a move of the best book price alone re-prices the event, through
 * the same bounds (O3) as any re-price.
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
  /**
   * Rule O7: cap every quoted selection at the best fresh book price (SCRAPER_CAP_AT_BEST_PRICE=on).
   * Default false: the prices stay as they are and `outOfLine` only reports.
   */
  capAtBestPrice?: boolean;
  /**
   * Plan task 2.3 (SCRAPER_FACTORY_MARKETS=on): market prices also carry the market factory's own
   * markets, priced from the same fitted expected goals; each must pass O2 alone, so a weak one is
   * left out instead of holding the event. Default false: today's markets only.
   */
  factoryMarkets?: boolean;
  /**
   * Plan task 2.5: the margins per family and the families the weekly job left out
   * (loadFactoryPricingPlan). Read from the database when needed and not given, so a change in
   * the back office or by the job applies at the next re-price.
   */
  factoryPlan?: FactoryPricingPlan;
}

/** A priced market: today's (FeedMarket) or one of the market factory's (a string type). */
export interface PricedMarket {
  type: string;
  line: string | null;
  selections: Array<{ code: string; oddsMilli: number }>;
}

export interface EventPrice {
  source: EventPriceSource;
  markets: PricedMarket[];
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
  /**
   * Rule O7: the selections whose price (before any cap) is above the best fresh book price, with
   * both prices; empty without fresh book prices (always for a new event).
   */
  outOfLine: readonly OutOfLineSelection[];
  /** Rule O7: the cap was on and lowered at least one price (`outOfLine` lists them). */
  capped?: true;
  /** Some markets take a competitor board's prices (boardRule): which board, how many, how fresh. */
  board?: { name: 'hulusport'; markets: number; pricesAt: Date };
}

/** True for a pricing key that comes from the market (the stamp column holds either form). */
export const isMarketKey = (key: string | null | undefined): boolean =>
  typeof key === 'string' && key.startsWith(`${MARKET_PRICING_KEY_PREFIX}|`);

export async function priceEvent(exec: DbExecutor, input: EventPriceInput): Promise<EventPrice> {
  // The fresh bookmaker prices (one voice per book), read once for O5 and O7.
  const rows =
    input.eventId === null
      ? []
      : consensusRows(
          await latestMarketOdds(exec, {
            eventIds: [input.eventId],
            now: input.now,
            maxAgeMs: input.maxAgeMs ?? MARKET_ODDS_MAX_AGE_MS,
          }),
        );
  // Plan task 2.5: the factory's margins and families, only when its markets can be priced (from
  // the market, or from the model since 16 Nov 2026).
  const needsPlan = input.factoryMarkets === true && input.factoryPlan === undefined;
  const plan = needsPlan ? await loadFactoryPricingPlan(exec) : input.factoryPlan;
  // Our own prices (with the factory's markets), then the Hulusport board's prices over the
  // markets we already price, then the half-time rule.
  const own = priceBook(input, rows, plan, await o1hBoard(exec, input));
  const price = await halfTimeRule(exec, input, await boardRule(exec, input, own));
  return capRule(price, rows, input.capAtBestPrice === true);
}

/**
 * Hulusport's prices (owner's decision of 14 Nov 2026, docs/plans/hulusport-feed.md), while the
 * back office switch `hulusport_pricing` is on: every market of our prices that the board also
 * quotes, fresh (BOARD_PRICES_MAX_AGE_MS) and as a complete book, takes the board's prices with
 * the board's margin replaced by ours (priceBoardMarkets). Only markets we already price are
 * replaced, never added: the catalogue never removes a market a later price leaves out, so a
 * board-only line would keep an old price once the board dropped it. Nothing changes without the
 * board's 1X2 (the main market), for a new event, or when the board links the event twice.
 *
 * The rest of the rules apply unchanged afterwards: O6 (half-time markets), O7 (out of line against
 * the best book price, and the cap), and when re-pricing, the bounds of O3. The key carries the
 * board part (BOARD_KEY_MARKER and a digest of the board markets used), so a move of the board
 * re-prices, and switching off or a stale board goes back to our own prices through the same bounds.
 */
async function boardRule(
  exec: DbExecutor,
  input: EventPriceInput,
  price: EventPrice,
): Promise<EventPrice> {
  if (input.eventId === null) return price;
  if (!(await getHulusportPricing(exec)).enabled) return price;
  const board = await latestBoardOdds(exec, {
    eventId: input.eventId,
    now: input.now,
    maxAgeMs: BOARD_PRICES_MAX_AGE_MS,
  });
  if (board === null) return price;
  const ours = new Set(price.markets.map((m) => anyMarketKey(m.type, m.line)));
  const replacing = new Map(
    priceBoardMarkets(board.markets as BoardMarketInput[])
      .filter((m) => ours.has(anyMarketKey(m.type, m.line)))
      .map((m) => [anyMarketKey(m.type, m.line), m] as const),
  );
  if (!replacing.has(anyMarketKey('1x2'))) return price;
  const markets = price.markets.map((m) => replacing.get(anyMarketKey(m.type, m.line)) ?? m);
  const digest = createHash('sha256')
    .update(JSON.stringify([...replacing.entries()].sort(([a], [b]) => (a < b ? -1 : 1))))
    .digest('hex')
    .slice(0, 16);
  return {
    ...price,
    markets,
    key: `${price.key}${BOARD_KEY_MARKER}${digest}`,
    pricesSane: checkMarkets(markets).ok,
    board: { name: 'hulusport', markets: replacing.size, pricesAt: board.pricesAt },
  };
}

/** Rule O6 on the prices (see priceEvent). */
async function halfTimeRule(
  exec: DbExecutor,
  input: EventPriceInput,
  price: EventPrice,
): Promise<EventPrice> {
  if (input.halfTimeMarkets !== false) return price;
  // O6: never take a half-time market away from an event that has one.
  if (input.eventId !== null && (await hasHalfTimeMarket(exec, input.eventId))) return price;
  const markets = withoutHalfTimeMarkets(price.markets);
  if (markets.length === price.markets.length) return price;
  return { ...price, markets, pricesSane: checkMarkets(markets).ok, halfTimeOmitted: true };
}

/** Rule O7 on the final markets (see priceEvent): list, and with `cap` lower, what is out of line. */
function capRule(price: EventPrice, rows: readonly MarketPriceRow[], cap: boolean): EventPrice {
  if (rows.length === 0) return price;
  const result = capAtBestPrice(price.markets, bestBookPrices(rows), { cap });
  if (result.outOfLine.length === 0) return price;
  if (!cap) return { ...price, outOfLine: result.outOfLine };
  return {
    ...price,
    markets: result.markets,
    pricesSane: checkMarkets(result.markets).ok,
    outOfLine: result.outOfLine,
    capped: true,
    key: cappedPricingKey(price.key, result.outOfLine),
  };
}

/** Today's half-time types and the factory's markets on a half or both halves (O6, plan 2.3). */
const HALF_TIME_TYPES: string[] = HALF_TIME_MARKET_TYPES.filter(isHalfTimeMarket);

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
function priceBook(
  input: EventPriceInput,
  rows: readonly MarketPriceRow[],
  plan: FactoryPricingPlan | undefined,
  board: LatestBoardOdds | null,
): EventPrice {
  let fallback: EventPrice['fallback'];
  if (input.competitionPricingSource === 'market' && input.eventId !== null) {
    const market = marketPrice(rows, input.factoryMarkets === true ? (plan ?? null) : null);
    if (market.kind === 'priced') return market.price;
    fallback = market.reason;
  }
  // Rule O1h: teams the model cannot price yet, and a fresh board that explains its own prices.
  if (board !== null) {
    const fromBoard = boardPrice(board, input.factoryMarkets === true ? (plan ?? null) : null);
    if (fromBoard !== null) return fromBoard;
  }
  const own = priceFixture('football', input.homeRatings ?? null, input.awayRatings ?? null);
  // The factory's markets from the model's own expected goals (owner's request of 16 Nov 2026: about
  // 500 options per match on the leagues whose "Market factory markets" switch is on, whatever
  // their prices come from). The key says so, as for the market path, so switching it on or off,
  // or a change of the factory's margins or families, re-prices each event once.
  const factory = input.factoryMarkets === true ? (plan ?? null) : null;
  let markets: PricedMarket[] = own;
  if (factory !== null) {
    const goals = matchStrengths('football', input.homeRatings ?? null, input.awayRatings ?? null);
    markets = [...own, ...factoryMarketsFrom(goals.home, goals.away, factory)];
  }
  const key = ratingsKey(input.homeRatings, input.awayRatings);
  return {
    source: 'model',
    markets,
    key: factory === null ? key : `${key}${factoryKeySuffix(factory)}`,
    calibrated:
      isCalibrated(input.homeRatings ?? null, input.minRatingMatches) &&
      isCalibrated(input.awayRatings ?? null, input.minRatingMatches),
    pricesSane: checkMarkets(markets).ok,
    backsOpening: false,
    outOfLine: [],
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/**
 * Rule O1h (16-18 Nov 2026, the owner's locked odds): the fresh Hulusport board linked to an event
 * whose teams are NOT both calibrated, while the switch `hulusport_pricing` is on; null otherwise
 * (calibrated teams keep the model, with boardRule over the markets the board quotes).
 */
async function o1hBoard(exec: DbExecutor, input: EventPriceInput): Promise<LatestBoardOdds | null> {
  if (input.eventId === null) return null;
  if (
    isCalibrated(input.homeRatings ?? null, input.minRatingMatches) &&
    isCalibrated(input.awayRatings ?? null, input.minRatingMatches)
  ) {
    return null;
  }
  if (!(await getHulusportPricing(exec)).enabled) return null;
  return latestBoardOdds(exec, {
    eventId: input.eventId,
    now: input.now,
    maxAgeMs: BOARD_PRICES_MAX_AGE_MS,
  });
}

/**
 * Rule O1h: the WHOLE book of an event from the expected goals that explain the board's own 1X2
 * and goal line (boardGoalsFit, the conditions of O5), so no market is priced from empty ratings:
 * today's markets as priceFootball prices them, then the factory's from the same goals. Treated as
 * a market price that backs opening (one strong source, as for the board-only matches the owner
 * accepted on 14 Nov 2026): the hand-over, F7b and a person may open it while the stored prices
 * are these very prices, and rule A2 suspends it once the board is no longer fresh. boardRule then
 * puts the board's own prices (with our margin) over the markets it quotes. Null without a fit.
 */
function boardPrice(board: LatestBoardOdds, factory: FactoryPricingPlan | null): EventPrice | null {
  const books = board.markets as BoardMarketInput[];
  const fit = boardGoalsFit(books);
  if (fit === null || fit.totalsLine === null) return null;
  const own: PricedMarket[] = priceFootball(fit.lambdaHome, fit.lambdaAway);
  const markets =
    factory === null
      ? own
      : [...own, ...factoryMarketsFrom(fit.lambdaHome, fit.lambdaAway, factory)];
  const digest = createHash('sha256')
    .update(JSON.stringify(boardConsensus(books)))
    .digest('hex')
    .slice(0, 16);
  const key = `${BOARD_PRICING_KEY_PREFIX}|${digest}`;
  return {
    source: 'market',
    markets,
    key: factory === null ? key : `${key}${factoryKeySuffix(factory)}`,
    calibrated: true,
    pricesSane: checkMarkets(markets).ok,
    residual: fit.residual,
    books: 1,
    bookmakers: ['hulusport'],
    backsOpening: true,
    totalsLine: fit.totalsLine,
    outOfLine: [],
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
  if (input.eventId === null) return false;
  const price = await priceEvent(exec, input);
  if (price.source !== 'market' || !price.backsOpening) return false;
  // O1h: board-priced prices back opening in any competition; O1m only where the market is asked.
  if (input.competitionPricingSource !== 'market' && !isBoardPricedKey(price.key)) return false;
  const stamp = (await listEventPricing(exec, [input.eventId])).get(input.eventId);
  return stamp?.ratingsKey === price.key;
}

/**
 * The market prices of an event, or why there are none. The fresh rows come from latestMarketOdds
 * (maxAge MARKET_ODDS_MAX_AGE_MS unless the caller asks for fresher); a bookmaker counts once even
 * when two sources of one upstream list it (one voice, as for results: consensusRows), the newest
 * sighting winning.
 */
function marketPrice(
  rows: readonly MarketPriceRow[],
  /** The factory's pricing plan when its markets are priced, else null. */
  factory: FactoryPricingPlan | null,
): { kind: 'priced'; price: EventPrice } | { kind: 'none'; reason: MarketFallback } {
  const consensus = marketConsensus(rows, { minBooks: CONSENSUS_MIN_BOOKS });
  const x12 = consensus.find((c) => c.market === '1x2');
  if (x12 === undefined) return { kind: 'none', reason: 'no_consensus' };
  const fit = fitGoalsToMarket(consensus);
  if (fit === null) return { kind: 'none', reason: 'no_consensus' };
  if (fit.totalsLine === null) return { kind: 'none', reason: 'no_totals' };
  if (!(fit.residual <= MAX_MARKET_FIT_RESIDUAL)) return { kind: 'none', reason: 'poor_fit' };
  const priced = priceFootballFromMarket(consensus);
  if (priced === null) return { kind: 'none', reason: 'no_consensus' };
  const markets: PricedMarket[] =
    factory === null
      ? priced.markets
      : [...priced.markets, ...factoryMarketsFrom(priced.lambdaHome, priced.lambdaAway, factory)];
  return {
    kind: 'priced',
    price: {
      source: 'market',
      markets,
      // The factory's markets change what is priced, so the key says so: switching it on or off,
      // or changing its margins or families (task 2.5), re-prices every market-priced event once
      // (through the bounds of O3).
      key:
        factory === null
          ? marketPricingKey(consensus)
          : `${marketPricingKey(consensus)}${factoryKeySuffix(factory)}`,
      calibrated: true,
      pricesSane: checkMarkets(markets).ok,
      residual: priced.residual,
      books: priced.source.books1x2,
      bookmakers: x12.bookmakers,
      backsOpening: marketBacksOpening(x12.bookmakers),
      booksOu25: priced.source.booksOu25,
      totalsLine: priced.totalsLine,
      outOfLine: [],
    },
  };
}

/** Marks a market pricing key whose prices include the market factory's markets (version 1). */
export const FACTORY_KEY_SUFFIX = '|fm1';

/**
 * The suffix of a key whose prices include the factory's markets: FACTORY_KEY_SUFFIX alone with the
 * default margins and every family priced (so today's stamps stay current), else followed by
 * `.<tag>`, the plan's stamp of its margins and left-out families (factoryPricingPlan).
 */
export function factoryKeySuffix(plan: Pick<FactoryPricingPlan, 'tag'>): string {
  return plan.tag === '' ? FACTORY_KEY_SUFFIX : `${FACTORY_KEY_SUFFIX}.${plan.tag}`;
}

/**
 * Plan task 2.3: the market factory's own markets (not today's types, which the market path prices
 * already), from the expected goals fitted to the market, every selection listed. A market whose
 * favourite would pay under 1.02 is not offered, and a market is kept only when it passes O2 on its
 * own, so one weak market never holds the event's prices. Task 2.5: at the plan's margins per
 * class and family, without the families the weekly job suspended or turned off (their stored
 * markets are then suspended by the feed: upsertFixture's factoryComplete).
 */
export function factoryMarketsFrom(
  lambdaHome: number,
  lambdaAway: number,
  plan: FactoryPricingPlan,
): PricedMarket[] {
  if (plan.types.length === 0) return [];
  // Every selection is listed (no long-shot pruning): a stored factory market then always holds
  // all its prices, and hiding long shots is the match page's choice, not the storage's.
  return priceFactoryMarkets(lambdaHome, lambdaAway, {
    types: plan.types,
    marginBps: plan.marginBps,
    typeMarginBps: plan.typeMarginBps,
    firstHalfShare: plan.firstHalfShare,
    drawCorrection: plan.drawCorrection,
    maxListedOddsMilli: null,
  })
    .map((m) => ({
      type: m.type,
      line: m.line,
      selections: m.selections.map((sel) => ({ code: sel.code, oddsMilli: sel.oddsMilli })),
    }))
    .filter((m) => m.selections.length > 0 && checkMarkets([m]).ok);
}
