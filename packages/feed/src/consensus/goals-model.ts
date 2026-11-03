import { CORRECT_SCORE_SELECTIONS } from '@vamos/core';
import { clamp, poissonPmf } from '../pricing/book';
import { isHalfPointLine } from './lines';

/**
 * The market-implied goals model. The Odds API's league endpoint carries
 * only 1X2 and the main total, so BTTS, correct score and the other goal
 * lines are priced from a Dixon–Coles model whose parameters are fitted to
 * the consensus of those two markets. Its prices are therefore consistent
 * with the real market, not with our own team ratings.
 *
 * Dixon–Coles is the independent Poisson model with a correction ρ on the
 * four low scores (0-0, 1-0, 0-1, 1-1), which plain Poisson gets wrong:
 * real matches end level more often than independent scoring predicts. With
 * three parameters (λ home, λ away, ρ) it can match all three independent
 * inputs (home, draw and the total; away is 1 minus the others).
 */

export interface GoalsModel {
  /** Expected goals of the home side. */
  lambdaHome: number;
  /** Expected goals of the away side. */
  lambdaAway: number;
  /** Low-score dependence; negative values add draws (typical −0.15 to 0). */
  rho: number;
}

export interface GoalsTargets {
  /** Fair 1X2 probabilities from the consensus (summing to 1). */
  home: number;
  draw: number;
  away: number;
  /** The fair probability of more goals than a half-point `line`. */
  total: { line: number; over: number };
}

export interface GoalsFit extends GoalsModel {
  /** Largest absolute miss on any target (home, draw, away, over), as a probability. */
  error: number;
}

/** Goals per side up to which scores are enumerated (the tail is renormalised). */
export const GOALS_GRID_MAX = 12;
export const MIN_GOAL_RATE = 0.05;
export const MAX_GOAL_RATE = 5;
export const MAX_ABS_RHO = 0.25;

/**
 * P(home goals = h, away goals = a) for h, a in 0..maxGoals, summing to 1.
 * ρ is narrowed to the range where every adjusted probability stays
 * non-negative for these rates.
 */
export function scoreGrid(model: GoalsModel, maxGoals = GOALS_GRID_MAX): number[][] {
  checkRate(model.lambdaHome, 'lambdaHome');
  checkRate(model.lambdaAway, 'lambdaAway');
  if (!Number.isFinite(model.rho)) throw new RangeError(`invalid rho: ${model.rho}`);
  const home = poissonPmf(model.lambdaHome, maxGoals);
  const away = poissonPmf(model.lambdaAway, maxGoals);
  const rho = feasibleRho(model.rho, model.lambdaHome, model.lambdaAway);
  const tau = (h: number, a: number): number => {
    if (h === 0 && a === 0) return 1 - model.lambdaHome * model.lambdaAway * rho;
    if (h === 0 && a === 1) return 1 + model.lambdaHome * rho;
    if (h === 1 && a === 0) return 1 + model.lambdaAway * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
  };
  let total = 0;
  const grid = home.map((ph, h) =>
    away.map((pa, a) => {
      const p = ph * pa * tau(h, a);
      total += p;
      return p;
    }),
  );
  return grid.map((row) => row.map((p) => p / total));
}

/** Home win, draw and away win probabilities of a score grid. */
export function resultProbabilities(grid: readonly (readonly number[])[]): {
  home: number;
  draw: number;
  away: number;
} {
  let home = 0;
  let draw = 0;
  let away = 0;
  eachScore(grid, (h, a, p) => {
    if (h > a) home += p;
    else if (h === a) draw += p;
    else away += p;
  });
  return { home, draw, away };
}

/** The probability of more goals than `line` in total. */
export function overProbability(grid: readonly (readonly number[])[], line: number): number {
  let over = 0;
  eachScore(grid, (h, a, p) => {
    if (h + a > line) over += p;
  });
  return over;
}

/** The probability that both sides score. */
export function bothScoreProbability(grid: readonly (readonly number[])[]): number {
  let yes = 0;
  eachScore(grid, (h, a, p) => {
    if (h > 0 && a > 0) yes += p;
  });
  return yes;
}

