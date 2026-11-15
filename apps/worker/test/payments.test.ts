import { randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_PAYMENT_RULES, type PaymentRules } from '@vamos/core';
import {
  applyDepositEvent,
  approveWithdrawal,
  createDepositIntent,
  DEPOSIT_SUCCEEDED,
  enqueueOutbox,
  getBalance,
  getPayout,
  markDepositInitiated,
  requestWithdrawal,
  schema,
  setSetting,
  WITHDRAWAL_APPROVED,
  WITHDRAWAL_FAILED,
  WITHDRAWAL_PAID,
  type AccountRef,
  type Payout,
} from '@vamos/db';
import {
  mockDepositRef,
  PaymentProviderError,
  type PaymentProvider,
  type PaymentProviderRegistry,
  type ProviderPaymentStatus,
} from '@vamos/payments';
import { Queue } from 'bullmq';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/lib/queues';
import { paymentSmsBody } from '../src/lib/sms';
import type { TaskContext } from '../src/tasks/context';
import { runDepositReconciliation } from '../src/tasks/deposit-reconcile';
import {
  createOutboxDispatcher,
  outboxJobId,
  type OutboxDispatcher,
  type PayoutJobData,
  type SmsJobData,
  type UserNotifyJobData,
} from '../src/tasks/outbox-dispatch';
import { processPayoutJob, payoutTask, runPayoutSweep } from '../src/tasks/payouts';
import { processSmsJob, smsNotifyTask } from '../src/tasks/sms-notify';
import type { WorkerTask } from '../src/worker';
import { eventually } from './betting';
import {
  createWorkerTestContext,
  REDIS_URL,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

const MINUTE_MS = 60_000;

let t: WorkerTestContext;
let dispatcher: OutboxDispatcher;
let consumers: WorkerTask[];

beforeAll(async () => {
  t = await createWorkerTestContext();
  // Rows written while seeding are not part of these tests.
  await publishAll();
  dispatcher = createOutboxDispatcher(t.ctx);
  consumers = [payoutTask(t.ctx), smsNotifyTask(t.ctx)];
  for (const task of consumers) await task.start();
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const task of [...(consumers ?? [])].reverse()) await task.stop();
  await dispatcher?.close();
  await t?.close();
}, SETUP_TIMEOUT);

/** Marks every outbox row published, so no later dispatcher run hands it to a consumer. */
async function publishAll(): Promise<void> {
  await t.db.db
    .update(schema.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(schema.outboxEvents.publishedAt));
}

const cash = (userId: string): AccountRef => ({ kind: 'player_cash', userId });
const HELD: AccountRef = { kind: 'house_withdrawals_pending' };
const CLEARING: AccountRef = { kind: 'house_psp_clearing', provider: 'mock' };

/** Payment rules for requests (wagering off: not what these tests are about). */
const RULES: PaymentRules = { ...DEFAULT_PAYMENT_RULES, wageringMultiplierBps: 0 };

let counter = 0;

/**
 * An active, KYC-verified player. `suffix` is the last four digits of the
 * phone: the mock provider fails payouts to …0000 and keeps …9999 pending
 * until its status is queried.
 */
