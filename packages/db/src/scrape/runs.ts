import type { ScrapeRunStatus } from '@vamos/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { domainNotFound } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { scrapeRuns, type ScrapeRunIssueJson } from '../schema/scrape';
import { ScrapeRunStateError, clampLimit } from './common';

/** At most this many issues are stored per run; the rest are summarised in one last issue. */
export const MAX_RUN_ISSUES = 100;
/** `scrape_runs.error` is cut to this many characters. */
export const MAX_RUN_ERROR_LENGTH = 2000;
const MAX_ISSUE_MESSAGE_LENGTH = 500;

export type ScrapeRunTrigger = 'schedule' | 'manual';

export interface ScrapeRun {
  id: string;
  sourceId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: ScrapeRunStatus;
  trigger: ScrapeRunTrigger;
  requests: number;
  bytes: number;
  recordsSeen: number;
  recordsAccepted: number;
  fixtures: number;
  results: number;
  issues: ScrapeRunIssueJson[];
  error: string | null;
}

export interface FinishRunInput {
  /** Any status but 'running'. */
  status: Exclude<ScrapeRunStatus, 'running'>;
  requests?: number;
  bytes?: number;
  recordsSeen?: number;
  recordsAccepted?: number;
  fixtures?: number;
  results?: number;
  issues?: ScrapeRunIssueJson[];
  error?: string | null;
  finishedAt?: Date;
}

function toRun(row: typeof scrapeRuns.$inferSelect): ScrapeRun {
  return {
    ...row,
    status: row.status as ScrapeRunStatus,
    trigger: row.trigger as ScrapeRunTrigger,
  };
}

/** Opens a run (status 'running') for a source. */
export async function startRun(
  exec: DbExecutor,
  input: { sourceId: string; trigger?: ScrapeRunTrigger; startedAt?: Date },
): Promise<ScrapeRun> {
  const [row] = await exec
    .insert(scrapeRuns)
    .values({
      sourceId: input.sourceId,
      trigger: input.trigger ?? 'schedule',
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    })
    .returning();
  return toRun(row!);
}

/** Caps the issues (count and message length) so one broken page cannot bloat the table. */
export function capIssues(issues: readonly ScrapeRunIssueJson[]): ScrapeRunIssueJson[] {
  const trim = (issue: ScrapeRunIssueJson): ScrapeRunIssueJson => ({
    ...issue,
    message: issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH),
  });
  if (issues.length <= MAX_RUN_ISSUES) return issues.map(trim);
  // Keep every fatal issue before the plain ones, whatever their position.
  const ordered = [...issues.filter((i) => i.fatal), ...issues.filter((i) => !i.fatal)];
  const kept = ordered.slice(0, MAX_RUN_ISSUES - 1).map(trim);
  kept.push({
    severity: 'warning',
    code: 'issues_truncated',
    message: `${issues.length - kept.length} more issues were not stored`,
  });
  return kept;
}

/**
 * Closes a running run with its outcome. Only a 'running' run can be finished
 * (the update is conditional, so a second call, or a concurrent one, fails
 * with ScrapeRunStateError instead of overwriting the outcome).
 */
export async function finishRun(
  exec: DbExecutor,
  runId: string,
  input: FinishRunInput,
): Promise<ScrapeRun> {
  const [row] = await exec
    .update(scrapeRuns)
    .set({
      status: input.status,
      finishedAt: input.finishedAt ?? sql`now()`,
      ...(input.requests === undefined ? {} : { requests: input.requests }),
      ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
      ...(input.recordsSeen === undefined ? {} : { recordsSeen: input.recordsSeen }),
      ...(input.recordsAccepted === undefined ? {} : { recordsAccepted: input.recordsAccepted }),
      ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
      ...(input.results === undefined ? {} : { results: input.results }),
      issues: capIssues(input.issues ?? []),
      error: input.error == null ? null : input.error.slice(0, MAX_RUN_ERROR_LENGTH),
    })
    .where(and(eq(scrapeRuns.id, runId), eq(scrapeRuns.status, 'running')))
    .returning();
  if (row !== undefined) return toRun(row);
  const [existing] = await exec
    .select({ status: scrapeRuns.status })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.id, runId));
  if (existing === undefined) throw domainNotFound('scrape run');
  throw new ScrapeRunStateError(runId, existing.status);
}

/** The newest runs, optionally of one source. */
export async function listRecentRuns(
  exec: DbExecutor,
  options: { sourceId?: string; limit?: number } = {},
): Promise<ScrapeRun[]> {
  const rows = await exec
    .select()
    .from(scrapeRuns)
    .where(options.sourceId === undefined ? undefined : eq(scrapeRuns.sourceId, options.sourceId))
    .orderBy(desc(scrapeRuns.startedAt), desc(scrapeRuns.id))
    .limit(clampLimit(options.limit, 50));
  return rows.map(toRun);
}

