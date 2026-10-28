import { randomInt, randomUUID } from 'node:crypto';
import {
  addBusinessDays,
  businessDateOf,
  businessDayWindow,
  DEFAULT_PAYMENT_RULES,
  type PaymentRules,
} from '@vamos/core';
import {
  applyDepositEvent,
  createDepositIntent,
  DEPOSIT_SUCCEEDED,
  markDepositInitiated,
  RECONCILIATION_REQUESTED,
  requestReconciliation,
  schema,
} from '@vamos/db';
import { mockDepositRef } from '@vamos/payments';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  amlEvaluateTask,
  processAmlJob,
  reconciliationRequestTask,
  runDailyAmlSweep,
  RECONCILIATION_LOCK,
  runScheduledReconciliation,
} from '../src/tasks/compliance';
import {
  createOutboxDispatcher,
  OUTBOX_ROUTES,
  type AmlJobData,
  type OutboxDispatcher,
} from '../src/tasks/outbox-dispatch';
import type { WorkerTask } from '../src/worker';
import { eventually } from './betting';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

const HOUR = 3_600_000;
const RULES: PaymentRules = { ...DEFAULT_PAYMENT_RULES, wageringMultiplierBps: 0 };

let t: WorkerTestContext;
let dispatcher: OutboxDispatcher;
let consumers: WorkerTask[];

beforeAll(async () => {
  t = await createWorkerTestContext();
  await publishAll();
  dispatcher = createOutboxDispatcher(t.ctx);
  consumers = [amlEvaluateTask(t.ctx), reconciliationRequestTask(t.ctx)];
  for (const task of consumers) await task.start();
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const task of [...(consumers ?? [])].reverse()) await task.stop();
  await dispatcher?.close();
  await t?.close();
}, SETUP_TIMEOUT);

/** Marks every outbox row published (rows of earlier steps never reach the queues). */
async function publishAll(): Promise<void> {
  await t.db.db
    .update(schema.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(schema.outboxEvents.publishedAt));
}

async function createPlayer(): Promise<string> {
  const [row] = await t.db.db
    .insert(schema.users)
    .values({
      phone: `+2519${randomInt(10_000_000, 99_999_999)}`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
      locale: 'en',
    })
    .returning({ id: schema.users.id });
  const userId = row!.id;
  await t.db.db
    .insert(schema.kycProfiles)
    .values({ userId, status: 'verified', provider: 'mock', verifiedName: 'Abebe Kebede' });
  return userId;
}

/** A credited mock deposit; returns the intent id. */
async function deposit(userId: string, amount: bigint): Promise<string> {
  const now = t.clock.now;
  const { intent } = await t.db.db.transaction((tx) =>
    createDepositIntent(tx, {
      userId,
      provider: 'mock',
      amount,
      idempotencyKey: `dep-${randomUUID()}`,
      now,
      rules: RULES,
    }),
  );
  const initiation = await t.mockPayments.initiateDeposit({
    intentId: intent.id,
    amount,
    phone: intent.phone,
    callbackUrl: 'http://localhost:4000/payments/webhooks/mock',
    returnUrl: 'http://localhost:3000/wallet/deposit',
  });
  await t.db.db.transaction((tx) =>
    markDepositInitiated(tx, { intentId: intent.id, initiation, now }),
  );
  const event = await t.mockPayments.verifyWebhook(
    t.mockPayments.simulateDepositDecision({
      providerRef: mockDepositRef(intent.id),
      amount,
      decision: 'approve',
      pin: '1234',
    }),
  );
  const result = await t.db.db.transaction((tx) =>
    applyDepositEvent(tx, { provider: 'mock', event, now }),
  );
  expect(result.outcome).toBe('credited');
  return intent.id;
}

async function outboxRowsOf(type: string, aggregateId?: string) {
  return t.db.db
    .select()
    .from(schema.outboxEvents)
    .where(
      aggregateId === undefined
        ? eq(schema.outboxEvents.type, type)
        : and(eq(schema.outboxEvents.type, type), eq(schema.outboxEvents.aggregateId, aggregateId)),
    );
}

async function flagsOf(userId: string) {
  return t.db.db.select().from(schema.amlFlags).where(eq(schema.amlFlags.userId, userId));
}

describe('outbox routes (compliance)', () => {
  it('routes AML triggers to the aml queue', () => {
    const userId = randomUUID();
    const row = {
      id: 42n,
      jobKey: 'k',
      type: DEPOSIT_SUCCEEDED,
      aggregateType: 'payment_intent',
      aggregateId: randomUUID(),
      payload: { userId, intentId: randomUUID(), amount: '1000' },
    } as unknown as Parameters<(typeof OUTBOX_ROUTES)[string][number]>[0];
    const jobs = (OUTBOX_ROUTES[DEPOSIT_SUCCEEDED] ?? [])
      .map((route) => route(row, new Date()))
      .filter((job) => job !== null);
    expect(jobs.find((job) => job.queue === 'aml')?.data as AmlJobData).toEqual({
      outboxId: '42',
      type: DEPOSIT_SUCCEEDED,
      userId,
    });
  });
});