async function createPlayer(suffix?: string): Promise<{ userId: string; phone: string }> {
  counter += 1;
  const tail = suffix ?? String(1000 + counter).padStart(4, '0');
  const phone = `+2519${randomInt(1000, 9999)}${tail}`;
  const [row] = await t.db.db
    .insert(schema.users)
    .values({
      phone,
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
  return { userId, phone };
}

/** A pending mock deposit (intent + initiation); returns the intent id. */
async function pendingDeposit(userId: string, amount: bigint, createdAt = t.clock.now) {
  const { intent } = await t.db.db.transaction((tx) =>
    createDepositIntent(tx, {
      userId,
      provider: 'mock',
      amount,
      idempotencyKey: `dep-${randomUUID()}`,
      now: createdAt,
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
    markDepositInitiated(tx, { intentId: intent.id, initiation, now: createdAt }),
  );
  return intent.id;
}

/** A credited mock deposit (the dev phone simulator's signed webhook). */
async function deposit(userId: string, amount: bigint): Promise<string> {
  const intentId = await pendingDeposit(userId, amount);
  const event = await t.mockPayments.verifyWebhook(
    t.mockPayments.simulateDepositDecision({
      providerRef: mockDepositRef(intentId),
      amount,
      decision: 'approve',
      pin: '1234',
    }),
  );
  const result = await t.db.db.transaction((tx) =>
    applyDepositEvent(tx, { provider: 'mock', event, now: t.clock.now }),
  );
  expect(result.outcome).toBe('credited');
  return intentId;
}

async function withdraw(
  player: { userId: string; phone: string },
  amount: bigint,
  rules: PaymentRules = RULES,
): Promise<Payout> {
  const { payout } = await t.db.db.transaction((tx) =>
    requestWithdrawal(tx, {
      userId: player.userId,
      amount,
      phone: player.phone,
      provider: 'mock',
      idempotencyKey: `wd-${randomUUID()}`,
      now: t.clock.now,
      rules,
    }),
  );
  return payout;
}

async function payout(id: string): Promise<Payout> {
  const row = await getPayout(t.db.db, id);
  if (row === null) throw new Error(`payout ${id} not found`);
  return row;
}

async function smsTo(phone: string) {
  return t.db.db
    .select()
    .from(schema.smsMessages)
    .where(eq(schema.smsMessages.to, phone))
    .orderBy(desc(schema.smsMessages.createdAt));
}

/** A registry with one provider named `mock` built from the given overrides of the mock. */
function registryWith(overrides: Partial<PaymentProvider>): PaymentProviderRegistry {
  const mock = t.mockPayments;
  const provider: PaymentProvider = {
    name: 'mock',
    capabilities: mock.capabilities,
    initiateDeposit: (input) => mock.initiateDeposit(input),
    verifyWebhook: (input) => mock.verifyWebhook(input),
    queryDeposit: (ref) => mock.queryDeposit(ref),
    initiatePayout: (input) => mock.initiatePayout(input),
    queryPayout: (ref) => mock.queryPayout(ref),
    ...overrides,
  };
  return {
    names: ['mock'],
    get: (name) => (name === 'mock' ? provider : undefined),
    require: (name) => {
      if (name !== 'mock') throw new Error(`not enabled: ${name}`);
      return provider;
    },
  };
}

const ctxWith = (payments: PaymentProviderRegistry): TaskContext => ({ ...t.ctx, payments });

describe('payouts end to end (outbox → payouts queue → provider → SMS)', () => {
  it(
    'pays an approved withdrawal out and texts the player',
    async () => {
      const player = await createPlayer();
      await deposit(player.userId, 1_000_000n);
      const heldBefore = await getBalance(t.db.db, HELD);
      const clearingBefore = await getBalance(t.db.db, CLEARING);
      const small = await withdraw(player, 100_000n);
      expect(small.status).toBe('approved');
      expect(await getBalance(t.db.db, cash(player.userId))).toBe(900_000n);

      // The deposit SMS, then the payout job.
      const first = await dispatcher.run();
      expect(first.jobs).toBeGreaterThanOrEqual(2);
      await eventually(
        async () => (await payout(small.id)).status === 'paid',
        10_000,
        'payout paid',
      );
      const paid = await payout(small.id);
      expect(paid).toMatchObject({
        attempts: 1,
        providerRef: `mockpay_s_${small.id}`,
        flagReason: null,
      });
      expect(paid.paidLedgerTransactionId).not.toBeNull();
      expect(await getBalance(t.db.db, HELD)).toBe(heldBefore);
      expect(await getBalance(t.db.db, CLEARING)).toBe(clearingBefore + 100_000n);

      // payment.withdrawal_paid → sms.
      await dispatcher.run();
      await eventually(
        async () => (await smsTo(player.phone)).some((sms) => sms.template === 'withdrawal_paid'),
        10_000,
        'withdrawal SMS',
      );
      const messages = await smsTo(player.phone);
      expect(messages.map((sms) => sms.template).sort()).toEqual([
        'deposit_succeeded',
        'withdrawal_paid',
      ]);
      expect(messages.find((sms) => sms.template === 'withdrawal_paid')?.body).toContain(
        'ETB 1,000.00',
      );

      // A withdrawal approved by staff goes the same way.
      const big = await withdraw(player, 600_000n);
      expect(big.status).toBe('requested');
      await t.db.db.transaction((tx) =>
        approveWithdrawal(tx, { payoutId: big.id, adminId: 'admin-1', now: t.clock.now }),
      );
      await dispatcher.run();
      await eventually(async () => (await payout(big.id)).status === 'paid', 10_000, 'big paid');
      expect(await getBalance(t.db.db, cash(player.userId))).toBe(300_000n);
    },
    TEST_TIMEOUT,
  );
});

describe('outbox routes', () => {
  it(
    'queues approved withdrawals on payouts and payment outcomes on sms and user-notify',
    async () => {
      const opts = { connection: { url: REDIS_URL }, prefix: t.queuePrefix };
      const payoutsQueue = new Queue(QUEUE_NAMES.payouts, opts);
      const smsQueue = new Queue(QUEUE_NAMES.sms, opts);
      const notifyQueue = new Queue(QUEUE_NAMES.userNotify, opts);
      // A dispatcher with nothing consuming its jobs: stop the consumers first.
      for (const task of [...consumers].reverse()) await task.stop();
      await publishAll();
      try {
        const payoutId = randomUUID();
        const userId = randomUUID();
        const approved = await enqueueOutbox(t.db.db, {
          type: WITHDRAWAL_APPROVED,
          aggregateType: 'payout',
          aggregateId: payoutId,
          payload: { payoutId, userId, provider: 'mock', amount: 5000n, approvedBy: 'system:auto' },
        });
        const notified: bigint[] = [];
        for (const type of [DEPOSIT_SUCCEEDED, WITHDRAWAL_PAID, WITHDRAWAL_FAILED]) {
          notified.push(
            await enqueueOutbox(t.db.db, {
              type,
              aggregateType: 'payout',
              aggregateId: payoutId,
              payload: { payoutId, userId, amount: 5000n, reason: 'x' },
            }),
          );
        }
        const broken = await enqueueOutbox(t.db.db, {
          type: WITHDRAWAL_APPROVED,
          aggregateType: 'payout',
          aggregateId: 'x',
          payload: { payoutId: 'not-a-uuid' },
        });

        const summary = await dispatcher.run();
        // The approved payout; each outcome on sms and user-notify (a wallet.changed push);
        // the deposit on aml.
        expect(summary).toMatchObject({ claimed: 5, published: 4, jobs: 8, failed: 1 });

        const row = async (id: bigint) => {
          const [r] = await t.db.db
            .select()
            .from(schema.outboxEvents)
            .where(eq(schema.outboxEvents.id, id));
          return r!;
        };
        const payoutJob = await payoutsQueue.getJob(outboxJobId(await row(approved)));
        expect(payoutJob?.data as PayoutJobData).toEqual({
          outboxId: approved.toString(),
          payoutId,
        });
        for (const [index, id] of notified.entries()) {
          const job = await smsQueue.getJob(outboxJobId(await row(id)));
          expect(job?.data as SmsJobData).toEqual({
            outboxId: id.toString(),
            type: [DEPOSIT_SUCCEEDED, WITHDRAWAL_PAID, WITHDRAWAL_FAILED][index],
            userId,
            amount: '5000',
          });
          const push = await notifyQueue.getJob(outboxJobId(await row(id)));
          expect(push?.data as UserNotifyJobData).toEqual({
            outboxId: id.toString(),
            type: [DEPOSIT_SUCCEEDED, WITHDRAWAL_PAID, WITHDRAWAL_FAILED][index],
            userId,
            messages: [],
            wallet: true,
          });
        }
        expect(await notifyQueue.getJob(outboxJobId(await row(approved)))).toBeUndefined();
        expect((await row(broken)).publishedAt).toBeNull();
        expect((await row(broken)).attempts).toBe(1);
      } finally {
        await publishAll();
        await payoutsQueue.obliterate({ force: true });
        await smsQueue.obliterate({ force: true });
        await notifyQueue.obliterate({ force: true });
        await payoutsQueue.close();
        await smsQueue.close();
        await notifyQueue.close();
        for (const task of consumers) await task.start();
      }
    },
    TEST_TIMEOUT,
  );
});

describe('payout worker', () => {
  it('returns the hold when the provider fails the payout, and texts the player', async () => {
    const player = await createPlayer('0000');
    await deposit(player.userId, 200_000n);
    const request = await withdraw(player, 150_000n);
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(50_000n);

    const run = await processPayoutJob(t.ctx, { payoutId: request.id });
    expect(run).toEqual({ payoutId: request.id, outcome: 'failed', attempt: 'failed' });
    const failed = await payout(request.id);
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'failed_at_provider' });
    expect(failed.reversalLedgerTransactionId).not.toBeNull();
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(200_000n);

    const [event] = await t.db.db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateId, request.id),
          eq(schema.outboxEvents.type, WITHDRAWAL_FAILED),
        ),
      );
    expect(event).toBeDefined();
    const sent = await processSmsJob(t.ctx, {
      outboxId: event!.id.toString(),
      type: WITHDRAWAL_FAILED,
      userId: player.userId,
      amount: '150000',
    });
    expect(sent).toMatchObject({ sent: true, template: 'withdrawal_failed' });
    expect((await smsTo(player.phone))[0]?.body).toContain('back in your balance');
    await publishAll();
  });

  it('polls a pending payout after its backoff until the provider reports it paid', async () => {
    const player = await createPlayer('9999');
    await deposit(player.userId, 200_000n);
    const request = await withdraw(player, 100_000n);
    await publishAll();

    const first = await processPayoutJob(t.ctx, { payoutId: request.id });
    expect(first).toMatchObject({ outcome: 'pending', attempt: 'pending' });
    const pending = await payout(request.id);
    expect(pending).toMatchObject({
      status: 'processing',
      attempts: 1,
      providerRef: `mockpay_p_${request.id}`,
    });
    expect(pending.nextAttemptAt?.getTime()).toBe(t.clock.now.getTime() + MINUTE_MS);

    // Not due yet: neither the job nor the sweep touches it.
    expect(await processPayoutJob(t.ctx, { payoutId: request.id })).toMatchObject({
      outcome: 'skipped',
    });
    await runPayoutSweep(t.ctx);
    expect((await payout(request.id)).attempts).toBe(1);

    t.clock.advance(MINUTE_MS);
    const sweep = await runPayoutSweep(t.ctx);
    expect(sweep.outcomes.paid).toBeGreaterThanOrEqual(1);
    expect(await payout(request.id)).toMatchObject({ status: 'paid', attempts: 2 });
    await publishAll();
  });

  it(
    'retries with exponential backoff and flags the payout when attempts run out',
    async () => {
      await setSetting(t.db.db, 'payments', { payoutMaxAttempts: 3 });
      const sent: string[] = [];
      const flaky = ctxWith(
        registryWith({
          initiatePayout: async (input) => {
            sent.push(input.payoutId);
            throw new PaymentProviderError('mock', 'gateway timeout', { retryable: true });
          },
        }),
      );
      try {
        const player = await createPlayer();
        await deposit(player.userId, 200_000n);
        const request = await withdraw(player, 100_000n);
        await publishAll();

        const first = await processPayoutJob(flaky, { payoutId: request.id });
        expect(first).toMatchObject({ outcome: 'retry_scheduled', attempt: 'retry' });
        let row = await payout(request.id);
        expect(row).toMatchObject({ status: 'processing', attempts: 1, providerRef: null });
        expect(row.lastError).toContain('gateway timeout');
        expect(row.nextAttemptAt?.getTime()).toBe(t.clock.now.getTime() + MINUTE_MS);

        t.clock.advance(MINUTE_MS);
        await runPayoutSweep(flaky);
        row = await payout(request.id);
        expect(row.attempts).toBe(2);
        expect(row.nextAttemptAt?.getTime()).toBe(t.clock.now.getTime() + 2 * MINUTE_MS);

        // Still backing off one minute later.
        t.clock.advance(MINUTE_MS);
        await runPayoutSweep(flaky);
        expect((await payout(request.id)).attempts).toBe(2);

        t.clock.advance(MINUTE_MS);
        await runPayoutSweep(flaky);
        row = await payout(request.id);
        expect(row).toMatchObject({
          status: 'processing',
          attempts: 3,
          flagReason: 'attempts_exhausted',
        });
        expect(sent.filter((id) => id === request.id)).toHaveLength(3);

        // Flagged: the worker leaves it to staff, and the money stays held.
        t.clock.advance(60 * MINUTE_MS);
        await runPayoutSweep(flaky);
        expect(await processPayoutJob(flaky, { payoutId: request.id })).toMatchObject({
          outcome: 'skipped',
        });
        expect((await payout(request.id)).attempts).toBe(3);
        expect(await getBalance(t.db.db, cash(player.userId))).toBe(100_000n);
      } finally {
        await setSetting(t.db.db, 'payments', {});
        await publishAll();
      }
    },
    TEST_TIMEOUT,
  );

  it('fails a payout refused on its first submission but flags a refused resubmission', async () => {
    let mode: 'retry' | 'refuse' = 'refuse';
    const refusing = ctxWith(
      registryWith({
        initiatePayout: async () => {
          throw new PaymentProviderError(
            'mock',
            mode === 'refuse' ? 'invalid account' : 'timeout',
            {
              retryable: mode === 'retry',
            },
          );
        },
      }),
    );
    const player = await createPlayer();
    await deposit(player.userId, 300_000n);

    const once = await withdraw(player, 100_000n);
    await publishAll();
    expect(await processPayoutJob(refusing, { payoutId: once.id })).toMatchObject({
      outcome: 'failed',
    });
    expect(await payout(once.id)).toMatchObject({
      status: 'failed',
      failureReason: 'refused_by_provider',
    });

    // Sent once without an answer, then refused: the first may have gone through.
    const twice = await withdraw(player, 100_000n);
    await publishAll();
    mode = 'retry';
    await processPayoutJob(refusing, { payoutId: twice.id });
    mode = 'refuse';
    t.clock.advance(MINUTE_MS);
    expect(await processPayoutJob(refusing, { payoutId: twice.id })).toMatchObject({
      outcome: 'flagged',
      attempt: 'unknown',
    });
    expect(await payout(twice.id)).toMatchObject({
      status: 'processing',
      flagReason: 'ambiguous_result',
    });
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(200_000n);
    await publishAll();
  });

  it('fails a payout whose provider is no longer enabled, before anything was sent', async () => {
    const none: PaymentProviderRegistry = {
      names: [],
      get: () => undefined,
      require: () => {
        throw new Error('none');
      },
    };
    const player = await createPlayer();
    await deposit(player.userId, 100_000n);
    const request = await withdraw(player, 60_000n);
    await publishAll();
    expect(await processPayoutJob(ctxWith(none), { payoutId: request.id })).toMatchObject({
      outcome: 'failed',
    });
    expect(await payout(request.id)).toMatchObject({
      status: 'failed',
      failureReason: 'provider_not_enabled',
    });
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(100_000n);
  });

  it('claims due payouts one at a time, so a slow provider never outlives the next lease', async () => {
    const player = await createPlayer();
    await deposit(player.userId, 300_000n);
    const first = await withdraw(player, 50_000n);
    const second = await withdraw(player, 60_000n);
    await publishAll();
    // Every submission takes longer than a payout's lease (one minute).
    const slow = ctxWith(
      registryWith({
        initiatePayout: async (input) => {
          t.clock.advance(2 * MINUTE_MS);
          return t.mockPayments.initiatePayout(input);
        },
      }),
    );
    const sweep = await runPayoutSweep(slow, { limit: 50 });
    expect(sweep.outcomes.stale ?? 0).toBe(0);
    const [a, b] = [await payout(first.id), await payout(second.id)].sort(
      (x, y) => x.processingAt!.getTime() - y.processingAt!.getTime(),
    );
    expect(a!.status).toBe('paid');
    expect(b!.status).toBe('paid');
    // The second was claimed only after the first was done, with a lease of its own.
    expect(b!.processingAt!.getTime() - a!.processingAt!.getTime()).toBeGreaterThanOrEqual(
      2 * MINUTE_MS,
    );
    expect([a!.attempts, b!.attempts]).toEqual([1, 1]);
    await publishAll();
  });

  it(
    'flags a payout whose adapter keeps throwing once the attempts run out',
    async () => {
      await setSetting(t.db.db, 'payments', { payoutMaxAttempts: 2 });
      const broken = ctxWith(
        registryWith({
          initiatePayout: async () => {
            throw new TypeError('adapter bug');
          },
        }),
      );
      try {
        const player = await createPlayer();
        await deposit(player.userId, 200_000n);
        const request = await withdraw(player, 100_000n);
        await publishAll();

        expect(await processPayoutJob(broken, { payoutId: request.id })).toMatchObject({
          outcome: 'error',
        });
        let row = await payout(request.id);
        expect(row).toMatchObject({ status: 'processing', unansweredAttempts: 1, flaggedAt: null });
        expect(row.lastError).toContain('adapter bug');

        t.clock.advance(MINUTE_MS);
        await processPayoutJob(broken, { payoutId: request.id });
        row = await payout(request.id);
        expect(row).toMatchObject({
          status: 'processing',
          attempts: 2,
          flagReason: 'attempts_exhausted',
        });
        // The hold stays until staff decide.
        expect(await getBalance(t.db.db, cash(player.userId))).toBe(100_000n);
      } finally {
        await setSetting(t.db.db, 'payments', {});
        await publishAll();
      }
    },
    TEST_TIMEOUT,
  );

  it('skips payouts that are not approved, unknown or already being sent', async () => {
    const player = await createPlayer();
    await deposit(player.userId, 1_000_000n);
    const review = await withdraw(player, 600_000n);
    await publishAll();
    expect(review.status).toBe('requested');
    expect(await processPayoutJob(t.ctx, { payoutId: review.id })).toMatchObject({
      outcome: 'skipped',
    });
    expect(await processPayoutJob(t.ctx, { payoutId: randomUUID() })).toMatchObject({
      outcome: 'skipped',
    });

    // A payout job delivered twice: the second finds it paid.
    const small = await withdraw(player, 50_000n);
    await publishAll();
    expect(await processPayoutJob(t.ctx, { payoutId: small.id })).toMatchObject({
      outcome: 'paid',
    });
    expect(await processPayoutJob(t.ctx, { payoutId: small.id })).toMatchObject({
      outcome: 'skipped',
    });
    expect((await payout(small.id)).attempts).toBe(1);
  });
});

