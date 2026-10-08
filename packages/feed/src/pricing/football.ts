import { parseLine } from '@vamos/core';
import type { FeedMarket, LiveScoreState } from '../types';
import {
  buildMarket,
  checkedLiveState,
  checkedMarginBps,
  clamp,
  defaultMarginBps,
  isPositiveFinite,
} from './book';

/**
 * Football pricing with independent Poisson goal counts per team.
 *
 * Prematch the expected goals λh, λa cover the whole match. In play the goals
 * still to come are Poisson with λ scaled by the remaining fraction of the 90
 * minutes (45 for first-half markets), added to the current score. Markets
 * whose outcome is already certain are left out instead of being priced at
 * 1.00, and so is any market whose favourite is too likely to be offered at
 * 1.001 or more (see priceProbability).
 */

export const FOOTBALL_BASE_GOALS = 1.35;
export const FOOTBALL_HOME_ADVANTAGE = 1.15;
/** Expected goals are clamped to this range so extreme ratings stay priceable. */
export const MIN_EXPECTED_GOALS = 0.05;
export const MAX_EXPECTED_GOALS = 6;
export const DEFAULT_GOAL_LINES: readonly string[] = Object.freeze([
  '0.5',
  '1.5',
  '2.5',
  '3.5',
  '4.5',
]);
export const DEFAULT_MAX_GOALS = 10;

const FULL_TIME_MINUTES = 90;
const HALF_MINUTES = 45;
/** Playing time still assumed while a half runs on (added time), so prices stay finite. */
const MIN_REMAINING_MINUTES = 0.5;
/** Highest per-team goal count with its own correct-score selection (see @vamos/core). */
const CORRECT_SCORE_MAX_GOALS = 4;
const MAX_GRID_GOALS = 50;

export interface FootballTeamStrength {
  /** Scoring strength, ~1.0; higher scores more. */
  attack: number;
  /** Defensive weakness, ~1.0; higher concedes MORE. */
  defence: number;
}

export interface ExpectedGoalsOptions {
  /** League-average goals per team per match (default 1.35). */
  base?: number;
  /** Multiplier on the home side's expected goals (default 1.15; 1 = neutral venue). */
  homeAdvantage?: number;
}

export interface ExpectedGoals {
  home: number;
  away: number;
}

/**
 * Expected goals of both sides:
 * λh = base × attack_h × defence_a × homeAdvantage, λa = base × attack_a × defence_h,
 * each clamped to [MIN_EXPECTED_GOALS, MAX_EXPECTED_GOALS].
 */
export function expectedGoals(
  home: FootballTeamStrength,
  away: FootballTeamStrength,
  options: ExpectedGoalsOptions = {},
): ExpectedGoals {
  const base = options.base ?? FOOTBALL_BASE_GOALS;
  const homeAdvantage = options.homeAdvantage ?? FOOTBALL_HOME_ADVANTAGE;
  for (const [what, value] of [
    ['base', base],
    ['homeAdvantage', homeAdvantage],
    ['home attack', home.attack],
    ['home defence', home.defence],
    ['away attack', away.attack],
    ['away defence', away.defence],
  ] as const) {
    if (!isPositiveFinite(value)) throw new RangeError(`${what} must be a positive number`);
  }
  return {
    home: clamp(
      base * home.attack * away.defence * homeAdvantage,
      MIN_EXPECTED_GOALS,
      MAX_EXPECTED_GOALS,
    ),
    away: clamp(base * away.attack * home.defence, MIN_EXPECTED_GOALS, MAX_EXPECTED_GOALS),
  };
}

/**
 * Joint score probabilities grid[h][a] for h, a in 0..maxGoals under
 * independent Poisson(λh), Poisson(λa), renormalised so the grid sums to 1.
 */
