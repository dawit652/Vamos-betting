import type { SportCode } from '@vamos/core';

/**
 * What The Odds API's `/scores` endpoint covers, checked against real
 * responses (fixtures/real): football and basketball return live and final
 * scores; tennis returns none (no completed match over three days of a
 * running ATP tournament, and no score for a match two hours after its start).
 * A sport without feed scores is never polled for them (each call costs
 * credits), and its results come from staff.
 */
const WITH_FEED_SCORES: ReadonlySet<SportCode> = new Set<SportCode>(['football', 'basketball']);

/** Whether the feed reports scores (and so results) for a sport. */
export function hasFeedScores(sport: SportCode): boolean {
  return WITH_FEED_SCORES.has(sport);
}

/**
 * How long after its scheduled start a match without feed scores goes to
 * staff for its result. Tennis start times are estimates (a match follows
 * the one before it on court) and a best-of-five match runs for hours, so
 * this errs late; staff can result an event earlier from the back office.
 */
export const NO_FEED_SCORES_REVIEW_AFTER_MS = 6 * 60 * 60 * 1000;
