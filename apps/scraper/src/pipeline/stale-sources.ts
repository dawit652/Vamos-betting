import {
  closeReviewItemsBySubject,
  listReviewItems,
  listSourceContentFacts,
  openReviewItem,
} from '@vamos/db';
import { HOUR_MS, MIN_MATCH_DURATION_MS, SOURCE_STALE_AFTER_MS } from '@vamos/scraper';
import type { ScraperContext } from '../context';

/** A dismissed item stays quiet this long; a source still stale after that is raised again. */
const STALE_SNOOZE_MS = 24 * HOUR_MS;

export interface StaleSourcesSummary {
  opened: number;
  closed: number;
}

/**
 * Rule S5. A source can answer every run with a page that never changes (a volunteer dataset nobody
 * updates, a cached proxy), and then every health signal says "ok" while no result ever arrives. A
 * source is stale when it is enabled, its latest run was ok, and a match it lists ended (at the
 * earliest) `SOURCE_STALE_AFTER_MS` ago or more with nothing new shown by the source since. A quiet
 * source between match days is not stale: the clock starts when a listed match ends. A
 * `source_stale` item tells a person which source and how many matches are waiting; dismissing it
 * silences it for 24 hours. It closes by itself when the source shows something new, when no listed
 * match is waiting any more, or when the source is disabled or failing (those have their own
 * signals). It changes no data.
 */
export async function flagStaleSources(ctx: ScraperContext): Promise<StaleSourcesSummary> {
  const now = ctx.clock();
  const summary: StaleSourcesSummary = { opened: 0, closed: 0 };

  const facts = await listSourceContentFacts(ctx.db, {
    now,
    minMatchDurationMs: MIN_MATCH_DURATION_MS,
    staleAfterMs: SOURCE_STALE_AFTER_MS,
  });
  const stale = facts.filter((fact) => fact.dueMatches > 0);
  const snoozed = new Set(
    (
      await listReviewItems(ctx.db, {
        kind: 'source_stale',
        status: 'dismissed',
        resolvedSince: new Date(now.getTime() - STALE_SNOOZE_MS),
        limit: 200,
      })
    ).map((item) => item.subjectKey),
  );

  const staleKeys = new Set<string>();
  for (const fact of stale) {
    const subjectKey = `source|${fact.sourceId}`;
    staleKeys.add(subjectKey);
    if (snoozed.has(subjectKey)) continue;
    const hoursUnchanged = Math.floor((now.getTime() - fact.lastChangedAt.getTime()) / HOUR_MS);
    try {
      const { created } = await ctx.db.transaction((tx) =>
        openReviewItem(tx, {
          kind: 'source_stale',
          subjectKey,
          severity: 'warning',
          title: `${fact.sourceName}: nothing new for ${Math.floor(hoursUnchanged / 24)} days`,
          payload: {
            sourceId: fact.sourceId,
            sourceName: fact.sourceName,
            lastChangedAt: fact.lastChangedAt.toISOString(),
            hoursUnchanged,
            dueMatches: fact.dueMatches,
          },
          now,
        }),
      );
      if (created) summary.opened += 1;
    } catch (error) {
      ctx.logger.error({ err: error, sourceId: fact.sourceId }, 'stale source item failed');
    }
  }

  const open = await listReviewItems(ctx.db, { kind: 'source_stale', status: 'open', limit: 200 });
  for (const item of open) {
    if (staleKeys.has(item.subjectKey)) continue;
    try {
      const closed = await ctx.db.transaction((tx) =>
        closeReviewItemsBySubject(tx, item.subjectKey, {
          kinds: ['source_stale'],
          resolution: 'the source shows news again, or no listed match is waiting on it',
          now,
        }),
      );
      summary.closed += closed.length;
    } catch (error) {
      ctx.logger.error({ err: error, itemId: item.id }, 'closing a stale source item failed');
    }
  }

  ctx.logger[summary.opened + summary.closed > 0 ? 'info' : 'debug'](
    { ...summary },
    'stale source run',
  );
  return summary;
}