export function scoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = DEFAULT_MAX_GOALS,
): number[][] {
  checkLambda(lambdaHome, 'lambdaHome');
  checkLambda(lambdaAway, 'lambdaAway');
  if (!Number.isSafeInteger(maxGoals) || maxGoals < 0 || maxGoals > MAX_GRID_GOALS) {
    throw new RangeError(`maxGoals must be an integer 0..${MAX_GRID_GOALS}, got ${maxGoals}`);
  }
  const home = poissonPmf(lambdaHome, maxGoals);
  const away = poissonPmf(lambdaAway, maxGoals);
  let total = 0;
  const grid = home.map((ph) =>
    away.map((pa) => {
      const p = ph * pa;
      total += p;
      return p;
    }),
  );
  return grid.map((row) => row.map((p) => p / total));
}

export interface FootballPricingOptions {
  /** Margin of every market but correct score; default 600 bps prematch, 800 in play. */
  marginBps?: number;
  /** Margin of correct score; default 1500 bps prematch, 1700 in play. */
  correctScoreMarginBps?: number;
  /** Over/under lines, each a half-point line (default 0.5 … 4.5). */
  lines?: readonly string[];
  /**
   * In-play state. The first half counts as over once BOTH half-time scores
   * are set; until then a minute past 45 is first-half added time. In the
   * second half `minute` runs from 45 to 90 (and beyond in added time).
   */
  state?: LiveScoreState;
}

/**
 * Prices the football markets ('1x2', 'dc', one 'ou' per line, 'btts', 'dnb',
 * 'ht_1x2', 'cs') in display order. In play, markets with a certain outcome
 * are omitted: 'ou' lines already exceeded, 'btts' once both teams scored and
 * 'ht_1x2' once the first half is over.
 */
export function priceFootball(
  lambdaHome: number,
  lambdaAway: number,
  opts: FootballPricingOptions = {},
): FeedMarket[] {
  checkLambda(lambdaHome, 'lambdaHome');
  checkLambda(lambdaAway, 'lambdaAway');
  const state = opts.state === undefined ? null : checkedLiveState(opts.state);
  const live = state !== null;
  const margin = checkedMarginBps(opts.marginBps ?? defaultMarginBps('1x2', live));
  const csMargin = checkedMarginBps(opts.correctScoreMarginBps ?? defaultMarginBps('cs', live));
  const lines = canonicalLines(opts.lines ?? DEFAULT_GOAL_LINES);

  const home0 = state?.home ?? 0;
  const away0 = state?.away ?? 0;
  const firstHalfOver = state !== null && state.htHome !== null && state.htAway !== null;
  const fullTimeLeft = remainingFraction(state, firstHalfOver, FULL_TIME_MINUTES);
  const grid = scoreMatrix(lambdaHome * fullTimeLeft, lambdaAway * fullTimeLeft);

  const markets: FeedMarket[] = [];
  const offer = (market: FeedMarket | null): void => {
    if (market !== null) markets.push(market);
  };

  const result = outcomes(grid, home0, away0);
  offer(buildMarket('1x2', null, { '1': result.home, X: result.draw, '2': result.away }, margin));
  offer(
    buildMarket(
      'dc',
      null,
      {
        '1X': result.home + result.draw,
        '12': result.home + result.away,
        X2: result.draw + result.away,
      },
      margin,
    ),
  );

  const goalsSoFar = home0 + away0;
  const remainingTotals = totalGoalsDistribution(grid);
  for (const line of lines) {
    const value = Number(line);
    if (goalsSoFar > value) continue; // 'over' has already won
    let over = 0;
    let under = 0;
    remainingTotals.forEach((p, extra) => {
      if (goalsSoFar + extra > value) over += p;
      else under += p;
    });
    offer(buildMarket('ou', line, { over, under }, margin));
  }

  if (!(home0 > 0 && away0 > 0)) {
    let yes = 0;
    let no = 0;
    eachCell(grid, (h, a, p) => {
      if (home0 + h > 0 && away0 + a > 0) yes += p;
      else no += p;
    });
    offer(buildMarket('btts', null, { yes, no }, margin));
  }

  const decisive = result.home + result.away;
  if (decisive > 1e-12) {
    offer(
      buildMarket(
        'dnb',
        null,
        { '1': result.home / decisive, '2': result.away / decisive },
        margin,
      ),
    );
  }

  if (!firstHalfOver) {
    const firstHalfLeft = remainingFraction(state, false, HALF_MINUTES);
    const halfGrid = scoreMatrix(
      (lambdaHome / 2) * firstHalfLeft,
      (lambdaAway / 2) * firstHalfLeft,
    );
    const half = outcomes(halfGrid, home0, away0);
    offer(buildMarket('ht_1x2', null, { '1': half.home, X: half.draw, '2': half.away }, margin));
  }

  offer(buildMarket('cs', null, correctScoreProbabilities(grid, home0, away0), csMargin));
  return markets;
}

