import { selectionsFor, type MarketTypeCode, type SportCode } from '@vamos/core';
import {
  buildMarket,
  CORRECT_SCORE_MARGIN_BPS,
  DEFAULT_MARGIN_BPS,
  LIVE_MARGIN_EXTRA_BPS,
} from '../pricing/book';
import type { FeedMarket } from '../types';
import {
  bothScoreProbability,
  correctScoreProbabilities,
  fitGoalsModel,
  overProbability,
  scoreGrid,
  type GoalsFit,
} from './goals-model';
import { formatLine, isHalfPointLine, mainLine } from './lines';

/**
 * Our prices from the market consensus. Every price comes from buildMarket,
 * so each selection pays less than its fair (consensus) probability allows:
 * no selection, and no combination of them, has a positive expectation
 * against the consensus.
 */

/** Margins in basis points. */
export interface PricingMargins {
  /** 1X2, double chance, draw no bet, totals, moneyline, winner. */
  main: number;
  /** Markets priced from the goals model (BTTS, model goal lines): less certain. */
  derived: number;
  correctScore: number;
}

/** Extra margin on model-derived markets for the model's own error. */
export const DERIVED_MARGIN_EXTRA_BPS = 200;
/** Fit error above which the model's markets are withheld (1.5 percentage points). */
export const DEFAULT_MAX_FIT_ERROR = 0.015;
/** Goal lines the model prices when the market itself has no consensus for them. */
export const DEFAULT_DERIVED_GOAL_LINES: readonly number[] = Object.freeze([
  0.5, 1.5, 2.5, 3.5, 4.5,
]);
/** A lengthening price is written only once it has moved this much (1%). */
export const MIN_LENGTHENING = 0.01;

/** Margins for a base main-market margin, prematch or in play. */
export function pricingMargins(mainBps = DEFAULT_MARGIN_BPS, live = false): PricingMargins {
  const extra = live ? LIVE_MARGIN_EXTRA_BPS : 0;
  return {
    main: mainBps + extra,
    derived: mainBps + extra + DERIVED_MARGIN_EXTRA_BPS,
    correctScore: Math.max(CORRECT_SCORE_MARGIN_BPS, mainBps) + extra,
  };
}

/** A consensus for one line of a totals market: [over, under]. */
export interface TotalConsensus {
  line: number;
  probabilities: readonly [number, number];
  books: number;
}

export interface EventConsensus {
  sport: SportCode;
  /**
   * The match-result consensus: [home, draw, away] for football, [home,
   * away] otherwise. Without it the event is not priced at all.
   */
  result: readonly number[] | null;
  /** Totals consensus per half-point line (goals, or points in basketball). */
  totals: readonly TotalConsensus[];
}

export interface EventPricingOptions {
  margins: PricingMargins;
  /** Price BTTS, correct score and missing goal lines from the goals model (football). */
  derived: boolean;
  derivedLines?: readonly number[];
  maxFitError?: number;
}

export interface EventPricing {
  markets: FeedMarket[];
  /** The fitted goals model (football with a total), else null. */
  fit: GoalsFit | null;
  /** Whether the model's markets were priced (fit good enough and enabled). */
  derived: boolean;
}

/** Our markets for one event; an empty list when the result market has no consensus. */
export function priceEvent(consensus: EventConsensus, options: EventPricingOptions): EventPricing {
  const none: EventPricing = { markets: [], fit: null, derived: false };
  if (consensus.result === null) return none;
  switch (consensus.sport) {
    case 'football':
      return priceFootball(consensus.result, consensus.totals, options);
    case 'basketball': {
      const markets = offer([priceFromList('ml', null, consensus.result, options.margins.main)]);
      // Adjacent basketball lines differ by a point or two, so independent
      // consensuses could cross; only the main line is offered.
      const main = mainLine(candidates(consensus.totals));
      const total = consensus.totals.find((entry) => entry.line === main);
      if (markets.length > 0 && total !== undefined) {
        markets.push(
          ...offer([
            priceFromList(
              'total',
              formatLine(total.line),
              total.probabilities,
              options.margins.main,
            ),
          ]),
        );
      }
      return { ...none, markets };
    }
    case 'tennis':
    case 'volleyball':
      return {
        ...none,
        markets: offer([priceFromList('winner', null, consensus.result, options.margins.main)]),
      };
    default: {
      const unknown: never = consensus.sport;
      throw new RangeError(`unknown sport: ${String(unknown)}`);
    }
  }
}

