import type { Database } from '@vamos/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { QueueConfig } from '../lib/queues';

/** What the worker tasks need from the outside world (tests pass their own). */
export interface TaskContext {
  db: Database;
  redis: Redis;
  logger: Logger;
  /** Current time. Tasks read the time only from here. */
  clock: () => Date;
  /** Redis channel for live deltas (LIVE_CHANNEL; tests use a unique one). */
  channel: string;
  /** BullMQ queues (settlement, live bet acceptance); tests use a unique prefix. */
  queues: QueueConfig;
}
