import { SCRAPED_FEED_PROVIDER, type MarketTypeCode } from '@vamos/core';
import {
  closeReviewItemsBySubject,
  getCompetitionPolicy,
  getTeamRatings,
  listCompetitionPolicies,
  loadKickoffEvidence,
  marketsWithSelections,
  setEventBettingOpen,
  type DbExecutor,
  type KickoffEvidence,
  type LiveMessage,
} from '@vamos/db';
import { auditLog, events as eventsTable, scrapeReviewItems } from '@vamos/db/schema';
import {
  assessKickoff,
  checkMarkets,
  isCalibrated,
  MIN_LEAD_MS,
  REPRICE_SUBJECT_SUFFIX,
  type GateMarket,
  type KickoffAssessment,
} from '@vamos/scraper';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { auditScraper } from './common';
import { backedByMarket } from './event-pricing';
import { asStatements, EARLIER_SUBJECT_SUFFIX, loaderOptions } from './kickoff-safety';

export interface AutoOpenSummary {
  /** Closed events waiting for a person in a competition with auto_open, assessed this pass. */
  checked: number;
  /** Events whose betting this pass opened (F7b). */
  opened: number;
  /** Events that raised an error (logged, the pass goes on with the next event). */
  failed: number;
  /** Live deltas published after the commits. */
  published: number;
}

/** The audit actions that record a change of an event's betting, by a person or by the scraper. */
const BETTING_CHANGES = [
  'catalog.event.betting_opened',
  'catalog.event.betting_closed',
  'scrape.fixture.betting_closed',
  'scrape.fixture.betting_opened',
] as const;

/** K1's automatic closure: the only earlier change after which F7b may open betting again. */
const K1_CLOSURE = 'scrape.fixture.betting_closed';

const OPENED = 'betting opened automatically: auto open is on and the kickoff is confirmed (F7b)';

/** Events are assessed this many per evidence read (one SQL parameter each). */
const CHUNK = 200;

/**
 * Rule F7b (docs/scraper.md): the automatic opening of F7, for an event that is waiting for a person.
 * F7 decides once, at creation, and an event created 14 days ahead from one source cannot have a
 * confirmed kickoff then (K2: C1 needs two independent fresh upstreams, C2 the last 72 hours). This
 * opens betting on a scraped, scheduled, unresulted event with betting closed that starts after
 * `now + MIN_LEAD_MS`, when all of these hold at that moment:
 *
 * - its competition's policy is enabled with `auto_open` (the person's standing choice);
 * - it waits for a person: its `odds_approval` item (F7, O3) or K1's `<feedRef>|earlier` item is open;
 * - no person decided on its betting: the latest betting change in the audit is none, or K1's
 *   automatic closure (a trader's close, or a dismissed item, keeps it closed);
 * - no open F4 `kickoff_change` item for it (sources disagree about the kickoff);
 * - no re-price of it held for a person (`<feedRef>|reprice`, O3): its stored prices are not the
 *   current ones;
 * - its kickoff is confirmed (K2: C1, C2 or C3), so K1's earlier report, if any, is gone;
 * - O1 (both teams calibrated), or O1m (`backedByMarket`: the event is priced from a fresh
 *   market whose 1X2 has at least 3 distinct books, one sharp, and the stored prices are those);
 *   and O2 (the open and suspended markets pass the price checks).
 *
 * Under the event row lock, then the locks of its review items, everything is read again. The
 * writes: `betting_open = true` (no actor), the audit `scrape.fixture.betting_opened` and the waiting items
 * resolved by the scraper; the live delta is published after the COMMIT. Nothing else changes:
 * no market, price, start time, status or bet. Idempotent: it acts only on closed betting.
 */
export async function openConfirmedEvents(ctx: ScraperContext): Promise<AutoOpenSummary> {
  const now = ctx.clock();
  const summary: AutoOpenSummary = { checked: 0, opened: 0, failed: 0, published: 0 };
  const autoOpen = await autoOpenCompetitions(ctx.db);
  if (autoOpen.size === 0) return summary;

  const waiting = (await waitingEvents(ctx.db, now)).filter((row) =>
    autoOpen.has(row.competitionId),
  );
  for (let from = 0; from < waiting.length; from += CHUNK) {
    const ids = waiting.slice(from, from + CHUNK).map((row) => row.id);
    let evidence: Map<string, KickoffEvidence>;
    try {
      evidence = await loadKickoffEvidence(ctx.db, { eventIds: ids, ...loaderOptions(now) });
    } catch (error) {
      summary.failed += ids.length;
      ctx.logger.error({ err: error, events: ids.length }, 'kickoff evidence read failed');
      continue;
    }
    for (const eventId of ids) {
      const found = evidence.get(eventId);
      if (found === undefined) continue;
      summary.checked += 1;
      try {
        // A first look without locks: most waiting events are not confirmed yet.
        if (!assess(found, now).confirmed) continue;
        const messages = await openOne(ctx, eventId, now);
        if (messages === null) continue;
        summary.opened += 1;
        summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
      } catch (error) {
        summary.failed += 1;
        ctx.logger.error({ err: error, eventId }, 'opening betting on a confirmed kickoff failed');
      }
    }
  }

  ctx.logger[summary.opened + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'auto open run',
  );
  return summary;
}

