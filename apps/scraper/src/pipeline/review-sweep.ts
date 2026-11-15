import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { closeReviewItemsBySubject } from '@vamos/db';
import { events as eventsTable, scrapeReviewItems } from '@vamos/db/schema';
import { REPRICE_SUBJECT_SUFFIX } from '@vamos/scraper';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { auditScraper } from './common';
import { EARLIER_SUBJECT_SUFFIX } from './kickoff-safety';

export interface ReviewSweepSummary {
  /** Subjects (a request to open betting, or a held re-price, of one event) assessed this pass. */
  checked: number;
  /** Review items closed. */
  closed: number;
  /** Subjects that raised an error (logged, the pass goes on with the next subject). */
  failed: number;
}

/** Why an item became pointless, in the order the reasons are checked (rule Q1). */
type SweepReason =
  'event_missing' | 'event_resulted' | 'event_started' | 'event_cancelled' | 'betting_open';

/** The two groups of items Q1 closes. */
type Group = 'request' | 'reprice';

interface Subject {
  group: Group;
  feedRef: string;
  /** The `subject_key` of the items. */
  subjectKey: string;
}

interface EventFacts {
  id: string;
  status: string;
  bettingOpen: boolean;
  resultedAt: Date | null;
  startTime: Date;
}

/** Group A: a request to open betting (F7, the hand-over, O1). Group B: a held re-price (O3). */
const REQUEST_KINDS = ['odds_approval', 'ratings_uncalibrated'] as const;
const REPRICE_KINDS = ['odds_approval'] as const;

/** Events are read this many per query (one SQL parameter each). */
const CHUNK = 200;

/**
 * Rule Q1 (docs/scraper.md): the review queue sweeper. Some open items become pointless and nobody
 * closes them: the request to open betting (`odds_approval` on the `feed_ref`, F7, or
 * `ratings_uncalibrated`, group A) and the held re-price (`odds_approval` on `<feedRef>|reprice`,
 * O3, group B) of an event that is gone, resulted, started or cancelled, and, for group A, of an
 * event whose betting is open. Other kinds and other subjects are never touched. The first reason
 * that holds wins:
 *
 * 1. `event_missing`: no scraped event has that `feed_ref`;
 * 2. `event_resulted`: `resulted_at` is set;
 * 3. `event_started`: live or finished, or scheduled with `start_time <= now`;
 * 4. `event_cancelled`: cancelled or abandoned;
 * 5. `betting_open`: group A only; a held re-price is still a decision for a trader while betting is
 *    open. A postponed event, or a scheduled one that has not started, keeps its items.
 *
 * One snapshot read decides what to look at; each subject to close then gets its own transaction:
 * the event row is locked first, then the subject's open items (the order of the review actions,
 * K1, the re-price step and F7b; the reverse could deadlock), and every condition is read again
 * with the same `now`. The writes: the items resolved by the scraper with `auto: <reason>` and one
 * audit `scrape.review.swept` per item. Nothing else changes: no event, market, price, bet or
 * rating. Idempotent: a second pass finds nothing open to close.
 */
export async function sweepReviewQueue(ctx: ScraperContext): Promise<ReviewSweepSummary> {
  const now = ctx.clock();
  const summary: ReviewSweepSummary = { checked: 0, closed: 0, failed: 0 };

  const items = await ctx.db
    .select({ kind: scrapeReviewItems.kind, subjectKey: scrapeReviewItems.subjectKey })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.status, 'open'),
        inArray(scrapeReviewItems.kind, ['odds_approval', 'ratings_uncalibrated']),
      ),
    );
  const subjects = new Map<string, Subject>();
  for (const item of items) {
    const subject = subjectOf(item.kind, item.subjectKey);
    if (subject !== null) subjects.set(`${subject.group}:${subject.subjectKey}`, subject);
  }
  if (subjects.size === 0) {
    ctx.logger.debug({ ...summary }, 'review sweep run');
    return summary;
  }

  const facts = await eventFacts(ctx, [...new Set([...subjects.values()].map((s) => s.feedRef))]);
  for (const subject of subjects.values()) {
    summary.checked += 1;
    try {
      if (reasonFor(subject.group, facts.get(subject.feedRef), now) === null) continue;
      summary.closed += await sweepOne(ctx, subject, now);
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, subjectKey: subject.subjectKey }, 'review sweep failed');
    }
  }

  ctx.logger[summary.closed + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'review sweep run',
  );
  return summary;
}

