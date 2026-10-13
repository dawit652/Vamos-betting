import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '@vamos/config';
import { userChannelPattern, userIdOfChannel, type UserMessage } from '@vamos/contracts';
import type { SportCode } from '@vamos/core';
import {
  loadCatalogIds,
  seedCatalog,
  upsertFixture,
  type CatalogIds,
  type LiveMessage,
} from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import type { FeedFixture, MockFeedProvider } from '@vamos/feed';
import {
  createPaymentProviders,
  MockPaymentProvider,
  type PaymentProviderRegistry,
} from '@vamos/payments';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { MockSmsSender } from '../src/lib/sms';
import type { TaskContext } from '../src/tasks/context';

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

/** A clock that only moves when told to. */
export interface TestClock {
  now: Date;
  set(date: Date): void;
  advance(ms: number): void;
}

export interface WorkerTestContext {
  db: TestDatabase;
  redis: Redis;
  ids: CatalogIds;
  clock: TestClock;
  /** Unique live channel of this test file. */
  channel: string;
  /** Unique BullMQ key prefix of this test file (ctx.queues.prefix). */
  queuePrefix: string;
  /** Every LiveMessage received on `channel`, in order. */
  received: LiveMessage[];
  /** Unique prefix of the per-player channels of this test file (ctx.userChannelPrefix). */
  userChannelPrefix: string;
  /** Every UserMessage received on a player channel under `userChannelPrefix`, in order. */
  userMessages: Array<{ userId: string; message: UserMessage }>;
  ctx: TaskContext;
  /** The mock payment provider in ctx.payments (on the test clock). */
  mockPayments: MockPaymentProvider;
  /** Waits until `predicate` holds for the received messages (or fails after `ms`). */
  waitForMessages(predicate: (messages: LiveMessage[]) => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * A throwaway, migrated and catalogue-seeded database, a Redis client with a
 * unique key prefix, a subscriber on a unique live channel and a manual
 * clock. One per test file.
 */
export async function createWorkerTestContext(): Promise<WorkerTestContext> {
  const db = await createTestDatabase();
  await seedCatalog(db.db);
  const ids = await loadCatalogIds(db.db);
  const id = randomBytes(6).toString('hex');
  const redis = new Redis(REDIS_URL, { keyPrefix: `vamos-test:${id}:`, maxRetriesPerRequest: 2 });
  const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const channel = `vamos-test:${id}:live`;
  const queuePrefix = `vamos-test-${id}-bull`;
  const received: LiveMessage[] = [];
  subscriber.on('message', (from: string, payload: string) => {
    if (from === channel) received.push(JSON.parse(payload) as LiveMessage);
  });
  await subscriber.subscribe(channel);
  const userChannelPrefix = `vamos-test:${id}:user:`;
  const userMessages: WorkerTestContext['userMessages'] = [];
  subscriber.on('pmessage', (_pattern: string, from: string, payload: string) => {
    const userId = userIdOfChannel(from, userChannelPrefix);
    if (userId !== null) userMessages.push({ userId, message: JSON.parse(payload) as UserMessage });
  });
  await subscriber.psubscribe(userChannelPattern(userChannelPrefix));

  const clock: TestClock = {
    now: new Date(),
    set(date) {
      this.now = new Date(date.getTime());
    },
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const now = () => new Date(clock.now.getTime());
  const payments = testPaymentProviders(now);
  const mockPayments = payments.get('mock');
  if (!(mockPayments instanceof MockPaymentProvider)) throw new Error('mock provider missing');
  const ctx: TaskContext = {
    db: db.db,
    redis,
    logger: pino({ level: 'silent' }),
    clock: now,
    channel,
    userChannelPrefix,
    queues: { redisUrl: REDIS_URL, prefix: queuePrefix },
    payments,
    sms: new MockSmsSender(db.db),
  };

  return {
    db,
    redis,
    ids,
    clock,
    channel,
    queuePrefix,
    received,
    userChannelPrefix,
    userMessages,
    ctx,
    mockPayments,
    async waitForMessages(predicate, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!predicate(received)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for live messages (got ${received.length})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      await subscriber.quit();
      // ioredis does not prefix KEYS patterns; it does prefix the keys given to DEL.
      const prefix = `vamos-test:${id}:`;
      const keys = (await redis.keys(`${prefix}*`)).filter((key) => key.startsWith(prefix));
      if (keys.length > 0) await redis.del(...keys.map((key) => key.slice(prefix.length)));
      await redis.quit();
      await deleteQueueKeys(queuePrefix);
      db.pool.on('error', () => undefined);
      await db.drop();
    },
  };
}

/** The demo payment providers (the mock one only) on the given clock; no network. */
export function testPaymentProviders(clock: () => Date): PaymentProviderRegistry {
  return createPaymentProviders(loadConfig({ NODE_ENV: 'test' }), {
    fetch: () => Promise.reject(new Error('no network in tests')),
    clock,
    randomBytes: (size) => randomBytes(size),
  });
}

/** Deletes every BullMQ key under `prefix` (close Queues and Workers first). */
export async function deleteQueueKeys(prefix: string): Promise<void> {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  try {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(...keys);
  } finally {
    await client.quit();
  }
}

/** A FeedFixture between two seeded teams. */
export function feedFixture(
  sport: SportCode,
  competitionSlug: string,
  home: string,
  away: string,
  startTime: Date,
): FeedFixture {
  return {
    feedRef: `test:${randomUUID()}`,
    sport,
    competitionSlug,
    homeShortName: home,
    awayShortName: away,
    startTime,
  };
}

/** Inserts a fixture priced by the provider, as feed ingest would; returns the event id. */
export async function insertFixture(
  t: WorkerTestContext,
  provider: MockFeedProvider,
  fixture: FeedFixture,
  feedProvider: string,
): Promise<string> {
  const lookup = (map: Map<string, string>, key: string) => {
    const value = map.get(key);
    if (value === undefined) throw new Error(`not seeded: ${key}`);
    return value;
  };
  const result = await t.db.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider,
        feedRef: fixture.feedRef,
        sport: fixture.sport,
        competitionId: lookup(t.ids.competitions, `${fixture.sport}/${fixture.competitionSlug}`),
        homeTeamId: lookup(t.ids.teams, `${fixture.sport}/${fixture.homeShortName}`),
        awayTeamId: lookup(t.ids.teams, `${fixture.sport}/${fixture.awayShortName}`),
        startTime: fixture.startTime,
      },
      provider.price(fixture),
    ),
  );
  return result.eventId;
}

/** Hook and test timeouts: integration tests create and migrate a database. */
export const SETUP_TIMEOUT = 60_000;
export const TEST_TIMEOUT = 30_000;
