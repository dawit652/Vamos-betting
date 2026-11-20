import { closeReviewItemsBySubject } from '@vamos/db';
import { scrapeReviewItems, scrapeSources } from '@vamos/db/schema';
import { and, asc, eq, inArray, like, lt } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { auditScraper } from './common';
import type { ReviewSweepSummary } from './review-sweep';

/** An `unknown_team` / `unknown_competition` item nobody saw for this long is closed (rule Q2b). */
export const NAME_NOT_SEEN_MS = 7 * 24 * 3_600_000;

/** The subject of the items about one source: `source|<id>` (run-source.ts, stale-sources.ts). */
const SOURCE_SUBJECT_PREFIX = 'source|';
const SOURCE_KINDS = ['source_broken', 'source_stale'] as const;
const NAME_KINDS = ['unknown_team', 'unknown_competition'] as const;

/** Sources are read this many per query (one SQL parameter each). */
const CHUNK = 200;

/**
 * Rule Q2 (docs/scraper.md), the second part of the review queue sweeper (Q1 is `sweepReviewQueue`):
 *
 * - Q2a `source_disabled`: `source_broken` and `source_stale` items on `source|<id>` whose source row
 *   does not exist or has `enabled = false`: a source that no longer runs cannot recover, and nothing
 *   would ever close the item. Items of other subjects (credit alarms, `odds_out_of_line|...`) are
 *   left alone.
 * - Q2b `name_not_seen`: `unknown_team` and `unknown_competition` items with
 *   `updated_at < now - NAME_NOT_SEEN_MS`. `openReviewItem` moves `updated_at` on every sighting, so
 *   this means no source showed the name for a week.
 *
 * Each item (Q2b) or source subject (Q2a) gets its own transaction that locks the row(s) first and
 * reads the condition again with the same `now`. Resolved by the scraper with `auto: <reason>` and
 * one audit `scrape.review.swept` per item. The items are resolved, not dismissed: a dismissal is a
 * person's decision (`payload.dismissals`, which stops auto-aliasing), and a name that appears again
 * simply opens a new item. Nothing else changes. Idempotent.
 */
export async function sweepStaleReviewItems(ctx: ScraperContext): Promise<ReviewSweepSummary> {
  const now = ctx.clock();
  const summary: ReviewSweepSummary = { checked: 0, closed: 0, failed: 0 };
  const guard = async (what: Record<string, unknown>, work: () => Promise<number>) => {
    summary.checked += 1;
    try {
      summary.closed += await work();
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, ...what }, 'stale review sweep failed');
    }
  };

  for (const subjectKey of await deadSourceSubjects(ctx)) {
    await guard({ subjectKey }, () => sweepSource(ctx, subjectKey, now));
  }

  const cutoff = new Date(now.getTime() - NAME_NOT_SEEN_MS);
  const names = await ctx.db
    .select({ id: scrapeReviewItems.id, kind: scrapeReviewItems.kind })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.status, 'open'),
        inArray(scrapeReviewItems.kind, [...NAME_KINDS]),
        lt(scrapeReviewItems.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(scrapeReviewItems.id));
  for (const item of names) {
    await guard({ itemId: item.id }, () => sweepName(ctx, item.id, cutoff, now));
  }

  ctx.logger[summary.closed + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'stale review sweep run',
  );
  return summary;
}

const sourceIdOf = (subjectKey: string) => subjectKey.slice(SOURCE_SUBJECT_PREFIX.length);

/** Subjects `source|<id>` with an open item (Q2a kinds) whose source is missing or disabled. */
async function deadSourceSubjects(ctx: ScraperContext): Promise<string[]> {
  const open = await ctx.db
    .selectDistinct({ subjectKey: scrapeReviewItems.subjectKey })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.status, 'open'),
        inArray(scrapeReviewItems.kind, [...SOURCE_KINDS]),
        like(scrapeReviewItems.subjectKey, `${SOURCE_SUBJECT_PREFIX}%`),
      ),
    );
  const subjects = open.map((row) => row.subjectKey).filter((key) => sourceIdOf(key) !== '');
  const enabled = new Set<string>();
  for (let from = 0; from < subjects.length; from += CHUNK) {
    const rows = await ctx.db
      .select({ id: scrapeSources.id })
      .from(scrapeSources)
      .where(
        and(
          eq(scrapeSources.enabled, true),
          inArray(scrapeSources.id, subjects.slice(from, from + CHUNK).map(sourceIdOf)),
        ),
      );
    for (const row of rows) enabled.add(row.id);
  }
  return subjects.filter((key) => !enabled.has(sourceIdOf(key))).sort();
}

/** Q2a for one source subject. Returns the number of items closed. */
async function sweepSource(ctx: ScraperContext, subjectKey: string, now: Date): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [source] = await tx
      .select({ enabled: scrapeSources.enabled })
      .from(scrapeSources)
      .where(eq(scrapeSources.id, sourceIdOf(subjectKey)))
      .for('update');
    const open = await tx
      .select({ id: scrapeReviewItems.id })
      .from(scrapeReviewItems)
      .where(
        and(
          eq(scrapeReviewItems.status, 'open'),
          eq(scrapeReviewItems.subjectKey, subjectKey),
          inArray(scrapeReviewItems.kind, [...SOURCE_KINDS]),
        ),
      )
      .orderBy(asc(scrapeReviewItems.id))
      .for('update');
    if (open.length === 0 || source?.enabled === true) return 0;

    const closed = await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: SOURCE_KINDS,
      resolution: 'auto: source_disabled',
      now,
    });
    for (const item of closed) {
      await auditScraper(tx, {
        action: 'scrape.review.swept',
        targetType: 'scrape_review_item',
        targetId: item.id,
        metadata: {
          rule: 'Q2',
          kind: item.kind,
          subjectKey,
          reason: 'source_disabled',
          sourceExists: source !== undefined,
        },
      });
    }
    return closed.length;
  });
}

/** Q2b for one item. Returns 1 when it was closed. */
async function sweepName(
  ctx: ScraperContext,
  itemId: string,
  cutoff: Date,
  now: Date,
): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: scrapeReviewItems.id,
        kind: scrapeReviewItems.kind,
        subjectKey: scrapeReviewItems.subjectKey,
      })
      .from(scrapeReviewItems)
      .where(
        and(
          eq(scrapeReviewItems.id, itemId),
          eq(scrapeReviewItems.status, 'open'),
          lt(scrapeReviewItems.updatedAt, cutoff),
        ),
      )
      .for('update');
    // Seen again, or closed by a person, since the snapshot.
    if (item === undefined) return 0;

    const closed = await closeReviewItemsBySubject(tx, item.subjectKey, {
      kinds: [item.kind as (typeof NAME_KINDS)[number]],
      resolution: 'auto: name_not_seen',
      now,
    });
    for (const row of closed) {
      await auditScraper(tx, {
        action: 'scrape.review.swept',
        targetType: 'scrape_review_item',
        targetId: row.id,
        metadata: {
          rule: 'Q2',
          kind: row.kind,
          subjectKey: item.subjectKey,
          reason: 'name_not_seen',
        },
      });
    }
    return closed.length;
  });
}
