import { SCRAPED_FEED_PROVIDER, type ResolutionInput } from '@vamos/core';
import type { DbTransaction } from '@vamos/db';
import { events } from '@vamos/db/schema';
import { MIN_MATCH_DURATION_MS } from '@vamos/scraper';
import { eq } from 'drizzle-orm';
import { conflict } from '../../lib/errors';

/**
 * Rule R1's floor for a person (S-5, docs/scraper.md 6.2): a `finished` result of an event the data
 * scraper created is accepted only from MIN_MATCH_DURATION_MS (105 minutes) after its kickoff, the
 * floor the scraper's own result gate applies; earlier is 409 `match_not_over` with the earliest
 * moment. The event row is locked first (staffResultEvent locks it again in the same transaction).
 * Other feeds, and the other statuses (cancelled, postponed, abandoned), are not affected; an unknown
 * event is left to the caller's 404.
 */
export async function assertScrapedMatchOver(
  tx: DbTransaction,
  eventId: string,
  result: ResolutionInput,
  now: Date,
): Promise<void> {
  if (result.status !== 'finished') return;
  const [event] = await tx
    .select({ feedProvider: events.feedProvider, startTime: events.startTime })
    .from(events)
    .where(eq(events.id, eventId))
    .for('update');
  if (event === undefined || event.feedProvider !== SCRAPED_FEED_PROVIDER) return;
  const earliest = new Date(event.startTime.getTime() + MIN_MATCH_DURATION_MS);
  if (now.getTime() < earliest.getTime()) {
    throw conflict(
      'match_not_over',
      'The match cannot have ended yet: a result can be entered from 105 minutes after kickoff',
      { earliest: earliest.toISOString() },
    );
  }
}
