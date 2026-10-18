import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addBusinessDays,
  businessDateOf,
  businessDayWindow,
  DAILY_SUMMARY_FINALIZED,
  DEFAULT_PAYMENT_RULES,
  type PaymentRules,
} from '@vamos/core';
import {
  applyDepositEvent,
  createDepositIntent,
  createFileElsReporter,
  DEPOSIT_SUCCEEDED,
  markDepositInitiated,
  schema,
} from '@vamos/db';
import { mockDepositRef } from '@vamos/payments';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  amlEvaluateTask,
  elsReportTask,
  processAmlJob,
  processElsJob,
  runDailyAmlSweep,
  runDailySummaryTask,
  runElsSweep,
  runScheduledReconciliation,
} from '../src/tasks/compliance';
import {
  createOutboxDispatcher,
  OUTBOX_ROUTES,
  type AmlJobData,
  type ElsJobData,
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
let dir: string;
let dispatcher: OutboxDispatcher;
let consumers: WorkerTask[];

beforeAll(async () => {
  t = await createWorkerTestContext();
  dir = await mkdtemp(join(tmpdir(), 'vamos-els-'));
  t.ctx.els = createFileElsReporter({ dir });
  await publishAll();
  dispatcher = createOutboxDispatcher(t.ctx);
  consumers = [elsReportTask(t.ctx), amlEvaluateTask(t.ctx)];
  for (const task of consumers) await task.start();
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const task of [...(consumers ?? [])].reverse()) await task.stop();
  await dispatcher?.close();
  await t?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
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

/** The records of the ELS stream files, by outbox id. */
async function streamRecords(): Promise<Array<{ outboxId: string; type: string }>> {
  const dates = new Set([businessDateOf(new Date()), businessDateOf(new Date(Date.now() - HOUR))]);
  const records: Array<{ outboxId: string; type: string }> = [];
  for (const date of dates) {
    const text = await readFile(join(dir, 'stream', `${date}.jsonl`), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (line.length > 0) records.push(JSON.parse(line) as { outboxId: string; type: string });
    }
  }
  return records;
}

async function flagsOf(userId: string) {
  return t.db.db.select().from(schema.amlFlags).where(eq(schema.amlFlags.userId, userId));
}

describe('outbox routes (compliance)', () => {
  it('routes reportable events to the els queue and AML triggers to the aml queue', () => {
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
    expect(jobs.find((job) => job.queue === 'els')?.data as ElsJobData).toEqual({
      outboxId: '42',
      type: DEPOSIT_SUCCEEDED,
    });
    expect(jobs.find((job) => job.queue === 'aml')?.data as AmlJobData).toEqual({
      outboxId: '42',
      type: DEPOSIT_SUCCEEDED,
      userId,
    });
    // The daily summary record goes to the stream, and nothing else.
    expect((OUTBOX_ROUTES[DAILY_SUMMARY_FINALIZED] ?? []).length).toBe(1);
  });
});

describe('ELS stream', () => {
  it(
    'writes each reportable event once, through the queue, a replayed job and the sweep',
    async () => {
      const userId = await createPlayer();
      const intentId = await deposit(userId, 50_000n);
      const [row] = await outboxRowsOf(DEPOSIT_SUCCEEDED, intentId);
      expect(row).toBeDefined();
      const outboxId = row!.id.toString();

      await dispatcher.run();
      await eventually(
        async () => (await streamRecords()).some((record) => record.outboxId === outboxId),
        10_000,
        'the ELS record',
      );

      // A replayed job (same outbox id), and the sweep, write nothing more.
      const replay = await processElsJob(t.ctx, { outboxId, type: DEPOSIT_SUCCEEDED });
      expect(replay.outcome).toBe('already_written');
      await runElsSweep(t.ctx, { graceMs: 0 });
      const lines = (await streamRecords()).filter((record) => record.outboxId === outboxId);
      expect(lines).toHaveLength(1);
      // No player PII in the stream line.
      const text = JSON.stringify(lines[0]);
      expect(text).not.toContain('Abebe');
      expect(text).not.toContain('+2519');
    },
    TEST_TIMEOUT,
  );

  it(
    'the sweep writes an event whose job was lost, once',
    async () => {
      const userId = await createPlayer();
      const intentId = await deposit(userId, 20_000n);
      // Published without a job: the queue never sees it.
      await publishAll();
      const [row] = await outboxRowsOf(DEPOSIT_SUCCEEDED, intentId);
      const outboxId = row!.id.toString();
      expect((await streamRecords()).some((record) => record.outboxId === outboxId)).toBe(false);

      const first = await runElsSweep(t.ctx, { graceMs: 0 });
      expect(first.recorded).toBeGreaterThanOrEqual(1);
      expect(first.failed).toBe(0);
      const second = await runElsSweep(t.ctx, { graceMs: 0 });
      expect(second).toMatchObject({ recorded: 0, written: 0, failed: 0 });
      expect((await streamRecords()).filter((record) => record.outboxId === outboxId)).toHaveLength(
        1,
      );
    },
    TEST_TIMEOUT,
  );
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

describe('daily summaries and reconciliation', () => {
  it(
    'finalises a day once and reconciles yesterday once per day',
    async () => {
      const real = t.clock.now;
      const today = businessDateOf(real);
      try {
        // Two days later: today is over and past its grace period.
        t.clock.set(new Date(businessDayWindow(addBusinessDays(today, 2)).start.getTime() + HOUR));
        const first = await runDailySummaryTask(t.ctx);
        expect(first.finalized).toContain(today);
        const second = await runDailySummaryTask(t.ctx);
        expect(second.finalized).toEqual([]);
        const [summary] = await t.db.db
          .select()
          .from(schema.dailySummaries)
          .where(eq(schema.dailySummaries.businessDate, today));
        expect(summary?.status).toBe('final');
        expect(await outboxRowsOf(DAILY_SUMMARY_FINALIZED, today)).toHaveLength(1);

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
});
