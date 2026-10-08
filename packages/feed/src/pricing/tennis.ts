import type { FeedMarket, LiveScoreState } from '../types';
import { buildMarket, checkedLiveState, checkedMarginBps, defaultMarginBps } from './book';

/**
 * Tennis and volleyball 'winner' pricing.
 *
 * Prematch the match-win probability is a logistic of the Elo-like rating
 * difference. It is converted to a per-set win probability (best of 3 sets
 * for tennis, best of 5 for volleyball), which then prices the match from
 * any set score. In play `home` / `away` are the sets won so far.
 */

export type SetSport = 'tennis' | 'volleyball';

/** Sets needed to win the match. */
export const SETS_TO_WIN: Readonly<Record<SetSport, number>> = Object.freeze({
  tennis: 2,
  volleyball: 3,
});

/** Rating of a player without one: the Elo average of the catalogue seed. */
export const DEFAULT_PLAYER_RATING = 1500;
const ELO_SCALE = 400;
const BISECTION_STEPS = 60;

/** P(home wins) = 1 / (1 + 10^((ratingAway − ratingHome) / 400)). */
export function eloWinProbability(ratingHome: number, ratingAway: number): number {
  if (!Number.isFinite(ratingHome) || !Number.isFinite(ratingAway)) {
    throw new RangeError('ratings must be finite numbers');
  }
  return 1 / (1 + 10 ** ((ratingAway - ratingHome) / ELO_SCALE));
}

/**
 * Probability that the home side wins the match from a set score, when it
 * wins each set independently with probability `setProbability`.
 */
export function matchWinProbability(
  setProbability: number,
  setsToWin: number,
  homeSets = 0,
  awaySets = 0,
): number {
  checkProbability(setProbability, 'setProbability');
  if (!Number.isSafeInteger(setsToWin) || setsToWin < 1) {
    throw new RangeError(`setsToWin must be a positive integer, got ${setsToWin}`);
  }
  for (const sets of [homeSets, awaySets]) {
    if (!Number.isSafeInteger(sets) || sets < 0 || sets > setsToWin) {
      throw new RangeError(`sets won must be an integer 0..${setsToWin}, got ${sets}`);
    }
  }
  if (homeSets === setsToWin && awaySets === setsToWin) {
    throw new RangeError('both sides cannot have won the match');
  }
  if (homeSets === setsToWin) return 1;
  if (awaySets === setsToWin) return 0;
  const needHome = setsToWin - homeSets;
  const needAway = setsToWin - awaySets;
  // Home wins its needHome-th set after losing k < needAway sets on the way.
  let probability = 0;
  let paths = 1; // C(needHome − 1 + k, k)
  for (let k = 0; k < needAway; k++) {
    if (k > 0) paths = (paths * (needHome - 1 + k)) / k;
    probability += paths * setProbability ** needHome * (1 - setProbability) ** k;
  }
  return Math.min(1, probability);
}

/** The per-set probability whose best-of-(2·setsToWin − 1) match probability is `matchProbability`. */
export function setWinProbability(matchProbability: number, setsToWin: number): number {
  checkProbability(matchProbability, 'matchProbability');
  if (matchProbability === 0 || matchProbability === 1) return matchProbability;
  // matchWinProbability is increasing in the set probability: bisect.
  let low = 0;
  let high = 1;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const mid = (low + high) / 2;
    if (matchWinProbability(mid, setsToWin) < matchProbability) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export interface WinnerPricingOptions {
  /** Margin; default 600 bps prematch, 800 in play. */
  marginBps?: number;
  /** In play: `home` / `away` are the sets won so far (minute is ignored). */
  state?: LiveScoreState;
}

/** Prices the 'winner' market; empty once the match is decided. */
export function priceWinner(
  sport: SetSport,
  ratingHome: number,
  ratingAway: number,
  opts: WinnerPricingOptions = {},
): FeedMarket[] {
  const setsToWin = SETS_TO_WIN[sport];
  if (setsToWin === undefined) throw new RangeError(`not a set sport: "${String(sport)}"`);
  const state = opts.state === undefined ? null : checkedLiveState(opts.state);
  const margin = checkedMarginBps(opts.marginBps ?? defaultMarginBps('winner', state !== null));
  const prematch = eloWinProbability(ratingHome, ratingAway);
  let home = prematch;
  if (state !== null && (state.home > 0 || state.away > 0)) {
    if (state.home > setsToWin || state.away > setsToWin) {
      throw new RangeError(`a ${sport} match has at most ${setsToWin} sets per side`);
    }
    home = matchWinProbability(
      setWinProbability(prematch, setsToWin),
      setsToWin,
      state.home,
      state.away,
    );
  }
  const market = buildMarket('winner', null, { '1': home, '2': 1 - home }, margin);
  return market === null ? [] : [market];
}

export function priceTennis(
  ratingHome: number,
  ratingAway: number,
  opts: WinnerPricingOptions = {},
): FeedMarket[] {
  return priceWinner('tennis', ratingHome, ratingAway, opts);
}

export function priceVolleyball(
  ratingHome: number,
  ratingAway: number,
  opts: WinnerPricingOptions = {},
): FeedMarket[] {
  return priceWinner('volleyball', ratingHome, ratingAway, opts);
}

function checkProbability(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${what} must be in [0, 1], got ${String(value)}`);
  }
}
