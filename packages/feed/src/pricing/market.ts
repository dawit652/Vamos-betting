import { MARKET_PRICING_KEY_PREFIX, type MarketConsensus } from '@vamos/core';
import type { FeedMarket } from '../types';
import { checkedMarginBps, clamp, defaultMarginBps } from './book';
import {
  DEFAULT_GOAL_LINES,
  type FootballBook,
  type FootballPricingOptions,
  MAX_EXPECTED_GOALS,
  MIN_EXPECTED_GOALS,
  buildFootballMarkets,
  footballBooks,
} from './football';

/**
 * Football prices from the bookmaker market (a licensed odds feed's consensus,
 * see marketConsensus in @vamos/core), which take priority over the
 * team-rating model when a consensus is available.
 *
 * - '1x2' is priced directly from the consensus fair probabilities, with our
 *   own margin; 'dc' and 'dnb' are derived from those same probabilities.
 * - 'ou' 2.5 is priced directly from the consensus when there is one.
 * - Every other market (the other goal lines, 'btts', 'ht_1x2', 'cs') comes
 *   from the independent-Poisson model of football.ts, with expected goals
 *   fitted to the consensus by fitGoalsToMarket.
 *
 * The fit uses the home and away win probabilities (the draw follows) and the
 * over probability of one goal line: 2.5 when it has a consensus, otherwise
 * the x.5 line from FIT_LINE_MIN to FIT_LINE_MAX with the most books (rule T1
 * of docs/theoddsapi-plan/README.md; a book's main line is often 3.5). With no
 * goal line at all there are no market prices (rule T2): fitted to the 1X2
 * alone, the model can only reach the market's draw by lowering both expected
 * goals, which prices over 2.5 five to nine points short (that plan, 10.3).
 *
 * It does not fit the draw: the independent Poisson
 * prices draws a little short of what the market says (fix plan F-17), and
 * fitting it would pull both expected goals down to make room for it. The
 * markets fitted from the model therefore carry that bias; the residual says
 * how well the model could match the targets it was given.
 *
 * Prematch only. Floats are fine here (probabilities); prices come out as
 * integer milli through buildMarket.
 */

/**
 * The pipeline holds an event for a trader when the fit's residual (largest
 * absolute probability error over the fitted targets) is above this: the
 * model markets would disagree visibly with the 1X2 and 2.5 line priced from
 * the market.
 */
export const MAX_MARKET_FIT_RESIDUAL = 0.03;
/** Probabilities in marketPricingKey are rounded to this step (half a percentage point). */
export const MARKET_PRICING_KEY_STEP = 0.005;
/** Prefix of marketPricingKey (defined in @vamos/core so the API can tell the two key forms apart). */
export { MARKET_PRICING_KEY_PREFIX };

const GOAL_LINE = '2.5';
/** Goal lines the fit may use in place of a missing 2.5 consensus (rule T1); the far ones say little. */
const FIT_LINE_MIN = 1.5;
const FIT_LINE_MAX = 4.5;
/** Fixed start of the fit (log expected goals): an ordinary match. */
const FIT_START: readonly [number, number] = [Math.log(1.45), Math.log(1.15)];
const FIT_MAX_ITERATIONS = 100;
/** Relative step of the numerical derivatives, in log expected goals. */
const FIT_DERIVATIVE_STEP = 1e-6;
const FIT_STEP_TOLERANCE = 1e-10;
const FIT_MIN_DAMPING = 1e-12;
const FIT_MAX_DAMPING = 1e12;
const LOG_MIN = Math.log(MIN_EXPECTED_GOALS);
const LOG_MAX = Math.log(MAX_EXPECTED_GOALS);

export interface MarketGoalsFit {
  lambdaHome: number;
  lambdaAway: number;
  /** Largest absolute probability error over the fitted targets (home, away, over the goal line if any). */
  residual: number;
  /**
   * The goal line fitted with the 1X2: '2.5' when it has a consensus, else the line used in its place
   * (rule T1); null when the consensus has none, and then the goals are too low to price from (T2).
   */
  totalsLine: string | null;
}

