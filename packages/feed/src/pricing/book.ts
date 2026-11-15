import {
  MAX_ODDS_MILLI,
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
 * The lowest price of any selection but a heavy favourite (see priceProbability).
 * Prices from here up are whole hundredths; below it, whole thousandths.
 */
const FLOOR_ODDS_MILLI = 1010;
/** Price step above FLOOR_ODDS_MILLI: a whole hundredth. */
const HUNDREDTH_MILLI = 10;
/** Implied probability (Σ 1/odds terms) of the longest price. */
const MIN_IMPLIED = 1000 / MAX_ODDS_MILLI;
/** Selections whose ideal shares differ by less than this (relative) are priced alike. */
const TIE_TOLERANCE = 1e-9;

/** A probability checked and clamped to [MIN_PROBABILITY, 1], as priceProbability does. */
function checkedProbability(probability: number): number {
  // Tolerates float noise just outside [0, 1] (e.g. 1.0000000000000002).
  if (!Number.isFinite(probability) || probability < -1e-9 || probability > 1 + 1e-9) {
    throw new RangeError(`probability must be in [0, 1], got ${probability}`);
  }
  return Math.min(1, Math.max(MIN_PROBABILITY, probability));
}

/** Σ of the values, smallest first, so the result does not depend on the order given. */
function orderFreeSum(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b).reduce((sum, value) => sum + value, 0);
}

interface Slot {
  /** Model probability. */
  p: number;
  /** Lowest implied probability (1/odds) allowed: never below p, never below the longest price's. */
  lo: number;
  /** Highest implied probability allowed: the shortest price the selection may be offered at. */
  hi: number;
  /** The shortest price the selection may be offered at, in milli. */
  minOdds: number;
}

/**
 * Implied probabilities q_i = clamp(λ p_i, lo_i, hi_i) of the `free` slots with
 * Σ q_i = `target`, for the one λ that does it (the margin is spread over the
 * book in proportion to the probabilities). Exact: the sum is piecewise linear
 * in λ, so the root is found by walking its breakpoints in order. When the
 * target cannot be reached the nearest end is returned (every selection at its
 * lowest, or at its highest, implied probability).
 */
function spreadShares(slots: readonly Slot[], free: readonly number[], target: number): number[] {
  const lowest = orderFreeSum(free.map((i) => slots[i]!.lo));
  const highest = orderFreeSum(free.map((i) => slots[i]!.hi));
  if (target <= lowest) return free.map((i) => slots[i]!.lo);
  if (target >= highest) return free.map((i) => slots[i]!.hi);
  const breakpoints: Array<{ at: number; slope: number }> = [];
  for (const i of free) {
    const { p, lo, hi } = slots[i]!;
    breakpoints.push({ at: lo / p, slope: p }, { at: hi / p, slope: -p });
  }
  breakpoints.sort((a, b) => a.at - b.at || b.slope - a.slope);
  let lambda = 0;
  let value = lowest;
  let slope = 0;
  for (const point of breakpoints) {
    const reached = value + slope * (point.at - lambda);
    if (slope > 0 && reached >= target) break;
    value = reached;
    lambda = point.at;
    slope += point.slope;
  }
  if (slope > 0) lambda += (target - value) / slope;
  return free.map((i) => {
    const { p, lo, hi } = slots[i]!;
    return Math.min(hi, Math.max(lo, lambda * p));
  });
}

/**
 * Prices a whole book (the selections of one market, in order) so that its
 * overround is the margin, whatever the probabilities.
 *
 * `priceProbability` marks each selection up on its own, which fails for a
 * lopsided book: a heavy favourite cannot be priced below 1.001 (1.01 outside
 * the thousandths fallback), so the margin that selection cannot carry is lost
 * and the book comes out thin. Here the target is the whole book's, Σ 1/odds
 * = (1 + margin) × Σ p. Every implied probability is λ p_i for one λ, except
 * the ones held at a bound of the price range, whose missing or surplus share
 * goes to the others (so a longshot opposite a favourite carries more than its
 * own share). Prices are whole hundredths from 1.01 up (thousandths below,
 * for outcomes above p = 1/1.01): the selections with the coarsest steps (the
 * shortest prices) are rounded to the nearest step first, each time spreading
 * what is left over the ones still unpriced, so the rounding error lands on
 * the finest price and the delivered total is within a step of it.
 *
 * Every price satisfies 1/odds ≥ p, so the book's overround is at least its
 * fair sum and no selection is offered above its fair price. Returns null when
 * a selection is too likely to be offered at 1.001 or more (see
 * priceProbability). With no price at a bound and no rounding, this is the
 * same price as oddsFromProbability gives each selection alone.
 */
