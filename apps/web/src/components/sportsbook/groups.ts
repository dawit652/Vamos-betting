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