interface Targets {
  home: number;
  draw: number;
  away: number;
  books1x2: number;
  /** Over 2.5 of the consensus, priced straight from it; null without a 2.5 consensus. */
  over: number | null;
  booksOu25: number;
  /** The goal line the fit uses (see MarketGoalsFit.totalsLine), or null. */
  totals: { line: string; over: number; books: number } | null;
}

/**
 * Expected goals (λh, λa) of the independent-Poisson model, priced exactly as
 * priceFootball prices them prematch, that best match the consensus home and
 * away win probabilities and the over probability of its goal line (2.5, or
 * the line in its place, see the module comment), when it has one: least
 * squares on the probabilities, equally weighted, solved by a damped
 * Gauss-Newton (Levenberg-Marquardt) in log expected goals from a fixed
 * start, bounded by MIN_EXPECTED_GOALS..MAX_EXPECTED_GOALS, with a fixed
 * iteration cap. Deterministic. Null when there is no usable 1X2 consensus.
 */
export function fitGoalsToMarket(consensus: readonly MarketConsensus[]): MarketGoalsFit | null {
  const targets = readTargets(consensus);
  return targets === null ? null : fit(targets);
}

export type MarketPricingOptions = Pick<
  FootballPricingOptions,
  'marginBps' | 'correctScoreMarginBps' | 'lines'
>;

export interface MarketPricing {
  /** Same markets, order and shape as priceFootball. */
  markets: FeedMarket[];
  lambdaHome: number;
  lambdaAway: number;
  /** See MarketGoalsFit.residual and MAX_MARKET_FIT_RESIDUAL. */
  residual: number;
  /** The goal line the expected goals were fitted to: '2.5', or the line in its place (rule T1). */
  totalsLine: string;
  /** Books behind the 1X2 and the over/under 2.5 consensus (0 when there is none). */
  source: { books1x2: number; booksOu25: number };
}

/**
 * Prematch football markets from the market consensus (see the module
 * comment for which markets come from where), with priceFootball's margins
 * (default 600 bps, 1500 for correct score). Null when there is no usable
 * 1X2 consensus, or no goal line to fit the goals to (rule T2).
 */
export function priceFootballFromMarket(
  consensus: readonly MarketConsensus[],
  opts: MarketPricingOptions = {},
): MarketPricing | null {
  const targets = readTargets(consensus);
  if (targets === null || targets.totals === null) return null;
  const totalsLine = targets.totals.line;
  const margin = checkedMarginBps(opts.marginBps ?? defaultMarginBps('1x2', false));
  const csMargin = checkedMarginBps(opts.correctScoreMarginBps ?? defaultMarginBps('cs', false));
  const goals = fit(targets);
  const { home, draw, away, over } = targets;
  const books = footballBooks(goals.lambdaHome, goals.lambdaAway, {
    lines: opts.lines ?? DEFAULT_GOAL_LINES,
  }).map((book): FootballBook => {
    switch (book.type) {
      case '1x2':
        return { ...book, probabilities: { '1': home, X: draw, '2': away } };
      case 'dc':
        return {
          ...book,
          probabilities: { '1X': home + draw, '12': home + away, X2: draw + away },
        };
      case 'dnb':
        return {
          ...book,
          probabilities: { '1': home / (home + away), '2': away / (home + away) },
        };
      case 'ou':
        return book.line === GOAL_LINE && over !== null
          ? { ...book, probabilities: { over, under: 1 - over } }
          : book;
      default:
        return book;
    }
  });
  return {
    markets: buildFootballMarkets(books, margin, csMargin),
    lambdaHome: goals.lambdaHome,
    lambdaAway: goals.lambdaAway,
    residual: goals.residual,
    totalsLine,
    source: { books1x2: targets.books1x2, booksOu25: targets.booksOu25 },
  };
}