/** Correct-score probabilities keyed by the selection codes of 'cs' ('2-1', …, 'other'). */
export function correctScoreProbabilities(
  grid: readonly (readonly number[])[],
): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const code of CORRECT_SCORE_SELECTIONS) probabilities[code] = 0;
  eachScore(grid, (h, a, p) => {
    const code = `${h}-${a}`;
    if (Object.hasOwn(probabilities, code) && code !== 'other') probabilities[code] = p;
    else probabilities.other = (probabilities.other ?? 0) + p;
  });
  return probabilities;
}

/**
 * Fits λ home, λ away and ρ to the consensus 1X2 and total by least squares:
 * a coarse grid over the two rates, a pattern search over all three, then a
 * Levenberg–Marquardt polish (the pattern search alone can stall in the curved
 * valley where ρ trades off against the rates, a 0.1 pp miss on a low-scoring
 * match). The result reports the largest remaining miss; callers withhold the
 * derived markets when it is too large (the inputs then disagree with any
 * sensible goals model). Throws a RangeError for invalid targets.
 */
export function fitGoalsModel(targets: GoalsTargets): GoalsFit {
  checkTargets(targets);
  const objective = (model: GoalsModel): number => {
    const residuals = misses(model, targets);
    return residuals.reduce((sum, r) => sum + r * r, 0);
  };

  // Coarse start: the best pair of rates on a 0.25 grid, with a typical ρ.
  let best: GoalsModel = { lambdaHome: 1.4, lambdaAway: 1.1, rho: -0.05 };
  let bestValue = objective(best);
  for (let lambdaHome = 0.25; lambdaHome <= 4.75; lambdaHome += 0.25) {
    for (let lambdaAway = 0.25; lambdaAway <= 4.75; lambdaAway += 0.25) {
      const candidate = { lambdaHome, lambdaAway, rho: -0.05 };
      const value = objective(candidate);
      if (value < bestValue) {
        best = candidate;
        bestValue = value;
      }
    }
  }

  // Pattern search: try a step either way along each parameter, halve the steps when nothing helps.
  const steps = { lambdaHome: 0.125, lambdaAway: 0.125, rho: 0.05 };
  const keys = ['lambdaHome', 'lambdaAway', 'rho'] as const;
  for (let evaluations = 0; evaluations < 5000;) {
    let moved = false;
    for (const key of keys) {
      for (const direction of [1, -1]) {
        const candidate = { ...best, [key]: bounded(key, best[key] + direction * steps[key]) };
        evaluations++;
        const value = objective(candidate);
        if (value < bestValue) {
          best = candidate;
          bestValue = value;
          moved = true;
          break;
        }
      }
    }
    if (!moved) {
      steps.lambdaHome /= 2;
      steps.lambdaAway /= 2;
      steps.rho /= 2;
      if (steps.lambdaHome < 1e-7) break;
    }
  }
  best = polish(best, (model) => misses(model, targets));
  const rho = feasibleRho(best.rho, best.lambdaHome, best.lambdaAway);
  const fitted = { ...best, rho };
  const error = Math.max(...misses(fitted, targets).map(Math.abs));
  return { ...fitted, error };
}

const MODEL_KEYS = ['lambdaHome', 'lambdaAway', 'rho'] as const;

/**
 * Levenberg–Marquardt steps from `start` on the residuals (Jacobian by
 * forward differences). Only a step that lowers the sum of squares is taken,
 * so the result is never worse than the start.
 */
