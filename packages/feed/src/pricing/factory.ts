import {
  FACTORY_MARKETS,
  type FactoryGroup,
  type FactoryMarginClass,
  type FactoryMarket,
  type FactoryScoreGrids,
  LEGACY_FOOTBALL_TYPES,
  type MarketTypeCode,
  type OddsMilli,
  canonicalFactoryLine,
  DEFAULT_FAMILY_MARGIN_BPS,
  fairBook,
  findFactoryMarket,
} from '@vamos/core';
import { checkedMarginBps, defaultMarginBps, priceBook } from './book';
import { mixedScoreMatrix, remainingPlayingTime, scoreMatrix } from './football';

/**
 * Pricing of the market factory's football markets (docs/plans/hulusport-parity-plan.md
 * section 4.1, task 2.2): the model's score grids go through each market's own
 * rule ({@link fairBook}) and the fair book is priced with {@link priceBook}.
 */

const FIRST_HALF_SHARE_MIN = 0.3;
const FIRST_HALF_SHARE_MAX = 0.7;

export interface PrematchGridOptions {
  /**
   * Plan item P-5: the share of the match's goals scored in the first half
   * (0.3 to 0.7). null (default) keeps today's time-based split, which follows
   * from the playing time of each half.
   */
  firstHalfShare?: number | null;
  /**
   * Plan item P-4: the Dixon-Coles correlation ρ applied to the four low
   * scores of the full-time grid. null (default) leaves the independent
   * Poisson grid; 0 is the same as null. Fitting ρ is not done here.
   */
  drawCorrection?: number | null;
}

/**
 * The score grids a prematch match is priced from. With both switches off
 * these are exactly the grids today's football pricing uses: `ft` and `h1` as
 * in `footballBooks` (the latter for 'ht_1x2'), and `h2` the same mixture over
 * the playing time of a second half.
 */
export function prematchFactoryGrids(
  lambdaHome: number,
  lambdaAway: number,
  options: PrematchGridOptions = {},
): FactoryScoreGrids {
  const share = options.firstHalfShare ?? null;
  const rho = options.drawCorrection ?? null;
  if (share !== null) {
    if (
      typeof share !== 'number' ||
      !Number.isFinite(share) ||
      share < FIRST_HALF_SHARE_MIN ||
      share > FIRST_HALF_SHARE_MAX
    ) {
      throw new RangeError(
        `firstHalfShare must be a number ${FIRST_HALF_SHARE_MIN}..${FIRST_HALF_SHARE_MAX}, got ${String(share)}`,
      );
    }
  }
  if (rho !== null && (typeof rho !== 'number' || !Number.isFinite(rho))) {
    throw new RangeError(`drawCorrection must be a finite number, got ${String(rho)}`);
  }

  const playing = remainingPlayingTime(0, false);
  const secondHalf = remainingPlayingTime(45, true);
  const mixedFullTime = mixedScoreMatrix(lambdaHome, lambdaAway, playing.fullTime);
  const ft =
    rho === null || rho === 0
      ? mixedFullTime
      : dixonColes(mixedFullTime, lambdaHome, lambdaAway, rho);

  if (share === null) {
    if (playing.firstHalf === null) throw new RangeError('no first half to price');
    return {
      ft,
      h1: mixedScoreMatrix(lambdaHome, lambdaAway, playing.firstHalf),
      h2: mixedScoreMatrix(lambdaHome, lambdaAway, secondHalf.fullTime),
    };
  }
  return {
    ft,
    h1: scoreMatrix(lambdaHome * share, lambdaAway * share),
    h2: scoreMatrix(lambdaHome * (1 - share), lambdaAway * (1 - share)),
  };
}

/** Multiplies the four low cells by the Dixon-Coles τ and renormalises; the input grid is not changed. */
function dixonColes(
  grid: number[][],
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number[][] {
  const tau: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 1 - lambdaHome * lambdaAway * rho],
    [0, 1, 1 + lambdaHome * rho],
    [1, 0, 1 + lambdaAway * rho],
    [1, 1, 1 - rho],
  ];
  for (const [h, a, factor] of tau) {
    if (factor < 0) {
      throw new RangeError(
        `drawCorrection ${rho} makes the correction of score ${h}-${a} negative (${factor})`,
      );
    }
  }
  const corrected = grid.map((row) => [...row]);
  for (const [h, a, factor] of tau) {
    const row = corrected[h];
    if (row === undefined || row[a] === undefined) continue;
    row[a] *= factor;
  }
  let total = 0;
  for (const row of corrected) for (const p of row) total += p;
  if (!(total > 0)) throw new RangeError('drawCorrection leaves no probability');
  return corrected.map((row) => row.map((p) => p / total));
}

/**
 * Default margins of the factory markets that are not today's football markets (the defaults of
 * the setting `market_families.marginBps`, DEFAULT_FAMILY_MARGIN_BPS in @vamos/core).
 */
export const FACTORY_MARGIN_BPS: Readonly<Record<FactoryMarginClass, number>> =
  DEFAULT_FAMILY_MARGIN_BPS;
/** A market whose shortest price is below this is not listed (1.02). */
export const DEFAULT_MIN_FAVOURITE_ODDS_MILLI = 1020;
/** A selection priced above this is not listed (500.0). */
export const DEFAULT_MAX_LISTED_ODDS_MILLI = 500_000;