/**
 * A short, stable fingerprint of what priceFootballFromMarket prices from:
 * the 1X2 consensus and the fitted goal line's over probability (2.5, or the
 * line in its place) rounded to MARKET_PRICING_KEY_STEP (in thousandths), and
 * their book counts. Same role as ratingsKey in @vamos/scraper: an unchanged
 * key means the stored prices are current, so a market that only wiggles does
 * not re-price. Other goal lines are left out because they do not change our
 * prices. Example: "mkt1|1x2:455,270,275/6|ou2.5:530/5" (or "|ou3.5:310/5").
 */
export function marketPricingKey(consensus: readonly MarketConsensus[]): string {
  const targets = readTargets(consensus);
  if (targets === null) return `${MARKET_PRICING_KEY_PREFIX}|none`;
  const r = (p: number): number =>
    Math.round(p / MARKET_PRICING_KEY_STEP) * Math.round(MARKET_PRICING_KEY_STEP * 1000);
  const x12 = `1x2:${r(targets.home)},${r(targets.draw)},${r(targets.away)}/${targets.books1x2}`;
  const t = targets.totals;
  const ou = t === null ? `ou${GOAL_LINE}:-` : `ou${t.line}:${r(t.over)}/${t.books}`;
  return `${MARKET_PRICING_KEY_PREFIX}|${x12}|${ou}`;
}

/** The fit and pricing targets of a consensus, or null without a usable 1X2. */
function readTargets(consensus: readonly MarketConsensus[]): Targets | null {
  const x12 = consensus.find((c) => c?.market === '1x2');
  const probabilities = x12 === undefined ? null : probabilitiesOf(x12, ['1', 'X', '2']);
  if (x12 === undefined || probabilities === null) return null;
  const [home, draw, away] = probabilities as [number, number, number];
  const ou = consensus.find((c) => c?.market === 'ou' && Number(c.line) === Number(GOAL_LINE));
  const ouProbabilities = ou === undefined ? null : probabilitiesOf(ou, ['over', 'under']);
  const over = ouProbabilities === null ? null : ouProbabilities[0]!;
  const booksOu25 = ou === undefined || ouProbabilities === null ? 0 : booksOf(ou);
  return {
    home,
    draw,
    away,
    books1x2: booksOf(x12),
    over,
    booksOu25,
    totals:
      over === null ? lineInPlaceOf25(consensus) : { line: GOAL_LINE, over, books: booksOu25 },
  };
}

/**
 * Rule T1: the goal line fitted when 2.5 has no consensus. Of the x.5 lines
 * from FIT_LINE_MIN to FIT_LINE_MAX with usable probabilities and books: the
 * most books, then the nearest to 2.5, then the lower. Null when there is none.
 */
function lineInPlaceOf25(consensus: readonly MarketConsensus[]): Targets['totals'] {
  const target = Number(GOAL_LINE);
  const candidates: { line: number; over: number; books: number }[] = [];
  for (const c of consensus) {
    if (c?.market !== 'ou') continue;
    const line = Number(c.line);
    const p = probabilitiesOf(c, ['over', 'under']);
    const books = booksOf(c);
    if (!isFitLine(line) || line === target || p === null || books === 0) continue;
    candidates.push({ line, over: p[0]!, books });
  }
  candidates.sort(
    (a, b) =>
      b.books - a.books || Math.abs(a.line - target) - Math.abs(b.line - target) || a.line - b.line,
  );
  const best = candidates[0];
  return best === undefined
    ? null
    : { line: String(best.line), over: best.over, books: best.books };
}

/** An x.5 line (whole and quarter lines can push) from FIT_LINE_MIN to FIT_LINE_MAX. */
function isFitLine(line: number): boolean {
  return (
    Number.isInteger(line * 2) &&
    !Number.isInteger(line) &&
    line >= FIT_LINE_MIN &&
    line <= FIT_LINE_MAX
  );
}

