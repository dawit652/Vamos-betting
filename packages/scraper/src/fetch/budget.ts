import {
  DAY_MS,
  MARKET_ODDS_MINIMAL_INTERVAL_MS,
  METERED_RESULTS_WINDOW_START_MS,
  MIN_LEAD_MS,
} from '../constants';
import { marketOddsPollIntervalMs, meteredResultsPollIntervalMs } from './cadence';
import { creditGuardMode, type CreditGuardMode } from './credit-guard';
import type { CompetitionTier } from './tiering';

/**
 * Credit budget estimates for a metered odds API (docs/feed-quality-plan.md C-1). Pure: the clock
 * and the fixture calendar are arguments. They replay the scheduler's own interval functions
 * (marketOddsPollIntervalMs, meteredResultsPollIntervalMs) over the calendar, so a change to the
 * reading schedule changes the estimate with it.
 *
 * Simplifications, stated in the command's footer: the next read comes exactly one interval after
 * the last (the scheduler may start up to 10% early, and ticks every 30 s); a calendar that ends
 * (events are created up to 14 days ahead) means no matches after it.
 */

/** Daily buckets: element i is the reads that start in [now + i days, now + i + 1 days). */
function emptyDays(days: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(days)) }, () => 0);
}

/**
 * Reads of a bookmaker-odds source (2 credits each on the 20K plan) per day over the next `days`
 * days, given the kickoffs of its competition's matches. The schedule is that of the source's
 * price rows: the next kickoff more than MIN_LEAD_MS ahead and within `horizonMs` (the adapter
 * drops matches beyond its `horizonDays`) sets the interval. A read that would return no match
 * (none within the horizon) is free and not counted.
 */
export function estimateOddsReadsPerDay(input: {
  now: Date;
  kickoffs: readonly Date[];
  days: number;
  horizonMs: number;
  mode?: CreditGuardMode;
  /** C-2: a `standard` competition reads on the slower schedule; default `priority`. */
  tier?: CompetitionTier;
}): number[] {
  const { now, days, horizonMs, mode = 'normal', tier = 'priority' } = input;
  const reads = emptyDays(days);
  const start = now.getTime();
  const end = start + reads.length * DAY_MS;
  const times = input.kickoffs.map((k) => k.getTime()).filter((k) => Number.isFinite(k));
  times.sort((a, b) => a - b);
  for (let t = start; t < end;) {
    const at = new Date(t);
    const next = times.find((k) => k > t + MIN_LEAD_MS && k <= t + horizonMs);
    const interval = marketOddsPollIntervalMs(
      at,
      next === undefined ? null : new Date(next),
      mode,
      tier,
    );
    if (interval === null) {
      // The guard says stop (or minimal with nothing within 3 h): nothing is read, look again later.
      if (mode === 'stop') break;
      t += MARKET_ODDS_MINIMAL_INTERVAL_MS;
      continue;
    }
    if (times.some((k) => k > t && k <= t + horizonMs)) {
      const day = Math.floor((t - start) / DAY_MS);
      reads[day] = (reads[day] ?? 0) + 1;
    }
    t += interval;
  }
  return reads;
}

/**
 * Reads of a metered scores source per day: only while one of the league's matches is between
 * kickoff + 110 min and kickoff + the window end (4 h), every 20 min in normal mode. A match
 * stays in the window to its end: the real source stops once the match is resulted, so this is
 * an upper bound.
 */
export function estimateScoresReadsPerDay(input: {
  now: Date;
  kickoffs: readonly Date[];
  days: number;
  mode?: CreditGuardMode;
}): number[] {
  const { now, days, mode = 'normal' } = input;
  const reads = emptyDays(days);
  const start = now.getTime();
  const end = start + reads.length * DAY_MS;
  const kickoffs = input.kickoffs.filter((k) => Number.isFinite(k.getTime()));
  for (let t = start; t < end;) {
    const interval = meteredResultsPollIntervalMs(new Date(t), kickoffs, mode);
    if (interval === null) {
      if (mode === 'stop') break;
      // Jump to the next moment a match enters the window.
      const entering = kickoffs
        .map((k) => k.getTime() + METERED_RESULTS_WINDOW_START_MS)
        .filter((s) => s > t);
      if (entering.length === 0) break;
      t = Math.min(...entering);
      continue;
    }
    const day = Math.floor((t - start) / DAY_MS);
    if (day < reads.length) reads[day] = (reads[day] ?? 0) + 1;
    t += interval;
  }
  return reads;
}

export interface DailyCredits {
  /** Credits over the whole estimate window (reads × cost). */
  totalCredits: number;
  /** Average credits a day over the first `spanDays` days (the part of the window the calendar covers). */
  avgCreditsPerDay: number;
  avgReadsPerDay: number;
  /** The most credits any one day needs, and which day (0 = today). */
  peakCredits: number;
  peakDay: number;
}

/** Turns reads per day into credits: the average over `spanDays` (at least 1, at most all days) and the peak. */
export function summariseCredits(
  readsPerDay: readonly number[],
  costPerRead: number,
  spanDays: number,
): DailyCredits {
  const span = Math.min(readsPerDay.length, Math.max(1, Math.floor(spanDays)));
  const inSpan = readsPerDay.slice(0, span);
  const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0);
  let peakDay = 0;
  readsPerDay.forEach((n, i) => {
    if (n > (readsPerDay[peakDay] ?? 0)) peakDay = i;
  });
  return {
    totalCredits: sum(readsPerDay) * costPerRead,
    avgCreditsPerDay: inSpan.length === 0 ? 0 : (sum(inSpan) * costPerRead) / span,
    avgReadsPerDay: inSpan.length === 0 ? 0 : sum(inSpan) / span,
    peakCredits: (readsPerDay[peakDay] ?? 0) * costPerRead,
    peakDay,
  };
}

/** Whole days (rounded up) from `now` to the last kickoff, within 1 to `maxDays`; `maxDays` with no kickoff. */
export function calendarSpanDays(now: Date, kickoffs: readonly Date[], maxDays: number): number {
  const latest = Math.max(...kickoffs.map((k) => k.getTime()).filter((t) => Number.isFinite(t)));
  if (!Number.isFinite(latest)) return maxDays;
  return Math.min(maxDays, Math.max(1, Math.ceil((latest - now.getTime()) / DAY_MS)));
}

export interface LeavesNormal {
  /** Days from now until the guard leaves `normal` at this rate; null: not before the reset. */
  days: number | null;
  /** The mode it enters then. */
  mode: CreditGuardMode | null;
}

/**
 * How long a key stays in the guard's `normal` mode at a steady spend of `creditsPerDay`,
 * replaying creditGuardMode itself in quarter-day steps until the quota resets. `quota` null (no
 * reading yet) is read as normal throughout, as the guard does.
 */
export function daysUntilLeavesNormal(input: {
  quota: number | null;
  remaining: number | null;
  creditsPerDay: number;
  daysLeftInMonth: number;
}): LeavesNormal {
  const { quota, remaining, creditsPerDay, daysLeftInMonth } = input;
  if (quota === null || remaining === null || !(creditsPerDay >= 0)) {
    return { days: null, mode: null };
  }
  for (let t = 0; t < daysLeftInMonth; t += 0.25) {
    const mode = creditGuardMode({
      quota,
      remaining: Math.max(0, remaining - creditsPerDay * t),
      spentLast24h: creditsPerDay,
      daysLeftInMonth: daysLeftInMonth - t,
      keyRefused: false,
    });
    if (mode !== 'normal') return { days: t, mode };
  }
  return { days: null, mode: null };
}