describe('deposit reconciliation', () => {
  it('expires stale intents and credits a deposit its provider reports paid', async () => {
    const player = await createPlayer();
    const longAgo = new Date(t.clock.now.getTime() - 40 * MINUTE_MS);
    const stale = await pendingDeposit(player.userId, 10_000n, longAgo);
    const recent = await pendingDeposit(
      player.userId,
      20_000n,
      new Date(t.clock.now.getTime() - 5 * MINUTE_MS),
    );
    const fresh = await pendingDeposit(player.userId, 30_000n);

    // The mock has no status endpoint: everything stays pending, the stale one expires.
    const plain = await runDepositReconciliation(t.ctx);
    expect(plain.stillPending).toBeGreaterThanOrEqual(1);
    expect(plain.expired).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => {
      const [row] = await t.db.db
        .select()
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.id, id));
      return row!;
    };
    expect((await status(stale)).status).toBe('expired');
    expect((await status(recent)).status).toBe('pending');

    // Polls back off: the next one for `recent` is due a little later.
    expect(
      (await runDepositReconciliation(t.ctx)).queried,
      'nothing is asked about again at once',
    ).toBe(0);
    t.clock.advance(90_000);

    const queried: string[] = [];
    const answering = ctxWith(
      registryWith({
        queryDeposit: async (providerRef) => {
          queried.push(providerRef);
          const amount = providerRef === mockDepositRef(recent) ? 20_000n : null;
          const result: ProviderPaymentStatus = amount === null ? 'pending' : 'succeeded';
          return { providerRef, status: result, amount, currency: 'ETB', raw: { providerRef } };
        },
      }),
    );
    const reconciled = await runDepositReconciliation(answering);
    expect(reconciled.applied.credited).toBe(1);
    // Too new to ask about yet.
    expect(queried).not.toContain(mockDepositRef(fresh));
    expect(await status(recent)).toMatchObject({ status: 'succeeded' });
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(20_000n);

    // Asking again changes nothing (credited once).
    await runDepositReconciliation(answering);
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(20_000n);
    await publishAll();
  });

  it('flags a deposit whose provider reports another amount', async () => {
    const player = await createPlayer();
    const intent = await pendingDeposit(
      player.userId,
      10_000n,
      new Date(t.clock.now.getTime() - 5 * MINUTE_MS),
    );
    const wrong = ctxWith(
      registryWith({
        queryDeposit: async (providerRef) => ({
          providerRef,
          status: providerRef === mockDepositRef(intent) ? 'succeeded' : 'pending',
          amount: 99_000n,
          currency: 'ETB',
          raw: {},
        }),
      }),
    );
    const summary = await runDepositReconciliation(wrong);
    expect(summary.applied.flagged).toBe(1);
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(0n);
    await publishAll();
  });
});

