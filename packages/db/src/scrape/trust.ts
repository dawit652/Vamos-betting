import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { and, asc, eq, gte, max, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { events } from '../schema/catalog';
import {
  scrapeLadderShadow,
  scrapeObservations,
  scrapeSources,
  scrapeSourceTrust,
} from '../schema/scrape';

/**
 * Measured trust and the result ladder in shadow (docs/plans/hulusport-parity-plan.md 4.4, tasks
 * 1.2, 1.3 and 1.6). Nothing here changes an event: trust is read by the ladder, and the shadow
 * table only records what the ladder WOULD have done. Structural types only: this package does
 * not import @vamos/scraper.
 */

const HOUR_MS = 3_600_000;

/** A shadow row is only touched again when its last decision is more than this old. */
export const LADDER_SHADOW_REFRESH_MS = HOUR_MS;

/** A source's observation belongs to an event when its kickoff is within 12 hours of the event's. */
export const TRUTH_KICKOFF_WINDOW_MS = 12 * HOUR_MS;

// ---------------------------------------------------------------------------
// Source trust

/** One row of `scrape_source_trust`: what the truth-check measured for an upstream and sport. */
export interface SourceTrustRow {
  /** As `upstreamKey` writes it: trimmed and lower-cased. */
  upstream: string;
  sport: string;
  compared: number;
  agreed: number;
  /** Kickoffs of the first and last compared match; null when nothing was compared. */
  windowFrom: Date | null;
  windowTo: Date | null;
  /** A few recent examples of disagreement (plain JSON). */
  disagreements: readonly unknown[];
  measuredAt: Date;
}

/** Stores the measurement of one upstream and sport, replacing the previous one. */
export async function upsertSourceTrust(exec: DbExecutor, row: SourceTrustRow): Promise<void> {
  if (row.upstream !== row.upstream.trim().toLowerCase() || row.upstream === '') {
    throw new RangeError('upstream must be trimmed, lower-case and not empty (upstreamKey)');
  }
  if (
    !Number.isSafeInteger(row.compared) ||
    !Number.isSafeInteger(row.agreed) ||
    row.agreed < 0 ||
    row.agreed > row.compared
  ) {
    throw new RangeError('agreed must be a whole number from 0 to compared');
  }
  const values = {
    upstream: row.upstream,
    sport: row.sport,
    compared: row.compared,
    agreed: row.agreed,
    windowFrom: row.windowFrom,
    windowTo: row.windowTo,
    disagreements: row.disagreements,
    measuredAt: row.measuredAt,
  };
  await exec
    .insert(scrapeSourceTrust)
    .values(values)
    .onConflictDoUpdate({
      target: [scrapeSourceTrust.upstream, scrapeSourceTrust.sport],
      set: {
        compared: values.compared,
        agreed: values.agreed,
        windowFrom: values.windowFrom,
        windowTo: values.windowTo,
        disagreements: values.disagreements,
        measuredAt: values.measuredAt,
      },
    });
}

/** The measured trust per upstream (by `upstreamKey`) for a sport: what the ladder reads. */
export async function listSourceTrust(
  exec: DbExecutor,
  sport: string,
): Promise<Map<string, { compared: number; agreed: number }>> {
  const rows = await exec
    .select({
      upstream: scrapeSourceTrust.upstream,
      compared: scrapeSourceTrust.compared,
      agreed: scrapeSourceTrust.agreed,
    })
    .from(scrapeSourceTrust)
    .where(eq(scrapeSourceTrust.sport, sport));
  return new Map(rows.map((r) => [r.upstream, { compared: r.compared, agreed: r.agreed }]));
}

/** When trust was last measured for a sport (the newest row); null when never. */
export async function newestSourceTrustMeasuredAt(
  exec: DbExecutor,
  sport: string,
): Promise<Date | null> {
  const [row] = await exec
    .select({ at: max(scrapeSourceTrust.measuredAt) })
    .from(scrapeSourceTrust)
    .where(eq(scrapeSourceTrust.sport, sport));
  return row?.at ?? null;
}

/** A score as events and observations carry it. */
export interface TruthScore {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}

/** One finished regular-time result observation of an event's match, with the source behind it. */
export interface TruthObservation {
  sourceId: string;
  /** scrape_sources.upstream as stored (the caller normalises it). */
  upstream: string;
  score: TruthScore;
  changedAt: Date;
}

/** An event with an applied final result and what sources currently say about it. */
export interface TruthCheckEvent {
  eventId: string;
  startTime: Date;
  applied: TruthScore;
  resultedAt: Date;
  /**
   * The upstreams of the latest `scrape.result.applied` audit row of the event (the votes the
   * result was applied on), as stored. Null: no such audit row (a result entered by hand, or
   * applied before the audit recorded it).
   */
  appliedOn: readonly string[] | null;
  observations: TruthObservation[];
}

export interface ListTruthCheckEventsQuery {
  sport: string;
  /** Events that kicked off at or after this. */
  since: Date;
}

interface TruthRow {
  eventId: string;
  startTime: Date;
  scoreHome: number | null;
  scoreAway: number | null;
  htScoreHome: number | null;
  htScoreAway: number | null;
  resultedAt: Date | null;
  appliedOn: unknown;
  sourceId: string;
  upstream: string;
  obsScore: TruthScore | null;
  changedAt: Date;
}

/**
 * Scraped events with an applied final result (status finished, score set, resulted) that kicked off
 * since `since`, each with the finished regular-time result observations of its match (same
 * competition and teams, kickoff within 12 hours) of every source, enabled or not: a source that
 * was switched off still said what it said. Events without such an observation are left out. By
 * kickoff, then id.
 */
export async function listTruthCheckEvents(
  exec: DbExecutor,
  query: ListTruthCheckEventsQuery,
): Promise<TruthCheckEvent[]> {
  const rows: TruthRow[] = await exec
    .select({
      eventId: events.id,
      startTime: events.startTime,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
      resultedAt: events.resultedAt,
      appliedOn: sql<unknown>`(
        SELECT a.metadata -> 'upstreams' FROM audit_log a
        WHERE a.action = 'scrape.result.applied' AND a.target_type = 'event'
          AND a.target_id = ${events.id}::text
        ORDER BY a.id DESC LIMIT 1)`,
      sourceId: scrapeObservations.sourceId,
      upstream: scrapeSources.upstream,
      obsScore: scrapeObservations.score,
      changedAt: scrapeObservations.changedAt,
    })
    .from(events)
    .innerJoin(
      scrapeObservations,
      and(
        eq(scrapeObservations.competitionId, events.competitionId),
        eq(scrapeObservations.homeTeamId, events.homeTeamId),
        eq(scrapeObservations.awayTeamId, events.awayTeamId),
        sql`abs(extract(epoch FROM (${scrapeObservations.kickoff} - ${events.startTime}))) * 1000 <= ${TRUTH_KICKOFF_WINDOW_MS}`,
      ),
    )
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeObservations.sourceId))
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.sportId, query.sport),
        eq(events.status, 'finished'),
        sql`${events.scoreHome} IS NOT NULL AND ${events.scoreAway} IS NOT NULL AND ${events.resultedAt} IS NOT NULL`,
        gte(events.startTime, query.since),
        eq(scrapeObservations.kind, 'result'),
        eq(scrapeObservations.status, 'finished'),
        eq(scrapeObservations.scoreBasis, 'regular_time'),
        sql`${scrapeObservations.score} IS NOT NULL`,
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id), asc(scrapeObservations.sourceId));

  const byEvent = new Map<string, TruthCheckEvent>();
  for (const row of rows) {
    if (
      row.scoreHome === null ||
      row.scoreAway === null ||
      row.resultedAt === null ||
      row.obsScore === null
    ) {
      continue;
    }
    let event = byEvent.get(row.eventId);
    if (event === undefined) {
      event = {
        eventId: row.eventId,
        startTime: row.startTime,
        applied: {
          home: row.scoreHome,
          away: row.scoreAway,
          htHome: row.htScoreHome,
          htAway: row.htScoreAway,
        },
        resultedAt: row.resultedAt,
        appliedOn: Array.isArray(row.appliedOn)
          ? row.appliedOn.filter((u): u is string => typeof u === 'string')
          : null,
        observations: [],
      };
      byEvent.set(row.eventId, event);
    }
    event.observations.push({
      sourceId: row.sourceId,
      upstream: row.upstream,
      score: {
        home: row.obsScore.home,
        away: row.obsScore.away,
        htHome: row.obsScore.htHome ?? null,
        htAway: row.obsScore.htAway ?? null,
      },
      changedAt: row.changedAt,
    });
  }
  return [...byEvent.values()];
}

