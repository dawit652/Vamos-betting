import { KICKOFF_TOLERANCE_MS, MATCH_WINDOW_MS } from '../constants';
import type { ExistingEvent } from '../types';
import type { FixtureCluster } from './cluster';

/**
 * Rule F3 (docs/scraper.md section 6.1): find the existing event a cluster
 * belongs to. The match is by competition, home, away and start time within
 * `MATCH_WINDOW_MS`, NOT by the fixture key: the key is fixed at creation and
 * a rescheduled match must still find its event.
 */

export type EventMatch =
  | { kind: 'existing'; event: ExistingEvent }
  | { kind: 'new' }
  | { kind: 'ambiguous'; candidates: ExistingEvent[] };

export type MatchableCluster = Pick<
  FixtureCluster,
  'competitionId' | 'homeTeamId' | 'awayTeamId' | 'firstKickoff' | 'lastKickoff'
>;

/**
 * Exactly one candidate: that event. None: a new event. Several: ambiguous,
 * never the nearest (a wrong pick moves or results the wrong match). Events
 * in any status count: a finished or cancelled event must never be
 * re-created as a new one. Duplicate entries of one eventId count once.
 */
export function matchEvent(
  cluster: MatchableCluster,
  events: readonly ExistingEvent[],
  matchWindowMs: number = MATCH_WINDOW_MS,
): EventMatch {
  if (!Number.isFinite(matchWindowMs) || matchWindowMs < 0) {
    throw new RangeError('matchWindowMs must be a finite, non-negative number');
  }
  const from = cluster.firstKickoff.getTime() - matchWindowMs;
  const to = cluster.lastKickoff.getTime() + matchWindowMs;
  if (Number.isNaN(from) || Number.isNaN(to))
    throw new RangeError('cluster with an invalid kickoff');

  const found = new Map<string, ExistingEvent>();
  for (const event of events) {
    if (
      event.competitionId !== cluster.competitionId ||
      event.homeTeamId !== cluster.homeTeamId ||
      event.awayTeamId !== cluster.awayTeamId
    ) {
      continue;
    }
    const start = event.startTime.getTime();
    if (start >= from && start <= to && !found.has(event.eventId)) found.set(event.eventId, event);
  }
  const candidates = [...found.values()].sort(
    (a, b) =>
      a.startTime.getTime() - b.startTime.getTime() ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
  const [only] = candidates;
  if (candidates.length === 0 || only === undefined) return { kind: 'new' };
  if (candidates.length === 1) return { kind: 'existing', event: only };
  return { kind: 'ambiguous', candidates };
}

/** Kickoffs closer than the tolerance (inclusive) are the same time. Invalid dates are never the same. */
export function sameKickoff(a: Date, b: Date, toleranceMs: number = KICKOFF_TOLERANCE_MS): boolean {
  const gap = Math.abs(a.getTime() - b.getTime());
  return Number.isFinite(gap) && gap <= toleranceMs;
}

/**
 * Largest distance between any two of the kickoffs, in ms (0 for none or
 * one). Infinity if any date is invalid, so an agreement check on the
 * spread fails closed.
 */
export function kickoffSpread(dates: readonly Date[]): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const date of dates) {
    const ms = date.getTime();
    if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  return dates.length === 0 ? 0 : max - min;
}
