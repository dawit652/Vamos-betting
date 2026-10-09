import {
  BET_PLACED,
  enqueueOutbox,
  EVENT_RESULTED,
  redriveOutboxEvents,
  schema,
  type Database,
} from '@vamos/db';
import { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { ReplyError } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES, TimeoutError, type QueueSet } from '../src/lib/queues';
import {
  createOutboxDispatcher,
  isQueueOutageError,
  outboxDispatchTask,
  outboxJobId,
  type BetAcceptanceJobData,
  type SettlementJobData,
} from '../src/tasks/outbox-dispatch';
import {
  createWorkerTestContext,
  REDIS_URL,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

let t: WorkerTestContext;
let settlementQueue: Queue;
let acceptanceQueue: Queue;

beforeAll(async () => {
  t = await createWorkerTestContext();
  const opts = { connection: { url: REDIS_URL }, prefix: t.queuePrefix };
  settlementQueue = new Queue(QUEUE_NAMES.settlement, opts);
  acceptanceQueue = new Queue(QUEUE_NAMES.betAcceptance, opts);
  // Rows written while seeding are not part of these tests.
  await t.db.db.update(schema.outboxEvents).set({ publishedAt: new Date() });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await settlementQueue?.close();
  await acceptanceQueue?.close();
  await t?.close();
}, SETUP_TIMEOUT);

async function outboxRow(id: bigint) {
  const [row] = await t.db.db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.id, id));
  if (row === undefined) throw new Error(`outbox row ${id} not found`);
  return row;
}

async function enqueue(type: string, aggregateType: string, payload: Record<string, unknown>) {
  const aggregateId = (payload.eventId ?? payload.betId ?? 'x') as string;
  return enqueueOutbox(t.db.db, { type, aggregateType, aggregateId, payload });
}

/** An ioredis ReplyError (the error of a command Redis refused), typed. */
function replyError(text: string): Error {
  const Reply = ReplyError as unknown as new (message: string) => Error;
  return new Reply(text);
}

function capturingLogger() {
  const lines: Array<{ level: number; msg: string } & Record<string, unknown>> = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as (typeof lines)[number]) },
  );
  return { logger, lines };
}