function assess(evidence: KickoffEvidence, now: Date): KickoffAssessment {
  return assessKickoff({
    start: evidence.event.startTime,
    now,
    statements: asStatements(evidence),
    person: evidence.person,
  });
}

/** Competitions whose policy is configured, enabled and has auto_open. */
async function autoOpenCompetitions(exec: DbExecutor): Promise<Set<string>> {
  const rows = await listCompetitionPolicies(exec, { sportId: 'football' });
  return new Set(
    rows
      .filter((row) => row.configured && row.enabled && row.autoOpen)
      .map((row) => row.competitionId),
  );
}

const startsLateEnough = (now: Date) =>
  gt(eventsTable.startTime, new Date(now.getTime() + MIN_LEAD_MS));

/**
 * Scraped, scheduled, unresulted events with betting closed that start after now + MIN_LEAD_MS and
 * have an open waiting item: `odds_approval` (subject = feed_ref) or K1's (`<feedRef>|earlier`).
 */
async function waitingEvents(
  exec: DbExecutor,
  now: Date,
): Promise<Array<{ id: string; competitionId: string }>> {
  const items = await exec
    .select({ kind: scrapeReviewItems.kind, subjectKey: scrapeReviewItems.subjectKey })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.status, 'open'),
        inArray(scrapeReviewItems.kind, ['odds_approval', 'kickoff_change']),
      ),
    );
  const feedRefs = new Set(
    items.flatMap((item) => {
      if (item.kind === 'odds_approval') return [item.subjectKey];
      return item.subjectKey.endsWith(EARLIER_SUBJECT_SUFFIX)
        ? [item.subjectKey.slice(0, -EARLIER_SUBJECT_SUFFIX.length)]
        : [];
    }),
  );
  if (feedRefs.size === 0) return [];
  const rows = await exec
    .select({
      id: eventsTable.id,
      competitionId: eventsTable.competitionId,
      feedRef: eventsTable.feedRef,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(eventsTable.status, 'scheduled'),
        eq(eventsTable.bettingOpen, false),
        isNull(eventsTable.resultedAt),
        startsLateEnough(now),
      ),
    )
    .orderBy(asc(eventsTable.startTime), asc(eventsTable.id));
  return rows
    .filter((row) => row.feedRef !== null && feedRefs.has(row.feedRef))
    .map(({ id, competitionId }) => ({ id, competitionId }));
}

/**
 * F7b for one event, in one transaction: the event row is locked first, then its review items (the
 * order of K1, the re-price step and the review actions, which all lock the event before they write
 * an item; the reverse order could deadlock with a trader's `open_betting`), and every condition is
 * read again. Returns the live deltas, or null when a condition no longer holds.
 */
