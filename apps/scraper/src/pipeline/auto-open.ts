import { SCRAPED_FEED_PROVIDER, type MarketTypeCode } from '@vamos/core';
import {
  closeReviewItemsBySubject,
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
 * Why F7b does not open an event, in the order it checks (several may hold at once):
 *
 * - `not_found`, `not_scraped`, `not_scheduled`, `resulted`, `betting_open`: not an event F7b opens;
 * - `starts_too_soon`: it starts within MIN_LEAD_MS;
 * - `policy_off`: its competition is switched off, has no policy, or has `auto_open` off;
 * - `not_waiting`: no open `odds_approval` item and no open K1 item: a person resolved or dismissed it;
 * - `person_decided`: a person opened or closed its betting (the audit), so it stays as they left it;
 * - `kickoff_question`: an open F4 `kickoff_change` item (the sources disagree about the kickoff);
 * - `price_proposal`: an open re-price proposal (`<feedRef>|reprice`) waits for a person;
 * - `kickoff_unconfirmed`: K2 does not confirm the kickoff (`kickoffReasons` say why);
 * - `teams_uncalibrated`: O1 (`uncalibrated` lists the team ids);
 * - `prices_failed`: O2 (`priceIssues` lists the issue codes).
 */
export type AutoOpenBlocker =
  | 'not_found'
  | 'not_scraped'
  | 'not_scheduled'
  | 'resulted'
  | 'betting_open'
  | 'starts_too_soon'
  | 'policy_off'
  | 'not_waiting'
  | 'person_decided'
  | 'kickoff_question'
  | 'price_proposal'
  | 'kickoff_unconfirmed'
  | 'teams_uncalibrated'
  | 'prices_failed';

export interface AutoOpenCheck {
  eventId: string;
  feedRef: string | null;
  startTime: Date | null;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** Empty: F7b opens the event now. */
  blockers: AutoOpenBlocker[];
  /** K2's assessment; null when it was not reached. */
  assessment: KickoffAssessment | null;
  /** The latest betting change in the audit, or null when there is none. */
  latestChange: string | null;
  /** O1: the ids of the teams that are not calibrated. */
  uncalibrated: string[];
  /** O2: the issue codes of the bettable markets. */
  priceIssues: string[];
}

/**
 * Rule F7b (docs/scraper.md): the automatic opening of F7, for an event that is waiting for a person.
 * F7 decides once, at creation, and an event created 14 days ahead from one source cannot have a
 * confirmed kickoff then (K2: C1 needs two independent fresh upstreams, C2 the last 72 hours). This
 * opens betting on a scraped, scheduled, unresulted event with betting closed that starts after
 * `now + MIN_LEAD_MS`, when `autoOpenCheck` finds no blocker at that moment:
 *
 * - its competition's policy is enabled with `auto_open` (the person's standing choice);
 * - it waits for a person: its `odds_approval` item (F7, O3) or K1's `<feedRef>|earlier` item is open;
 * - no person decided on its betting: the latest betting change in the audit is none, or K1's
 *   automatic closure (a trader's close, or a dismissed item, keeps it closed);
 * - no open F4 `kickoff_change` item for it (sources disagree about the kickoff);
 * - no open re-price proposal for it (the market or the ratings moved its prices too far for the
 *   step to apply them: a person decides on the prices first);
 * - its kickoff is confirmed (K2: C1, C2 or C3), so K1's earlier report, if any, is gone;
 * - O1 (both teams calibrated) and O2 (the open and suspended markets pass the price checks).
 *
 * Under the locks of the waiting items and the event row, everything is read again
 * (`setEventBettingOpen` locks the row again within the same transaction). The writes:
 * `betting_open = true` (no actor), the audit `scrape.fixture.betting_opened` and the waiting items
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
 * Every F7b condition for one event, as blockers (none: F7b opens it). With `lock`, the waiting
 * items are locked first, then the event row (the order of the review actions), so it must run in
 * the transaction that opens betting; without it, it only reads (the feed report).
 */
export async function autoOpenCheck(
  exec: DbExecutor,
  eventId: string,
  now: Date,
  minRatingMatches: number,
  options: { lock: boolean },
): Promise<AutoOpenCheck> {
  const check: AutoOpenCheck = {
    eventId,
    feedRef: null,
    startTime: null,
    competitionId: null,
    homeTeamId: null,
    awayTeamId: null,
    blockers: [],
    assessment: null,
    latestChange: null,
    uncalibrated: [],
    priceIssues: [],
  };
  const [row] = await exec
    .select({ feedRef: eventsTable.feedRef })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));
  if (row === undefined) return { ...check, blockers: ['not_found'] };
  const feedRef = row.feedRef;
  if (feedRef === null) return { ...check, blockers: ['not_scraped'] };
  const earlierSubject = `${feedRef}${EARLIER_SUBJECT_SUFFIX}`;
  const repriceSubject = `${feedRef}${REPRICE_SUBJECT_SUFFIX}`;

  const itemsQuery = exec
    .select({ kind: scrapeReviewItems.kind, subjectKey: scrapeReviewItems.subjectKey })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.status, 'open'),
        inArray(scrapeReviewItems.subjectKey, [feedRef, earlierSubject, repriceSubject]),
        inArray(scrapeReviewItems.kind, ['odds_approval', 'kickoff_change']),
      ),
    )
    .orderBy(asc(scrapeReviewItems.id));
  const items = options.lock ? await itemsQuery.for('update') : await itemsQuery;
  const has = (kind: string, subject: string): boolean =>
    items.some((item) => item.kind === kind && item.subjectKey === subject);

  const eventQuery = exec
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
    .where(eq(eventsTable.id, eventId));
  const [event] = options.lock ? await eventQuery.for('update') : await eventQuery;
  if (event === undefined) return { ...check, blockers: ['not_found'] };
  check.feedRef = event.feedRef;
  check.startTime = event.startTime;
  check.competitionId = event.competitionId;
  check.homeTeamId = event.homeTeamId;
  check.awayTeamId = event.awayTeamId;
  if (event.feedProvider !== SCRAPED_FEED_PROVIDER || event.feedRef !== feedRef) {
    return { ...check, blockers: ['not_scraped'] };
  }

  const blockers: AutoOpenBlocker[] = [];
  if (event.status !== 'scheduled') blockers.push('not_scheduled');
  if (event.resultedAt !== null) blockers.push('resulted');
  if (event.bettingOpen) blockers.push('betting_open');
  if (event.startTime.getTime() <= now.getTime() + MIN_LEAD_MS) blockers.push('starts_too_soon');
  if (!(await autoOpenCompetitions(exec)).has(event.competitionId)) blockers.push('policy_off');
  if (!has('odds_approval', feedRef) && !has('kickoff_change', earlierSubject)) {
    blockers.push('not_waiting');
  }

  // No person decided on its betting: the latest change is none, or K1's automatic closure.
  const [latest] = await exec
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
  check.latestChange = latest?.action ?? null;
  if (latest !== undefined && latest.action !== K1_CLOSURE) blockers.push('person_decided');
  // An open F4 item: the sources disagree about the kickoff, a person decides.
  if (has('kickoff_change', feedRef)) blockers.push('kickoff_question');
  // An open re-price proposal: the prices moved too far to change without a person.
  if (has('odds_approval', repriceSubject)) blockers.push('price_proposal');

  // K2, read under the lock when there is one.
  const evidence = (
    await loadKickoffEvidence(exec, { eventIds: [eventId], ...loaderOptions(now) })
  ).get(eventId);
  check.assessment = evidence === undefined ? null : assess(evidence, now);
  if (check.assessment?.confirmed !== true) blockers.push('kickoff_unconfirmed');

  // O1 and O2, as for a person who opens betting (assertScrapedEventMayOpen in the API).
  const rated = await getTeamRatings(exec, [event.homeTeamId, event.awayTeamId]);
  check.uncalibrated = [event.homeTeamId, event.awayTeamId].filter(
    (id) => !isCalibrated(rated.get(id)?.ratings ?? null, minRatingMatches),
  );
  if (check.uncalibrated.length > 0) blockers.push('teams_uncalibrated');
  const bettable: GateMarket[] = (await marketsWithSelections(exec, eventId))
    .filter((market) => market.status === 'open' || market.status === 'suspended')
    .map((market) => ({
      type: market.type as MarketTypeCode,
      line: market.line,
      selections: market.selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
    }));
  const prices = checkMarkets(bettable);
  check.priceIssues = prices.ok ? [] : [...new Set(prices.issues.map((issue) => issue.code))];
  if (!prices.ok) blockers.push('prices_failed');

  return { ...check, blockers };
}

