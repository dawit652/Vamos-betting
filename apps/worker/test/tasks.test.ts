import { randomBytes } from 'node:crypto';
import { loadConfig } from '@vamos/config';
import type { Database, LiveMessage } from '@vamos/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { intervalTask } from '../src/lib/interval';
import { tryLock } from '../src/lib/lock';
import { publish, publishAfterCommit } from '../src/lib/publish';
import { createTasks } from '../src/tasks/index';
import { REDIS_URL } from './helpers';

const silent = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let redis: Redis;
let subscriber: Redis;
const id = randomBytes(6).toString('hex');
const channel = `vamos-test:${id}:live`;
const received: string[] = [];

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { keyPrefix: `vamos-test:${id}:`, maxRetriesPerRequest: 2 });
  subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  subscriber.on('message', (from: string, payload: string) => {
    if (from === channel) received.push(payload);
  });
  await subscriber.subscribe(channel);
});

afterAll(async () => {
  await subscriber.quit();
  await redis.quit();
});

describe('publish', () => {
  it('sends every message, in order, as JSON on the channel', async () => {
    const messages: LiveMessage[] = [
      { type: 'odds', eventId: 'e1', data: { s: 's1', o: 1850, st: 'open' } },
      { type: 'market', eventId: 'e1', data: { k: 'm1', st: 'suspended' } },
      {
        type: 'match',
        eventId: 'e1',
        data: { e: 'e1', m: 12, p: '1H', sc: [1, 0], st: 'live', b: true },
      },
    ];
    expect(await publish(redis, [], channel)).toBe(0);
    expect(await publish(redis, messages, channel)).toBe(3);
    for (let i = 0; i < 100 && received.length < 3; i++) await sleep(10);
    expect(received.map((payload) => JSON.parse(payload) as unknown)).toEqual(messages);
  });

  it('logs instead of throwing after a commit when Redis fails', async () => {
    const broken = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
    broken.disconnect();
    const warnings: string[] = [];
    const sent = await publishAfterCommit(
      broken,
      [{ type: 'market', eventId: 'e1', data: { k: 'm1', st: 'open' } }],
      channel,
      { warn: (_obj, msg) => warnings.push(msg) },
    );
    expect(sent).toBe(0);
    expect(warnings).toEqual(['publishing live deltas failed']);
  });
});

describe('tryLock', () => {
  it('is exclusive until released, and release only frees our own lock', async () => {
    const key = 'lock:test';
    const first = await tryLock(redis, key, 10_000);
    expect(first).not.toBeNull();
    expect(await tryLock(redis, key, 10_000)).toBeNull();
    expect(await first!.release()).toBe(true);
    expect(await first!.release()).toBe(false);

    const expiring = await tryLock(redis, key, 20);
    await sleep(40);
    const next = await tryLock(redis, key, 10_000);
    expect(next).not.toBeNull();
    // The expired holder cannot release the new holder's lock.
    expect(await expiring!.release()).toBe(false);
    expect(await redis.get(key)).toBe(next!.token);
    await next!.release();
    await expect(tryLock(redis, key, 0)).rejects.toThrow(RangeError);
  });
});

describe('intervalTask', () => {
  it('runs at start and then every interval, never overlapping, until stopped', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const task = intervalTask({
      name: 'test',
      intervalMs: 15,
      logger: silent,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        await sleep(25);
        active--;
      },
    });
    await task.start();
    await sleep(120);
    await task.stop();
    const stoppedAt = runs;
    expect(active).toBe(0);
    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBe(1);
    await sleep(60);
    expect(runs).toBe(stoppedAt);
  });

  it('keeps its schedule after a failed run and runs on demand', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const logger = pino({ level: 'error' }, { write: (line: string) => errors.push(line) });
    const task = intervalTask({
      name: 'flaky',
      intervalMs: 10,
      logger,
      runOnStart: false,
      run: async () => {
        runs++;
        if (runs === 1) throw new Error('boom');
      },
    });
    await task.runNow();
    expect(runs).toBe(1);
    expect(errors).toHaveLength(1);
    await task.start();
    await sleep(60);
    await task.stop();
    expect(runs).toBeGreaterThan(2);
  });
});

describe('createTasks', () => {
  const ctx = {
    db: {} as Database,
    redis,
    logger: silent,
    clock: () => new Date(),
    channel,
  };

  it('runs the simulated feed only with the mock feed provider in demo mode', () => {
    expect(createTasks(loadConfig({ FEED_PROVIDER: 'mock' }), ctx).map((t) => t.name)).toEqual([
      'feed-ingest',
      'live-sim',
      'prematch-drift',
    ]);
    expect(createTasks(loadConfig({ FEED_PROVIDER: 'manual' }), ctx)).toEqual([]);
  });
});
