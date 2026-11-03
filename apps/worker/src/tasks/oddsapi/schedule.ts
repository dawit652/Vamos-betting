/**
 * When The Odds API is called, and how fresh a price must be
 * (docs/odds-api-integration-plan.md §9). Pure functions of the clock and
 * the credit budget.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** Events further ahead than this are not priced. */
export const ODDS_HORIZON_MS = 72 * HOUR_MS;

export type BudgetMode = 'normal' | 'reserve' | 'critical';

export interface Budget {
  /** Every poll interval is multiplied by this (1 while spending is on plan). */
  factor: number;
  /**
   * normal: everything runs. reserve: only in-play odds and scores (the
   * quota left is inside the reserve). critical: only scores.
   */
  mode: BudgetMode;
}

/** The share of the monthly quota below which only scores are read. */
const CRITICAL_SHARE = 0.01;
/** The furthest the governor stretches a poll interval. */
const MAX_FACTOR = 24;

/**
 * The budget for the next polls: intervals stretch by the ratio of the last
 * 24 hours' spend to a thirtieth of the monthly credits, and the mode drops to
 * reserve or critical as the remaining quota runs low.
 */
export function planBudget(input: {
  spentLast24h: number;
  monthlyCredits: number;
  reservePercent: number;
  /** The quota left as last reported; null before the first call. */
  remaining: number | null;
}): Budget {
  const daily = input.monthlyCredits / 30;
  const factor = Math.min(MAX_FACTOR, Math.max(1, input.spentLast24h / daily));
  const reserve = (input.monthlyCredits * input.reservePercent) / 100;
  const critical = input.monthlyCredits * CRITICAL_SHARE;
  let mode: BudgetMode = 'normal';
  if (input.remaining !== null && input.remaining <= critical) mode = 'critical';
  else if (input.remaining !== null && input.remaining <= reserve) mode = 'reserve';
  return { factor, mode };
}

/** Base odds poll interval by the time left to the league's next start. */
export function prematchIntervalMs(untilStartMs: number): number {
  if (untilStartMs <= HOUR_MS) return 5 * MINUTE_MS;
  if (untilStartMs <= 6 * HOUR_MS) return 15 * MINUTE_MS;
  if (untilStartMs <= 24 * HOUR_MS) return HOUR_MS;
  return 3 * HOUR_MS;
}

export const IN_PLAY_INTERVAL_MS = MINUTE_MS;
/** How long a league without upcoming events waits before its odds are read again. */
export const IDLE_INTERVAL_MS = 6 * HOUR_MS;

/**
 * When a league's odds are read next: every minute while it has a match in
 * play (in-play on), else by the time to its next start; stretched by the
 * budget, and only in-play polls in reserve mode.
 */
export function nextOddsPollAt(input: {
  now: Date;
  nextStartAt: Date | null;
  liveCount: number;
  inPlay: boolean;
  budget: Budget;
}): Date {
  const { now, budget } = input;
  const at = (ms: number): Date => new Date(now.getTime() + Math.round(ms));
  if (budget.mode === 'critical') return at(IDLE_INTERVAL_MS);
  if (input.inPlay && input.liveCount > 0) return at(IN_PLAY_INTERVAL_MS * budget.factor);
  if (budget.mode === 'reserve' || input.nextStartAt === null) return at(IDLE_INTERVAL_MS);
  const until = input.nextStartAt.getTime() - now.getTime();
  if (until > ODDS_HORIZON_MS) {
    // Nothing to price until the next start comes inside the horizon.
    return at(Math.min(IDLE_INTERVAL_MS, until - ODDS_HORIZON_MS));
  }
  return at(prematchIntervalMs(Math.max(0, until)) * budget.factor);
}

/**
 * When a league's scores are read next: every 2 minutes with a match in
 * play, every 10 while finished matches await their result, else every 30
 * (the governor stretches scores at most twofold: results settle bets).
 */
export function nextScoresPollAt(input: {
  now: Date;
  live: boolean;
  awaitingResults: boolean;
  budget: Budget;
}): Date {
  const factor = Math.min(2, input.budget.factor);
  const base = input.live ? 2 * MINUTE_MS : input.awaitingResults ? 10 * MINUTE_MS : 30 * MINUTE_MS;
  return new Date(input.now.getTime() + base * factor);
}

/**
 * The oldest bookmaker quote used for a prematch price: 45 minutes in the
 * last 3 hours before the start, 3 hours before that. (To calibrate against
 * real `last_update` values.)
 */
export function prematchQuoteMaxAgeMs(untilStartMs: number): number {
  return untilStartMs <= 3 * HOUR_MS ? 45 * MINUTE_MS : 3 * HOUR_MS;
}

/** The oldest bookmaker quote used for an in-play price. */
export const IN_PLAY_QUOTE_MAX_AGE_MS = 90_000;

/**
 * Freshness limits of the stale-odds sweep: an event whose last consensus is
 * older than about two and a half poll intervals of its bucket is suspended
 * until the next fresh poll. `startsWithinMs` null is the catch-all bucket.
 */
export function staleBuckets(
  factor: number,
): Array<{ startsWithinMs: number | null; maxAgeMs: number }> {
  return [
    { startsWithinMs: HOUR_MS, maxAgeMs: 15 * MINUTE_MS * factor },
    { startsWithinMs: 6 * HOUR_MS, maxAgeMs: 40 * MINUTE_MS * factor },
    { startsWithinMs: 24 * HOUR_MS, maxAgeMs: 150 * MINUTE_MS * factor },
    { startsWithinMs: null, maxAgeMs: 450 * MINUTE_MS * factor },
  ];
}

/** In-play prices older than this are suspended by the sweep. */
export const IN_PLAY_STALE_MS = 150_000;
