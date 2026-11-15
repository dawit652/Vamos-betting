import {
  listCompetitionPolicies,
  listCurrentObservations,
  listScrapedEvents,
  type Database,
} from '@vamos/db';
import { teams } from '@vamos/db/schema';
import { inArray } from 'drizzle-orm';
import {
  compareSource,
  latencyMinutes,
  latestPerSource,
  type AuditScore,
  type AuditedEvent,
  type SourceComparison,
  type SourceResult,
} from './result-audit';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A source row belongs to an event when its kickoff is within 12 hours of the event's. */
const AUDIT_KICKOFF_WINDOW_MS = 12 * HOUR_MS;
/** Events that kicked off up to this long before they were resulted are still found. */
const AUDIT_LOOK_BACK_MS = 14 * DAY_MS;
const OBSERVATION_LIMIT = 20_000;

/** One applied result with what each source says now. */
export interface AuditRow extends AuditedEvent {
  eventId: string;
  gameId: number;
  home: string;
  away: string;
  kickoff: Date;
  appliedAt: Date;
  applied: AuditScore;
}

/**
 * Every scraped event whose result was applied from `from` to `to` (inclusive, by `resultedAt`),
 * with the applied score against the latest result observation of every source. Shared by
 * `review results-audit` and the weekly report. Read-only.
 */
export async function collectResultsAudit(
  db: Database,
  window: { from: Date; to: Date },
): Promise<AuditRow[]> {
  const { from, to } = window;
  const candidates = await listScrapedEvents(db, {
    from: new Date(from.getTime() - AUDIT_LOOK_BACK_MS),
    to,
    includeFinished: true,
  });
  const applied = candidates.filter(
    (e) =>
      e.status === 'finished' &&
      e.score !== null &&
      e.resultedAt !== null &&
      e.resultedAt >= from &&
      e.resultedAt <= to,
  );

  const slugs = new Map(
    (await listCompetitionPolicies(db, { sportId: 'football' })).map((p) => [
      p.competitionId,
      p.slug,
    ]),
  );
  const teamIds = [...new Set(applied.flatMap((e) => [e.homeTeamId, e.awayTeamId]))];
  const teamRows =
    teamIds.length === 0
      ? []
      : await db
          .select({ id: teams.id, name: teams.name, shortName: teams.shortName })
          .from(teams)
          .where(inArray(teams.id, teamIds));
  const teamName = new Map(teamRows.map((t) => [t.id, t.name.en || t.shortName]));

  const observations =
    applied.length === 0
      ? []
      : await listCurrentObservations(db, {
          kind: 'result',
          resolvedOnly: true,
          kickoffFrom: new Date(
            Math.min(...applied.map((e) => e.startTime.getTime())) - AUDIT_KICKOFF_WINDOW_MS,
          ),
          kickoffTo: new Date(
            Math.max(...applied.map((e) => e.startTime.getTime())) + AUDIT_KICKOFF_WINDOW_MS,
          ),
          limit: OBSERVATION_LIMIT,
        });

  return applied.map((event) => {
    const score = event.score as AuditScore;
    const sources: SourceResult[] = observations
      .filter(
        (o) =>
          o.competitionId === event.competitionId &&
          o.homeTeamId === event.homeTeamId &&
          o.awayTeamId === event.awayTeamId &&
          Math.abs(o.kickoff.getTime() - event.startTime.getTime()) <= AUDIT_KICKOFF_WINDOW_MS,
      )
      .map((o) => ({
        sourceId: o.sourceId,
        upstream: o.upstream,
        status: o.status,
        scoreBasis: o.scoreBasis,
        score: o.score,
        changedAt: o.changedAt,
      }));
    const comparisons: SourceComparison[] = latestPerSource(sources).map((s) =>
      compareSource(score, s),
    );
    return {
      eventId: event.eventId,
      gameId: event.gameId,
      competition: slugs.get(event.competitionId) ?? event.competitionId,
      home: teamName.get(event.homeTeamId) ?? event.homeTeamId,
      away: teamName.get(event.awayTeamId) ?? event.awayTeamId,
      kickoff: event.startTime,
      appliedAt: event.resultedAt as Date,
      applied: score,
      latencyMinutes: latencyMinutes(event.startTime, event.resultedAt as Date),
      comparisons,
    };
  });
}
