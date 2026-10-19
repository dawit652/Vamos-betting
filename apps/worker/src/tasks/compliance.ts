import {
  addBusinessDays,
  businessDateOf,
  businessDatesBetween,
  businessDayWindow,
} from '@vamos/core';
import {
  createOffElsReporter,
  emitElsEvent,
  evaluateAmlForEvent,
  failReconciliationRequest,
  runAmlSweep,
  runDailySummaries,
  runReconciliation,
  runRequestedReconciliation,
  schema,
  sweepElsReports,
  type ElsReporter,
  type ElsSweepResult,
  type EmitElsResult,
  type EvaluateAmlResult,
  type ReconciliationRun,
  type RequestedReconciliationResult,
  type RunDailySummariesResult,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { and, desc, eq, gte, inArray, lte, max, sql } from 'drizzle-orm';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { AmlJobData, ElsJobData, ReconciliationJobData } from './outbox-dispatch';

/**
 * Compliance tasks (Phase 10), all safe to replay and to run on several
 * workers at once:
 *
 * - `els-report`: the `els` queue consumer. Writes each reportable outbox
 *   event's record once (emitElsEvent: idempotent by outbox id through the
 *   els_reports table, so a replayed job or a restart never duplicates a
 *   line). A reporter that cannot deliver (the HTTP placeholder) leaves the
 *   record pending; other errors fail the job, which BullMQ retries.
 * - `els-sweep` (5 min): records reportable events no job recorded and
 *   writes the pending records (sweepElsReports).
 * - `daily-summaries` (hourly): finalises every business day over for more
 *   than its grace period (2 h) and refreshes the provisional ones
 *   (runDailySummaries; a final day is never touched again).
 * - `reconciliation` (checked every 15 min): one scheduled run per business
 *   day, for yesterday, once today is `afterMs` (3 h) old, so the day's
 *   summary is final first. Days missed while the worker was down are caught
 *   up first, oldest first, one per check (at most 7 days back). A day with a
 *   scheduled run is skipped (a failed one is retried after `retryFailedMs`,
 *   1 h). The run holds a Postgres advisory lock (RECONCILIATION_LOCK) from
 *   the check to the stored result, so a day never runs twice.
 * - `reconciliation-requests`: the `reconciliation` queue consumer: a staff
 *   "Run now" (runRequestedReconciliation), one at a time; a request whose
 *   job fails for good is marked failed so staff can ask again.
 * - `aml-evaluate`: the `aml` queue consumer (deposits, withdrawal requests,
 *   cash-outs): evaluateAmlForEvent; flags are deduplicated per player, rule
 *   and window, so a replay creates nothing new.
 * - `aml-sweep` (checked hourly): once per business day, runAmlSweep over
 *   every recently active player; the day done is kept in compliance_cursors
 *   (`aml_sweep`), so a restart does not run it again.
 *
 * The periodic runs take a short Redis lock so two workers do not do the
 * same work at the same moment; correctness does not depend on it (the
 * services serialise with database locks).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const ELS_SWEEP_INTERVAL_MS = 5 * MINUTE;
export const DAILY_SUMMARY_INTERVAL_MS = HOUR;
export const RECONCILIATION_CHECK_INTERVAL_MS = 15 * MINUTE;
export const AML_SWEEP_CHECK_INTERVAL_MS = HOUR;

/** compliance_cursors name: the business day (days since 1970-01-01) of the last AML sweep. */
export const AML_SWEEP_CURSOR = 'aml_sweep';

function reporterOf(ctx: TaskContext): ElsReporter {
  return ctx.els ?? createOffElsReporter();
}

/** Runs `fn` under a Redis lock named `name`; null when another worker holds it. */
async function underLock<T>(
  ctx: TaskContext,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lock = await tryLock(ctx.redis, `vamos:lock:compliance:${name}`, ttlMs);
  if (lock === null) return null;
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// ELS stream.

/** Writes the record of one `els` job. */
export function processElsJob(ctx: TaskContext, data: ElsJobData): Promise<EmitElsResult> {
  return emitElsEvent(ctx.db, reporterOf(ctx), { outboxId: data.outboxId });
}

export interface ElsReportOptions {
  /** Jobs handled in parallel (default 2; writes are serialised by a database lock anyway). */
  concurrency?: number;
}

/** The `els` queue consumer. */
export function elsReportTask(ctx: TaskContext, options: ElsReportOptions = {}): WorkerTask {
  let consumer: QueueWorker<ElsJobData, EmitElsResult['outcome']> | null = null;
  return {
    name: 'els-report',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.els,
        async (job: Job<ElsJobData>) => {
          const { outcome } = await processElsJob(ctx, job.data);
          if (outcome === 'not_found') {
            ctx.logger.warn({ outboxId: job.data.outboxId }, 'ELS job for an unknown outbox row');
          }
          return outcome;
        },
        ctx.logger,
        { concurrency: options.concurrency ?? 2 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

export interface ElsSweepOptions {
  /** Default 5 min. */
  intervalMs?: number;
  /** Only events and records older than this are swept (default 1 min: the queue has them). */
  graceMs?: number;
  /** Pending records written per run (default 500). */
  limit?: number;
}

export function runElsSweep(
  ctx: TaskContext,
  options: Omit<ElsSweepOptions, 'intervalMs'> = {},
): Promise<ElsSweepResult> {
  return sweepElsReports(ctx.db, reporterOf(ctx), {
    graceMs: options.graceMs ?? MINUTE,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export function elsSweepTask(ctx: TaskContext, options: ElsSweepOptions = {}): IntervalTask {
  return intervalTask({
    name: 'els-sweep',
    intervalMs: options.intervalMs ?? ELS_SWEEP_INTERVAL_MS,
    logger: ctx.logger,
    run: async () => {
      const result = await underLock(ctx, 'els-sweep', 10 * MINUTE, () =>
        runElsSweep(ctx, options),
      );
      if (result !== null && (result.recorded > 0 || result.written > 0 || result.failed > 0)) {
        ctx.logger[result.failed > 0 ? 'warn' : 'info']({ ...result }, 'ELS sweep');
      }
      return result;
    },
  });
}

// ---------------------------------------------------------------------------
// Daily summaries.

export interface DailySummaryOptions {
  /** Default 1 h. */
  intervalMs?: number;
  /** Time after a business day's end before it is finalised (default 2 h, the service's). */
  graceMs?: number;
}

export function runDailySummaryTask(
  ctx: TaskContext,
  options: Omit<DailySummaryOptions, 'intervalMs'> = {},
): Promise<RunDailySummariesResult> {
  return runDailySummaries(ctx.db, {
    now: ctx.clock(),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });
}

export function dailySummaryTask(
  ctx: TaskContext,
  options: DailySummaryOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'daily-summaries',
    intervalMs: options.intervalMs ?? DAILY_SUMMARY_INTERVAL_MS,
    logger: ctx.logger,
    run: async () => {
      const result = await underLock(ctx, 'daily-summaries', 30 * MINUTE, () =>
        runDailySummaryTask(ctx, options),
      );
      if (result !== null && result.finalized.length > 0) {
        ctx.logger.info({ finalized: result.finalized }, 'daily summaries finalised');
      }
      return result;
    },
  });
}

// ---------------------------------------------------------------------------
// Reconciliation.

export interface ReconciliationTaskOptions {
  /** How often the task checks whether a day's run is due (default 15 min). */
  intervalMs?: number;
  /** Time after the start of today (Addis Ababa) before yesterday is reconciled (default 3 h). */
  afterMs?: number;
  /** A failed scheduled run of a day is tried again after this long (default 1 h). */
  retryFailedMs?: number;
  /** How many days back a missed day is still caught up (default RECONCILIATION_MAX_CATCH_UP_DAYS). */
  maxCatchUpDays?: number;
}

/** Days back the scheduled reconciliation catches up after an outage. */
export const RECONCILIATION_MAX_CATCH_UP_DAYS = 7;

/**
 * Postgres advisory lock (transaction level) held for the whole scheduled
 * run: a run that outlives any TTL still cannot start twice, and the lock
 * goes away with the connection if the worker dies.
 */
export const RECONCILIATION_LOCK = 'vamos:reconciliation:scheduled';

export type ScheduledReconciliationResult =
  | { ran: true; businessDate: string; run: ReconciliationRun }
  | { ran: false; businessDate: string; reason: 'not_due' | 'done' | 'locked' };

/**
 * The oldest business day up to `yesterday` that still needs its scheduled
 * run: every day after the last clean or mismatches scheduled run (at most
 * `maxDays` back; only yesterday before the first one) that has no run, or
 * whose last run failed at least `retryFailedMs` ago. Null when none.
 */
async function nextScheduledReconciliationDay(
  ctx: TaskContext,
  input: { yesterday: string; now: Date; retryFailedMs: number; maxDays: number },
): Promise<string | null> {
  const runs = schema.reconciliationRuns;
  const [done] = await ctx.db
    .select({ date: max(runs.businessDate) })
    .from(runs)
    .where(and(eq(runs.kind, 'scheduled'), inArray(runs.status, ['clean', 'mismatches'])));
  const floor = addBusinessDays(input.yesterday, -(Math.max(1, input.maxDays) - 1));
  const after = done?.date ?? null;
  const next = after === null ? input.yesterday : addBusinessDays(after, 1);
  const start = next < floor ? floor : next;
  if (start > input.yesterday) return null;
  const rows = await ctx.db
    .select({ date: runs.businessDate, status: runs.status, startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        eq(runs.kind, 'scheduled'),
        gte(runs.businessDate, start),
        lte(runs.businessDate, input.yesterday),
      ),
    )
    .orderBy(desc(runs.startedAt));
  const last = new Map<string, { status: string; startedAt: Date }>();
  for (const row of rows) if (row.date !== null && !last.has(row.date)) last.set(row.date, row);
  for (const day of businessDatesBetween(start, input.yesterday, input.maxDays + 1)) {
    const run = last.get(day);
    if (run === undefined) return day;
    if (
      run.status === 'failed' &&
      input.now.getTime() - run.startedAt.getTime() >= input.retryFailedMs
    ) {
      return day;
    }
  }
  return null;
}

/**
 * Runs the scheduled reconciliation of the oldest day still due (yesterday,
 * or a day missed while the worker was down; one day per call), under the
 * RECONCILIATION_LOCK advisory lock so a day runs once.
 */
export async function runScheduledReconciliation(
  ctx: TaskContext,
  options: Omit<ReconciliationTaskOptions, 'intervalMs'> = {},
): Promise<ScheduledReconciliationResult> {
  const now = ctx.clock();
  const today = businessDateOf(now);
  const yesterday = addBusinessDays(today, -1);
  const dueAt = businessDayWindow(today).start.getTime() + (options.afterMs ?? 3 * HOUR);
  if (now.getTime() < dueAt) return { ran: false, businessDate: yesterday, reason: 'not_due' };
  return ctx.db.transaction(async (lockTx): Promise<ScheduledReconciliationResult> => {
    const lock = await lockTx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK})) AS locked`,
    );
    if (lock.rows[0]?.locked !== true) {
      return { ran: false, businessDate: yesterday, reason: 'locked' };
    }
    const businessDate = await nextScheduledReconciliationDay(ctx, {
      yesterday,
      now,
      retryFailedMs: options.retryFailedMs ?? HOUR,
      maxDays: options.maxCatchUpDays ?? RECONCILIATION_MAX_CATCH_UP_DAYS,
    });
    if (businessDate === null) return { ran: false, businessDate: yesterday, reason: 'done' };
    const { run } = await runReconciliation(ctx.db, { now, kind: 'scheduled', businessDate });
    ctx.logger[run.status === 'clean' ? 'info' : 'error'](
      { runId: run.id, businessDate, status: run.status, mismatches: run.mismatchCount },
      'scheduled reconciliation',
    );
    return { ran: true, businessDate, run };
  });
}

export function reconciliationTask(
  ctx: TaskContext,
  options: ReconciliationTaskOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'reconciliation',
    intervalMs: options.intervalMs ?? RECONCILIATION_CHECK_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runScheduledReconciliation(ctx, options),
  });
}

/** Runs the staff request of one `reconciliation` job. */
export function processReconciliationJob(
  ctx: TaskContext,
  data: ReconciliationJobData,
): Promise<RequestedReconciliationResult> {
  return runRequestedReconciliation(ctx.db, { requestId: data.requestId, now: ctx.clock() });
}

/** The `reconciliation` queue consumer (staff "Run now" requests, one at a time). */
export function reconciliationRequestTask(ctx: TaskContext): WorkerTask {
  let consumer: QueueWorker<ReconciliationJobData, string> | null = null;
  return {
    name: 'reconciliation-requests',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.reconciliation,
        async (job: Job<ReconciliationJobData>) => {
          try {
            const result = await processReconciliationJob(ctx, job.data);
            if (!result.ran) return result.reason;
            ctx.logger[result.run.status === 'clean' ? 'info' : 'error'](
              {
                runId: result.run.id,
                businessDate: result.run.businessDate,
                status: result.run.status,
                mismatches: result.run.mismatchCount,
              },
              'requested reconciliation',
            );
            return result.run.status;
          } catch (error) {
            if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
              await failReconciliationRequest(ctx.db, {
                requestId: job.data.requestId,
                now: ctx.clock(),
                error: error instanceof Error ? error.message : String(error),
              }).catch((cause: unknown) =>
                ctx.logger.error({ err: cause }, 'could not mark the request failed'),
              );
            }
            throw error;
          }
        },
        ctx.logger,
        // A reconciliation reads the whole ledger: one at a time, and a long lock.
        { concurrency: 1, lockDuration: 5 * MINUTE },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// AML.

/** Evaluates the player of one `aml` job. */
export function processAmlJob(
  ctx: TaskContext,
  data: AmlJobData,
): Promise<EvaluateAmlResult | null> {
  return evaluateAmlForEvent(ctx.db, {
    type: data.type,
    payload: { userId: data.userId },
    now: ctx.clock(),
  });
}

export interface AmlEvaluateOptions {
  /** Jobs handled in parallel (default 4). */
  concurrency?: number;
}

/** The `aml` queue consumer. */
export function amlEvaluateTask(ctx: TaskContext, options: AmlEvaluateOptions = {}): WorkerTask {
  let consumer: QueueWorker<AmlJobData, { flags: number; held: number }> | null = null;
  return {
    name: 'aml-evaluate',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.aml,
        async (job: Job<AmlJobData>) => {
          const result = await processAmlJob(ctx, job.data);
          if (result !== null && result.created.length > 0) {
            ctx.logger.warn(
              {
                userId: job.data.userId,
                rules: result.created.map((flag) => flag.rule),
                held: result.held.length,
              },
              'AML flags raised',
            );
          }
          return { flags: result?.created.length ?? 0, held: result?.held.length ?? 0 };
        },
        ctx.logger,
        { concurrency: options.concurrency ?? 4 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

export interface AmlSweepOptions {
  /** How often the task checks whether today's sweep is done (default 1 h). */
  intervalMs?: number;
  /** Players evaluated per sweep at most (default the service's, 10,000). */
  limit?: number;
}

export type AmlSweepTaskResult =
  | { ran: true; businessDate: string; evaluated: number; flagged: number; held: number }
  | { ran: false; businessDate: string; reason: 'done' | 'locked' };

/** Days since 1970-01-01 of a business date (the cursor's position). */
function dayNumber(date: string): bigint {
  return BigInt(Math.floor(Date.parse(`${date}T00:00:00Z`) / (24 * HOUR)));
}

/** Runs the AML sweep once per business day (Addis Ababa). */
export async function runDailyAmlSweep(
  ctx: TaskContext,
  options: Omit<AmlSweepOptions, 'intervalMs'> = {},
): Promise<AmlSweepTaskResult> {
  const now = ctx.clock();
  const businessDate = businessDateOf(now);
  const day = dayNumber(businessDate);
  const cursors = schema.complianceCursors;
  const outcome = await underLock(ctx, 'aml-sweep', 30 * MINUTE, async () => {
    const [cursor] = await ctx.db
      .select({ position: cursors.position })
      .from(cursors)
      .where(eq(cursors.name, AML_SWEEP_CURSOR));
    if (cursor !== undefined && cursor.position >= day) {
      return { ran: false, businessDate, reason: 'done' } as const;
    }
    const result = await runAmlSweep(ctx.db, {
      now,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    await ctx.db
      .insert(cursors)
      .values({ name: AML_SWEEP_CURSOR, position: day })
      .onConflictDoUpdate({
        target: cursors.name,
        set: { position: sql`GREATEST(${cursors.position}, ${day})`, updatedAt: sql`now()` },
      });
    if (result.flagged > 0) ctx.logger.warn({ ...result, businessDate }, 'AML sweep raised flags');
    return { ran: true, businessDate, ...result } as const;
  });
  return outcome ?? { ran: false, businessDate, reason: 'locked' };
}

export function amlSweepTask(ctx: TaskContext, options: AmlSweepOptions = {}): IntervalTask {
  return intervalTask({
    name: 'aml-sweep',
    intervalMs: options.intervalMs ?? AML_SWEEP_CHECK_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runDailyAmlSweep(ctx, options),
  });
}
