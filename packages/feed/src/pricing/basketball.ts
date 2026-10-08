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
 * Basketball pricing in the live simulator's own model (simulator.ts), whose
 * results settle the mock feed's markets: each team scores single points as
 * a Poisson process at its expected points / 48 per minute, through
 * regulation and every 5-minute overtime. The points still to come in the
 * current period are therefore independent Poisson counts, and a period that
 * ends level is followed by overtime until one ends with a winner. Winner and
 * total probabilities are computed exactly from these distributions,
 * overtime points included (both markets settle on the final score).
 */

export const BASKETBALL_REGULATION_MINUTES = 48;
export const BASKETBALL_OVERTIME_MINUTES = 5;
/** Average points per team per game. */
export const BASKETBALL_BASE_POINTS = 97.5;
export const BASKETBALL_HOME_COURT = 1.015;
/** Expected game totals are kept within this range. */
export const BASKETBALL_MIN_TOTAL = 160;
export const BASKETBALL_MAX_TOTAL = 230;
/** Largest expected margin between the teams (a heavy favourite still prices at ~1.01). */
export const BASKETBALL_MAX_MARGIN = 25;
/** Distance between the three total-points lines prematch. */
export const BASKETBALL_LINE_SPACING = 5;

/** A tiny remaining time at the end of a period keeps the distributions proper. */
const MIN_REMAINING_MINUTES = 0.01;
const MAX_LINE = 999.5;
/** Overtimes after the first that are still modelled (each ends level only ~6% of the time). */
const EXTRA_OVERTIMES = 4;
/** Probabilities below this are dropped from the point distributions. */
const NEGLIGIBLE = 1e-16;
/** Overtime outcomes depend only on the scoring rates; recent ones are kept. */
const OVERTIME_CACHE_SIZE = 64;
const overtimeCache = new Map<string, OvertimeOutcome>();

export interface BasketballTeamStrength {
  /** Scoring strength, ~1.0; higher scores more. */
  attack: number;
  /** Defensive weakness, ~1.0; higher concedes MORE. */
  defence: number;
}

/**
 * Expected points of both sides over 48 minutes: base × attack × opponent's
 * defence (× home court for the home side), scaled so the total stays within
 * BASKETBALL_MIN_TOTAL..BASKETBALL_MAX_TOTAL and the margin within
 * ±BASKETBALL_MAX_MARGIN. Realistic ratings lie within about 0.9–1.1.
 */
export function expectedPoints(
  home: BasketballTeamStrength,
  away: BasketballTeamStrength,
  options: { base?: number; homeCourt?: number } = {},
): { home: number; away: number } {
  const base = options.base ?? BASKETBALL_BASE_POINTS;
  const homeCourt = options.homeCourt ?? BASKETBALL_HOME_COURT;
  for (const value of [base, homeCourt, home.attack, home.defence, away.attack, away.defence]) {
    if (!isPositiveFinite(value)) throw new RangeError('ratings and options must be positive');
  }
  const rawHome = base * home.attack * away.defence * homeCourt;
  const rawAway = base * away.attack * home.defence;
  const total = rawHome + rawAway;
  const scaledTotal = clamp(total, BASKETBALL_MIN_TOTAL, BASKETBALL_MAX_TOTAL);
  const margin = clamp(
    ((rawHome - rawAway) * scaledTotal) / total,
    -BASKETBALL_MAX_MARGIN,
    BASKETBALL_MAX_MARGIN,
  );
  return { home: (scaledTotal + margin) / 2, away: (scaledTotal - margin) / 2 };
}

export interface BasketballPricingOptions {
  /** Margin of every market; default 600 bps prematch, 800 in play. */
  marginBps?: number;
  /** In play: `minute` on the game clock (0–48, then 48+ in overtime), points so far. */
  state?: LiveScoreState;
}

/**
 * Prices 'ml' (winner including overtime) and 'total' with three half-point
 * lines around the expected total at the end of the current period. Lines
 * already exceeded in play are omitted, and a finished game prices nothing.
 */
