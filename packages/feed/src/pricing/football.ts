import { type MarketTypeCode, parseLine } from '@vamos/core';
import type { FeedMarket, LiveScoreState } from '../types';
import {
  buildMarket,
  checkedLiveState,
  checkedMarginBps,
  clamp,
  defaultMarginBps,
  isPositiveFinite,
  poissonPmf,
} from './book';

/**
 * Football pricing with independent Poisson goal counts per team, in the same
 * units as the live simulator (simulator.ts), whose results settle the mock
 * feed's markets.
 *
 * The expected goals λh, λa cover the whole match including added time, so
 * goals arrive at λ / FOOTBALL_PLAYING_MINUTES per minute of play. Each half
 * runs on for a whole number of added minutes drawn uniformly from
 * FIRST_HALF_ADDED_TIME / SECOND_HALF_ADDED_TIME. The goals still to come are
 * therefore a mixture of Poisson counts over the possible remaining playing
 * times: a half that has reached added time has at least one more added
 * minute than the clock shows. They are added to the current score. Prematch
 * is the same model from minute 0.
 *
 * Markets whose outcome is already certain are left out instead of being
 * priced at 1.00, and so is any market whose favourite is too likely to be
 * offered at 1.001 or more (see priceProbability).
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

/** Added time of each half: whole minutes, each value equally likely. */
export const FIRST_HALF_ADDED_TIME: readonly [number, number] = Object.freeze([1, 3] as const);
export const SECOND_HALF_ADDED_TIME: readonly [number, number] = Object.freeze([2, 6] as const);

const FULL_TIME_MINUTES = 90;
const HALF_MINUTES = 45;
/**
 * Mean minutes of play in a match: 90 plus the mean added time of both halves
 * (96). Expected goals are per match, so the goal rate per minute of play is
 * λ / FOOTBALL_PLAYING_MINUTES and the expected goals of a whole match are λ.
 */
export const FOOTBALL_PLAYING_MINUTES =
  FULL_TIME_MINUTES +
  (FIRST_HALF_ADDED_TIME[0] + FIRST_HALF_ADDED_TIME[1]) / 2 +
  (SECOND_HALF_ADDED_TIME[0] + SECOND_HALF_ADDED_TIME[1]) / 2;
/**
 * Playing time still assumed when a half runs on beyond its longest added
 * time (possible only with a real feed's clock), so prices stay finite.
 */
const MIN_REMAINING_MINUTES = 0.5;
/** Clock values closer than this to a period end count as having reached it. */
const CLOCK_EPSILON = 1e-9;
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
  const books = footballBooks(lambdaHome, lambdaAway, opts);
  const live = opts.state !== undefined;
  const margin = checkedMarginBps(opts.marginBps ?? defaultMarginBps('1x2', live));
  const csMargin = checkedMarginBps(opts.correctScoreMarginBps ?? defaultMarginBps('cs', live));
  return buildFootballMarkets(books, margin, csMargin);
}

/** One football market before pricing: its type, line and fair selection probabilities. */
export interface FootballBook {
  type: MarketTypeCode;
  line: string | null;
  probabilities: Record<string, number>;
}

/**
 * The fair probabilities of every football market priceFootball offers, in
 * the same order, before margins are applied and before markets that cannot
 * be priced are dropped (those are dropped by buildFootballMarkets). Shared
 * with the market-priced path (market.ts), which replaces some of them.
 */
export function footballBooks(
  lambdaHome: number,
  lambdaAway: number,
  opts: Pick<FootballPricingOptions, 'lines' | 'state'> = {},
): FootballBook[] {
  checkLambda(lambdaHome, 'lambdaHome');
  checkLambda(lambdaAway, 'lambdaAway');
  const state = opts.state === undefined ? null : checkedLiveState(opts.state);
  const lines = canonicalLines(opts.lines ?? DEFAULT_GOAL_LINES);

  const home0 = state?.home ?? 0;
  const away0 = state?.away ?? 0;
  const firstHalfOver = state !== null && state.htHome !== null && state.htAway !== null;
  const playing = remainingPlayingTime(state?.minute ?? 0, firstHalfOver);
  const grid = mixedScoreMatrix(lambdaHome, lambdaAway, playing.fullTime);

  const books: FootballBook[] = [];
  const offer = (
    type: MarketTypeCode,
    line: string | null,
    probabilities: Record<string, number>,
  ) => {
    books.push({ type, line, probabilities });
  };

  const result = outcomes(grid, home0, away0);
  offer('1x2', null, { '1': result.home, X: result.draw, '2': result.away });
  offer('dc', null, {
    '1X': result.home + result.draw,
    '12': result.home + result.away,
    X2: result.draw + result.away,
  });

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
    offer('ou', line, { over, under });
  }

  if (!(home0 > 0 && away0 > 0)) {
    let yes = 0;
    let no = 0;
    eachCell(grid, (h, a, p) => {
      if (home0 + h > 0 && away0 + a > 0) yes += p;
      else no += p;
    });
    offer('btts', null, { yes, no });
  }

  const decisive = result.home + result.away;
  if (decisive > 1e-12) {
    offer('dnb', null, { '1': result.home / decisive, '2': result.away / decisive });
  }

  if (playing.firstHalf !== null) {
    const halfGrid = mixedScoreMatrix(lambdaHome, lambdaAway, playing.firstHalf);
    const half = outcomes(halfGrid, home0, away0);
    offer('ht_1x2', null, { '1': half.home, X: half.draw, '2': half.away });
  }

  offer('cs', null, correctScoreProbabilities(grid, home0, away0));
  return books;
}

