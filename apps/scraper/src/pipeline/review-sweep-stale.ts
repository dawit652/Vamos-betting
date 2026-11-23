import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { closeReviewItemsBySubject } from '@vamos/db';
import { betLegs, events as eventsTable, scrapeReviewItems, scrapeSources } from '@vamos/db/schema';
import { and, asc, eq, inArray, like, lt } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { auditScraper } from './common';
import { EARLIER_SUBJECT_SUFFIX } from './kickoff-safety';
import type { ReviewSweepSummary } from './review-sweep';

/** An `unknown_team` / `unknown_competition` item nobody saw for this long is closed (rule Q2b). */
export const NAME_NOT_SEEN_MS = 7 * 24 * 3_600_000;

/** The subject of the items about one source: `source|<id>` (run-source.ts, stale-sources.ts). */
const SOURCE_SUBJECT_PREFIX = 'source|';
const SOURCE_KINDS = ['source_broken', 'source_stale'] as const;
const NAME_KINDS = ['unknown_team', 'unknown_competition'] as const;

/** Sources are read this many per query (one SQL parameter each). */
const CHUNK = 200;

/** Q2c: questions about a match that the match itself has answered. */
const MATCH_KINDS = ['kickoff_change', 'fixture_missing', 'fixture_conflict'] as const;
type MatchKind = (typeof MATCH_KINDS)[number];
/** A fixture never created is closed this long after the end of its day (its feed_ref's date). */
export const FIXTURE_DAY_PAST_MS = 2 * 24 * 3_600_000;

export type MatchSweepReason =
  'event_resulted' | 'event_cancelled' | 'event_started' | 'fixture_past';

export interface MatchFacts {
  status: string;
  resultedAt: Date | null;
  startTime: Date;
  /** At least one bet (any status) has a leg on the match. */
  hasBets: boolean;
}

/** The end of the UTC day a feed_ref names (`fx|comp|home|away|YYYY-MM-DD`), or null. */
export function fixtureDayEnd(feedRef: string): Date | null {
  const day = feedRef.split('|').at(-1) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== day) return null;
  return new Date(start + 24 * 3_600_000);
}

/**
 * Q2c (owner, 23 Nov 2026: most review items should resolve by themselves): why an open item about
 * a match no longer needs a person, or null when it still does.
 *
 * - `kickoff_change`: once the match has a result, was cancelled or kicked off, the time question
 *   is moot, but only when nobody bet on it: with bets, a later real kickoff could mean bets taken
 *   after it, and a person must look.
 * - `fixture_missing`: once the match has a result or was cancelled (a scheduled match past its
 *   start without a result stays: `result_overdue` follows it).
 * - `fixture_conflict`: once the match kicked off or ended; for a fixture never created, two days
 *   after its day.
 */
export function matchItemReason(
  kind: MatchKind,
  event: MatchFacts | undefined,
  feedRef: string,
  now: Date,
): MatchSweepReason | null {
  if (event === undefined) {
    const dayEnd = fixtureDayEnd(feedRef);
    return dayEnd !== null && now.getTime() >= dayEnd.getTime() + FIXTURE_DAY_PAST_MS
      ? 'fixture_past'
      : null;
  }
  if (kind === 'kickoff_change' && event.hasBets) return null;
  if (event.resultedAt !== null || event.status === 'finished') return 'event_resulted';
  if (event.status === 'cancelled' || event.status === 'abandoned') return 'event_cancelled';
  const started =
    event.status === 'live' ||
    (event.status === 'scheduled' && event.startTime.getTime() <= now.getTime());
  if (started && kind !== 'fixture_missing') return 'event_started';
  return null;
}

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
 * - Q2c (owner, 23 Nov 2026): `kickoff_change`, `fixture_missing` and `fixture_conflict` items the
 *   match has answered (`matchItemReason`): it has a result, was cancelled or kicked off; a
 *   kickoff question with bets on the match, and a missing fixture without a result, stay.
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

  const matchItems = await ctx.db
    .select({ id: scrapeReviewItems.id })
    .from(scrapeReviewItems)
    .where(
      and(eq(scrapeReviewItems.status, 'open'), inArray(scrapeReviewItems.kind, [...MATCH_KINDS])),
    )
    .orderBy(asc(scrapeReviewItems.id));
  for (const item of matchItems) {
    await guard({ itemId: item.id }, () => sweepMatchItem(ctx, item.id, now));
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

/**
 * Q2c for one item, in one transaction: the match row first (the order of the review actions and
 * of Q1), then the item, both locked, and the reason decided again. Returns 1 when it was closed.
 */
async function sweepMatchItem(ctx: ScraperContext, itemId: string, now: Date): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ kind: scrapeReviewItems.kind, subjectKey: scrapeReviewItems.subjectKey })
      .from(scrapeReviewItems)
      .where(eq(scrapeReviewItems.id, itemId));
    if (peek === undefined) return 0;
    const feedRef = peek.subjectKey.endsWith(EARLIER_SUBJECT_SUFFIX)
      ? peek.subjectKey.slice(0, -EARLIER_SUBJECT_SUFFIX.length)
      : peek.subjectKey;
    const [event] = await tx
      .select({
        id: eventsTable.id,
        status: eventsTable.status,
        resultedAt: eventsTable.resultedAt,
        startTime: eventsTable.startTime,
      })
      .from(eventsTable)
      .where(
        and(eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER), eq(eventsTable.feedRef, feedRef)),
      )
      .for('update');
    const [item] = await tx
      .select({ id: scrapeReviewItems.id, kind: scrapeReviewItems.kind })
      .from(scrapeReviewItems)
      .where(and(eq(scrapeReviewItems.id, itemId), eq(scrapeReviewItems.status, 'open')))
      .for('update');
    // Closed by a person or another pass since the snapshot.
    if (item === undefined) return 0;
    const kind = item.kind as MatchKind;

    let facts: MatchFacts | undefined;
    if (event !== undefined) {
      const [leg] = await tx
        .select({ id: betLegs.id })
        .from(betLegs)
        .where(eq(betLegs.eventId, event.id))
        .limit(1);
      facts = { ...event, hasBets: leg !== undefined };
    }
    const reason = matchItemReason(kind, facts, feedRef, now);
    if (reason === null) return 0;

    const closed = await closeReviewItemsBySubject(tx, peek.subjectKey, {
      kinds: [kind],
      resolution: `auto: ${reason}`,
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
          subjectKey: peek.subjectKey,
          reason,
          eventId: event?.id ?? null,
        },
      });
    }
    return closed.length;
  });
}
