import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  listCompetitionPolicies,
  listReviewItems,
  listSources,
  sourceHealth,
  type Database,
} from '@vamos/db';
import { competitions, events, teams } from '@vamos/db/schema';
import { autoOpenCheck, type AutoOpenCheck } from '../pipeline/auto-open';
import {
  EXIT_OK,
  UsageError,
  emit,
  noPositionals,
  parseCommandArgs,
  table,
  type CliEnv,
} from './io';

const HOUR_MS = 3_600_000;
const PAGE = 200;

const iso = (date: Date | null): string => (date === null ? '-' : date.toISOString());
const kickoffText = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ');

function ago(from: Date | null, now: Date): string {
  if (from === null) return 'never';
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 2880) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}

function parseDays(value: string | boolean | undefined): number {
  if (value === undefined) return 7;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    throw new UsageError('--days must be a whole number from 1 to 30');
  }
  return n;
}

const KICKOFF_REASONS: Record<string, (start: Date) => string> = {
  too_early_for_single_source: (start) =>
    `one source confirms only from 72 h before kickoff (opens from ${kickoffText(
      new Date(start.getTime() - 72 * HOUR_MS),
    )})`,
  not_stable: () => 'a source changed the kickoff less than 24 h ago',
  sources_disagree: () => 'the sources disagree about the kickoff',
  earlier_kickoff_reported: () => 'a source says the match starts earlier',
  source_not_fresh: () => 'no fresh source lists it',
  no_statement: () => 'no source lists it',
  void_status_reported: () => 'a source says postponed or cancelled',
  result_reported: () => 'a source already reports a result',
};

/** One plain line for a blocker. `teamNames` maps team ids to names. */
function blockerLine(
  blocker: string,
  check: AutoOpenCheck,
  start: Date,
  teamNames: Map<string, string>,
): string {
  switch (blocker) {
    case 'policy_off':
      return 'auto open is off for this competition (or the competition is switched off)';
    case 'not_waiting':
      return 'its odds approval item was resolved or dismissed: open betting by hand in Trading';
    case 'person_decided':
      return `a person opened or closed betting by hand (last: ${check.latestChange ?? '-'})`;
    case 'kickoff_question':
      return 'a kickoff change item is open: the sources disagree about the kickoff';
    case 'price_proposal':
      return 'a price change proposal waits for a person (Feed review)';
    case 'kickoff_unconfirmed': {
      if (check.assessment === null) return 'kickoff not confirmed: kickoff evidence missing';
      const reasons = check.assessment.reasons.map((r) => KICKOFF_REASONS[r]?.(start) ?? r);
      return `kickoff not confirmed: ${reasons.join('; ')}`;
    }
    case 'teams_uncalibrated':
      return `team ratings not reviewed: ${check.uncalibrated
        .map((id) => teamNames.get(id) ?? id)
        .join(', ')}`;
    case 'prices_failed':
      return `prices fail the checks: ${check.priceIssues.join(', ')}`;
    case 'starts_too_soon':
      return 'starts within 10 minutes';
    default:
      return blocker;
  }
}

async function reviewQueue(db: Database) {
  const items: Awaited<ReturnType<typeof listReviewItems>> = [];
  let after: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const page = await listReviewItems(db, {
      status: 'open',
      limit: PAGE,
      ...(after === undefined ? {} : { after }),
    });
    items.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) break;
    after = { createdAt: last.createdAt, id: last.id };
  }
  const reasonOf = (payload: Record<string, unknown>): string => {
    for (const key of ['reasons', 'rules']) {
      const value = payload[key];
      if (Array.isArray(value) && value.length > 0) return value.map(String).join(', ');
    }
    return '-';
  };
  const kinds = new Map<
    string,
    { count: number; reasons: Map<string, number>; newest: string[] }
  >();
  // Newest first, so the first three titles seen per kind are the newest.
  for (const item of items) {
    const entry = kinds.get(item.kind) ?? {
      count: 0,
      reasons: new Map<string, number>(),
      newest: [],
    };
    entry.count += 1;
    const reason = reasonOf(item.payload);
    entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
    if (entry.newest.length < 3) entry.newest.push(item.title);
    kinds.set(item.kind, entry);
  }
  return [...kinds.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, e]) => ({
      kind,
      count: e.count,
      reasons: [...e.reasons.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      newest: e.newest,
    }));
}

/**
 * `feed report [--days <n>]`: why upcoming matches have betting closed, and what is in the review
 * queue. Read-only: only selects (autoOpenCheck runs with lock: false).
 */