describe('outbox dispatcher', () => {
  it(
    'routes each row to its queue by type, marks every row published and never queues a row twice',
    async () => {
      const eventId = '00000000-0000-4000-8000-000000000001';
      const acceptAfter = new Date(t.clock.now.getTime() + 4000);
      const resulted = await enqueue(EVENT_RESULTED, 'event', {
        eventId,
        status: 'finished',
        score: { home: 1, away: 0 },
      });
      const pending = await enqueue(BET_PLACED, 'bet', {
        betId: 'bet-pending',
        status: 'pending_acceptance',
        acceptAfter,
      });
      const open = await enqueue(BET_PLACED, 'bet', {
        betId: 'bet-open',
        status: 'open',
        acceptAfter: null,
      });
      const other = await enqueue('user.registered', 'user', { userId: 'u1' });

      const dispatcher = createOutboxDispatcher(t.ctx);
      try {
        const first = await dispatcher.run();
        expect(first).toMatchObject({
          claimed: 4,
          published: 4,
          jobs: 2,
          failed: 0,
          redisDown: false,
        });
        for (const id of [resulted, pending, open, other]) {
          expect((await outboxRow(id)).publishedAt).not.toBeNull();
        }

        const settle = await settlementQueue.getJob(outboxJobId(await outboxRow(resulted)));
        expect(settle?.name).toBe(EVENT_RESULTED);
        expect(settle?.data as SettlementJobData).toEqual({
          outboxId: resulted.toString(),
          type: EVENT_RESULTED,
          eventId,
        });
        const accept = await acceptanceQueue.getJob(outboxJobId(await outboxRow(pending)));
        expect(accept?.data as BetAcceptanceJobData).toEqual({
          outboxId: pending.toString(),
          betId: 'bet-pending',
          acceptAfter: acceptAfter.toISOString(),
        });
        expect(accept?.opts.delay).toBe(4000);
        expect(await accept?.getState()).toBe('delayed');
        expect(await acceptanceQueue.getJob(outboxJobId(await outboxRow(open)))).toBeUndefined();
        expect(settle?.id).toBe(`outbox-${resulted}-${(await outboxRow(resulted)).jobKey}`);

        // A second run finds nothing to do.
        expect(await dispatcher.run()).toMatchObject({ claimed: 0, published: 0, jobs: 0 });

        // A row dispatched again (crash between the enqueue and the COMMIT) maps to the same job.
        await t.db.db
          .update(schema.outboxEvents)
          .set({ publishedAt: null })
          .where(inArray(schema.outboxEvents.id, [resulted, pending]));
        const counts = async () => ({
          settlement: await settlementQueue.count(),
          acceptance: await acceptanceQueue.count(),
        });
        const before = await counts();
        expect(await dispatcher.run()).toMatchObject({ claimed: 2, published: 2, jobs: 2 });
        expect(await counts()).toEqual(before);
        expect(before).toEqual({ settlement: 1, acceptance: 1 });
      } finally {
        await dispatcher.close();
        await settlementQueue.obliterate({ force: true });
        await acceptanceQueue.obliterate({ force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'claims nothing while Redis is unreachable, so attempts are not used up',
    async () => {
      const id = await enqueue('user.registered', 'user', { userId: 'u2' });
      const { logger, lines } = capturingLogger();
      const dispatcher = createOutboxDispatcher({
        ...t.ctx,
        logger,
        queues: { redisUrl: 'redis://127.0.0.1:1', prefix: t.queuePrefix },
      });
      try {
        expect(await dispatcher.run()).toMatchObject({ redisDown: true, claimed: 0 });
        expect(await dispatcher.run()).toMatchObject({ redisDown: true, claimed: 0 });
      } finally {
        await dispatcher.close();
      }
      const row = await outboxRow(id);
      expect(row).toMatchObject({ publishedAt: null, attempts: 0 });
      expect(lines.filter((l) => l.msg.includes('redis unreachable'))).toHaveLength(1);

      const healthy = createOutboxDispatcher(t.ctx);
      try {
        expect(await healthy.run()).toMatchObject({ claimed: 1, published: 1 });
      } finally {
        await healthy.close();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'backs off a row that cannot be queued (stored in the row) and dead-letters it at maxAttempts',
    async () => {
      const bad = await enqueue(BET_PLACED, 'bet', { status: 'pending_acceptance' });
      const fine = await enqueue('user.registered', 'user', { userId: 'u3' });
      const { logger, lines } = capturingLogger();
      const dispatcher = createOutboxDispatcher(
        { ...t.ctx, logger },
        { maxAttempts: 3, backoffBaseMs: 1000 },
      );
      try {
        expect(await dispatcher.run()).toMatchObject({ claimed: 2, published: 1, failed: 1 });
        expect((await outboxRow(fine)).publishedAt).not.toBeNull();
        let row = await outboxRow(bad);
        expect(row.attempts).toBe(1);
        expect(row.lastError).toContain('ZodError');
        expect(row.nextAttemptAt).toEqual(new Date(t.clock.now.getTime() + 1000));

        // Within the backoff (1 s after the first failure) the row is not even claimed.
        t.clock.advance(500);
        expect(await dispatcher.run()).toMatchObject({ claimed: 0, failed: 0 });
        t.clock.advance(500);
        expect(await dispatcher.run()).toMatchObject({ failed: 1, deadLettered: 0 });
        expect((await outboxRow(bad)).attempts).toBe(2);
        // The second backoff is 2 s, honoured by any dispatcher (it is stored in the row).
        t.clock.advance(1000);
        const other = createOutboxDispatcher(t.ctx, { maxAttempts: 3 });
        try {
          expect(await other.run()).toMatchObject({ claimed: 0 });
        } finally {
          await other.close();
        }
        t.clock.advance(1000);
        expect(await dispatcher.run()).toMatchObject({ failed: 1, deadLettered: 1 });
        row = await outboxRow(bad);
        expect(row).toMatchObject({ attempts: 3, publishedAt: null });

        // Dead-lettered: never claimed again.
        t.clock.advance(60_000);
        expect(await dispatcher.run()).toMatchObject({ claimed: 0 });
        const dead = lines.filter((l) => l.msg.includes('dead-lettered: reached max attempts'));
        expect(dead).toHaveLength(1);
        expect(dead[0]).toMatchObject({ outboxId: bad.toString(), type: BET_PLACED, attempts: 3 });
      } finally {
        await dispatcher.close();
      }

      // A new dispatcher (a restart) reports the dead letters at its first run, then
      // again only every deadLetterReportMs.
      const restarted = capturingLogger();
      const again = createOutboxDispatcher(
        { ...t.ctx, logger: restarted.logger },
        { maxAttempts: 3, deadLetterReportMs: 60_000 },
      );
      const reported = () => restarted.lines.filter((l) => l.msg.includes('dead-lettered events'));
      try {
        await again.run();
        await again.run();
        expect(reported()).toHaveLength(1);
        expect(reported()[0]).toMatchObject({ count: 1 });
        t.clock.advance(60_000);
        await again.run();
        expect(reported()).toHaveLength(2);
      } finally {
        await again.close();
      }

      // Redriven, the row is queued again (and fails again: its payload is still bad).
      expect(await redriveOutboxEvents(t.db.db, [bad])).toEqual([bad]);
      const redriven = createOutboxDispatcher(t.ctx, { maxAttempts: 3 });
      try {
        expect(await redriven.run()).toMatchObject({ claimed: 1, failed: 1 });
        expect((await outboxRow(bad)).attempts).toBe(1);
      } finally {
        await redriven.close();
      }
      await t.db.db
        .update(schema.outboxEvents)
        .set({ publishedAt: new Date() })
        .where(eq(schema.outboxEvents.id, bad));
    },
    TEST_TIMEOUT,
  );

  it(
    'rows backing off never hold back newer rows',
    async () => {
      const bad = await enqueue(BET_PLACED, 'bet', { status: 'pending_acceptance' });
      const newer = await enqueue('user.registered', 'user', { userId: 'u5' });
      const dispatcher = createOutboxDispatcher(t.ctx, { batchSize: 1, maxAttempts: 5 });
      try {
        expect(await dispatcher.run()).toMatchObject({ claimed: 1, failed: 1 });
        // The oldest row is backing off: the next run takes the newer one.
        expect(await dispatcher.run()).toMatchObject({ claimed: 1, published: 1 });
        expect((await outboxRow(newer)).publishedAt).not.toBeNull();
      } finally {
        await dispatcher.close();
        await t.db.db
          .update(schema.outboxEvents)
          .set({ publishedAt: new Date() })
          .where(eq(schema.outboxEvents.id, bad));
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'a Redis that answers PING but refuses writes (OOM, READONLY…) never dead-letters a row',
    async () => {
      const id = await enqueue(EVENT_RESULTED, 'event', {
        eventId: '00000000-0000-4000-8000-000000000002',
        status: 'finished',
      });
      let added = 0;
      const refusing: QueueSet = {
        get: () =>
          ({
            add: async () => {
              added += 1;
              throw replyError("OOM command not allowed when used memory > 'maxmemory'.");
            },
          }) as unknown as ReturnType<QueueSet['get']>,
        ping: async () => undefined,
        close: async () => undefined,
      };
      const { logger, lines } = capturingLogger();
      const dispatcher = createOutboxDispatcher(
        { ...t.ctx, logger },
        { maxAttempts: 3, queueSet: refusing, outageRetryMs: 1000 },
      );
      try {
        for (let i = 0; i < 10; i += 1) {
          expect(await dispatcher.run()).toMatchObject({ claimed: 1, failed: 1, outage: 1 });
          t.clock.advance(1000);
        }
      } finally {
        await dispatcher.close();
      }
      expect(added).toBe(10);
      const row = await outboxRow(id);
      expect(row).toMatchObject({ attempts: 0, publishedAt: null });
      expect(row.lastError).toContain('OOM');
      expect(lines.filter((l) => l.msg.includes('refuses jobs'))).toHaveLength(1);

      // Redis takes writes again: the row goes out.
      const healthy = createOutboxDispatcher(t.ctx, { maxAttempts: 3 });
      try {
        expect(await healthy.run()).toMatchObject({ claimed: 1, published: 1, jobs: 1 });
      } finally {
        await healthy.close();
        await settlementQueue.obliterate({ force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it('tells queue outages from bad rows', () => {
    for (const reply of [
      "OOM command not allowed when used memory > 'maxmemory'.",
      "READONLY You can't write against a read only replica.",
      'MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk.',
      'LOADING Redis is loading the dataset in memory',
    ]) {
      expect(isQueueOutageError(replyError(reply)), reply).toBe(true);
    }
    expect(isQueueOutageError(new TimeoutError('enqueue to settlement', 5000))).toBe(true);
    expect(isQueueOutageError(new Error('Connection is closed.'))).toBe(true);
    expect(isQueueOutageError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isQueueOutageError(replyError('ERR Error running script'))).toBe(false);
    expect(isQueueOutageError(new Error('pending bet b1 has no acceptAfter'))).toBe(false);
    expect(isQueueOutageError('weird')).toBe(false);
  });

  it(
    'a failed dead-letter count is tried again on the next run',
    async () => {
      const bad = await enqueue('user.registered', 'user', { userId: 'u6' });
      await t.db.db
        .update(schema.outboxEvents)
        .set({ attempts: 3 })
        .where(eq(schema.outboxEvents.id, bad));
      // The first count query fails (Postgres failing over at boot).
      let failures = 1;
      const db: Database = new Proxy(t.db.db, {
        get(target, prop, receiver): unknown {
          if (prop === 'select' && failures > 0) {
            failures -= 1;
            return () => {
              throw new Error('connection terminated');
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const { logger, lines } = capturingLogger();
      const dispatcher = createOutboxDispatcher({ ...t.ctx, db, logger }, { maxAttempts: 3 });
      try {
        await expect(dispatcher.run()).rejects.toThrow('connection terminated');
        await dispatcher.run();
      } finally {
        await dispatcher.close();
        await t.db.db
          .update(schema.outboxEvents)
          .set({ publishedAt: new Date() })
          .where(eq(schema.outboxEvents.id, bad));
      }
      const reported = lines.filter((l) => l.msg.includes('dead-lettered events'));
      expect(reported).toHaveLength(1);
      expect(reported[0]?.count).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'runs as an interval task and stops cleanly',
    async () => {
      const id = await enqueue('user.registered', 'user', { userId: 'u4' });
      const task = outboxDispatchTask(t.ctx, { intervalMs: 20, maxAttempts: 3 });
      await task.start();
      try {
        const deadline = Date.now() + 5000;
        while ((await outboxRow(id)).publishedAt === null) {
          if (Date.now() > deadline) throw new Error('row was not dispatched');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await task.stop();
      }
      expect(task.name).toBe('outbox-dispatch');
    },
    TEST_TIMEOUT,
  );
});