/**
 * Fraction of `periodMinutes` (90 full time, 45 first half) still to play.
 * Prematch 1. A half running into added time keeps MIN_REMAINING_MINUTES.
 */
function remainingFraction(
  state: Required<LiveScoreState> | null,
  firstHalfOver: boolean,
  periodMinutes: number,
): number {
  if (state === null) return 1;
  const clock = firstHalfOver
    ? clamp(state.minute, HALF_MINUTES, FULL_TIME_MINUTES)
    : Math.min(state.minute, HALF_MINUTES);
  return Math.max(periodMinutes - clock, MIN_REMAINING_MINUTES) / periodMinutes;
}

/** Final 1X2 probabilities: remaining goals from the grid added to the current score. */
function outcomes(
  grid: number[][],
  home0: number,
  away0: number,
): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  eachCell(grid, (h, a, p) => {
    const diff = home0 + h - (away0 + a);
    if (diff > 0) home += p;
    else if (diff === 0) draw += p;
    else away += p;
  });
  return { home, draw, away };
}

/** P(remaining total goals = k). */
function totalGoalsDistribution(grid: number[][]): number[] {
  const totals: number[] = [];
  eachCell(grid, (h, a, p) => {
    totals[h + a] = (totals[h + a] ?? 0) + p;
  });
  return Array.from(totals, (p) => p ?? 0);
}

/**
 * Correct-score probabilities for the 25 grid scores and 'other'. Scores the
 * match can no longer end on get 0 (priced at the maximum odds).
 */
function correctScoreProbabilities(
  grid: number[][],
  home0: number,
  away0: number,
): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (let h = 0; h <= CORRECT_SCORE_MAX_GOALS; h++) {
    for (let a = 0; a <= CORRECT_SCORE_MAX_GOALS; a++) {
      probabilities[`${h}-${a}`] =
        h >= home0 && a >= away0 ? (grid[h - home0]?.[a - away0] ?? 0) : 0;
    }
  }
  let other = 0;
  eachCell(grid, (h, a, p) => {
    if (home0 + h > CORRECT_SCORE_MAX_GOALS || away0 + a > CORRECT_SCORE_MAX_GOALS) other += p;
  });
  probabilities.other = other;
  return probabilities;
}

function eachCell(grid: number[][], visit: (home: number, away: number, p: number) => void): void {
  grid.forEach((row, h) => row.forEach((p, a) => visit(h, a, p)));
}

function poissonPmf(lambda: number, maxGoals: number): number[] {
  const pmf: number[] = [];
  let p = Math.exp(-lambda);
  pmf.push(p);
  for (let k = 1; k <= maxGoals; k++) {
    p *= lambda / k;
    pmf.push(p);
  }
  return pmf;
}

function checkLambda(lambda: number, what: string): void {
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0) {
    throw new RangeError(`${what} must be a finite number >= 0, got ${String(lambda)}`);
  }
}

function canonicalLines(lines: readonly string[]): string[] {
  const unique = new Map<number, string>();
  for (const line of lines) {
    const value = parseLine(line);
    unique.set(value, String(value));
  }
  return [...unique.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
}
