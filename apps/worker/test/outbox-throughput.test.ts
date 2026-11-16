import { randomUUID } from 'node:crypto';
import {
  BET_PLACED,
  enqueueOutbox,
  EVENT_RESULTED,
  readOutboxBacklog,
  schema,
  WITHDRAWAL_APPROVED,
} from '@vamos/db';
import { Queue } from 'bullmq';
import { isNull, sql } from 'drizzle-orm';
import { ReplyError } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES, type QueueSet } from '../src/lib/queues';
import {
  createOutboxDispatcher,
  outboxDispatchTask,
  outboxJobId,
} from '../src/tasks/outbox-dispatch';
import {
  createWorkerTestContext,
  REDIS_URL,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/**
 * The outbox is the one path from a committed change to every queue: a live bet's acceptance, a
 * payout, a result to settle, a notification. A burst (a busy minute of bets, the settlement of
 * an evening's matches) must drain at the pace the queues take jobs, and must not hold a payout
 * back for minutes. Task A9 of docs/plans/scale-and-payments-plan.md.
 */

let t: WorkerTestContext;
let payoutsQueue: Queue;

const BURST = 3000;

beforeAll(async () => {
  t = await createWorkerTestContext();
  payoutsQueue = new Queue(QUEUE_NAMES.payouts, {
    connection: { url: REDIS_URL },
    prefix: t.queuePrefix,
  });
  // Rows written while seeding are not part of this test.
  await t.db.db.update(schema.outboxEvents).set({ publishedAt: new Date() });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await payoutsQueue?.close();
  await t?.close();
}, SETUP_TIMEOUT);

// No test leaves rows for the next one.
afterEach(async () => {
  await t.db.db
    .update(schema.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(schema.outboxEvents.publishedAt));
});

/** Rows of a type without a route: published without a job. */
async function plainRows(count: number): Promise<void> {
  await t.db.db.insert(schema.outboxEvents).values(
    Array.from({ length: count }, (_, i) => ({
      type: 'user.registered',
      aggregateType: 'user',
      aggregateId: `u${i}`,
      payload: { userId: `u${i}` },
    })),
  );
}

async function unpublished(): Promise<number> {
  const [row] = await t.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.outboxEvents)
    .where(isNull(schema.outboxEvents.publishedAt));
  return row?.n ?? 0;
}