describe('AML', () => {
  it(
    'flags deposit velocity through the aml queue once, and a replay or the sweep adds nothing',
    async () => {
      const userId = await createPlayer();
      // Six deposits in the hour: the default limit is five.
      for (let i = 0; i < 6; i += 1) await deposit(userId, 10_000n);
      await dispatcher.run();
      await eventually(async () => (await flagsOf(userId)).length > 0, 10_000, 'the AML flag');
      const flags = await flagsOf(userId);
      expect(flags.map((flag) => flag.rule)).toEqual(['deposit_velocity']);

      const [last] = (await outboxRowsOf(DEPOSIT_SUCCEEDED)).slice(-1);
      const replay = await processAmlJob(t.ctx, {
        outboxId: last!.id.toString(),
        type: DEPOSIT_SUCCEEDED,
        userId,
      });
      expect(replay?.created).toEqual([]);

      const sweep = await runDailyAmlSweep(t.ctx);
      expect(sweep.ran).toBe(true);
      const again = await runDailyAmlSweep(t.ctx);
      expect(again).toMatchObject({ ran: false, reason: 'done' });
      expect(await flagsOf(userId)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

describe('scheduled reconciliation', () => {
  it(
    'reconciles yesterday once per day',
    async () => {
      const real = t.clock.now;
      const today = businessDateOf(real);
      try {
        // Reconciliation of `today` runs the next day, 3 h after midnight in Addis Ababa.
        const tomorrow = businessDayWindow(addBusinessDays(today, 1)).start.getTime();
        t.clock.set(new Date(tomorrow + HOUR));
        expect(await runScheduledReconciliation(t.ctx)).toMatchObject({
          ran: false,
          reason: 'not_due',
          businessDate: today,
        });
        t.clock.set(new Date(tomorrow + 4 * HOUR));
        const ran = await runScheduledReconciliation(t.ctx);
        expect(ran.ran).toBe(true);
        if (ran.ran) {
          expect(ran.run.kind).toBe('scheduled');
          expect(ran.run.businessDate).toBe(today);
          expect(ran.run.status).toBe('clean');
        }
        expect(await runScheduledReconciliation(t.ctx)).toMatchObject({
          ran: false,
          reason: 'done',
        });
        const runs = await t.db.db
          .select()
          .from(schema.reconciliationRuns)
          .where(eq(schema.reconciliationRuns.businessDate, today));
        expect(runs).toHaveLength(1);
      } finally {
        t.clock.set(real);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'catches up the days missed while the worker was down (oldest first), one run per day',
    async () => {
      const real = t.clock.now;
      const today = businessDateOf(real);
      const day1 = addBusinessDays(today, 1);
      const day2 = addBusinessDays(today, 2);
      try {
        // The worker was down from day1 until day3 04:00: day1 and day2 were never reconciled.
        t.clock.set(
          new Date(businessDayWindow(addBusinessDays(today, 3)).start.getTime() + 4 * HOUR),
        );
        // Another worker holds the run lock (a run longer than any TTL): nothing runs twice.
        const blocked = await t.db.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK}))`);
          return runScheduledReconciliation(t.ctx);
        });
        expect(blocked).toMatchObject({ ran: false, reason: 'locked' });
        const first = await runScheduledReconciliation(t.ctx);
        expect(first).toMatchObject({ ran: true, businessDate: day1 });
        const second = await runScheduledReconciliation(t.ctx);
        expect(second).toMatchObject({ ran: true, businessDate: day2 });
        expect(await runScheduledReconciliation(t.ctx)).toMatchObject({
          ran: false,
          reason: 'done',
        });
        const runs = await t.db.db
          .select({ date: schema.reconciliationRuns.businessDate })
          .from(schema.reconciliationRuns)
          .where(eq(schema.reconciliationRuns.kind, 'scheduled'));
        expect(runs.filter((run) => run.date === day1)).toHaveLength(1);
        expect(runs.filter((run) => run.date === day2)).toHaveLength(1);
      } finally {
        t.clock.set(real);
      }
    },
    TEST_TIMEOUT,
  );
});

describe('requested reconciliation ("Run now")', () => {
  it('routes the request to the reconciliation queue only for a well-formed payload', () => {
    const row = (payload: unknown) =>
      ({
        id: 42n,
        jobKey: 0,
        type: RECONCILIATION_REQUESTED,
        payload,
      }) as unknown as Parameters<(typeof OUTBOX_ROUTES)[string][number]>[0];
    const routes = OUTBOX_ROUTES[RECONCILIATION_REQUESTED] ?? [];
    expect(routes).toHaveLength(1);
    const requestId = randomUUID();
    expect(routes[0]!(row({ requestId }), new Date())).toMatchObject({
      queue: 'reconciliation',
      data: { outboxId: '42', requestId },
      opts: { attempts: 3 },
    });
    expect(routes[0]!(row({ requestId: 'nope' }), new Date())).toBeNull();
  });

  it(
    'runs a queued request off the request path: outbox, queue, run with the request id',
    async () => {
      const adminId = randomUUID();
      const request = await requestReconciliation(t.db.db, {
        now: t.clock.now,
        actor: { adminId, ip: null },
      });
      await dispatcher.run();
      const done = async () => {
        const [row] = await t.db.db
          .select()
          .from(schema.reconciliationRequests)
          .where(eq(schema.reconciliationRequests.id, request.id));
        return row?.status === 'done' ? row : null;
      };
      await eventually(async () => (await done()) !== null, 20_000, 'the requested run');
      expect(await done()).toMatchObject({ runId: request.id, attempts: 1 });
      const [run] = await t.db.db
        .select()
        .from(schema.reconciliationRuns)
        .where(eq(schema.reconciliationRuns.id, request.id));
      expect(run).toMatchObject({ kind: 'manual', triggeredBy: adminId });
    },
    TEST_TIMEOUT,
  );
});