export function priceBasketball(
  meanHome: number,
  meanAway: number,
  opts: BasketballPricingOptions = {},
): FeedMarket[] {
  for (const value of [meanHome, meanAway]) {
    if (!isPositiveFinite(value)) throw new RangeError('expected points must be positive');
  }
  const state = opts.state === undefined ? null : checkedLiveState(opts.state);
  const margin = checkedMarginBps(opts.marginBps ?? defaultMarginBps('ml', state !== null));

  const remaining = remainingMinutes(state);
  if (remaining === null) return [];
  const home0 = state?.home ?? 0;
  const away0 = state?.away ?? 0;
  const pointsSoFar = home0 + away0;
  const rateHome = meanHome / BASKETBALL_REGULATION_MINUTES;
  const rateAway = meanAway / BASKETBALL_REGULATION_MINUTES;

  const period = periodOutcome(rateHome * remaining, rateAway * remaining, home0 - away0);
  const overtime = overtimeOutcome(rateHome, rateAway);
  const homeWins = period.home + period.tie * overtime.homeWins;
  const awayWins = period.away + period.tie * (1 - overtime.homeWins);

  const markets: FeedMarket[] = [];
  const ml = buildMarket('ml', null, { '1': homeWins, '2': awayWins }, margin);
  if (ml !== null) markets.push(ml);

  const fraction = remaining / BASKETBALL_REGULATION_MINUTES;
  const totalMean = pointsSoFar + (meanHome + meanAway) * fraction;
  const spacing = Math.max(1, Math.round(BASKETBALL_LINE_SPACING * Math.sqrt(fraction)));
  const centre = Math.floor(totalMean) + 0.5;
  for (const value of [centre - spacing, centre, centre + spacing]) {
    if (value < 0.5 || value > MAX_LINE || pointsSoFar > value) continue;
    // P(final total > value): the period's points when it produces a winner,
    // plus every overtime point after a level period.
    let over = 0;
    period.decidedTotals.forEach((p, points) => {
      if (pointsSoFar + points > value) over += p;
    });
    period.levelTotals.forEach((p, points) => {
      over += p * overtime.pointsAbove(value - pointsSoFar - points);
    });
    const under = Math.max(0, 1 - over);
    const market = buildMarket('total', value.toFixed(1), { over, under }, margin);
    if (market !== null) markets.push(market);
  }
  return markets;
}

interface PeriodOutcome {
  /** The period ends with the home / away side ahead, or level (→ overtime). */
  home: number;
  away: number;
  tie: number;
  /** P(the period's points = k and it produces a winner), by k. */
  decidedTotals: number[];
  /** P(the period's points = k and it ends level), by k. */
  levelTotals: number[];
}

/**
 * The rest of a period with Poisson(meanHome) and Poisson(meanAway) points
 * still to come, starting `lead` points ahead (home − away).
 */
function periodOutcome(meanHome: number, meanAway: number, lead: number): PeriodOutcome {
  const home = truncatedPoisson(meanHome);
  const away = truncatedPoisson(meanAway);
  const awayCdf: number[] = [];
  let cumulative = 0;
  for (const p of away) {
    cumulative += p;
    awayCdf.push(cumulative);
  }
  const cdfAway = (k: number): number =>
    k < 0 ? 0 : (awayCdf[Math.min(k, awayCdf.length - 1)] ?? 0);

  let homeAhead = 0;
  let level = 0;
  const levelTotals: number[] = [];
  home.forEach((ph, h) => {
    // Home ahead at the end: away scores fewer than h + lead more points.
    homeAhead += ph * cdfAway(h + lead - 1);
    const a = h + lead;
    const pa = a >= 0 ? (away[a] ?? 0) : 0;
    if (pa > 0) {
      level += ph * pa;
      levelTotals[h + a] = (levelTotals[h + a] ?? 0) + ph * pa;
    }
  });
  const totals = truncatedPoisson(meanHome + meanAway);
  const decidedTotals = totals.map((p, k) => Math.max(0, p - (levelTotals[k] ?? 0)));
  return {
    home: homeAhead,
    away: Math.max(0, 1 - homeAhead - level),
    tie: level,
    decidedTotals,
    levelTotals: Array.from(levelTotals, (p) => p ?? 0),
  };
}