function polish(start: GoalsModel, residualsOf: (model: GoalsModel) => number[]): GoalsModel {
  const squares = (r: readonly number[]): number => r.reduce((sum, v) => sum + v * v, 0);
  let model = start;
  let residuals = residualsOf(model);
  let value = squares(residuals);
  let damping = 1e-3;
  for (let iteration = 0; iteration < 50 && value > 1e-24; iteration++) {
    const columns = MODEL_KEYS.map((key) => {
      const h = 1e-7 * Math.max(1, Math.abs(model[key]));
      const shifted = residualsOf({ ...model, [key]: model[key] + h });
      return shifted.map((v, i) => (v - (residuals[i] ?? 0)) / h);
    });
    const normal = columns.map((a) => columns.map((b) => dot(a, b)));
    const gradient = columns.map((column) => -dot(column, residuals));
    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const step = solve3(
        normal.map((row, i) => row.map((v, j) => (i === j ? v + damping : v))),
        gradient,
      );
      if (step !== null) {
        const candidate: GoalsModel = {
          lambdaHome: bounded('lambdaHome', model.lambdaHome + (step[0] ?? 0)),
          lambdaAway: bounded('lambdaAway', model.lambdaAway + (step[1] ?? 0)),
          rho: bounded('rho', model.rho + (step[2] ?? 0)),
        };
        const next = residualsOf(candidate);
        const nextValue = squares(next);
        if (nextValue < value) {
          model = candidate;
          residuals = next;
          value = nextValue;
          damping = Math.max(1e-12, damping / 10);
          improved = true;
          continue;
        }
      }
      damping *= 10;
    }
    if (!improved) break;
  }
  return model;
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
}

/** Solves the 3×3 system A·x = b by Gaussian elimination with partial pivoting; null when singular. */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = row;
    }
    const pivotRow = m[pivot];
    const p = pivotRow?.[col] ?? 0;
    if (pivotRow === undefined || !Number.isFinite(p) || Math.abs(p) < 1e-300) return null;
    [m[col], m[pivot]] = [pivotRow, m[col] as number[]];
    for (let row = col + 1; row < 3; row++) {
      const target = m[row] as number[];
      const factor = (target[col] ?? 0) / p;
      for (let k = col; k < 4; k++) target[k] = (target[k] ?? 0) - factor * (pivotRow[k] ?? 0);
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    const r = m[row] as number[];
    let sum = r[3] ?? 0;
    for (let k = row + 1; k < 3; k++) sum -= (r[k] ?? 0) * (x[k] ?? 0);
    x[row] = sum / (r[row] ?? 1);
  }
  return x.every(Number.isFinite) ? x : null;
}

function misses(model: GoalsModel, targets: GoalsTargets): number[] {
  const grid = scoreGrid(model);
  const result = resultProbabilities(grid);
  return [
    result.home - targets.home,
    result.draw - targets.draw,
    result.away - targets.away,
    overProbability(grid, targets.total.line) - targets.total.over,
  ];
}

function bounded(key: keyof GoalsModel, value: number): number {
  return key === 'rho'
    ? clamp(value, -MAX_ABS_RHO, MAX_ABS_RHO)
    : clamp(value, MIN_GOAL_RATE, MAX_GOAL_RATE);
}

/** ρ within ±MAX_ABS_RHO and where 1 − λμρ, 1 + λρ, 1 + μρ and 1 − ρ all stay positive. */
function feasibleRho(rho: number, lambdaHome: number, lambdaAway: number): number {
  const safety = 0.999;
  const low = Math.max(-MAX_ABS_RHO, (-1 / lambdaHome) * safety, (-1 / lambdaAway) * safety);
  const high = Math.min(MAX_ABS_RHO, (1 / (lambdaHome * lambdaAway)) * safety);
  return clamp(rho, low, high);
}

function eachScore(
  grid: readonly (readonly number[])[],
  visit: (home: number, away: number, probability: number) => void,
): void {
  grid.forEach((row, h) => row.forEach((p, a) => visit(h, a, p)));
}

function checkRate(rate: number, what: string): void {
  if (!Number.isFinite(rate) || rate < MIN_GOAL_RATE || rate > MAX_GOAL_RATE) {
    throw new RangeError(`${what} must be in [${MIN_GOAL_RATE}, ${MAX_GOAL_RATE}], got ${rate}`);
  }
}

function checkTargets(targets: GoalsTargets): void {
  const probabilities = [targets.home, targets.draw, targets.away, targets.total.over];
  if (!probabilities.every((p) => Number.isFinite(p) && p > 0 && p < 1)) {
    throw new RangeError('goal model targets must be probabilities strictly between 0 and 1');
  }
  if (Math.abs(targets.home + targets.draw + targets.away - 1) > 1e-6) {
    throw new RangeError('the 1X2 targets must sum to 1');
  }
  if (!isHalfPointLine(targets.total.line) || targets.total.line < 0) {
    throw new RangeError(`the total line must be a half-point line, got ${targets.total.line}`);
  }
}
