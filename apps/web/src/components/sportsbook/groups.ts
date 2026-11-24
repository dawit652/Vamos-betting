import type { EventSummary } from '@vamos/contracts';

export interface CompetitionGroup {
  slug: string;
  name: EventSummary['competition']['name'];
  category: EventSummary['competition']['category'];
  events: EventSummary[];
}

/**
 * Groups consecutive events of the same competition (the list is ordered by
 * start time, so a competition can appear again further down; each run gets
 * its own header and the page order is kept).
 */
export function groupByCompetition(events: readonly EventSummary[]): CompetitionGroup[] {
  const groups: CompetitionGroup[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last !== undefined && last.slug === event.competition.slug) {
      last.events.push(event);
    } else {
      groups.push({
        slug: event.competition.slug,
        name: event.competition.name,
        category: event.competition.category,
        events: [event],
      });
    }
  }
  return groups;
}

/** Kick-offs at least this far apart in one competition start a new matchweek (startsNewRound). */
export const ROUND_BREAK_MS = 48 * 60 * 60_000;

/**
 * Whether `next` opens a new matchweek after `prev` (owner, 24 Nov 2026: a little space between
 * one league week and the next). Events carry no round number, so two consecutive matches of the
 * same competition at least two days apart mark it: a weekend round runs Friday to Monday (about
 * 40 hours at most between its kick-offs), a midweek round Tuesday to Thursday.
 */
export function startsNewRound(prev: EventSummary | undefined, next: EventSummary): boolean {
  return (
    prev !== undefined &&
    prev.competition.slug === next.competition.slug &&
    Date.parse(next.startTime) - Date.parse(prev.startTime) >= ROUND_BREAK_MS
  );
}
