import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bindQueuePrefix,
  createQueueWorker,
  QUEUE_NAMES,
  queuePrefixBindingKey,
  QueuePrefixBoundError,
} from '../src/lib/queues';
import { REDIS_URL } from './helpers';

const silent = pino({ level: 'silent' });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
const prefix = `vamos-test-${randomBytes(6).toString('hex')}-queues`;

afterAll(async () => {
  await redis.del(queuePrefixBindingKey(prefix));
  await redis.quit();
});

describe('createQueueWorker', () => {
  it('close() returns within its time limit when Redis is unreachable', async () => {
    const consumer = createQueueWorker(
      { redisUrl: 'redis://127.0.0.1:1', prefix },
      QUEUE_NAMES.settlement,
      async () => undefined,
      silent,
      { closeTimeoutMs: 300 },
    );
    // Let the worker try (and fail) to connect.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await consumer.close();
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);
});

describe('bindQueuePrefix', () => {
  it('binds a prefix to the first database and refuses another one', async () => {
    const mine = randomUUID();
    expect(await bindQueuePrefix(redis, prefix, mine)).toEqual({ bound: true });
    expect(await bindQueuePrefix(redis, prefix, mine)).toEqual({ bound: false });
    expect(await redis.get(queuePrefixBindingKey(prefix))).toBe(mine);
    const other = randomUUID();
    const error = await bindQueuePrefix(redis, prefix, other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueuePrefixBoundError);
    expect(error).toMatchObject({ prefix, boundTo: mine, installationId: other });
    expect((error as Error).message).toContain('QUEUE_PREFIX');
  });
});