/**
 * Accepted-record counts of the latest SUCCESSFUL runs of a source, newest
 * first: the baseline for the shape check S1. With `url`, the yield of that
 * document in those runs (scrape_raw.records_accepted); without, the run's
 * total. Broken, failed and blocked runs never count towards the baseline.
 */
export async function recentAcceptedCounts(
  exec: DbExecutor,
  sourceId: string,
  url: string | undefined,
  limit: number,
): Promise<number[]> {
  const n = clampLimit(limit, 20);
  if (url === undefined) {
    const rows = await exec
      .select({ accepted: scrapeRuns.recordsAccepted })
      .from(scrapeRuns)
      .where(and(eq(scrapeRuns.sourceId, sourceId), eq(scrapeRuns.status, 'ok')))
      .orderBy(desc(scrapeRuns.startedAt), desc(scrapeRuns.id))
      .limit(n);
    return rows.map((row) => row.accepted);
  }
  const rows = await exec.execute<{ accepted: number }>(sql`
    SELECT r.records_accepted AS accepted
    FROM scrape_raw r JOIN scrape_runs s ON s.id = r.run_id
    WHERE s.source_id = ${sourceId} AND s.status = 'ok' AND r.url = ${url}
      AND r.records_accepted IS NOT NULL
    ORDER BY s.started_at DESC, s.id DESC
    LIMIT ${n}`);
  return rows.rows.map((row) => Number(row.accepted));
}

export interface SourceHealth {
  sourceId: string;
  name: string;
  upstream: string;
  enabled: boolean;
  /** The newest run that has finished (running and skipped runs do not count). */
  lastRun: {
    id: string;
    status: ScrapeRunStatus;
    startedAt: Date;
    finishedAt: Date | null;
    recordsAccepted: number;
    error: string | null;
  } | null;
  lastOkAt: Date | null;
  /** Milliseconds from the last ok run's start to `now`; null when it never succeeded. */
  sinceLastOkMs: number | null;
  /** failed / broken / blocked runs since the last ok run (skipped and running ones are neutral). */
  consecutiveFailures: number;
  lastStatus: ScrapeRunStatus | null;
  lastAcceptedCount: number | null;
  /** Open review items whose subject or payload.sourceId is this source. */
  openReviewItems: number;
}

/** One row per source for the health page and the kill switch. */
export async function sourceHealth(exec: DbExecutor, now: Date): Promise<SourceHealth[]> {
  const result = await exec.execute<{
    id: string;
    name: string;
    upstream: string;
    enabled: boolean;
    run_id: string | null;
    run_status: string | null;
    run_started: Date | null;
    run_finished: Date | null;
    run_accepted: number | null;
    run_error: string | null;
    last_ok: Date | null;
    failures: number;
    open_items: number;
  }>(sql`
    SELECT s.id, s.name, s.upstream, s.enabled,
      l.id AS run_id, l.status AS run_status, l.started_at AS run_started,
      l.finished_at AS run_finished, l.records_accepted AS run_accepted, l.error AS run_error,
      ok.started_at AS last_ok,
      (SELECT count(*)::int FROM scrape_runs f
        WHERE f.source_id = s.id AND f.status IN ('failed', 'broken', 'blocked')
          AND (ok.started_at IS NULL OR f.started_at > ok.started_at)) AS failures,
      (SELECT count(*)::int FROM scrape_review_items i
        WHERE i.status = 'open' AND (i.subject_key = s.id OR i.payload->>'sourceId' = s.id)) AS open_items
    FROM scrape_sources s
    LEFT JOIN LATERAL (
      SELECT r.* FROM scrape_runs r
      WHERE r.source_id = s.id AND r.status NOT IN ('running', 'skipped')
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1) l ON true
    LEFT JOIN LATERAL (
      SELECT r.started_at FROM scrape_runs r
      WHERE r.source_id = s.id AND r.status = 'ok'
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1) ok ON true
    ORDER BY s.id`);
  return result.rows.map((row) => {
    const lastOk = row.last_ok === null ? null : new Date(row.last_ok);
    return {
      sourceId: row.id,
      name: row.name,
      upstream: row.upstream,
      enabled: row.enabled,
      lastRun:
        row.run_id === null
          ? null
          : {
              id: row.run_id,
              status: row.run_status as ScrapeRunStatus,
              startedAt: new Date(row.run_started!),
              finishedAt: row.run_finished === null ? null : new Date(row.run_finished),
              recordsAccepted: Number(row.run_accepted),
              error: row.run_error,
            },
      lastOkAt: lastOk,
      sinceLastOkMs: lastOk === null ? null : Math.max(0, now.getTime() - lastOk.getTime()),
      consecutiveFailures: Number(row.failures),
      lastStatus: row.run_status as ScrapeRunStatus | null,
      lastAcceptedCount: row.run_accepted === null ? null : Number(row.run_accepted),
      openReviewItems: Number(row.open_items),
    };
  });
}
