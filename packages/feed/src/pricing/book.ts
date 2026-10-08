import {
  MIN_ODDS_MILLI,
  type MarketTypeCode,
  type OddsMilli,
  oddsFromProbability,
  selectionsFor,
} from '@vamos/core';
import type { FeedMarket, LiveScoreState } from '../types';

/**
 * Turning model probabilities into a bookmaker's book.
 *
 * Floats are fine here: these are probabilities and prices, never money. The
 * output odds are integer milli within MIN_ODDS_MILLI..MAX_ODDS_MILLI.
 */

/** Default margin for the main markets (1X2, DC, DNB, BTTS, O/U, ML, totals, winner). */
export const DEFAULT_MARGIN_BPS = 600;
/** Default margin for correct score. */
export const CORRECT_SCORE_MARGIN_BPS = 1500;
/** Added to the default margins when pricing in play. */
export const LIVE_MARGIN_EXTRA_BPS = 200;
/** Probabilities are clamped to [MIN_PROBABILITY, 1] before pricing. */
export const MIN_PROBABILITY = 1e-6;
const MAX_MARGIN_BPS = 10_000;

/** The default margin of a market, prematch or live. */
export function defaultMarginBps(type: MarketTypeCode, live: boolean): number {
  const base = type === 'cs' ? CORRECT_SCORE_MARGIN_BPS : DEFAULT_MARGIN_BPS;
  return base + (live ? LIVE_MARGIN_EXTRA_BPS : 0);
}

/** Validates a margin in basis points: an integer in 0..10000. */
export function checkedMarginBps(marginBps: number): number {
  if (!Number.isSafeInteger(marginBps) || marginBps < 0 || marginBps > MAX_MARGIN_BPS) {
    throw new RangeError(`marginBps must be an integer 0..${MAX_MARGIN_BPS}, got ${marginBps}`);
  }
  return marginBps;
}

/**
 * Prices one selection with `oddsFromProbability`, or returns null when the
 * selection cannot be offered without handing the customer an edge.
 *
 * `oddsFromProbability` floors prices at 1.01. For a heavy favourite (p above
 * 1/1.01 ≈ 0.990) that floor would pay more than the fair price, so the price
 * falls back to thousandths (down to 1.001). Above p = 1/1.001 nothing can be
 * offered and the caller drops the market: its outcome is practically decided.
 *
 * Every price returned satisfies 1/odds ≥ p, which is what makes each book's
 * overround at least the sum of its probabilities.
 */
export function priceProbability(probability: number, marginBps: number): OddsMilli | null {
  // Tolerates float noise just outside [0, 1] (e.g. 1.0000000000000002).
  if (!Number.isFinite(probability) || probability < -1e-9 || probability > 1 + 1e-9) {
    throw new RangeError(`probability must be in [0, 1], got ${probability}`);
  }
  const margin = checkedMarginBps(marginBps);
  const p = Math.min(1, Math.max(MIN_PROBABILITY, probability));
  let odds = oddsFromProbability(p, margin);
  if (1000 / odds < p) {
    const raw = 1000 / (p * (1 + margin / 10_000));
    odds = Math.max(MIN_ODDS_MILLI, Math.floor(raw + 1e-9));
    if (1000 / odds < p) return null;
  }
  return odds;
}

/**
 * Builds a market with exactly the selections of `selectionsFor(type)`, in
 * their display order. Returns null (market not offered) when any selection
 * cannot be priced; see {@link priceProbability}.
 */
export function buildMarket(
  type: MarketTypeCode,
  line: string | null,
  probabilities: Readonly<Record<string, number>>,
  marginBps: number,
): FeedMarket | null {
  const selections: FeedMarket['selections'] = [];
  for (const code of selectionsFor(type)) {
    const probability = probabilities[code];
    if (probability === undefined) {
      throw new RangeError(`missing probability for selection "${code}" of market "${type}"`);
    }
    const oddsMilli = priceProbability(probability, marginBps);
    if (oddsMilli === null) return null;
    selections.push({ code, oddsMilli });
  }
  return { type, line, selections };
}

/** The book's overround: the sum of implied probabilities, Σ 1/odds. */
export function bookOverround(market: Pick<FeedMarket, 'selections'>): number {
  return market.selections.reduce((sum, selection) => sum + 1000 / selection.oddsMilli, 0);
}

/** Standard normal cumulative distribution Φ(x), relative error < 1.2e-7 including the tails. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Complementary error function (Numerical Recipes' Chebyshev fit, relative error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t *
                          (-1.13520398 +
                            t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const r = t * Math.exp(-z * z + poly);
  return x >= 0 ? r : 2 - r;
}

/** Clamps x into [min, max]. */
export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/** True for a finite number > 0. */
export function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validates an in-play state: a finite minute ≥ 0 and non-negative integer
 * scores, with any half-time score not above the current score. Returns a
 * normalised copy (absent half-time scores become null).
 */
export function checkedLiveState(state: LiveScoreState): Required<LiveScoreState> {
  if (typeof state !== 'object' || state === null) throw new RangeError('live state is required');
  const { minute } = state;
  if (typeof minute !== 'number' || !Number.isFinite(minute) || minute < 0) {
    throw new RangeError(`invalid live minute: ${String(minute)}`);
  }
  const home = checkedCount(state.home, 'home score');
  const away = checkedCount(state.away, 'away score');
  const htHome =
    state.htHome === null || state.htHome === undefined
      ? null
      : checkedCount(state.htHome, 'half-time home score');
  const htAway =
    state.htAway === null || state.htAway === undefined
      ? null
      : checkedCount(state.htAway, 'half-time away score');
  if ((htHome !== null && htHome > home) || (htAway !== null && htAway > away)) {
    throw new RangeError(`half-time score ${htHome}-${htAway} exceeds the score ${home}-${away}`);
  }
  return { minute, home, away, htHome, htAway };
}

function checkedCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid ${what}: ${String(value)}`);
  }
  return value;
}