export function priceBook(probabilities: readonly number[], marginBps: number): OddsMilli[] | null {
  const margin = checkedMarginBps(marginBps);
  const slots: Slot[] = [];
  for (const raw of probabilities) {
    const p = checkedProbability(raw);
    if (1000 / MIN_ODDS_MILLI < p) return null;
    const heavy = p > 1000 / FLOOR_ODDS_MILLI;
    const minOdds = heavy ? MIN_ODDS_MILLI : FLOOR_ODDS_MILLI;
    slots.push({ p, lo: Math.max(p, MIN_IMPLIED), hi: 1000 / minOdds, minOdds });
  }
  const odds: Array<OddsMilli | null> = slots.map(() => null);
  const fixedImplied = (): number =>
    orderFreeSum(odds.flatMap((o) => (o === null ? [] : [1000 / o])));
  const total = (1 + margin / 10_000) * orderFreeSum(slots.map((s) => s.p));

  let open = slots.map((_, i) => i);
  while (open.length > 0) {
    const shares = spreadShares(slots, open, total - fixedImplied());
    // Selections at a bound of the price range are priced there, exactly.
    const atBound = open.filter((i, k) => {
      const slot = slots[i]!;
      const share = shares[k]!;
      if (share >= slot.hi) {
        odds[i] = slot.minOdds;
        return true;
      }
      if (share <= MIN_IMPLIED && slot.p < MIN_IMPLIED) {
        odds[i] = MAX_ODDS_MILLI;
        return true;
      }
      return false;
    });
    if (atBound.length === open.length) break;
    // The coarsest step first: the largest share, with ties (equal shares) priced together.
    const rest = open.filter((i) => odds[i] === null);
    const shareOf = new Map(open.map((i, k) => [i, shares[k]!]));
    const coarsest = Math.max(...rest.map((i) => shareOf.get(i)!));
    const group = rest.filter((i) => shareOf.get(i)! >= coarsest * (1 - TIE_TOLERANCE));
    const price = nearestPrice(
      coarsest,
      Math.max(...group.map((i) => slots[i]!.p)),
      Math.max(...group.map((i) => slots[i]!.minOdds)),
    );
    for (const i of group) odds[i] = price;
    open = rest.filter((i) => odds[i] === null);
  }
  return odds.map((o) => o ?? MAX_ODDS_MILLI);
}

/**
 * The price (a whole step of 10 milli from 1.01 up, else 1 milli) whose
 * implied probability is nearest to `share`, among those that are not above
 * fair (1/odds ≥ p) and not shorter than `minOdds` or longer than the maximum.
 */
function nearestPrice(share: number, p: number, minOdds: number): OddsMilli {
  const ideal = 1000 / share;
  const step = ideal >= FLOOR_ODDS_MILLI ? HUNDREDTH_MILLI : 1;
  let shorter = Math.max(minOdds, Math.min(MAX_ODDS_MILLI, Math.floor(ideal / step) * step));
  // Float noise at the edges: never let the rounded-down price fall below fair.
  while (1000 / shorter < p && shorter > minOdds) shorter -= step;
  const longer = shorter + step;
  if (longer > MAX_ODDS_MILLI || 1000 / longer < p) return shorter;
  return Math.abs(1000 / longer - share) < Math.abs(1000 / shorter - share) ? longer : shorter;
}

/**
 * Builds a market with exactly the selections of `selectionsFor(type)`, in
 * their display order, priced as one book with {@link priceBook} so that its
 * overround is the margin. Returns null (market not offered) when any
 * selection cannot be priced; see {@link priceProbability}.
 */
export function buildMarket(
  type: MarketTypeCode,
  line: string | null,
  probabilities: Readonly<Record<string, number>>,
  marginBps: number,
): FeedMarket | null {
  const codes = selectionsFor(type);
  const values = codes.map((code) => {
    const probability = probabilities[code];
    if (probability === undefined) {
      throw new RangeError(`missing probability for selection "${code}" of market "${type}"`);
    }
    return probability;
  });
  const prices = priceBook(values, marginBps);
  if (prices === null) return null;
  return {
    type,
    line,
    selections: codes.map((code, i) => ({ code, oddsMilli: prices[i]! })),
  };
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

/**
 * Poisson probabilities P(k) for k = 0..maxK (not renormalised; callers that
 * truncate a relevant tail renormalise themselves).
 */
export function poissonPmf(lambda: number, maxK: number): number[] {
  const pmf: number[] = [];
  let p = Math.exp(-lambda);
  pmf.push(p);
  for (let k = 1; k <= maxK; k++) {
    p *= lambda / k;
    pmf.push(p);
  }
  return pmf;
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
