import {
  BET_PLACED,
  claimOutboxBatch,
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  markOutboxFailed,
  markOutboxPublished,
  schema,
  type OutboxEvent,
} from '@vamos/db';
import type { JobsOptions } from 'bullmq';
import { and, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { intervalTask } from '../lib/interval';
import { createQueueSet, QUEUE_NAMES, withTimeout, type QueueName } from '../lib/queues';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';

/**
 * The outbox dispatcher: the only reader of `outbox_events`. Every run claims
 * a batch of unpublished rows (FOR UPDATE SKIP LOCKED, so several workers can
 * run it), hands each row to the BullMQ queue(s) of its type and marks it
 * published, all in one transaction. The outbox has a single published_at
 * column, so new consumers (SMS, ELS reporting…) get a route here instead
 * of reading the outbox themselves.
 *
 * - Each job's id is `outbox-<row id>` (BullMQ refuses ':' in custom ids), so
 *   a row queued again (a crash between the enqueue and the COMMIT) maps to
 *   the job already there: a row is never processed twice. Finished jobs are
 *   kept for a day (KEEP_COMPLETED) for this. Consumers are idempotent anyway.
 * - Types without a route are just marked published.
 * - A row whose enqueue fails gets markOutboxFailed and an exponential
 *   backoff (kept in memory: 1 s, 2 s, 4 s… at most 60 s). One that reaches
 *   `maxAttempts` is no longer claimed (dead letter) and is logged once, at
 *   error level. Dead-lettered rows left from earlier runs are counted and
 *   logged once at the first run.
 * - When Redis does not answer a PING, the run claims nothing, so an outage
 *   does not use up the rows' attempts.
 */

export const OUTBOX_DISPATCH_INTERVAL_MS = 1000;

export interface OutboxDispatchOptions {
  /** Default 1 s. */
  intervalMs?: number;
  /** Rows claimed per run (default 100). */
  batchSize?: number;
  /** Failed attempts after which a row is dead-lettered (default 10). */
  maxAttempts?: number;
  /** First retry delay after a failed enqueue (default 1 s, doubled per attempt). */
  backoffBaseMs?: number;
  /** Longest retry delay (default 60 s). */
  backoffMaxMs?: number;
  /** Time limit of one enqueue (default 5 s). */
  enqueueTimeoutMs?: number;
}

/** Data of a `settlement` job. */
export interface SettlementJobData {
  outboxId: string;
  type: string;
  eventId: string;
}

/** Data of a `bet-acceptance` job (a delayed job due at acceptAfter). */
export interface BetAcceptanceJobData {
  outboxId: string;
  betId: string;
  /** ISO time. */
  acceptAfter: string;
}

export interface RoutedJob {
  queue: QueueName;
  name: string;
  data: unknown;
  opts?: JobsOptions;
}

/** Turns an outbox row into a job, or null when this row needs none. Throws on a malformed payload. */
export type OutboxRoute = (row: OutboxEvent, now: Date) => RoutedJob | null;

const nonEmpty = z.string().min(1);

const settlementRoute: OutboxRoute = (row) => {
  const eventId = nonEmpty.parse(row.aggregateId);
  const data: SettlementJobData = { outboxId: row.id.toString(), type: row.type, eventId };
  return { queue: QUEUE_NAMES.settlement, name: row.type, data };
};

const betPlacedPayload = z.object({
  betId: nonEmpty,
  status: nonEmpty,
  acceptAfter: z.iso.datetime({ offset: true }).nullable().optional(),
});

/** A live bet placed `pending_acceptance` gets a job delayed until its acceptAfter. */
const betAcceptanceRoute: OutboxRoute = (row, now) => {
  const payload = betPlacedPayload.parse(row.payload);
  if (payload.status !== 'pending_acceptance') return null;
  if (payload.acceptAfter === null || payload.acceptAfter === undefined) {
    throw new Error(`pending bet ${payload.betId} has no acceptAfter`);
  }
  const data: BetAcceptanceJobData = {
    outboxId: row.id.toString(),
    betId: payload.betId,
    acceptAfter: payload.acceptAfter,
  };
  const delay = Math.max(0, Date.parse(payload.acceptAfter) - now.getTime());
  return {
    queue: QUEUE_NAMES.betAcceptance,
    name: 'accept',
    data,
    opts: { delay, attempts: 5, backoff: { type: 'exponential', delay: 500 } },
  };
};

/** Outbox type -> the jobs it fans out to. */
export const OUTBOX_ROUTES: Readonly<Record<string, readonly OutboxRoute[]>> = {
  [EVENT_RESULTED]: [settlementRoute],
  [EVENT_RESULT_CORRECTED]: [settlementRoute],
  [BET_PLACED]: [betAcceptanceRoute],
};

/** The job id of an outbox row (the same in every queue it fans out to). */
export const outboxJobId = (id: bigint): string => `outbox-${id}`;

export interface OutboxDispatchSummary {
  claimed: number;
  /** Rows marked published (with or without jobs). */
  published: number;
  /** Jobs added (or found already queued under the same id). */
  jobs: number;
  /** Rows whose enqueue failed in this run. */
  failed: number;
  /** Rows that reached maxAttempts in this run. */
  deadLettered: number;
  /** Claimed rows left alone because their retry backoff is not over. */
  backingOff: number;
  /** true when Redis did not answer and nothing was claimed. */
  redisDown: boolean;
}

export interface OutboxDispatcher {
  run(): Promise<OutboxDispatchSummary>;
  /** Closes the queues' Redis connection. */
  close(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createOutboxDispatcher(
  ctx: TaskContext,
  options: OutboxDispatchOptions = {},
): OutboxDispatcher {
  const batchSize = options.batchSize ?? 100;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  const backoffMaxMs = options.backoffMaxMs ?? 60_000;
  const enqueueTimeoutMs = options.enqueueTimeoutMs ?? 5000;
  const { logger } = ctx;
  const queues = createQueueSet(ctx.queues, logger);
  /** Row id -> earliest time (ctx.clock ms) of its next try. */
  const retryAt = new Map<string, number>();
  let redisDown = false;
  let deadLetterChecked = false;

  const empty = (): OutboxDispatchSummary => ({
    claimed: 0,
    published: 0,
    jobs: 0,
    failed: 0,
    deadLettered: 0,
    backingOff: 0,
    redisDown: false,
  });

  const enqueue = async (row: OutboxEvent, now: Date): Promise<number> => {
    const jobs = (OUTBOX_ROUTES[row.type] ?? [])
      .map((route) => route(row, now))
      .filter((job): job is RoutedJob => job !== null);
    const jobId = outboxJobId(row.id);
    await Promise.all(
      jobs.map((job) =>
        withTimeout(
          queues.get(job.queue).add(job.name, job.data, { ...job.opts, jobId }),
          enqueueTimeoutMs,
          `enqueue to ${job.queue}`,
        ),
      ),
    );
    return jobs.length;
  };

  const reportDeadLetters = async (): Promise<void> => {
    deadLetterChecked = true;
    const o = schema.outboxEvents;
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(o)
      .where(and(isNull(o.publishedAt), gte(o.attempts, maxAttempts)));
    const n = row?.n ?? 0;
    if (n > 0) {
      logger.error(
        { count: n, maxAttempts },
        'outbox has dead-lettered events (unpublished, attempts >= maxAttempts); they are not retried',
      );
    }
  };

  return {
    async run() {
      try {
        await queues.ping();
        if (redisDown) logger.info('outbox dispatch: redis is reachable again');
        redisDown = false;
      } catch (error) {
        if (!redisDown) logger.warn({ err: error }, 'outbox dispatch paused: redis unreachable');
        redisDown = true;
        return { ...empty(), redisDown: true };
      }
      if (!deadLetterChecked) await reportDeadLetters();

      const now = ctx.clock();
      return ctx.db.transaction(async (tx) => {
        const summary = empty();
        const rows = await claimOutboxBatch(tx, batchSize, { maxAttempts });
        summary.claimed = rows.length;
        const due = rows.filter((row) => (retryAt.get(row.id.toString()) ?? 0) <= now.getTime());
        summary.backingOff = rows.length - due.length;
        const results = await Promise.allSettled(due.map((row) => enqueue(row, now)));

        const published: bigint[] = [];
        for (const [i, result] of results.entries()) {
          const row = due[i];
          if (row === undefined) continue;
          const key = row.id.toString();
          if (result.status === 'fulfilled') {
            published.push(row.id);
            summary.jobs += result.value;
            retryAt.delete(key);
            continue;
          }
          const error = message(result.reason);
          const attempts = row.attempts + 1;
          summary.failed += 1;
          await markOutboxFailed(tx, row.id, error);
          if (attempts >= maxAttempts) {
            summary.deadLettered += 1;
            retryAt.delete(key);
            logger.error(
              { outboxId: key, type: row.type, aggregateId: row.aggregateId, attempts, error },
              'outbox event dead-lettered: reached max attempts, it will not be retried',
            );
          } else {
            const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1));
            retryAt.set(key, now.getTime() + delay);
            logger.warn(
              { outboxId: key, type: row.type, attempts, retryInMs: delay, error },
              'outbox event could not be queued; will retry',
            );
          }
        }
        await markOutboxPublished(tx, published);
        summary.published = published.length;
        if (summary.jobs > 0) {
          logger.debug({ ...summary }, 'outbox dispatched');
        }
        return summary;
      });
    },
    close: () => queues.close(),
  };
}

/** The dispatcher as a WorkerTask (every second by default). */
export function outboxDispatchTask(
  ctx: TaskContext,
  options: OutboxDispatchOptions = {},
): WorkerTask {
  let dispatcher: OutboxDispatcher | null = null;
  const task = intervalTask({
    name: 'outbox-dispatch',
    intervalMs: options.intervalMs ?? OUTBOX_DISPATCH_INTERVAL_MS,
    logger: ctx.logger,
    run: async () => dispatcher?.run(),
  });
  return {
    name: task.name,
    start: async () => {
      dispatcher ??= createOutboxDispatcher(ctx, options);
      await task.start();
    },
    stop: async () => {
      await task.stop();
      const current = dispatcher;
      dispatcher = null;
      await current?.close();
    },
  };
}
