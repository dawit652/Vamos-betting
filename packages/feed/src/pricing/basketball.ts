import type { FeedMarket, LiveScoreState } from '../types';
import {
  buildMarket,
  checkedLiveState,
  checkedMarginBps,
  clamp,
  defaultMarginBps,
  isPositiveFinite,
  normalCdf,
} from './book';

/**
 * Basketball pricing with a normal model: the final margin (home − away) and
 * the final total are normal around their expected values. In play only the
 * remaining minutes are uncertain: their mean and variance scale with the
 * remaining fraction of the 48 minutes (or of the current 5-minute overtime).
 */

export const BASKETBALL_REGULATION_MINUTES = 48;
export const BASKETBALL_OVERTIME_MINUTES = 5;
/** Standard deviation of the total points over 48 minutes. */
export const BASKETBALL_TOTAL_SD = 12;
/** Standard deviation of the margin (home − away) over 48 minutes. */
export const BASKETBALL_MARGIN_SD = 11;
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
 * lines around the expected final total. A tie after the remaining time goes
 * to overtime, so its probability is split evenly between the teams. Lines
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
  const fraction = remaining / BASKETBALL_REGULATION_MINUTES;
  const home0 = state?.home ?? 0;
  const away0 = state?.away ?? 0;

  const marginMean = home0 - away0 + (meanHome - meanAway) * fraction;
  const marginSd = BASKETBALL_MARGIN_SD * Math.sqrt(fraction);
  // Final margin is an integer: ≥ 1 wins, 0 ties (→ overtime), ≤ −1 loses.
  const homeWins = 1 - normalCdf((0.5 - marginMean) / marginSd);
  const awayWins = normalCdf((-0.5 - marginMean) / marginSd);
  const tie = Math.max(0, 1 - homeWins - awayWins);

  const markets: FeedMarket[] = [];
  const ml = buildMarket('ml', null, { '1': homeWins + tie / 2, '2': awayWins + tie / 2 }, margin);
  if (ml !== null) markets.push(ml);

  const pointsSoFar = home0 + away0;
  const totalMean = pointsSoFar + (meanHome + meanAway) * fraction;
  const totalSd = BASKETBALL_TOTAL_SD * Math.sqrt(fraction);
  const spacing = Math.max(1, Math.round(BASKETBALL_LINE_SPACING * Math.sqrt(fraction)));
  const centre = Math.floor(totalMean) + 0.5;
  for (const value of [centre - spacing, centre, centre + spacing]) {
    if (value < 0.5 || value > MAX_LINE || pointsSoFar > value) continue;
    // The final total is an integer, so 'over' means ≥ value + 0.5.
    const over = 1 - normalCdf((value - totalMean) / totalSd);
    const market = buildMarket('total', value.toFixed(1), { over, under: 1 - over }, margin);
    if (market !== null) markets.push(market);
  }
  return markets;
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
