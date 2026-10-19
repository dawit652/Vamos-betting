import { randomBytes } from 'node:crypto';
import { NOOP_TELEMETRY, type Telemetry } from '@vamos/config';
import { createTestDatabase } from '@vamos/db/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHealthServer, workerReadinessChecks, type HealthServer } from '../src/lib/health';
import {
  createQueueWorker,
  queueWorkerStatuses,
  QUEUE_NAMES,
  setQueueTelemetry,
  type QueueWorkerStatus,
} from '../src/lib/queues';
import { deleteQueueKeys, REDIS_URL, SETUP_TIMEOUT, type TestDatabase } from './helpers';

const logger = pino({ level: 'silent' });
const PREFIX = `vamos-test-${randomBytes(6).toString('hex')}-health`;

async function get(server: HealthServer, path: string, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('worker health server', () => {
  let database: TestDatabase;
  let redis: Redis;
  let deadRedis: Redis;

  beforeAll(async () => {
    database = await createTestDatabase();
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    // Nothing listens on port 1: every command fails at once.
    deadRedis = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => undefined);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await redis.quit();
    deadRedis.disconnect();
    await database.drop();
    await deleteQueueKeys(PREFIX);
  }, SETUP_TIMEOUT);

  it('answers /health while up and /ready when the database, Redis and queues are', async () => {
    let queues: QueueWorkerStatus[] = [{ queue: 'settlement', running: true, connected: true }];
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      checks: workerReadinessChecks({ db: database.db, redis, queues: () => queues }),
    });
    try {
      expect(await get(server, '/health')).toEqual({
        status: 200,
        body: { status: 'ok', service: 'vamos-worker' },
      });
      expect(await get(server, '/ready')).toEqual({
        status: 200,
        body: {
          status: 'ok',
          checks: { database: { ok: true }, redis: { ok: true }, queues: { ok: true } },
        },
      });
      // A consumer that lost its connection makes the worker unready (but still alive).
      queues = [
        { queue: 'settlement', running: true, connected: true },
        { queue: 'payouts', running: true, connected: false },
      ];
      const unready = await get(server, '/ready');
      expect(unready.status).toBe(503);
      expect(unready.body).toMatchObject({
        status: 'unavailable',
        checks: { queues: { ok: false, error: 'not connected: payouts' } },
      });
      expect((await get(server, '/health')).status).toBe(200);
      expect((await get(server, '/nope')).status).toBe(404);
      expect((await get(server, '/ready', 'POST')).status).toBe(405);

      // Shutdown begins: /ready answers 503 draining at once.
      queues = [];
      server.markDraining();
      expect(await get(server, '/ready')).toEqual({
        status: 503,
        body: { status: 'draining', checks: {} },
      });
    } finally {
      await server.close();
    }
  });

  it('reports an unreachable Redis or database', async () => {
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      timeoutMs: 500,
      checks: workerReadinessChecks({
        db: { execute: () => Promise.reject(new Error('connection refused')) },
        redis: deadRedis,
        queues: () => [],
      }),
    });
    try {
      const report = await get(server, '/ready');
      expect(report.status).toBe(503);
      expect(report.body).toMatchObject({
        status: 'unavailable',
        checks: {
          database: { ok: false, error: 'connection refused' },
          redis: { ok: false },
          queues: { ok: true },
        },
      });
    } finally {
      await server.close();
    }
  });

  it('tracks the queue consumers and gives each job a consumer span', async () => {
    const spans: Array<{ name: string; attributes: Record<string, unknown>; error: boolean }> = [];
    const telemetry: Telemetry = {
      enabled: true,
      startSpan: (name, options = {}) => {
        const span = { name, attributes: { ...options.attributes }, error: false };
        spans.push(span);
        return {
          traceId: null,
          setAttributes: () => undefined,
          recordError: () => {
            span.error = true;
          },
          end: () => undefined,
        };
      },
      shutdown: () => Promise.resolve(),
    };
    setQueueTelemetry(telemetry);
    const config = { redisUrl: REDIS_URL, prefix: PREFIX };
    const processed: string[] = [];
    const consumer = createQueueWorker<{ n: number }, number>(
      config,
      QUEUE_NAMES.sms,
      async (job) => {
        processed.push(job.id ?? '');
        if (job.data.n < 0) throw new Error('negative');
        return job.data.n;
      },
      logger,
    );
    const producer = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(QUEUE_NAMES.sms, {
      connection: producer,
      prefix: PREFIX,
    });
    try {
      await consumer.worker.waitUntilReady();
      await expect
        .poll(() => queueWorkerStatuses().find((status) => status.queue === QUEUE_NAMES.sms))
        .toEqual({ queue: QUEUE_NAMES.sms, running: true, connected: true });
      await queue.add('ok', { n: 1 }, { jobId: 'job-ok' });
      await queue.add('bad', { n: -1 }, { jobId: 'job-bad', attempts: 1 });
      await expect.poll(() => processed.length, { timeout: 10_000 }).toBe(2);
      await expect.poll(() => spans.length).toBe(2);
      const ok = spans.find((span) => span.attributes['messaging.message.id'] === 'job-ok');
      const bad = spans.find((span) => span.attributes['messaging.message.id'] === 'job-bad');
      expect(ok).toMatchObject({
        name: 'sms process',
        error: false,
        attributes: { 'messaging.system': 'bullmq', 'vamos.job.attempt': 1 },
      });
      expect(bad?.error).toBe(true);
    } finally {
      setQueueTelemetry(NOOP_TELEMETRY);
      await consumer.close();
      await queue.close();
      await producer.quit().catch(() => undefined);
    }
    // A closed consumer is no longer counted.
    expect(queueWorkerStatuses().some((status) => status.queue === QUEUE_NAMES.sms)).toBe(false);
  });
});