export async function feedReport(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { days: { type: 'string' } });
  noPositionals(parsed);
  const days = parseDays(parsed.values.days);
  const db = await env.database();
  const now = env.clock();
  const until = new Date(now.getTime() + days * 24 * HOUR_MS);
  const minRatingMatches = env.config().scraper.minRatingMatches;

  const policies = (await listCompetitionPolicies(db, { sportId: 'football' })).filter(
    (row) => row.configured,
  );
  const [sources, health] = await Promise.all([listSources(db), sourceHealth(db, now)]);
  const healthById = new Map(health.map((h) => [h.sourceId, h]));
  const queue = await reviewQueue(db);

  const rows = await db
    .select({
      id: events.id,
      startTime: events.startTime,
      competition: competitions.name,
      homeId: events.homeTeamId,
      awayId: events.awayTeamId,
    })
    .from(events)
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.status, 'scheduled'),
        isNull(events.resultedAt),
        eq(events.bettingOpen, false),
        gte(events.startTime, now),
        lte(events.startTime, until),
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id));
  const teamIds = [...new Set(rows.flatMap((r) => [r.homeId, r.awayId]))];
  const teamRows =
    teamIds.length === 0
      ? []
      : await db
          .select({ id: teams.id, name: teams.name, shortName: teams.shortName })
          .from(teams)
          .where(inArray(teams.id, teamIds));
  const teamNames = new Map(
    teamRows.map((t) => [t.id, (t.name as { en?: string } | null)?.en || t.shortName]),
  );
  const nameOf = (id: string): string => teamNames.get(id) ?? id;
  const compName = (n: unknown): string => (n as { en?: string } | null)?.en ?? String(n);

  const locked = [];
  const blockerCounts = new Map<string, number>();
  for (const row of rows) {
    const check = await autoOpenCheck(db, row.id, now, minRatingMatches, { lock: false });
    const reasons = check.blockers.map((b) => ({
      code: b,
      text: blockerLine(b, check, row.startTime, teamNames),
    }));
    for (const b of check.blockers) blockerCounts.set(b, (blockerCounts.get(b) ?? 0) + 1);
    locked.push({
      eventId: row.id,
      kickoff: row.startTime,
      competition: compName(row.competition),
      home: nameOf(row.homeId),
      away: nameOf(row.awayId),
      reasons,
    });
  }
  const blockerSummary = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([blocker, count]) => ({ blocker, count }));

  const competitionRows = policies.map((p) => ({
    competitionId: p.competitionId,
    slug: p.slug,
    name: compName(p.name),
    enabled: p.enabled,
    autoOpen: p.autoOpen,
    autoResults: p.autoResults,
    extraTime: p.extraTime,
    pricingSource: p.pricingSource,
  }));
  const sourceRows = sources.map((s) => {
    const h = healthById.get(s.id);
    const at = h?.lastRun?.startedAt ?? null;
    return {
      id: s.id,
      enabled: s.enabled,
      lastStatus: h?.lastStatus ?? null,
      lastRunAt: at,
    };
  });

  const yn = (v: boolean) => (v ? 'yes' : 'no');
  const lines: string[] = [`Feed report (${iso(now)}, next ${days} days)`, ''];
  lines.push('1. Competitions');
  lines.push(
    ...(competitionRows.length === 0
      ? ['no competition policy is configured']
      : table(
          ['competition', 'enabled', 'auto open', 'auto results', 'extra time', 'pricing'],
          competitionRows.map((c) => [
            `${c.name} (${c.slug})`,
            yn(c.enabled),
            yn(c.autoOpen),
            yn(c.autoResults),
            yn(c.extraTime),
            String(c.pricingSource),
          ]),
        )),
  );
  lines.push('', '2. Sources');
  lines.push(
    ...(sourceRows.length === 0
      ? ['no sources']
      : table(
          ['source', 'state', 'last run', 'when'],
          sourceRows.map((s) => [
            s.id,
            s.enabled ? 'enabled' : 'disabled',
            s.lastStatus ?? 'never run',
            ago(s.lastRunAt, now),
          ]),
        )),
  );
  lines.push('', '3. Review queue (open items)');
  if (queue.length === 0) lines.push('the queue is empty');
  for (const k of queue) {
    lines.push(`${k.kind}: ${k.count}`);
    for (const r of k.reasons) lines.push(`  ${r.count} x ${r.reason}`);
    for (const title of k.newest) lines.push(`  newest: ${title}`);
  }
  lines.push('', `4. Locked matches in the next ${days} days (${locked.length})`);
  if (locked.length === 0) lines.push('none');
  for (const m of locked) {
    lines.push(`${kickoffText(m.kickoff)} UTC  ${m.competition}  ${m.home} v ${m.away}`);
    if (m.reasons.length === 0) lines.push('  opens on the next promotion pass');
    for (const r of m.reasons) lines.push(`  - ${r.text}`);
  }
  if (blockerSummary.length > 0) {
    lines.push('', 'Blockers:');
    for (const b of blockerSummary) lines.push(`  ${b.blocker}: ${b.count}`);
  }

  emit(
    env,
    parsed,
    {
      generatedAt: now,
      days,
      competitions: competitionRows,
      sources: sourceRows,
      reviewQueue: queue,
      lockedMatches: locked,
      blockerCounts: blockerSummary,
    },
    lines,
  );
  return EXIT_OK;
}
