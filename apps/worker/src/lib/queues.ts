import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** The BullMQ queues the outbox dispatcher feeds. */
export const QUEUE_NAMES = {
  /** event.resulted / event.result_corrected: settle the event's bets. */
  settlement: 'settlement',
  /** bet.placed of a live bet: accept or reject it once its delay is over (delayed job). */
  betAcceptance: 'bet-acceptance',
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

/** Rejects after `ms` (the promise itself carries on; callers must tolerate a late success). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
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
  /** Closes the worker (waiting for active jobs) and then its connection. */
  close(): Promise<void>;
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
  options: Omit<WorkerOptions, 'connection' | 'prefix'> = {},
): QueueWorker<Data, Result> {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error: unknown) =>
    logger.debug({ err: error, queue: name }, 'worker redis connection error'),
  );
  const worker = new Worker<Data, Result>(name, processor, {
    ...options,
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
        await worker.close();
      } finally {
        await closeRedis(connection);
      }
    },
  };
}