export interface FactoryPricingOptions extends PrematchGridOptions {
  /** Margin per class for the markets that are not today's football types (default 600 / 700 / 1200). */
  marginBps?: Partial<Record<FactoryMarginClass, number>>;
  /** Margin per market type; wins over everything else. */
  typeMarginBps?: Record<string, number>;
  /** Drop a market whose shortest price is below this (default 1020); null keeps every market. */
  minFavouriteOddsMilli?: number | null;
  /** Do not list a selection priced above this (default 500000); null lists every selection. */
  maxListedOddsMilli?: number | null;
  /** Only these market types, in catalogue order. */
  types?: readonly string[];
  /** Only these lines of a type (a type not named here keeps all its lines). */
  lines?: Record<string, readonly string[]>;
}

export interface FactoryPricedMarket {
  type: string;
  line: string | null;
  group: FactoryGroup;
  marginClass: FactoryMarginClass;
  selections: { code: string; oddsMilli: OddsMilli }[];
}

const LEGACY_TYPES: ReadonlySet<string> = new Set(LEGACY_FOOTBALL_TYPES);
const KNOWN_TYPES: ReadonlySet<string> = new Set(FACTORY_MARKETS.map((market) => market.type));
const MARGIN_CLASSES: readonly FactoryMarginClass[] = ['main', 'derivative', 'long'];

function checkedThreshold(
  value: number | null | undefined,
  fallback: number,
  what: string,
): number | null {
  if (value === null) return null;
  const threshold = value ?? fallback;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError(`${what} must be a number >= 0 or null, got ${String(threshold)}`);
  }
  return threshold;
}

/** The margin of every market, checked once up front. */
function marginResolver(options: FactoryPricingOptions): (market: FactoryMarket) => number {
  const byClass = new Map<FactoryMarginClass, number>();
  for (const marginClass of MARGIN_CLASSES) {
    byClass.set(
      marginClass,
      checkedMarginBps(options.marginBps?.[marginClass] ?? FACTORY_MARGIN_BPS[marginClass]),
    );
  }
  const byType = new Map<string, number>();
  for (const [type, margin] of Object.entries(options.typeMarginBps ?? {})) {
    byType.set(type, checkedMarginBps(margin));
  }
  return (market) => {
    const own = byType.get(market.type);
    if (own !== undefined) return own;
    if (LEGACY_TYPES.has(market.type)) {
      const explicit = options.marginBps?.[market.marginClass];
      // Today's football margins unless the caller overrode the class.
      return explicit === undefined
        ? defaultMarginBps(market.type as MarketTypeCode, false)
        : byClass.get(market.marginClass)!;
    }
    return byClass.get(market.marginClass)!;
  };
}

function selectedMarkets(options: FactoryPricingOptions): FactoryMarket[] {
  const types = options.types === undefined ? null : new Set(options.types);
  if (types !== null) {
    for (const type of types) {
      if (!KNOWN_TYPES.has(type)) throw new RangeError(`unknown factory market type: "${type}"`);
    }
  }
  const lines = new Map<string, Set<string | null>>();
  for (const [type, wanted] of Object.entries(options.lines ?? {})) {
    if (!KNOWN_TYPES.has(type)) throw new RangeError(`unknown factory market type: "${type}"`);
    const canonical = new Set<string | null>();
    for (const line of wanted) {
      if (findFactoryMarket(type, line) === undefined) {
        throw new RangeError(`unknown factory market: "${type}" line "${line}"`);
      }
      canonical.add(canonicalFactoryLine(line));
    }
    lines.set(type, canonical);
  }
  return FACTORY_MARKETS.filter(
    (market) =>
      (types === null || types.has(market.type)) &&
      (lines.get(market.type)?.has(market.line) ?? !lines.has(market.type)),
  );
}

/**
 * Prices the factory's football markets for a match prematch, in catalogue
 * order. A market is left out when it cannot be priced (a push-only market, or
 * a favourite too likely to offer), and, with the default pruning, when its
 * shortest price is under 1.02; a selection priced over 500.0 is not listed
 * (it still counts in the book, so the margin is unchanged).
 */
export function priceFactoryMarkets(
  lambdaHome: number,
  lambdaAway: number,
  options: FactoryPricingOptions = {},
): FactoryPricedMarket[] {
  const minFavourite = checkedThreshold(
    options.minFavouriteOddsMilli,
    DEFAULT_MIN_FAVOURITE_ODDS_MILLI,
    'minFavouriteOddsMilli',
  );
  const maxListed = checkedThreshold(
    options.maxListedOddsMilli,
    DEFAULT_MAX_LISTED_ODDS_MILLI,
    'maxListedOddsMilli',
  );
  const marginOf = marginResolver(options);
  const markets = selectedMarkets(options);
  const grids = prematchFactoryGrids(lambdaHome, lambdaAway, options);

  const priced: FactoryPricedMarket[] = [];
  for (const market of markets) {
    const book = fairBook(market, grids);
    if (!book.priceable) continue;
    const prices = priceBook(book.probabilities, marginOf(market));
    if (prices === null) continue;
    if (minFavourite !== null && Math.min(...prices) < minFavourite) continue;
    const selections: FactoryPricedMarket['selections'] = [];
    market.selections.forEach((code, i) => {
      const oddsMilli = prices[i]!;
      if (maxListed === null || oddsMilli <= maxListed) selections.push({ code, oddsMilli });
    });
    priced.push({
      type: market.type,
      line: market.line,
      group: market.group,
      marginClass: market.marginClass,
      selections,
    });
  }
  return priced;
}