/**
 * F7b for one event, in one transaction: `autoOpenCheck` under the locks, then the writes. Returns
 * the live deltas, or null when a condition no longer holds.
 */
async function openOne(
  ctx: ScraperContext,
  eventId: string,
  now: Date,
): Promise<LiveMessage[] | null> {
  return ctx.db.transaction(async (tx) => {
    const check = await autoOpenCheck(tx, eventId, now, ctx.config.scraper.minRatingMatches, {
      lock: true,
    });
    if (check.blockers.length > 0 || check.feedRef === null || check.assessment === null) {
      return null;
    }
    const feedRef = check.feedRef;

    const change = await setEventBettingOpen(tx, eventId, true);
    if (!change.changed) return null;
    await auditScraper(tx, {
      action: 'scrape.fixture.betting_opened',
      targetType: 'event',
      targetId: eventId,
      metadata: {
        feedRef,
        rule: 'F7b',
        start: check.startTime?.toISOString() ?? null,
        basis: check.assessment.basis,
        evidenceKey: check.assessment.evidenceKey,
        afterK1: check.latestChange === K1_CLOSURE,
      },
    });
    await closeReviewItemsBySubject(tx, feedRef, {
      kinds: ['odds_approval'],
      resolution: OPENED,
      now,
    });
    await closeReviewItemsBySubject(tx, `${feedRef}${EARLIER_SUBJECT_SUFFIX}`, {
      kinds: ['kickoff_change'],
      resolution: OPENED,
      now,
    });
    return change.messages;
  });
}