/** The group and event of an open item, or null for an item Q1 does not look at. */
function subjectOf(kind: string, subjectKey: string): Subject | null {
  if (kind === 'ratings_uncalibrated') {
    return { group: 'request', feedRef: subjectKey, subjectKey };
  }
  if (kind !== 'odds_approval') return null;
  if (subjectKey.endsWith(REPRICE_SUBJECT_SUFFIX)) {
    const feedRef = subjectKey.slice(0, -REPRICE_SUBJECT_SUFFIX.length);
    return feedRef === '' ? null : { group: 'reprice', feedRef, subjectKey };
  }
  // K1's `<feedRef>|earlier` is not a request to open betting (a feed_ref is `fx|...|day`).
  if (subjectKey.endsWith(EARLIER_SUBJECT_SUFFIX)) return null;
  return { group: 'request', feedRef: subjectKey, subjectKey };
}

/** The scraped events with these feed refs, keyed by feed ref. */
async function eventFacts(
  ctx: ScraperContext,
  feedRefs: string[],
): Promise<Map<string, EventFacts>> {
  const facts = new Map<string, EventFacts>();
  for (let from = 0; from < feedRefs.length; from += CHUNK) {
    const rows = await ctx.db
      .select({
        id: eventsTable.id,
        feedRef: eventsTable.feedRef,
        status: eventsTable.status,
        bettingOpen: eventsTable.bettingOpen,
        resultedAt: eventsTable.resultedAt,
        startTime: eventsTable.startTime,
      })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
          inArray(eventsTable.feedRef, feedRefs.slice(from, from + CHUNK)),
        ),
      );
    for (const { feedRef, ...rest } of rows) {
      if (feedRef !== null) facts.set(feedRef, rest);
    }
  }
  return facts;
}

/** The first reason (see the rule) the items of a subject are pointless, or null when they stay. */
function reasonFor(group: Group, event: EventFacts | undefined, now: Date): SweepReason | null {
  if (event === undefined) return 'event_missing';
  if (event.resultedAt !== null) return 'event_resulted';
  if (
    event.status === 'live' ||
    event.status === 'finished' ||
    (event.status === 'scheduled' && event.startTime.getTime() <= now.getTime())
  ) {
    return 'event_started';
  }
  if (event.status === 'cancelled' || event.status === 'abandoned') return 'event_cancelled';
  if (group === 'request' && event.bettingOpen) return 'betting_open';
  return null;
}

/**
 * Q1 for one subject, in one transaction: the event row (if there is one), then the open items,
 * each locked `FOR UPDATE`, and the reason is decided again. Returns the number of items closed.
 */
async function sweepOne(ctx: ScraperContext, subject: Subject, now: Date): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        id: eventsTable.id,
        status: eventsTable.status,
        bettingOpen: eventsTable.bettingOpen,
        resultedAt: eventsTable.resultedAt,
        startTime: eventsTable.startTime,
      })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
          eq(eventsTable.feedRef, subject.feedRef),
        ),
      )
      .for('update');
    const kinds = subject.group === 'request' ? REQUEST_KINDS : REPRICE_KINDS;
    const open = await tx
      .select({ id: scrapeReviewItems.id })
      .from(scrapeReviewItems)
      .where(
        and(
          eq(scrapeReviewItems.status, 'open'),
          eq(scrapeReviewItems.subjectKey, subject.subjectKey),
          inArray(scrapeReviewItems.kind, [...kinds]),
        ),
      )
      .orderBy(asc(scrapeReviewItems.id))
      .for('update');
    if (open.length === 0) return 0;
    const reason = reasonFor(subject.group, event, now);
    if (reason === null) return 0;

    const closed = await closeReviewItemsBySubject(tx, subject.subjectKey, {
      kinds,
      resolution: `auto: ${reason}`,
      now,
    });
    for (const item of closed) {
      await auditScraper(tx, {
        action: 'scrape.review.swept',
        targetType: 'scrape_review_item',
        targetId: item.id,
        metadata: {
          kind: item.kind,
          subjectKey: subject.subjectKey,
          reason,
          eventId: event?.id ?? null,
        },
      });
    }
    return closed.length;
  });
}
