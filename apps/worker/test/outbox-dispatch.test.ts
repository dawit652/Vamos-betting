import { BET_PLACED, enqueueOutbox, EVENT_RESULTED, schema } from '@vamos/db';
import { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/lib/queues';
import {
  createOutboxDispatcher,
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

        const settle = await settlementQueue.getJob(outboxJobId(resulted));
        expect(settle?.name).toBe(EVENT_RESULTED);
        expect(settle?.data as SettlementJobData).toEqual({
          outboxId: resulted.toString(),
          type: EVENT_RESULTED,
          eventId,
        });
        const accept = await acceptanceQueue.getJob(outboxJobId(pending));
        expect(accept?.data as BetAcceptanceJobData).toEqual({
          outboxId: pending.toString(),
          betId: 'bet-pending',
          acceptAfter: acceptAfter.toISOString(),
        });
        expect(accept?.opts.delay).toBe(4000);
        expect(await accept?.getState()).toBe('delayed');
        expect(await acceptanceQueue.getJob(outboxJobId(open))).toBeUndefined();

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
    'backs off a row that cannot be queued and dead-letters it, logged once, at maxAttempts',
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

        // Within the backoff (1 s after the first failure) the row is left alone.
        t.clock.advance(500);
        expect(await dispatcher.run()).toMatchObject({ claimed: 1, backingOff: 1, failed: 0 });
        t.clock.advance(500);
        expect(await dispatcher.run()).toMatchObject({ failed: 1, deadLettered: 0 });
        expect((await outboxRow(bad)).attempts).toBe(2);
        // The second backoff is 2 s.
        t.clock.advance(1000);
        expect(await dispatcher.run()).toMatchObject({ backingOff: 1 });
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

      // A new dispatcher (a restart) reports the dead letters once, at its first run.
      const restarted = capturingLogger();
      const again = createOutboxDispatcher(
        { ...t.ctx, logger: restarted.logger },
        { maxAttempts: 3 },
      );
      try {
        await again.run();
        await again.run();
      } finally {
        await again.close();
      }
      const reported = restarted.lines.filter((l) => l.msg.includes('dead-lettered events'));
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ count: 1 });
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
