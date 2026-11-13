import {
  listCompetitionPolicies,
  listLadderShadow,
  reviewQueueSummary,
  type Database,
  type LadderShadowEntry,
} from '@vamos/db';
import { teams } from '@vamos/db/schema';
import { inArray } from 'drizzle-orm';
import { collectResultsAudit } from '../eval/audit-data';
import { shadowLabel, shadowOutcome, summariseShadow } from '../eval/ladder-shadow';
import {
  ASSUMED_MATCH_MINUTES,
  isMismatch,
  summariseAudit,
  TARGET_MEDIAN_MINUTES,
  TARGET_P90_MINUTES,
  type AuditedEvent,
  type AuditScore,
  type AuditSummary,
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

  const rows = await collectResultsAudit(db, { from, to });
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

const DEFAULT_SHADOW_DAYS = 28;

/**
 * `review ladder-shadow [--since YYYY-MM-DD] [--json]` (plan task 1.6): every decision the result
 * ladder (rungs B to D) would have made for an event the result gate did not settle, first made
 * since the date (default 28 days ago), next to what happened to the event. An 'apply' decision is
 * compared with the applied score (match, mismatch, not resulted yet); a 'void' decision with
 * whether the event was later played (it got a final result) or ended void. A summary per rung and
 * reason follows: decisions, agreed, disagreed, pending. This is the evidence for the owner's
 * decisions D7 and D11. Nothing is applied or voided from the ladder. Read-only.
 */
export async function reviewLadderShadow(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { since: { type: 'string' } });
  noPositionals(parsed);
  const now = env.clock();
  const sinceText = optionalString(parsed, 'since');
  let since = new Date(now.getTime() - DEFAULT_SHADOW_DAYS * DAY_MS);
  if (sinceText !== undefined) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(sinceText) ? new Date(`${sinceText}T00:00:00Z`) : null;
    if (
      date === null ||
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== sinceText
    ) {
      throw new UsageError('--since must be a date as YYYY-MM-DD');
    }
    since = date;
  }
  const db: Database = await env.database();
  const entries = await listLadderShadow(db, { since });

  const slugs = new Map(
    (await listCompetitionPolicies(db, { sportId: 'football' })).map((p) => [
      p.competitionId,
      p.slug,
    ]),
  );
  const teamIds = [...new Set(entries.flatMap((e) => [e.event.homeTeamId, e.event.awayTeamId]))];
  const teamRows =
    teamIds.length === 0
      ? []
      : await db
          .select({ id: teams.id, name: teams.name, shortName: teams.shortName })
          .from(teams)
          .where(inArray(teams.id, teamIds));
  const teamName = new Map(teamRows.map((t) => [t.id, t.name.en || t.shortName]));

  const decisions = entries.map((e) => ({
    entry: e,
    label: shadowLabel(e),
    outcome: shadowOutcome(e),
    match: `${teamName.get(e.event.homeTeamId) ?? e.event.homeTeamId} v ${teamName.get(e.event.awayTeamId) ?? e.event.awayTeamId}`,
    competition: slugs.get(e.event.competitionId) ?? e.event.competitionId,
  }));

  const summary = summariseShadow(decisions);

  const decidedScore = (e: LadderShadowEntry): string =>
    e.score === null ? '-' : scoreText(e.score);
  const json = {
    since: since.toISOString(),
    decisions: decisions.map((d) => ({
      eventId: d.entry.eventId,
      gameId: d.entry.event.gameId,
      competition: d.competition,
      match: d.match,
      kickoff: d.entry.event.startTime.toISOString(),
      rung: d.entry.rung,
      action: d.entry.action,
      reason: d.entry.reason,
      strict: d.entry.strict,
      score: d.entry.score,
      upstreams: d.entry.upstreams,
      dissent: d.entry.dissent,
      firstDecidedAt: d.entry.firstDecidedAt.toISOString(),
      lastDecidedAt: d.entry.lastDecidedAt.toISOString(),
      eventStatus: d.entry.event.status,
      appliedScore: d.entry.event.score,
      outcome: d.outcome,
    })),
    summary,
  };
  const lines = [
    `Result ladder in shadow: decisions first made since ${since.toISOString().slice(0, 10)}. Nothing here was applied or voided.`,
    "apply: match / mismatch with the applied score, or pending (not resulted yet); void: 'played' (the event got a final result), 'void' (cancelled, abandoned or postponed) or pending.",
    '',
    ...(decisions.length === 0
      ? ['no shadow decisions']
      : table(
          [
            'game',
            'match',
            'kickoff',
            'decision',
            'would',
            'upstreams',
            'decided',
            'now',
            'outcome',
          ],
          decisions.map((d) => [
            String(d.entry.event.gameId),
            d.match,
            d.entry.event.startTime.toISOString(),
            d.label,
            decidedScore(d.entry),
            [...d.entry.upstreams, ...d.entry.dissent.map((u) => `!${u}`)].join(',') || '-',
            d.entry.firstDecidedAt.toISOString(),
            d.entry.event.status === 'finished' && d.entry.event.score !== null
              ? scoreText(d.entry.event.score)
              : d.entry.event.status,
            d.outcome,
          ]),
        )),
    '',
    ...table(
      ['rung and reason', 'decisions', 'agreed', 'disagreed', 'pending'],
      summary.map((g) => [
        g.label,
        String(g.decisions),
        String(g.agreed),
        String(g.disagreed),
        String(g.pending),
      ]),
    ),
  ];
  emit(env, parsed, json, lines);
  return EXIT_OK;
}