async function openOne(
  ctx: ScraperContext,
  eventId: string,
  now: Date,
): Promise<LiveMessage[] | null> {
  return ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        feedProvider: eventsTable.feedProvider,
        feedRef: eventsTable.feedRef,
        competitionId: eventsTable.competitionId,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        status: eventsTable.status,
        bettingOpen: eventsTable.bettingOpen,
        resultedAt: eventsTable.resultedAt,
        startTime: eventsTable.startTime,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId))
      .for('update');
    if (
      event === undefined ||
      event.feedProvider !== SCRAPED_FEED_PROVIDER ||
      event.feedRef === null ||
      event.status !== 'scheduled' ||
      event.bettingOpen ||
      event.resultedAt !== null ||
      event.startTime.getTime() <= now.getTime() + MIN_LEAD_MS
    ) {
      return null;
    }
    const feedRef = event.feedRef;
    const earlierSubject = `${feedRef}${EARLIER_SUBJECT_SUFFIX}`;
    const repriceSubject = `${feedRef}${REPRICE_SUBJECT_SUFFIX}`;

    const items = await tx
      .select({ kind: scrapeReviewItems.kind, subjectKey: scrapeReviewItems.subjectKey })
      .from(scrapeReviewItems)
      .where(
        and(
          eq(scrapeReviewItems.status, 'open'),
          inArray(scrapeReviewItems.subjectKey, [feedRef, earlierSubject, repriceSubject]),
          inArray(scrapeReviewItems.kind, ['odds_approval', 'kickoff_change']),
        ),
      )
      .orderBy(asc(scrapeReviewItems.id))
      .for('update');
    const waitsForPerson = items.some(
      (item) =>
        (item.kind === 'odds_approval' && item.subjectKey === feedRef) ||
        (item.kind === 'kickoff_change' && item.subjectKey === earlierSubject),
    );
    // An open F4 item: the sources disagree about the kickoff, a person decides.
    const kickoffQuestion = items.some(
      (item) => item.kind === 'kickoff_change' && item.subjectKey === feedRef,
    );
    // An O3 hold: a re-price waits for a person, so the stored prices are not the current ones.
    const repriceHeld = items.some(
      (item) => item.kind === 'odds_approval' && item.subjectKey === repriceSubject,
    );
    if (!waitsForPerson || kickoffQuestion || repriceHeld) return null;
    if (!(await autoOpenCompetitions(tx)).has(event.competitionId)) return null;

    // No person decided on its betting: the latest change is none, or K1's automatic closure.
    const [latest] = await tx
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, 'event'),
          eq(auditLog.targetId, eventId),
          inArray(auditLog.action, [...BETTING_CHANGES]),
        ),
      )
      // The id is a sequence: insertion order, unlike created_at (the transaction's start).
      .orderBy(desc(auditLog.id))
      .limit(1);
    if (latest !== undefined && latest.action !== K1_CLOSURE) return null;

    // K2, read again under the lock.
    const evidence = (
      await loadKickoffEvidence(tx, { eventIds: [eventId], ...loaderOptions(now) })
    ).get(eventId);
    if (evidence === undefined) return null;
    const assessment = assess(evidence, now);
    if (!assessment.confirmed) return null;

    // O1 (or O1m) and O2, as for a person who opens betting (assertScrapedEventMayOpen in the API).
    const rated = await getTeamRatings(tx, [event.homeTeamId, event.awayTeamId]);
    const minMatches = ctx.config.scraper.minRatingMatches;
    const home = rated.get(event.homeTeamId)?.ratings ?? null;
    const away = rated.get(event.awayTeamId)?.ratings ?? null;
    let calibration: 'ratings' | 'market' = 'ratings';
    if (!(isCalibrated(home, minMatches) && isCalibrated(away, minMatches))) {
      const policy = await getCompetitionPolicy(tx, event.competitionId);
      const backed = await backedByMarket(tx, {
        competitionPricingSource: policy.pricingSource,
        eventId,
        homeRatings: home,
        awayRatings: away,
        minRatingMatches: minMatches,
        now,
        // O7: the stamp of capped market prices carries the cap (priceEvent), so ask the same.
        capAtBestPrice: ctx.config.scraper.capAtBestPrice,
        // And it carries the factory's markets (plan task 2.3), so ask the same again.
        factoryMarkets: ctx.config.scraper.factoryMarkets && policy.factoryMarkets,
      });
      if (!backed) return null;
      calibration = 'market';
    }
    const bettable: GateMarket[] = (await marketsWithSelections(tx, eventId))
      .filter((market) => market.status === 'open' || market.status === 'suspended')
      .map((market) => ({
        type: market.type as MarketTypeCode,
        line: market.line,
        selections: market.selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
      }));
    if (!checkMarkets(bettable).ok) return null;

    const change = await setEventBettingOpen(tx, eventId, true);
    if (!change.changed) return null;
    await auditScraper(tx, {
      action: 'scrape.fixture.betting_opened',
      targetType: 'event',
      targetId: eventId,
      metadata: {
        feedRef,
        rule: 'F7b',
        start: event.startTime.toISOString(),
        basis: assessment.basis,
        evidenceKey: assessment.evidenceKey,
        afterK1: latest?.action === K1_CLOSURE,
        calibration,
      },
    });
    await closeReviewItemsBySubject(tx, feedRef, {
      kinds: ['odds_approval'],
      resolution: OPENED,
      now,
    });
    await closeReviewItemsBySubject(tx, earlierSubject, {
      kinds: ['kickoff_change'],
      resolution: OPENED,
      now,
    });
    return change.messages;
  });
}