describe('deposit reconciliation: late payments and backoff', () => {
  it('asks about expired deposits during the late-payment window and credits a late payment', async () => {
    const player = await createPlayer();
    const intent = await pendingDeposit(
      player.userId,
      15_000n,
      new Date(t.clock.now.getTime() - 40 * MINUTE_MS),
    );
    // Our own timeout passes first (the mock has no status endpoint).
    await runDepositReconciliation(t.ctx);
    const [expired] = await t.db.db
      .select()
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.id, intent));
    expect(expired?.status).toBe('expired');

    t.clock.advance(60 * MINUTE_MS);
    const paidLate = ctxWith(
      registryWith({
        queryDeposit: async (providerRef) =>
          providerRef === mockDepositRef(intent)
            ? { providerRef, status: 'succeeded', amount: 15_000n, currency: 'ETB', raw: {} }
            : { providerRef, status: 'pending', amount: null, currency: null, raw: {} },
      }),
    );
    const summary = await runDepositReconciliation(paidLate);
    expect(summary.applied.credited).toBe(1);
    expect(await getBalance(t.db.db, cash(player.userId))).toBe(15_000n);
    await publishAll();
  });

  it('runs expiry first and stops asking at its deadline', async () => {
    const player = await createPlayer();
    await pendingDeposit(player.userId, 10_000n, new Date(t.clock.now.getTime() - 40 * MINUTE_MS));
    const asked: string[] = [];
    const counting = ctxWith(
      registryWith({
        queryDeposit: async (providerRef) => {
          asked.push(providerRef);
          return { providerRef, status: 'pending', amount: null, currency: null, raw: {} };
        },
      }),
    );
    const summary = await runDepositReconciliation(counting, { deadlineMs: 0 });
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    expect(summary.queried).toBe(0);
    expect(asked).toEqual([]);
    await publishAll();
  });
});

describe('SMS notifications', () => {
  it('writes bilingual payment messages, English first for English players', () => {
    expect(paymentSmsBody('deposit_succeeded', 12_550n, 'en')).toMatch(
      /^Nahubet: Deposit of ETB 125\.50 received\. /,
    );
    expect(paymentSmsBody('withdrawal_paid', 100_000n, 'am')).toMatch(/^Nahubet: 1,000\.00 ብር/);
    expect(paymentSmsBody('withdrawal_paid', 100_000n, 'am')).toContain(
      'Withdrawal of ETB 1,000.00 sent to your phone.',
    );
  });

  it('skips unknown types and unknown players', async () => {
    expect(
      await processSmsJob(t.ctx, {
        outboxId: '1',
        type: 'payment.something_else',
        userId: randomUUID(),
        amount: '1',
      }),
    ).toEqual({ sent: false, reason: 'unknown_type' });
    expect(
      await processSmsJob(t.ctx, {
        outboxId: '1',
        type: DEPOSIT_SUCCEEDED,
        userId: randomUUID(),
        amount: '1',
      }),
    ).toEqual({ sent: false, reason: 'unknown_user' });
  });
});
