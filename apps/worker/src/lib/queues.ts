import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** The BullMQ queues the outbox dispatcher feeds. */
export const QUEUE_NAMES = {
  /**
   * event.resulted / event.result_corrected: settle the event's bets;
   * market.resulted (a market resulted early in play): settle that market's bets.
   */
  settlement: 'settlement',
  /**
   * event.resulted / event.result_corrected / market.resulted: settle the
   * jackpot rounds with a game on that event (or 1X2 market) once complete.
   */
  jackpotSettlement: 'jackpot-settlement',
  /** bet.placed of a live bet: accept or reject it once its delay is over (delayed job). */
  betAcceptance: 'bet-acceptance',
  /** payment.withdrawal_approved: send the payout to the provider. */
  payouts: 'payouts',
  /** Player notifications by SMS (deposit credited, withdrawal paid / failed). */
  sms: 'sms',
  /** Player push messages (bet and wallet changes) on the player's Redis channel. */
  userNotify: 'user-notify',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Where the worker's BullMQ queues live. */
export interface QueueConfig {
  redisUrl: string;
  /** BullMQ key prefix (QUEUE_PREFIX, default 'vamos'; tests use a unique one). */
  prefix: string;
}

/** How long a finished job (and so its custom id) is kept: replays of the same id are no-ops. */
export const KEEP_COMPLETED = { age: 24 * 3600, count: 50_000 } as const;
export const KEEP_FAILED = { age: 7 * 24 * 3600 } as const;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
};

/** The queue prefix is in use by the worker of another database. */
export class QueuePrefixBoundError extends Error {
  constructor(
    readonly prefix: string,
    readonly boundTo: string,
    readonly installationId: string,
  ) {
    super(
      `queue prefix "${prefix}" belongs to database installation ${boundTo}, but this database is ` +
        `${installationId}. Its queues hold the other database's jobs: give each database its own ` +
        `QUEUE_PREFIX, or, if the old database is gone for good, delete the Redis keys "${prefix}:*".`,
    );
    this.name = 'QueuePrefixBoundError';
  }
}

/** Redis key recording which database installation a queue prefix belongs to. */
export const queuePrefixBindingKey = (prefix: string) => `${prefix}:installation`;

/**
 * Binds the BullMQ queue prefix to this database's installation id (first
 * use), or checks that it is bound to it. Two stacks (or a rebuilt database)
 * on one Redis with the same prefix would otherwise consume each other's
 * jobs against the wrong database. Throws QueuePrefixBoundError on a
 * mismatch; Redis errors are thrown as they are.
 */
export async function bindQueuePrefix(
  redis: Redis,
  prefix: string,
  installationId: string,
): Promise<{ bound: boolean }> {
  const key = queuePrefixBindingKey(prefix);
  const set = await redis.set(key, installationId, 'NX');
  if (set === 'OK') return { bound: true };
  const current = await redis.get(key);
  if (current !== null && current !== installationId) {
    throw new QueuePrefixBoundError(prefix, current, installationId);
  }
  if (current === null) return bindQueuePrefix(redis, prefix, installationId);
  return { bound: false };
}

/** Producer side: lazily created queues sharing one Redis connection. */
export interface QueueSet {
  get(name: QueueName): Queue;
  /** Resolves when Redis answers within `timeoutMs`, throws otherwise. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** QUIT when connected, otherwise just drop the connection (a QUIT would wait for a reconnect). */
async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') {
    await redis.quit().catch(() => redis.disconnect());
  } else {
    redis.disconnect();
  }
}

/** The error of withTimeout. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError after `ms` (the promise itself carries on; callers must tolerate a late success). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Queues for producing jobs. The connection fails commands fast
 * (maxRetriesPerRequest 1) instead of BullMQ's wait-forever default, so the
 * outbox dispatcher never holds its claimed rows (and their transaction)
 * open while Redis is down; it retries on its next run.
 */
export function createQueueSet(config: QueueConfig, logger: Logger): QueueSet {
  let connection: Redis | null = null;
  const queues = new Map<QueueName, Queue>();
  const conn = (): Redis => {
    if (connection === null) {
      connection = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
      connection.on('error', (error: unknown) =>
        logger.debug({ err: error }, 'queue redis connection error'),
      );
    }
    return connection;
  };
  return {
    get(name) {
      let queue = queues.get(name);
      if (queue === undefined) {
        queue = new Queue(name, {
          connection: conn(),
          prefix: config.prefix,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        });
        queue.on('error', (error: unknown) =>
          logger.debug({ err: error, queue: name }, 'queue error'),
        );
        queues.set(name, queue);
      }
      return queue;
    },
    async ping(timeoutMs = 2000) {
      await withTimeout(conn().ping(), timeoutMs, 'redis ping');
    },
    async close() {
      await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
      queues.clear();
      if (connection !== null) {
        const current = connection;
        connection = null;
        await closeRedis(current);
      }
    },
  };
}

export interface QueueWorker<Data, Result> {
  worker: Worker<Data, Result>;
  /**
   * Closes the worker (waiting for active jobs) and then its connection. When
   * that takes longer than the close timeout (Redis unreachable: BullMQ's
   * close never settles then), the connection is dropped and the worker
   * force-closed; unfinished jobs are picked up again as stalled jobs.
   */
  close(): Promise<void>;
}

/** Default time limit of QueueWorker.close(). */
export const WORKER_CLOSE_TIMEOUT_MS = 20_000;

export interface QueueWorkerOptions extends Omit<WorkerOptions, 'connection' | 'prefix'> {
  /** Time limit of close() before the worker is forced shut (default WORKER_CLOSE_TIMEOUT_MS). */
  closeTimeoutMs?: number;
}

/**
 * A BullMQ Worker on `name` with its own connection (BullMQ requires
 * maxRetriesPerRequest: null for a worker's blocking connection).
 */
export function createQueueWorker<Data, Result>(
  config: QueueConfig,
  name: QueueName,
  processor: Processor<Data, Result>,
  logger: Logger,
  options: QueueWorkerOptions = {},
): QueueWorker<Data, Result> {
  const { closeTimeoutMs = WORKER_CLOSE_TIMEOUT_MS, ...workerOptions } = options;
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error: unknown) =>
    logger.debug({ err: error, queue: name }, 'worker redis connection error'),
  );
  const worker = new Worker<Data, Result>(name, processor, {
    ...workerOptions,
    connection,
    prefix: config.prefix,
  });
  worker.on('error', (error: unknown) => logger.warn({ err: error, queue: name }, 'worker error'));
  worker.on('failed', (job, error) => {
    const exhausted = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
    logger[exhausted ? 'error' : 'warn'](
      { err: error, queue: name, jobId: job?.id, attempt: job?.attemptsMade, exhausted },
      exhausted ? 'job failed for good (kept in the failed set)' : 'job failed, will retry',
    );
  });
  return {
    worker,
    async close() {
      try {
        await withTimeout(worker.close(), closeTimeoutMs, `closing the ${name} worker`);
      } catch (error) {
        logger.warn(
          { err: error, queue: name },
          'queue worker did not close in time (redis unreachable?); forcing it shut',
        );
        connection.disconnect();
        await withTimeout(worker.close(true), 1000, `force-closing the ${name} worker`).catch(
          () => undefined,
        );
      } finally {
        await withTimeout(closeRedis(connection), 1000, 'closing redis').catch(() =>
          connection.disconnect(),
        );
      }
    },
  };
}