// ---------------------------------------------------------------------------
// The result ladder in shadow

/** A score the ladder would apply. */
export interface LadderShadowScore {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}

/**
 * What `decideLadder` returned (structurally the `LadderDecision` of @vamos/scraper). Only 'apply'
 * and 'void' are recorded; the other actions are ignored.
 */
export type LadderShadowDecision =
  | {
      action: 'apply';
      rung: 'B' | 'C';
      score: LadderShadowScore;
      upstreams: readonly string[];
      dissent: readonly string[];
    }
  | {
      action: 'void';
      rung: 'D';
      reason: string;
      strict: boolean;
      notPlayed: readonly string[];
    }
  | { action: 'wait' | 'none' };

/** The key that tells one decision of an event from another (see `scrape_ladder_shadow`). */
export function ladderShadowKey(decision: LadderShadowDecision): string | null {
  if (decision.action !== 'apply' && decision.action !== 'void') return null;
  const reason = decision.action === 'void' ? decision.reason : '';
  const score =
    decision.action === 'apply'
      ? `${decision.score.home}-${decision.score.away}/${decision.score.htHome ?? ''}-${decision.score.htAway ?? ''}`
      : '';
  return `${decision.action}:${decision.rung}:${reason}:${score}`;
}

/**
 * Records what the ladder would have done for an event ('apply' or 'void'; anything else is
 * ignored). One row per (event, decision): the first sighting inserts it; seeing the same decision
 * again only moves `last_decided_at`, and only when the stored one is more than an hour older, so a
 * pass every minute does not rewrite the row. Returns true when a row was written.
 */
