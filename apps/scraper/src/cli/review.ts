import {
  listCompetitionPolicies,
  listCurrentObservations,
  listScrapedEvents,
  reviewQueueSummary,
  type Database,
} from '@vamos/db';
import { teams } from '@vamos/db/schema';
import { inArray } from 'drizzle-orm';
import {
  ASSUMED_MATCH_MINUTES,
  compareSource,
  isMismatch,
  latencyMinutes,
  latestPerSource,
  summariseAudit,
  TARGET_MEDIAN_MINUTES,
  TARGET_P90_MINUTES,
  type AuditedEvent,
  type AuditScore,
  type AuditSummary,
  type SourceComparison,
  type SourceResult,
} from '../eval/result-audit';
import {
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  table,
  UsageError,
  type CliEnv,
} from './io';

/**
 * `review counts [--json]`: the OPEN review-queue items per kind (every kind,
 * zeros included) with the creation time of the oldest open item, and the
 * total, so the queue can be seen at a glance.
 */
export async function reviewCounts(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db: Database = await env.database();
  const kinds = await reviewQueueSummary(db, 'open');
  const total = kinds.reduce((sum, k) => sum + k.count, 0);
  emit(
    env,
    parsed,
    {
      kinds: kinds.map((k) => ({
        kind: k.kind,
        count: k.count,
        oldestCreatedAt: k.oldestCreatedAt?.toISOString() ?? null,
      })),
      total,
    },
    [
      ...table(
        ['kind', 'open', 'oldest open'],
        kinds.map((k) => [k.kind, String(k.count), k.oldestCreatedAt?.toISOString() ?? '-']),
      ),
      `${total} open review item(s)`,
    ],
  );
  return EXIT_OK;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A result is audited once it has been applied this long. */
const AUDIT_AFTER_MS = 48 * HOUR_MS;
const DEFAULT_AUDIT_DAYS = 7;
const MAX_AUDIT_DAYS = 90;
/** A source row belongs to an event when its kickoff is within 12 hours of the event's. */
const AUDIT_KICKOFF_WINDOW_MS = 12 * HOUR_MS;
/** Events that kicked off up to this long before they were resulted are still found. */
const AUDIT_LOOK_BACK_MS = 14 * DAY_MS;
const OBSERVATION_LIMIT = 20_000;

const scoreText = (s: AuditScore | null): string =>
  s === null
    ? '-'
    : `${s.home}-${s.away}${s.htHome === null || s.htAway === null ? '' : ` (HT ${s.htHome}-${s.htAway})`}`;
const minutesText = (m: number | null): string => (m === null ? '-' : m.toFixed(1));

/**
 * `review results-audit [--days N] [--json]` (S-6 of docs/feed-quality-plan.md): every scraped
 * event whose result was applied in the last N days (default 7, 1 to 90) and at least 48 hours ago,
 * with the applied score (and half-time score) against the latest result observation of every
 * enabled source (football-data.org is one of them: its upstream is shown). A source whose
 * full-time or half-time score differs is flagged. Latency is applied time minus the assumed final
 * whistle (kickoff + 105 minutes); per competition the count, the mismatches and the median and
 * 90th percentile of the latency against the plan's targets (median 20 min, p90 30 min). Read-only.
 */
export async function reviewResultsAudit(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { days: { type: 'string' } });
  noPositionals(parsed);
  const daysText = optionalString(parsed, 'days');
  const days = daysText === undefined ? DEFAULT_AUDIT_DAYS : Number(daysText);
  if (daysText !== undefined && (!/^\d+$/.test(daysText) || days < 1 || days > MAX_AUDIT_DAYS)) {
    throw new UsageError(`--days must be a whole number from 1 to ${MAX_AUDIT_DAYS}`);
  }
  const now = env.clock();
  const from = new Date(now.getTime() - days * DAY_MS);
  const to = new Date(now.getTime() - AUDIT_AFTER_MS);
  const db: Database = await env.database();

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

  const rows = applied.map((event) => {
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
  const audited: AuditedEvent[] = rows;
  const { overall, byCompetition } = summariseAudit(audited);
  const mismatched = rows.filter((r) => r.comparisons.some((c) => isMismatch(c.verdict)));

  const json = {
    from: from.toISOString(),
    to: to.toISOString(),
    assumedMatchMinutes: ASSUMED_MATCH_MINUTES,
    targets: { medianMinutes: TARGET_MEDIAN_MINUTES, p90Minutes: TARGET_P90_MINUTES },
    overall,
    byCompetition,
    events: rows.map((r) => ({
      eventId: r.eventId,
      gameId: r.gameId,
      competition: r.competition,
      home: r.home,
      away: r.away,
      kickoff: r.kickoff.toISOString(),
      appliedAt: r.appliedAt.toISOString(),
      applied: r.applied,
      latencyMinutes: r.latencyMinutes,
      sources: r.comparisons.map((c) => ({
        sourceId: c.sourceId,
        upstream: c.upstream,
        verdict: c.verdict,
        score: c.score,
        changedAt: c.changedAt.toISOString(),
      })),
    })),
  };

  const summaryRow = (s: AuditSummary): string[] => [
    s.competition,
    String(s.count),
    String(s.mismatches),
    minutesText(s.medianLatencyMinutes),
    minutesText(s.p90LatencyMinutes),
    s.meetsTargets === null ? '-' : s.meetsTargets ? 'yes' : 'NO',
  ];
  const lines = [
    `Result audit: results applied ${from.toISOString()} to ${to.toISOString()} (at least 48 h ago)`,
    `Latency = applied time minus the assumed final whistle (kickoff + ${ASSUMED_MATCH_MINUTES} min), in minutes; targets: median <= ${TARGET_MEDIAN_MINUTES}, p90 <= ${TARGET_P90_MINUTES}.`,
    'Sources compared: the latest result observation of each enabled source; extra-time scores and unfinished rows are not compared.',
    '',
    ...table(
      ['competition', 'results', 'mismatches', 'median min', 'p90 min', 'meets targets'],
      [...byCompetition, overall].map(summaryRow),
    ),
    '',
    mismatched.length === 0
      ? 'No mismatches.'
      : `${mismatched.length} result(s) with a source that disagrees:`,
    ...mismatched.flatMap((r) => [
      `${r.competition}: ${r.home} v ${r.away}, kickoff ${r.kickoff.toISOString()}, applied ${scoreText(r.applied)} at ${r.appliedAt.toISOString()} (game ${r.gameId})`,
      ...table(
        ['  source', 'upstream', 'verdict', 'score', 'since'],
        r.comparisons.map((c) => [
          `  ${c.sourceId}`,
          c.upstream,
          c.verdict,
          scoreText(c.score),
          c.changedAt.toISOString(),
        ]),
      ),
    ]),
  ];
  emit(env, parsed, json, lines);
  return EXIT_OK;
}