interface OvertimeOutcome {
  /** P(home wins) from a level score, however many overtimes it takes. */
  homeWins: number;
  /** P(the overtime points, all overtimes together, exceed x). */
  pointsAbove(x: number): number;
}

function overtimeOutcome(rateHome: number, rateAway: number): OvertimeOutcome {
  const key = `${rateHome}|${rateAway}`;
  const cached = overtimeCache.get(key);
  if (cached !== undefined) return cached;
  const outcome = computeOvertimeOutcome(rateHome, rateAway);
  if (overtimeCache.size >= OVERTIME_CACHE_SIZE) {
    const oldest = overtimeCache.keys().next().value;
    if (oldest !== undefined) overtimeCache.delete(oldest);
  }
  overtimeCache.set(key, outcome);
  return outcome;
}

function computeOvertimeOutcome(rateHome: number, rateAway: number): OvertimeOutcome {
  const one = periodOutcome(
    rateHome * BASKETBALL_OVERTIME_MINUTES,
    rateAway * BASKETBALL_OVERTIME_MINUTES,
    0,
  );
  const decided = one.home + one.away;
  const homeWins = decided > 0 ? one.home / decided : 0.5;
  // Points of all overtimes: G = (this overtime's points) + G' if it ends level.
  const level = [...one.levelTotals.entries()].filter(([, p]) => p > NEGLIGIBLE);
  let points = one.decidedTotals.slice();
  for (let i = 0; i < EXTRA_OVERTIMES; i++) {
    const next = one.decidedTotals.slice();
    for (const [k, pLevel] of level) {
      points.forEach((p, j) => {
        if (p > NEGLIGIBLE) next[k + j] = (next[k + j] ?? 0) + pLevel * p;
      });
    }
    points = Array.from(next, (p) => p ?? 0);
  }
  // atLeast[k] = P(G ≥ k).
  const atLeast = new Array<number>(points.length).fill(0);
  let tail = 0;
  for (let k = points.length - 1; k >= 0; k--) {
    tail += points[k] ?? 0;
    atLeast[k] = tail;
  }
  return {
    homeWins,
    pointsAbove(x: number): number {
      const k = Math.floor(x) + 1; // G > x ⟺ G ≥ ⌊x⌋ + 1 for an integer G
      if (k <= 0) return 1;
      return atLeast[k] ?? 0;
    },
  };
}

/** Poisson(mean) probabilities up to far into the upper tail, renormalised to sum to 1. */
function truncatedPoisson(mean: number): number[] {
  const maxK = Math.ceil(mean + 12 * Math.sqrt(mean) + 12);
  const pmf = poissonPmf(mean, maxK);
  const total = pmf.reduce((sum, p) => sum + p, 0);
  return pmf.map((p) => p / total);
}

/**
 * Minutes left in the current period: regulation, or the running 5-minute
 * overtime. At the end of a period a tie starts a fresh overtime; any other
 * score is final (null).
 */
function remainingMinutes(state: Required<LiveScoreState> | null): number | null {
  if (state === null) return BASKETBALL_REGULATION_MINUTES;
  const { minute } = state;
  const periodEnd =
    minute <= BASKETBALL_REGULATION_MINUTES
      ? BASKETBALL_REGULATION_MINUTES
      : BASKETBALL_REGULATION_MINUTES +
        BASKETBALL_OVERTIME_MINUTES *
          Math.ceil((minute - BASKETBALL_REGULATION_MINUTES) / BASKETBALL_OVERTIME_MINUTES);
  const left = periodEnd - minute;
  if (left <= 0 && minute >= BASKETBALL_REGULATION_MINUTES) {
    return state.home === state.away ? BASKETBALL_OVERTIME_MINUTES : null;
  }
  return Math.max(left, MIN_REMAINING_MINUTES);
}