function priceFootball(
  result: readonly number[],
  totals: readonly TotalConsensus[],
  options: EventPricingOptions,
): EventPricing {
  const [home = 0, draw = 0, away = 0] = result;
  if (result.length !== 3) throw new RangeError('a football result consensus has 3 outcomes');
  const { margins } = options;
  const main1x2 = buildMarket('1x2', null, { '1': home, X: draw, '2': away }, margins.main);
  if (main1x2 === null) return { markets: [], fit: null, derived: false };
  const markets: FeedMarket[] = [main1x2];
  markets.push(
    ...offer([
      buildMarket(
        'dc',
        null,
        { '1X': home + draw, '12': home + away, X2: draw + away },
        margins.main,
      ),
      home + away > 0
        ? buildMarket(
            'dnb',
            null,
            { '1': home / (home + away), '2': away / (home + away) },
            margins.main,
          )
        : null,
    ]),
  );

  const lines = monotoneTotals(totals);
  for (const total of lines) {
    markets.push(
      ...offer([priceFromList('ou', formatLine(total.line), total.probabilities, margins.main)]),
    );
  }

  const main = mainLine(candidates(lines));
  const mainTotal = lines.find((entry) => entry.line === main);
  if (mainTotal === undefined) return { markets, fit: null, derived: false };
  const fit = fitGoalsModel({
    home,
    draw,
    away,
    total: { line: mainTotal.line, over: mainTotal.probabilities[0] },
  });
  const derived = options.derived && fit.error <= (options.maxFitError ?? DEFAULT_MAX_FIT_ERROR);
  if (!derived) return { markets, fit, derived: false };

  const grid = scoreGrid(fit);
  const btts = bothScoreProbability(grid);
  markets.push(...offer([buildMarket('btts', null, { yes: btts, no: 1 - btts }, margins.derived)]));
  const real = new Set(lines.map((entry) => entry.line));
  for (const line of options.derivedLines ?? DEFAULT_DERIVED_GOAL_LINES) {
    if (real.has(line) || !isHalfPointLine(line) || line < 0) continue;
    const over = overProbability(grid, line);
    markets.push(
      ...offer([buildMarket('ou', formatLine(line), { over, under: 1 - over }, margins.derived)]),
    );
  }
  markets.push(
    ...offer([buildMarket('cs', null, correctScoreProbabilities(grid), margins.correctScore)]),
  );
  return { markets: sortedMarkets(markets), fit, derived: true };
}

/**
 * The totals whose over-probability falls as the line rises, starting from
 * the main line: a crossing pair (noise between independent consensuses)
 * could otherwise be combined into a sure thing. Lines ascending.
 */
function monotoneTotals(totals: readonly TotalConsensus[]): TotalConsensus[] {
  const valid = totals
    .filter((entry) => isHalfPointLine(entry.line) && entry.line >= 0)
    .sort((a, b) => a.line - b.line);
  const main = mainLine(candidates(valid));
  const start = valid.findIndex((entry) => entry.line === main);
  if (start < 0) return [];
  const kept = [valid[start] as TotalConsensus];
  let previous = valid[start] as TotalConsensus;
  for (const entry of valid.slice(start + 1)) {
    if (entry.probabilities[0] < previous.probabilities[0]) {
      kept.push(entry);
      previous = entry;
    }
  }
  previous = valid[start] as TotalConsensus;
  for (const entry of valid.slice(0, start).reverse()) {
    if (entry.probabilities[0] > previous.probabilities[0]) {
      kept.unshift(entry);
      previous = entry;
    }
  }
  return kept;
}

function candidates(totals: readonly TotalConsensus[]) {
  return totals.map((entry) => ({
    line: entry.line,
    books: entry.books,
    probability: entry.probabilities[0],
  }));
}

/** buildMarket with probabilities given in selectionsFor(type) order. */
export function priceFromList(
  type: MarketTypeCode,
  line: string | null,
  probabilities: readonly number[],
  marginBps: number,
): FeedMarket | null {
  const codes = selectionsFor(type);
  if (probabilities.length !== codes.length) {
    throw new RangeError(`market "${type}" needs ${codes.length} probabilities`);
  }
  const byCode: Record<string, number> = {};
  codes.forEach((code, i) => {
    byCode[code] = probabilities[i] ?? 0;
  });
  return buildMarket(type, line, byCode, marginBps);
}

/**
 * Whether a selection's price should change from `current` to `next`: a
 * shorter price at once (a stale longer one would give value away), a longer
 * one only after it moved at least `minLengthening` (1%), so the board does
 * not flicker with every tiny move. Callers compare against the price last
 * written, so small moves still add up.
 */
export function shouldWritePrice(
  current: number,
  next: number,
  minLengthening = MIN_LENGTHENING,
): boolean {
  if (next === current) return false;
  if (next < current) return true;
  return (next - current) / current >= minLengthening;
}

function offer(markets: ReadonlyArray<FeedMarket | null>): FeedMarket[] {
  return markets.filter((market): market is FeedMarket => market !== null);
}

const FOOTBALL_ORDER: readonly MarketTypeCode[] = ['1x2', 'dc', 'ou', 'btts', 'dnb', 'cs'];

/** Football markets in catalogue order, goal lines ascending. */
function sortedMarkets(markets: FeedMarket[]): FeedMarket[] {
  const rank = (market: FeedMarket): number => {
    const index = FOOTBALL_ORDER.indexOf(market.type);
    return index < 0 ? FOOTBALL_ORDER.length : index;
  };
  return [...markets].sort(
    (a, b) => rank(a) - rank(b) || Number(a.line ?? 0) - Number(b.line ?? 0),
  );
}