export async function recordLadderShadow(
  exec: DbExecutor,
  input: { eventId: string; decision: LadderShadowDecision; now: Date },
): Promise<boolean> {
  const { decision, now, eventId } = input;
  const decisionKey = ladderShadowKey(decision);
  if (decisionKey === null) return false;
  const row =
    decision.action === 'apply'
      ? {
          rung: decision.rung,
          action: 'apply',
          reason: null,
          score: decision.score,
          strict: null,
          upstreams: [...decision.upstreams],
          dissent: [...decision.dissent],
        }
      : decision.action === 'void'
        ? {
            rung: decision.rung,
            action: 'void',
            reason: decision.reason,
            score: null,
            strict: decision.strict,
            upstreams: [...decision.notPlayed],
            dissent: [],
          }
        : null;
  if (row === null) return false;
  const written = await exec
    .insert(scrapeLadderShadow)
    .values({ eventId, decisionKey, ...row, firstDecidedAt: now, lastDecidedAt: now })
    .onConflictDoUpdate({
      target: [scrapeLadderShadow.eventId, scrapeLadderShadow.decisionKey],
      set: { lastDecidedAt: sql`excluded.last_decided_at` },
      setWhere: sql`${scrapeLadderShadow.lastDecidedAt} < excluded.last_decided_at - (${LADDER_SHADOW_REFRESH_MS} * interval '1 millisecond')`,
    })
    .returning({ eventId: scrapeLadderShadow.eventId });
  return written.length > 0;
}

/** A shadow decision with the event it was about, as the event is now. */
export interface LadderShadowEntry {
  eventId: string;
  decisionKey: string;
  rung: 'B' | 'C' | 'D';
  action: 'apply' | 'void';
  reason: string | null;
  score: LadderShadowScore | null;
  strict: boolean | null;
  upstreams: string[];
  dissent: string[];
  firstDecidedAt: Date;
  lastDecidedAt: Date;
  event: {
    gameId: number;
    competitionId: string;
    homeTeamId: string;
    awayTeamId: string;
    startTime: Date;
    status: string;
    resultedAt: Date | null;
    /** The score the event was resulted with; null until resulted (or resulted without one). */
    score: LadderShadowScore | null;
  };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Shadow decisions first made at or after `since`, oldest first, with the event's current state. */
export async function listLadderShadow(
  exec: DbExecutor,
  query: { since: Date },
): Promise<LadderShadowEntry[]> {
  const rows = await exec
    .select({
      eventId: scrapeLadderShadow.eventId,
      decisionKey: scrapeLadderShadow.decisionKey,
      rung: scrapeLadderShadow.rung,
      action: scrapeLadderShadow.action,
      reason: scrapeLadderShadow.reason,
      score: scrapeLadderShadow.score,
      strict: scrapeLadderShadow.strict,
      upstreams: scrapeLadderShadow.upstreams,
      dissent: scrapeLadderShadow.dissent,
      firstDecidedAt: scrapeLadderShadow.firstDecidedAt,
      lastDecidedAt: scrapeLadderShadow.lastDecidedAt,
      gameId: events.gameId,
      competitionId: events.competitionId,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
      startTime: events.startTime,
      status: events.status,
      resultedAt: events.resultedAt,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
    })
    .from(scrapeLadderShadow)
    .innerJoin(events, eq(events.id, scrapeLadderShadow.eventId))
    .where(gte(scrapeLadderShadow.firstDecidedAt, query.since))
    .orderBy(
      asc(scrapeLadderShadow.firstDecidedAt),
      asc(scrapeLadderShadow.eventId),
      asc(scrapeLadderShadow.decisionKey),
    );
  return rows.map((row) => ({
    eventId: row.eventId,
    decisionKey: row.decisionKey,
    rung: row.rung as 'B' | 'C' | 'D',
    action: row.action as 'apply' | 'void',
    reason: row.reason,
    score: asScore(row.score),
    strict: row.strict,
    upstreams: stringList(row.upstreams),
    dissent: stringList(row.dissent),
    firstDecidedAt: row.firstDecidedAt,
    lastDecidedAt: row.lastDecidedAt,
    event: {
      gameId: row.gameId,
      competitionId: row.competitionId,
      homeTeamId: row.homeTeamId,
      awayTeamId: row.awayTeamId,
      startTime: row.startTime,
      status: row.status,
      resultedAt: row.resultedAt,
      score:
        row.scoreHome === null || row.scoreAway === null
          ? null
          : {
              home: row.scoreHome,
              away: row.scoreAway,
              htHome: row.htScoreHome,
              htAway: row.htScoreAway,
            },
    },
  }));
}

function asScore(value: unknown): LadderShadowScore | null {
  if (typeof value !== 'object' || value === null) return null;
  const { home, away, htHome, htAway } = value as Record<string, unknown>;
  if (typeof home !== 'number' || typeof away !== 'number') return null;
  return {
    home,
    away,
    htHome: typeof htHome === 'number' ? htHome : null,
    htAway: typeof htAway === 'number' ? htAway : null,
  };
}
