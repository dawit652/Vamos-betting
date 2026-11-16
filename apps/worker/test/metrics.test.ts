import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/lib/health';
import {
  bearerMatches,
  cachedQueueMetrics,
  readQueueSnapshots,
  renderQueueMetrics,
} from '../src/lib/metrics';
import { createQueueSet, QUEUE_NAMES, type QueueSet } from '../src/lib/queues';
import { deleteQueueKeys, REDIS_URL, SETUP_TIMEOUT } from './helpers';

const logger = pino({ level: 'silent' });
const PREFIX = `vamos-test-${randomBytes(6).toString('hex')}-metrics`;
const TOKEN = 'm'.repeat(32);

describe('queue metrics', () => {
  let queues: QueueSet;
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    queues = createQueueSet({ redisUrl: REDIS_URL, prefix: PREFIX }, logger);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await queues.close();
    await redis.quit();
    await deleteQueueKeys(PREFIX);
  }, SETUP_TIMEOUT);

  it('reports depth by state and the age of the oldest waiting job', async () => {
    const payouts = queues.get(QUEUE_NAMES.payouts);
    const sms = queues.get(QUEUE_NAMES.sms);
    await payouts.add('old', { n: 1 }, { jobId: 'old' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await payouts.add('new', { n: 2 }, { jobId: 'new' });
    await sms.add('later', { n: 3 }, { jobId: 'later', delay: 60_000 });

    // A clock 90 s after the oldest job was created.
    const old = await payouts.getJob('old');
    const now = new Date((old?.timestamp ?? 0) + 90_500);
    const snapshots = await readQueueSnapshots(queues, now);

    expect(snapshots.map((snapshot) => snapshot.queue).sort()).toEqual(
      Object.values(QUEUE_NAMES).sort(),
    );
    expect(snapshots.find((snapshot) => snapshot.queue === 'payouts')).toEqual({
      queue: 'payouts',
      waiting: 2,
      active: 0,
      delayed: 0,
      failed: 0,
      oldestWaitingSeconds: 90,
    });
    // A delayed job is not waiting: no age, but it is counted.
    expect(snapshots.find((snapshot) => snapshot.queue === 'sms')).toMatchObject({
      waiting: 0,
      delayed: 1,
      oldestWaitingSeconds: 0,
    });
    expect(snapshots.find((snapshot) => snapshot.queue === 'aml')).toMatchObject({
      waiting: 0,
      oldestWaitingSeconds: 0,
    });
  });

  it('serves /metrics on the health port only with the token', async () => {
    const withToken = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      checks: [],
      metrics: { token: TOKEN, render: cachedQueueMetrics(queues, () => new Date()) },
    });
    const without = await startHealthServer({ host: '127.0.0.1', port: 0, logger, checks: [] });
    try {
      const url = `http://127.0.0.1:${withToken.port}/metrics`;
      expect((await fetch(url)).status).toBe(401);
      const wrong = await fetch(url, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('www-authenticate')).toBe('Bearer');

      const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
      const body = await ok.text();
      expect(body).toContain('# TYPE queue_jobs gauge');
      expect(body).toContain('queue_jobs{queue="payouts",state="waiting"} 2');
      expect(body).toMatch(/queue_oldest_waiting_seconds\{queue="payouts"\} \d+/);
      expect(body.endsWith('\n')).toBe(true);
      // /health is unchanged.
      expect((await fetch(`http://127.0.0.1:${withToken.port}/health`)).status).toBe(200);

      // No METRICS_TOKEN: the route does not exist.
      expect((await fetch(`http://127.0.0.1:${without.port}/metrics`)).status).toBe(404);
    } finally {
      await withToken.close();
      await without.close();
    }
  });

  it('answers 503 when the queues cannot be read, and reads again next time', async () => {
    let fail = true;
    const render = cachedQueueMetrics(
      {
        get: (name) => {
          if (fail) throw new Error('redis down');
          return queues.get(name);
        },
      },
      () => new Date(),
    );
    await expect(render()).rejects.toThrow('redis down');
    fail = false;
    await expect(render()).resolves.toContain('queue_jobs');
  });
});

describe('metrics helpers', () => {
  it('renders the gauges of every queue', () => {
    const text = renderQueueMetrics([
      { queue: 'sms', waiting: 3, active: 1, delayed: 0, failed: 2, oldestWaitingSeconds: 42 },
    ]);
    expect(text).toBe(
      [
        '# HELP queue_jobs Jobs per worker queue by state (waiting: ready to be taken; delayed: not due yet).',
        '# TYPE queue_jobs gauge',
        'queue_jobs{queue="sms",state="waiting"} 3',
        'queue_jobs{queue="sms",state="active"} 1',
        'queue_jobs{queue="sms",state="delayed"} 0',
        'queue_jobs{queue="sms",state="failed"} 2',
        '# HELP queue_oldest_waiting_seconds Age of the oldest waiting job per worker queue (0: none waiting).',
        '# TYPE queue_oldest_waiting_seconds gauge',
        'queue_oldest_waiting_seconds{queue="sms"} 42',
        '',
      ].join('\n'),
    );
  });

  it('matches only the exact bearer token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});