describe('outbox dispatcher under a burst', () => {
  it(`drains ${BURST} rows in seconds, and a payout approved behind them is queued in seconds`, async () => {
    // A burst of accepted pre-match bets (each routes one user-notify job)...
    for (let start = 0; start < BURST; start += 500) {
      await t.db.db.insert(schema.outboxEvents).values(
        Array.from({ length: Math.min(500, BURST - start) }, () => ({
          type: BET_PLACED,
          aggregateType: 'bet',
          aggregateId: randomUUID(),
          payload: {
            betId: randomUUID(),
            userId: randomUUID(),
            status: 'open',
            acceptAfter: null,
          },
        })),
      );
    }
    // ...and, behind all of them, a withdrawal that staff has just approved.
    const payoutId = randomUUID();
    const approvedId = await enqueueOutbox(t.db.db, {
      type: WITHDRAWAL_APPROVED,
      aggregateType: 'payout',
      aggregateId: payoutId,
      payload: { payoutId },
    });
    const [approved] = await t.db.db
      .select()
      .from(schema.outboxEvents)
      .where(sql`${schema.outboxEvents.id} = ${approvedId}`);
    if (approved === undefined) throw new Error('approved row not found');
    const jobId = outboxJobId(approved);

    const task = outboxDispatchTask(t.ctx);
    const startedAt = Date.now();
    let payoutQueuedMs: number | null = null;
    let drainedMs: number | null = null;
    await task.start();
    try {
      const deadline = startedAt + 60_000;
      while (Date.now() < deadline && (payoutQueuedMs === null || drainedMs === null)) {
        if (payoutQueuedMs === null && (await payoutsQueue.getJob(jobId)) !== undefined) {
          payoutQueuedMs = Date.now() - startedAt;
        }
        if (drainedMs === null && (await unpublished()) === 0) {
          drainedMs = Date.now() - startedAt;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await task.stop();
    }

    expect(payoutQueuedMs).not.toBeNull();
    expect(drainedMs).not.toBeNull();
    // One batch a second (the old behaviour) needed 30 s for this burst; a drain takes about a
    // third of a second on the development container (about 9,000 rows a second).
    expect(drainedMs ?? Infinity).toBeLessThan(10_000);
    expect(payoutQueuedMs ?? Infinity).toBeLessThan(10_000);
  }, 90_000);

  it(
    'readOutboxBacklog counts what waits and how long the oldest row has waited',
    async () => {
      expect(await readOutboxBacklog(t.db.db)).toEqual({ unpublished: 0, oldestSeconds: 0 });
      await plainRows(3);
      await t.db.db
        .update(schema.outboxEvents)
        .set({ createdAt: sql`now() - interval '90 seconds'` })
        .where(
          sql`${schema.outboxEvents.id} = (select min(id) from outbox_events where published_at is null)`,
        );
      const backlog = await readOutboxBacklog(t.db.db);
      expect(backlog.unpublished).toBe(3);
      expect(backlog.oldestSeconds).toBeGreaterThanOrEqual(90);
      expect(backlog.oldestSeconds).toBeLessThan(120);
    },
    TEST_TIMEOUT,
  );

  it(
    'a drain takes batch after batch until one is not full, and no more than maxBatchesPerDrain',
    async () => {
      await plainRows(10);
      const dispatcher = createOutboxDispatcher(t.ctx, { batchSize: 2, maxBatchesPerDrain: 3 });
      try {
        // Three full batches, then the turn goes back to the interval.
        expect(await dispatcher.drain()).toMatchObject({ claimed: 6, published: 6 });
        expect(await unpublished()).toBe(4);
        // Two full batches and an empty one: nothing more is due.
        expect(await dispatcher.drain()).toMatchObject({ claimed: 4, published: 4 });
        expect(await dispatcher.drain()).toMatchObject({ claimed: 0, published: 0 });
        expect(await unpublished()).toBe(0);
      } finally {
        await dispatcher.close();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'a drain asked to stop finishes its batch and takes no other',
    async () => {
      await plainRows(6);
      const dispatcher = createOutboxDispatcher(t.ctx, { batchSize: 2 });
      try {
        expect(await dispatcher.drain(() => true)).toMatchObject({ claimed: 2, published: 2 });
        expect(await unpublished()).toBe(4);
      } finally {
        await dispatcher.close();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'a drain stops at the first batch a refusing Redis turns down, without using up attempts',
    async () => {
      for (let i = 0; i < 6; i += 1) {
        await enqueueOutbox(t.db.db, {
          type: EVENT_RESULTED,
          aggregateType: 'event',
          aggregateId: `00000000-0000-4000-8000-00000000010${i}`,
          payload: { eventId: `00000000-0000-4000-8000-00000000010${i}`, status: 'finished' },
        });
      }
      let added = 0;
      const Reply = ReplyError as unknown as new (message: string) => Error;
      const refusing: QueueSet = {
        get: () =>
          ({
            add: async () => {
              added += 1;
              throw new Reply("OOM command not allowed when used memory > 'maxmemory'.");
            },
          }) as unknown as ReturnType<QueueSet['get']>,
        ping: async () => undefined,
        close: async () => undefined,
      };
      const dispatcher = createOutboxDispatcher(t.ctx, { batchSize: 2, queueSet: refusing });
      try {
        const summary = await dispatcher.drain();
        expect(summary).toMatchObject({ claimed: 2, published: 0, failed: 2, outage: 2 });
        // One batch only: the other four rows were not even tried.
        expect(added).toBeLessThanOrEqual(4);
        const rows = await t.db.db
          .select({ attempts: schema.outboxEvents.attempts })
          .from(schema.outboxEvents)
          .where(isNull(schema.outboxEvents.publishedAt));
        expect(rows).toHaveLength(6);
        expect(rows.every((row) => row.attempts === 0)).toBe(true);
      } finally {
        await dispatcher.close();
      }
    },
    TEST_TIMEOUT,
  );
});
