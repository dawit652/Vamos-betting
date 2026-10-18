import { addBusinessDays, businessDateOf, businessDayWindow } from '@vamos/core';
import {
  createOffElsReporter,
  emitElsEvent,
  evaluateAmlForEvent,
  runAmlSweep,
  runDailySummaries,
  runReconciliation,
  schema,
  sweepElsReports,
  type ElsReporter,
  type ElsSweepResult,
  type EmitElsResult,
  type EvaluateAmlResult,
  type ReconciliationRun,
  type RunDailySummariesResult,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { AmlJobData, ElsJobData } from './outbox-dispatch';

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
 *   summary is final first. The run is skipped when a scheduled run of that
 *   day exists (a failed one is retried after `retryFailedMs`, 1 h).
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
  /** How often the task checks whether yesterday's run is due (default 15 min). */
  intervalMs?: number;
  /** Time after the start of today (Addis Ababa) before yesterday is reconciled (default 3 h). */
  afterMs?: number;
  /** A failed scheduled run of the day is tried again after this long (default 1 h). */
  retryFailedMs?: number;
}

export type ScheduledReconciliationResult =
  | { ran: true; businessDate: string; run: ReconciliationRun }
  | { ran: false; businessDate: string; reason: 'not_due' | 'done' | 'locked' };

/** Runs the scheduled reconciliation of yesterday when it is due and not done yet. */
export async function runScheduledReconciliation(
  ctx: TaskContext,
  options: Omit<ReconciliationTaskOptions, 'intervalMs'> = {},
): Promise<ScheduledReconciliationResult> {
  const now = ctx.clock();
  const today = businessDateOf(now);
  const businessDate = addBusinessDays(today, -1);
  const dueAt = businessDayWindow(today).start.getTime() + (options.afterMs ?? 3 * HOUR);
  if (now.getTime() < dueAt) return { ran: false, businessDate, reason: 'not_due' };
  const retryFailedMs = options.retryFailedMs ?? HOUR;
  const outcome = await underLock(ctx, 'reconciliation', 30 * MINUTE, async () => {
    const runs = schema.reconciliationRuns;
    const [last] = await ctx.db
      .select({ status: runs.status, startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.kind, 'scheduled'), eq(runs.businessDate, businessDate)))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    if (
      last !== undefined &&
      (last.status !== 'failed' || now.getTime() - last.startedAt.getTime() < retryFailedMs)
    ) {
      return { ran: false, businessDate, reason: 'done' } as const;
    }
    const detail = await runReconciliation(ctx.db, { now, kind: 'scheduled', businessDate });
    const { run } = detail;
    ctx.logger[run.status === 'clean' ? 'info' : 'error'](
      { runId: run.id, businessDate, status: run.status, mismatches: run.mismatchCount },
      'scheduled reconciliation',
    );
    return { ran: true, businessDate, run } as const;
  });
  return outcome ?? { ran: false, businessDate, reason: 'locked' };
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