/**
 * Prices football books in order with `marginBps` (correct score with
 * `correctScoreMarginBps`), leaving out any market that cannot be offered
 * (see buildMarket).
 */
export function buildFootballMarkets(
  books: readonly FootballBook[],
  marginBps: number,
  correctScoreMarginBps: number,
): FeedMarket[] {
  return books.flatMap((book) => {
    const market = buildMarket(
      book.type,
      book.line,
      book.probabilities,
      book.type === 'cs' ? correctScoreMarginBps : marginBps,
    );
    return market === null ? [] : [market];
  });
}

/** Possible playing times (minutes) with their probabilities, summing to 1. */
export type PlayingTime = ReadonlyArray<{ minutes: number; weight: number }>;

/**
 * Minutes of play still to come, as the live simulator plays them: until full
 * time, and until half time while the first half runs (null once it is over).
 * `minute` is the match clock: 0 to 45 plus added time in the first half, 45
 * to 90 plus added time in the second half (45 during the break). A half
 * whose clock is past its regular end has not ended yet, so its added time is
 * longer than the time already played.
 */
export function remainingPlayingTime(
  minute: number,
  firstHalfOver: boolean,
): { fullTime: PlayingTime; firstHalf: PlayingTime | null } {
  if (!Number.isFinite(minute) || minute < 0) {
    throw new RangeError(`invalid live minute: ${String(minute)}`);
  }
  const secondHalf = halfLeft(HALF_MINUTES, FULL_TIME_MINUTES, SECOND_HALF_ADDED_TIME);
  if (firstHalfOver) {
    const clock = Math.max(minute, HALF_MINUTES);
    return {
      fullTime: halfLeft(clock, FULL_TIME_MINUTES, SECOND_HALF_ADDED_TIME),
      firstHalf: null,
    };
  }
  const firstHalf = halfLeft(minute, HALF_MINUTES, FIRST_HALF_ADDED_TIME);
  return { fullTime: sumOf(firstHalf, secondHalf), firstHalf };
}

/**
 * Minutes left in a half ending at `regularEnd` plus added time drawn from
 * `addedTime`, with the clock at `clock`: the added times still possible
 * (the half has not ended at `clock`), equally likely.
 */
function halfLeft(
  clock: number,
  regularEnd: number,
  addedTime: readonly [number, number],
): PlayingTime {
  const left: number[] = [];
  for (let added = addedTime[0]; added <= addedTime[1]; added++) {
    const minutes = regularEnd + added - clock;
    if (minutes > CLOCK_EPSILON) left.push(minutes);
  }
  if (left.length === 0) return [{ minutes: MIN_REMAINING_MINUTES, weight: 1 }];
  return left.map((minutes) => ({ minutes, weight: 1 / left.length }));
}

/** The distribution of the sum of two independent playing times. */
function sumOf(a: PlayingTime, b: PlayingTime): PlayingTime {
  const byMinutes = new Map<number, { minutes: number; weight: number }>();
  for (const x of a) {
    for (const y of b) {
      const minutes = x.minutes + y.minutes;
      const key = Math.round(minutes * 1e6);
      const entry = byMinutes.get(key);
      if (entry === undefined) byMinutes.set(key, { minutes, weight: x.weight * y.weight });
      else entry.weight += x.weight * y.weight;
    }
  }
  return [...byMinutes.values()];
}

/** Score grid of the goals still to come: Poisson grids mixed over the playing time left. */
function mixedScoreMatrix(lambdaHome: number, lambdaAway: number, time: PlayingTime): number[][] {
  let mixed: number[][] | null = null;
  for (const { minutes, weight } of time) {
    const share = minutes / FOOTBALL_PLAYING_MINUTES;
    const grid = scoreMatrix(lambdaHome * share, lambdaAway * share);
    if (mixed === null) {
      mixed = grid.map((row) => row.map((p) => p * weight));
    } else {
      for (const [h, row] of grid.entries()) {
        const target = mixed[h];
        if (target === undefined) continue;
        for (const [a, p] of row.entries()) target[a] = (target[a] ?? 0) + p * weight;
      }
    }
  }
  if (mixed === null) throw new RangeError('no playing time to price');
  return mixed;
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
