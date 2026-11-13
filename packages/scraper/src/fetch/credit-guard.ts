import { DAY_MS } from '../constants';
import type { FetchPlanItem } from '../types';

/**
 * The credit guard of a metered odds API (rules G of docs/theoddsapi-plan/README.md, section 4.7):
 * how hard the sources sharing one key may read, from the key's usage this calendar month.
 * Pure: the readings and the clock are arguments.
 *
 * - normal:  the schedule of marketOddsPollIntervalMs;
 * - economy: remaining under 20% of the quota with more than 7 days left, or more than 7.5% of
 *            the quota spent in the last 24 h: every interval longer;
 * - minimal: remaining under 10%: only leagues with a kickoff within 3 h, every 30 min;
 * - stop:    remaining under 1%, or the latest answer refused the key (HTTP 401): nothing.
 *
 * A normal month never leaves `normal`: the guard is there for bugs and heavy months.
 */
export type CreditGuardMode = 'normal' | 'economy' | 'minimal' | 'stop';

export const CREDIT_GUARD_MODES: readonly CreditGuardMode[] = [
  'normal',
  'economy',
  'minimal',
  'stop',
];

export interface CreditGuardInput {
  /** Credits of the month (`x-requests-used` + `x-requests-remaining`); null before any reading. */
  quota: number | null;
  /** `x-requests-remaining` of the latest reading this month; null before any reading. */
  remaining: number | null;
  /** Sum of `x-requests-last` over the last 24 hours. */
  spentLast24h: number;
  /** Whole and part days until the 1st of next month (UTC). */
  daysLeftInMonth: number;
  /** The latest answer this month refused the key, and nobody re-enabled the source since. */
  keyRefused: boolean;
}

export function creditGuardMode(input: CreditGuardInput): CreditGuardMode {
  if (input.keyRefused) return 'stop';
  const { quota, remaining } = input;
  // No reading yet this month (a new key, or the 1st): read normally; the first answer tells.
  if (quota === null || remaining === null || !(quota > 0) || !(remaining >= 0)) return 'normal';
  // Compared as remaining / quota < p without division: remaining × 1000 < quota × p‰.
  const below = (perMille: number) => remaining * 1000 < quota * perMille;
  if (below(10)) return 'stop';
  if (below(100)) return 'minimal';
  const spentFast = Number.isFinite(input.spentLast24h) && input.spentLast24h * 1000 > quota * 75;
  if ((below(200) && input.daysLeftInMonth > 7) || spentFast) return 'economy';
  return 'normal';
}

/** The first instant of `now`'s month, UTC: the quota resets then. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Days (fractional) from `now` to the 1st of next month, UTC. */
export function daysLeftInMonthUtc(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(0, (next - now.getTime()) / DAY_MS);
}

/**
 * The credit key of a source: the name of the environment variable its requests use, so every
 * source on one key shares one guard (rule G1). A source without a key is its own group.
 */
export function creditKeyOf(sourceId: string, plan: readonly FetchPlanItem[]): string {
  return plan.find((item) => item.auth !== undefined)?.auth?.secret ?? `source:${sourceId}`;
}

/** What the runs of one key's sources say (apiCreditUsage in @vamos/db has this shape). */
export interface CreditUsageReading {
  /** The latest reading this month (UTC), or null before any. */
  latest: { used: number | null; remaining: number; at: Date; runId: string } | null;
  /** Credits spent in the last 24 hours. */
  spentSince: number;
  /** When an answer this month last refused the key (HTTP 401), or null. */
  refusedAt: Date | null;
}

export interface CreditStatus {
  mode: CreditGuardMode;
  /** A 401 this month that no later reading, and no change to a source of the key, has cleared. */
  keyRefused: boolean;
  quota: number | null;
  remaining: number | null;
  spentLast24h: number;
  lastReadAt: Date | null;
}

/**
 * The guard's view of one key: its mode and the figures behind it. `sourcesUpdatedAt` are the
 * key's sources' last changes: a person re-enabling (or editing) one after a refusal gives the
 * key another try.
 */
export function creditStatus(
  usage: CreditUsageReading,
  sourcesUpdatedAt: readonly Date[],
  now: Date,
): CreditStatus {
  const { latest, refusedAt } = usage;
  const keyRefused =
    refusedAt !== null &&
    (latest === null || latest.at.getTime() <= refusedAt.getTime()) &&
    !sourcesUpdatedAt.some((at) => at.getTime() > refusedAt.getTime());
  const quota = latest !== null && latest.used !== null ? latest.used + latest.remaining : null;
  const remaining = latest?.remaining ?? null;
  return {
    mode: creditGuardMode({
      quota,
      remaining,
      spentLast24h: usage.spentSince,
      daysLeftInMonth: daysLeftInMonthUtc(now),
      keyRefused,
    }),
    keyRefused,
    quota,
    remaining,
    spentLast24h: usage.spentSince,
    lastReadAt: latest?.at ?? null,
  };
}

/** Where the last 24 hours of spending lead if they went on until the quota resets. */
export interface CreditProjection {
  /** Credits spent in the last 24 hours. */
  dailyRate: number;
  /** dailyRate over the days left until the 1st (UTC): what the rest of the month would cost. */
  projectedToReset: number;
  /** Days until the remaining credits are gone at that rate; null without a rate or a reading. */
  daysUntilEmpty: number | null;
  daysLeftInMonth: number;
  /** The projection exceeds the remaining credits: the key would run dry before the reset. */
  overruns: boolean;
}

/**
 * The early warning behind creditStatus (plan item C-3): the guard reacts only after the spending,
 * this says that the last day's rate would not last the month. Pure. With no reading yet
 * (remaining null) it never overruns.
 */
export function creditProjection(status: CreditStatus, now: Date): CreditProjection {
  const dailyRate = status.spentLast24h;
  const daysLeftInMonth = daysLeftInMonthUtc(now);
  const { remaining } = status;
  const projectedToReset = dailyRate * daysLeftInMonth;
  const rated = Number.isFinite(dailyRate) && dailyRate > 0;
  return {
    dailyRate,
    projectedToReset,
    daysUntilEmpty: rated && remaining !== null ? remaining / dailyRate : null,
    daysLeftInMonth,
    overruns: rated && remaining !== null && projectedToReset > remaining,
  };
}

/**
 * A daily request limit (API-Football, task A3) is low when under 10% of the day's requests are
 * left: an alarm, nothing slows down (the spine reads a few requests a run, far under the limit;
 * a low reading means something else shares the key). Pure.
 */
export const RATE_LIMIT_LOW_PER_MILLE = 100;

export function rateLimitLow(reading: { limit: number; remaining: number }): boolean {
  return reading.remaining * 1000 < reading.limit * RATE_LIMIT_LOW_PER_MILLE;
}

/** The first instant of `now`'s day, UTC: a daily request limit resets then. */
export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}