/** The selections' probabilities renormalised to sum to 1, or null unless each is in (0, 1). */
function probabilitiesOf(c: MarketConsensus, codes: readonly string[]): number[] | null {
  const values = codes.map((code) => c.probabilities?.[code]);
  if (!values.every((p): p is number => typeof p === 'number' && p > 0 && p < 1)) return null;
  const total = values.reduce((sum, p) => sum + p, 0);
  return values.map((p) => p / total);
}

function booksOf(c: MarketConsensus): number {
  return Number.isSafeInteger(c.books) && c.books > 0 ? c.books : 0;
}

/** Model probabilities of the fitted targets at log expected goals x: home, away, over `line` if any. */
function model(x: readonly [number, number], line: string | null): number[] {
  const books = footballBooks(Math.exp(x[0]), Math.exp(x[1]), { lines: [line ?? GOAL_LINE] });
  const result = books[0]!.probabilities;
  const values = [result['1']!, result['2']!];
  if (line !== null) values.push(books.find((b) => b.type === 'ou')!.probabilities.over!);
  return values;
}

function fit(targets: Targets): MarketGoalsFit {
  const line = targets.totals === null ? null : targets.totals.line;
  const goal = [
    targets.home,
    targets.away,
    ...(targets.totals === null ? [] : [targets.totals.over]),
  ];
  const errors = (x: readonly [number, number]): number[] =>
    model(x, line).map((p, i) => p - goal[i]!);
  const cost = (r: readonly number[]): number => r.reduce((sum, e) => sum + e * e, 0);
  const bound = (v: number): number => Math.min(LOG_MAX, Math.max(LOG_MIN, v));

  let x: [number, number] = [FIT_START[0], FIT_START[1]];
  let r = errors(x);
  let current = cost(r);
  let damping = 1e-3;
  for (let iteration = 0; iteration < FIT_MAX_ITERATIONS; iteration++) {
    // Central-difference Jacobian, one column per parameter.
    const h = FIT_DERIVATIVE_STEP;
    const column = (up: [number, number], down: [number, number]): number[] => {
      const rd = errors(down);
      return errors(up).map((e, i) => (e - rd[i]!) / (2 * h));
    };
    const columns = [
      column([x[0] + h, x[1]], [x[0] - h, x[1]]),
      column([x[0], x[1] + h], [x[0], x[1] - h]),
    ] as const;
    const dot = (a: readonly number[], b: readonly number[]): number =>
      a.reduce((sum, v, i) => sum + v * b[i]!, 0);
    const a00 = dot(columns[0], columns[0]);
    const a01 = dot(columns[0], columns[1]);
    const a11 = dot(columns[1], columns[1]);
    const g0 = dot(columns[0], r);
    const g1 = dot(columns[1], r);

    let improved = false;
    while (damping <= FIT_MAX_DAMPING) {
      const m00 = a00 * (1 + damping) + FIT_MIN_DAMPING;
      const m11 = a11 * (1 + damping) + FIT_MIN_DAMPING;
      const det = m00 * m11 - a01 * a01;
      const step0 = (-g0 * m11 + g1 * a01) / det;
      const step1 = (-g1 * m00 + g0 * a01) / det;
      const next: [number, number] = [bound(x[0] + step0), bound(x[1] + step1)];
      const moved = Math.abs(next[0] - x[0]) + Math.abs(next[1] - x[1]);
      if (!Number.isFinite(moved) || moved < FIT_STEP_TOLERANCE) break;
      const rn = errors(next);
      const candidate = cost(rn);
      if (candidate < current) {
        x = next;
        r = rn;
        current = candidate;
        damping = Math.max(FIT_MIN_DAMPING, damping / 3);
        improved = true;
        break;
      }
      damping *= 4;
    }
    if (!improved) break;
  }
  return {
    lambdaHome: clamp(Math.exp(x[0]), MIN_EXPECTED_GOALS, MAX_EXPECTED_GOALS),
    lambdaAway: clamp(Math.exp(x[1]), MIN_EXPECTED_GOALS, MAX_EXPECTED_GOALS),
    residual: Math.max(...r.map(Math.abs)),
    totalsLine: line,
  };
}
