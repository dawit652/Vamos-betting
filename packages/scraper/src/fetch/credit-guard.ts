import { DAY_MS } from '../constants';

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
