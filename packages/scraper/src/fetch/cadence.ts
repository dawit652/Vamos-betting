import {
  HOUR_MS,
  MARKET_ODDS_INTERVALS_MS,
  MARKET_ODDS_MINIMAL_INTERVAL_MS,
  MARKET_ODDS_TIER_LIMITS_MS,
  MINUTE_MS,
} from '../constants';
import type { CreditGuardMode } from './credit-guard';

/** How often sources are polled (docs/scraper.md section 5). Pure functions: the clock is an argument. */

export const FIXTURES_POLL_INTERVAL_MS = 15 * MINUTE_MS;
export const RESULTS_FAST_INTERVAL_MS = 5 * MINUTE_MS;
export const RESULTS_SLOW_INTERVAL_MS = 60 * MINUTE_MS;
/** Results polling speeds up from kickoff + 90 min ... */
export const RESULTS_WINDOW_START_MS = 90 * MINUTE_MS;
/** ... until kickoff + 6 h (then the event needs a person, not more polling). */
export const RESULTS_WINDOW_END_MS = 6 * HOUR_MS;
/** A failing source is never polled less often than every 6 hours (it is still probed). */
export const MAX_FAILURE_BACKOFF_MS = 6 * HOUR_MS;

export function fixturesPollIntervalMs(): number {
  return FIXTURES_POLL_INTERVAL_MS;
}

/** 5 minutes while any pending kickoff k has now in [k + 90 min, k + 6 h], else 60 minutes. Invalid dates are ignored. */
export function resultsPollIntervalMs(now: Date, pendingKickoffs: readonly Date[]): number {
  const t = now.getTime();
  if (Number.isNaN(t)) return RESULTS_SLOW_INTERVAL_MS;
  const hot = pendingKickoffs.some((k) => {
    const elapsed = t - k.getTime();
    return elapsed >= RESULTS_WINDOW_START_MS && elapsed <= RESULTS_WINDOW_END_MS;
  });
  return hot ? RESULTS_FAST_INTERVAL_MS : RESULTS_SLOW_INTERVAL_MS;
}

export interface IsDueInput {
  lastRunAt: Date | null;
  intervalMs: number;
  now: Date;
  /**
   * A fraction in [0, 0.5], drawn at random by the caller (so this stays
   * pure), by which the run may happen EARLY. It spreads sources out so they do
   * not all fire in the same instant; it never delays a run.
   */
  jitterFraction?: number;
}

/**
 * Is a run due? Fails towards running: no previous run, an unreadable date, a
 * last run in the future (clock skew) or a bad interval all say "due", because
 * a stuck schedule is worse than one extra polite request.
 */
export function isDue({ lastRunAt, intervalMs, now, jitterFraction = 0 }: IsDueInput): boolean {
  if (lastRunAt === null) return true;
  const elapsed = now.getTime() - lastRunAt.getTime();
  if (Number.isNaN(elapsed) || elapsed < 0 || !(intervalMs > 0)) return true;
  const early = Number.isFinite(jitterFraction) ? Math.min(0.5, Math.max(0, jitterFraction)) : 0;
  return elapsed >= intervalMs * (1 - early);
}

/**
 * Interval for a source with `consecutiveFailures` failed runs in a row:
 * the normal interval doubled per failure, capped at 6 h (never below normal).
 */
export function backoffAfterFailures(
  consecutiveFailures: number,
  normalIntervalMs: number,
): number {
  const n = Number.isFinite(consecutiveFailures)
    ? Math.min(30, Math.max(0, Math.floor(consecutiveFailures)))
    : 0;
  return Math.max(normalIntervalMs, Math.min(MAX_FAILURE_BACKOFF_MS, normalIntervalMs * 2 ** n));
}

/**
 * How often a bookmaker-odds source is read (docs/theoddsapi-plan/README.md, 4.5 and 4.7), or null
 * when it is not read at all for now. `nextKickoff` is the next kickoff in the source's own price
 * rows that is more than MIN_LEAD_MS ahead (null: none). The closer the kickoff, the more often:
 * within 3 h every 10 min, within 24 h every 30 min, within 14 days every 2 h, else every 6 h.
 * The guard's mode stretches that: economy reads less often, minimal reads only leagues with a
 * kickoff within 3 h (every 30 min), stop reads nothing. Invalid dates count as no kickoff.
 */
export function marketOddsPollIntervalMs(
  now: Date,
  nextKickoff: Date | null,
  mode: CreditGuardMode,
): number | null {
  if (mode === 'stop') return null;
  const until =
    nextKickoff === null || Number.isNaN(nextKickoff.getTime()) || Number.isNaN(now.getTime())
      ? Number.POSITIVE_INFINITY
      : nextKickoff.getTime() - now.getTime();
  let tier = MARKET_ODDS_TIER_LIMITS_MS.findIndex((limit) => until <= limit);
  if (tier === -1) tier = MARKET_ODDS_TIER_LIMITS_MS.length;
  if (mode === 'minimal') return tier === 0 ? MARKET_ODDS_MINIMAL_INTERVAL_MS : null;
  return MARKET_ODDS_INTERVALS_MS[mode][tier] ?? null;
}
