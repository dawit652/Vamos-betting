import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  getEventExposure,
  loadKickoffEvidence,
  lockEvent,
  setEventBettingOpen,
  type KickoffEvidence,
  type LiveMessage,
} from '@vamos/db';
import { betLegs, events as eventsTable } from '@vamos/db/schema';
import {
  assessKickoff,
  earlierKickoffAction,
  KICKOFF_EVIDENCE_WINDOW_MS,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
  type ExistingEvent,
  type GateReview,
  type KickoffAssessment,
  type KickoffStatement,
} from '@vamos/scraper';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { auditScraper, openGateReviews, teamNames } from './common';

export interface KickoffSafetySummary {
  /** Open, scheduled, unresulted scraped events that have not started and were assessed. */
  checked: number;
  /** Events whose betting this pass closed (K1). */
  closed: number;
  /** Events that raised an error (logged, the pass goes on with the next event). */
  failed: number;
  /** Live deltas published after the commits. */
  published: number;
}

/** Events are assessed this many per evidence read (one SQL parameter each). */
const CHUNK = 200;

/** Subject of the K1 item: separate from the F4 item (`<feedRef>`), which the gate rewrites every pass. */
export const EARLIER_SUBJECT_SUFFIX = '|earlier';

export const loaderOptions = (now: Date) => ({
  now,
  minMatchDurationMs: MIN_MATCH_DURATION_MS,
  staleAfterMs: SOURCE_STALE_AFTER_MS,
  evidenceWindowMs: KICKOFF_EVIDENCE_WINDOW_MS,
});

export const asStatements = (evidence: KickoffEvidence): KickoffStatement[] =>
  evidence.statements.map((s) => ({ ...s }));

/** The event as `earlierKickoffAction` reads it. */
const asEvent = (evidence: KickoffEvidence) => ({
  ...evidence.event,
  status: evidence.event.status as ExistingEvent['status'],
});

/**
 * Rule K1 (docs/scraper.md 6.1a). Prematch betting on a scraped event closes by itself at
 * `start_time` and the event never goes live, so betting that is open while a source says the match
 * starts EARLIER than our start is the one exposure. For every scraped, scheduled, unresulted event
 * with open betting that has not started, whose evidence holds an earlier-kickoff statement nobody
 * acknowledged, this closes betting on the event: in one transaction under the event's row lock,
 * which re-reads the event, the statements and the person record, it sets `events.betting_open` to
 * false (`setEventBettingOpen`, no actor) and writes an audit row and a critical `kickoff_change`
 * item (subject `<feedRef>|earlier`). Nothing else is written: no market, selection, price, start
 * time, status or bet. The live delta is published after the COMMIT.
 *
 * This code cannot open betting, move an event, result it or void anything: the only decision is
 * `earlierKickoffAction` ('none' | 'close') and the only write is `betting_open = false`.
 * Idempotent (K6): it acts only on events whose betting is open, so a second pass with the same data
 * changes nothing. An error on one event (an invalid date raises RangeError in the rules) is logged
 * and the pass goes on with the next one.
 */
