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

const MINUTE_MS = 60 * 1000;

const KEY_PREFIXES: ReadonlyArray<readonly [string, SportCode]> = [
  ['soccer_', 'football'],
  ['basketball_', 'basketball'],
  ['tennis_', 'tennis'],
];

/** The sport of an Odds API sport key by its prefix ('soccer_epl' → football); null for others. */
export function sportOfKey(sportKey: string): SportCode | null {
  return KEY_PREFIXES.find(([prefix]) => sportKey.startsWith(prefix))?.[1] ?? null;
}

/**
 * How long after its start a match is normally over, so its final score can
 * be asked for: football 90 minutes, half-time and stoppage time; an NBA game
 * about two and a half hours. Before that, live scores are read without
 * `daysFrom` (1 credit instead of 2).
 */
export function expectedMatchMs(sport: SportCode): number {
  switch (sport) {
    case 'football':
      return 115 * MINUTE_MS;
    case 'basketball':
      return 150 * MINUTE_MS;
    default:
      return NO_FEED_SCORES_REVIEW_AFTER_MS;
  }
}
