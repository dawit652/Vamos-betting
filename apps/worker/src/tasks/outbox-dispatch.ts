import {
  BET_PLACED,
  claimOutboxBatch,
  countDeadLetteredOutbox,
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  markOutboxFailed,
  markOutboxPublished,
  type OutboxEvent,
} from '@vamos/db';
import type { JobsOptions } from 'bullmq';
import { z } from 'zod';
import { intervalTask } from '../lib/interval';
import {
  createQueueSet,
  QUEUE_NAMES,
  TimeoutError,
  withTimeout,
  type QueueName,
  type QueueSet,
} from '../lib/queues';
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
 * - Each job's id is `outbox-<row id>-<row job_key>` (BullMQ refuses ':' in
 *   custom ids), so a row queued again (a crash between the enqueue and the
 *   COMMIT) maps to the job already there: a row is never processed twice.
 *   Finished jobs are kept for a day (KEEP_COMPLETED) for this. job_key is
 *   random per row, so a rebuilt or restored database whose id sequence
 *   restarted, or another stack on the same Redis, never maps a new row to an
 *   old job. Consumers are idempotent anyway.
 * - Types without a route are just marked published.
 * - A row whose routing or enqueue fails gets markOutboxFailed with
 *   next_attempt_at = now + an exponential backoff (1 s, 2 s, 4 s… at most
 *   60 s), stored in the row, so every worker honours it and rows backing
 *   off are not claimed (they never hold back newer rows). A row that
 *   reaches `maxAttempts` is no longer claimed (dead letter) and is logged
 *   at error level; redriveOutboxEvents (@vamos/db) queues it again.
 * - Queue outages do not use up attempts: when Redis does not answer a PING
 *   the run claims nothing, and an enqueue that fails because Redis refuses
 *   writes while still answering PING (OOM, READONLY replica, MISCONF…),
 *   drops the connection or times out is recorded with a short retry delay
 *   but without counting the attempt (isQueueOutageError).
 * - Dead letters are counted and logged at error level at the first run and
 *   then every `deadLetterReportMs` while there are any.
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
  /** Retry delay of a row whose enqueue hit a queue outage (default 5 s; no attempt counted). */
  outageRetryMs?: number;
  /** How often dead letters are counted and logged while there are any (default 5 min). */
  deadLetterReportMs?: number;
  /** The producer queues (default createQueueSet(ctx.queues); tests pass a fake). */
  queueSet?: QueueSet;
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
export const outboxJobId = (row: Pick<OutboxEvent, 'id' | 'jobKey'>): string =>
  `outbox-${row.id}-${row.jobKey}`;

export interface OutboxDispatchSummary {
  claimed: number;
  /** Rows marked published (with or without jobs). */
  published: number;
  /** Jobs added (or found already queued under the same id). */
  jobs: number;
  /** Rows whose routing or enqueue failed in this run (outages included). */
  failed: number;
  /** Failed rows whose error was a queue outage (attempt not counted). */
  outage: number;
  /** Rows that reached maxAttempts in this run. */
  deadLettered: number;
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

/** Redis replies that mean "Redis cannot take writes right now", not "this job is wrong". */
const OUTAGE_REPLY =
  /^(OOM|READONLY|MISCONF|LOADING|BUSY|MASTERDOWN|NOREPLICAS|CLUSTERDOWN|TRYAGAIN|NOAUTH|WRONGPASS)\b/;
const OUTAGE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * true for an enqueue failure caused by the queue's Redis (an outage), not
 * by the row: a refused write (OOM, READONLY, MISCONF, LOADING…), a lost or
 * closed connection, ioredis giving up on a command, or our enqueue timeout.
 */
export function isQueueOutageError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'ReplyError') return OUTAGE_REPLY.test(error.message);
  if (error.name === 'MaxRetriesPerRequestError') return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && OUTAGE_CODES.has(code)) return true;
  return /Connection is closed|Stream isn't writeable|Command timed out/i.test(error.message);
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
  const outageRetryMs = options.outageRetryMs ?? 5000;
  const deadLetterReportMs = options.deadLetterReportMs ?? 5 * 60_000;
  const { logger } = ctx;
  const queues = options.queueSet ?? createQueueSet(ctx.queues, logger);
  let redisDown = false;
  let queueOutage = false;
  /** ctx.clock ms of the last successful dead-letter count (null: not yet). */
  let deadLettersCountedAt: number | null = null;

  const empty = (): OutboxDispatchSummary => ({
    claimed: 0,
    published: 0,
    jobs: 0,
    failed: 0,
    outage: 0,
    deadLettered: 0,
    redisDown: false,
  });

  const enqueue = async (row: OutboxEvent, now: Date): Promise<number> => {
    const jobs = (OUTBOX_ROUTES[row.type] ?? [])
      .map((route) => route(row, now))
      .filter((job): job is RoutedJob => job !== null);
    const jobId = outboxJobId(row);
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

  const reportDeadLetters = async (now: Date): Promise<void> => {
    if (
      deadLettersCountedAt !== null &&
      now.getTime() - deadLettersCountedAt < deadLetterReportMs
    ) {
      return;
    }
    const n = await countDeadLetteredOutbox(ctx.db, maxAttempts);
    // Only once the count succeeded: a failed count is tried again next run.
    deadLettersCountedAt = now.getTime();
    if (n > 0) {
      logger.error(
        { count: n, maxAttempts },
        'outbox has dead-lettered events (unpublished, attempts >= maxAttempts); they are not retried until redriven',
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

      const now = ctx.clock();
      await reportDeadLetters(now);
      return ctx.db.transaction(async (tx) => {
        const summary = empty();
        const rows = await claimOutboxBatch(tx, batchSize, { maxAttempts, now });
        summary.claimed = rows.length;
        const results = await Promise.allSettled(rows.map((row) => enqueue(row, now)));

        const published: bigint[] = [];
        for (const [i, result] of results.entries()) {
          const row = rows[i];
          if (row === undefined) continue;
          const key = row.id.toString();
          if (result.status === 'fulfilled') {
            published.push(row.id);
            summary.jobs += result.value;
            continue;
          }
          const error = message(result.reason);
          summary.failed += 1;
          if (isQueueOutageError(result.reason)) {
            summary.outage += 1;
            await markOutboxFailed(tx, row.id, error, {
              countAttempt: false,
              retryAt: new Date(now.getTime() + outageRetryMs),
            });
            continue;
          }
          const attempts = row.attempts + 1;
          if (attempts >= maxAttempts) {
            await markOutboxFailed(tx, row.id, error);
            summary.deadLettered += 1;
            logger.error(
              { outboxId: key, type: row.type, aggregateId: row.aggregateId, attempts, error },
              'outbox event dead-lettered: reached max attempts, it will not be retried',
            );
          } else {
            const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1));
            await markOutboxFailed(tx, row.id, error, {
              retryAt: new Date(now.getTime() + delay),
            });
            logger.warn(
              { outboxId: key, type: row.type, attempts, retryInMs: delay, error },
              'outbox event could not be queued; will retry',
            );
          }
        }
        await markOutboxPublished(tx, published);
        summary.published = published.length;

        if (summary.outage > 0 && !queueOutage) {
          queueOutage = true;
          logger.warn(
            { rows: summary.outage, retryInMs: outageRetryMs },
            'outbox dispatch: the queue redis refuses jobs (outage); rows are retried without using up attempts',
          );
        } else if (summary.outage === 0 && published.length > 0 && queueOutage) {
          queueOutage = false;
          logger.info('outbox dispatch: the queue redis takes jobs again');
        }
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