export async function closeBettingOnEarlierKickoff(
  ctx: ScraperContext,
): Promise<KickoffSafetySummary> {
  const now = ctx.clock();
  const summary: KickoffSafetySummary = { checked: 0, closed: 0, failed: 0, published: 0 };

  const open = await ctx.db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(eventsTable.status, 'scheduled'),
        eq(eventsTable.bettingOpen, true),
        isNull(eventsTable.resultedAt),
        gt(eventsTable.startTime, now),
      ),
    )
    .orderBy(asc(eventsTable.startTime), asc(eventsTable.id));

  for (let from = 0; from < open.length; from += CHUNK) {
    const ids = open.slice(from, from + CHUNK).map((row) => row.id);
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
        // A first look without the lock: most events have nothing to close.
        if (!shouldClose(found, now)) continue;
        const messages = await closeOne(ctx, eventId, now);
        if (messages === null) continue;
        summary.closed += 1;
        summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
      } catch (error) {
        summary.failed += 1;
        ctx.logger.error({ err: error, eventId }, 'closing betting on an earlier kickoff failed');
      }
    }
  }

  ctx.logger[summary.closed + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'kickoff safety run',
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

function shouldClose(evidence: KickoffEvidence, now: Date): boolean {
  return (
    evidence.event.feedProvider === SCRAPED_FEED_PROVIDER &&
    earlierKickoffAction(asEvent(evidence), assess(evidence, now), now) === 'close'
  );
}

/** The date as the item title shows it: `2026-11-02 15:00 UTC`. */
const clock = (date: Date): string => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * K1 for one event, in one transaction. Returns the live deltas, or null when under the lock the
 * condition no longer holds (a trader closed betting, acknowledged the report, moved the event ...).
 */
async function closeOne(
  ctx: ScraperContext,
  eventId: string,
  now: Date,
): Promise<LiveMessage[] | null> {
  return ctx.db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    // Re-read under the lock: event, statements and the person record.
    const evidence = (
      await loadKickoffEvidence(tx, { eventIds: [eventId], ...loaderOptions(now) })
    ).get(eventId);
    if (evidence === undefined || evidence.event.feedProvider !== SCRAPED_FEED_PROVIDER)
      return null;
    const assessment = assess(evidence, now);
    if (earlierKickoffAction(asEvent(evidence), assessment, now) !== 'close') return null;
    const feedRef = evidence.event.feedRef;
    if (feedRef === null) throw new Error(`scraped event ${eventId} has no feed_ref`);

    // The only change to the event: betting_open true to false (K1).
    const change = await setEventBettingOpen(tx, eventId, false);
    if (!change.changed) return null;

    const start = evidence.event.startTime;
    const earlier = assessment.earlier;
    const first = earlier.reduce((a, b) => (b.kickoff.getTime() < a.kickoff.getTime() ? b : a));
    const exposure = await getEventExposure(tx, eventId);
    const [anyBet] = await tx
      .select({ id: betLegs.id })
      .from(betLegs)
      .where(eq(betLegs.eventId, eventId))
      .limit(1);
    const names = await teamNames(tx, [evidence.event.homeTeamId, evidence.event.awayTeamId]);
    const home = names.get(evidence.event.homeTeamId) ?? evidence.event.homeTeamId;
    const away = names.get(evidence.event.awayTeamId) ?? evidence.event.awayTeamId;
    const statementView = (s: KickoffStatement) => ({
      sourceId: s.sourceId,
      upstream: s.upstream,
      kind: s.kind,
      status: s.status,
      kickoff: s.kickoff.toISOString(),
      changedAt: s.changedAt.toISOString(),
      sourceFresh: s.sourceFresh,
    });

    await auditScraper(tx, {
      action: 'scrape.fixture.betting_closed',
      targetType: 'event',
      targetId: eventId,
      metadata: {
        feedRef,
        rule: 'K1',
        start: start.toISOString(),
        earlier: earlier.map((s) => ({
          sourceId: s.sourceId,
          upstream: s.upstream,
          kickoff: s.kickoff.toISOString(),
          changedAt: s.changedAt.toISOString(),
        })),
        evidenceKey: assessment.evidenceKey,
      },
    });
    const review: GateReview = {
      kind: 'kickoff_change',
      subjectKey: `${feedRef}${EARLIER_SUBJECT_SUFFIX}`,
      severity: 'critical',
      title:
        `Betting closed: ${home} v ${away} may start earlier: ${first.sourceId} says ` +
        `${clock(first.kickoff)} (ours ${clock(start)})`,
      payload: {
        // The contract of `kickoff_change` (apply_kickoff and the review page read these) ...
        eventId,
        currentKickoff: start.toISOString(),
        proposedKickoff: first.kickoff.toISOString(),
        sources: earlier
          .map((s) => ({
            sourceId: s.sourceId,
            upstream: s.upstream,
            changedAt: s.changedAt.toISOString(),
          }))
          .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
        hasBets: anyBet !== undefined,
        // ... and this item's own.
        feedRef,
        rules: ['K1'],
        reasons: ['earlier_kickoff'],
        rule: 'K1',
        reason: 'earlier_kickoff',
        bettingClosedAt: now.toISOString(),
        statements: evidence.statements.map(statementView),
        evidenceKey: assessment.evidenceKey,
        exposure: { openBets: exposure.openBets, totalStake: exposure.totalStake },
      },
    };
    await openGateReviews(tx, [review], now);
    return [...change.messages];
  });
}
