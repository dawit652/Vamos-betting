import { DEFAULT_PAYMENT_RULES, santimToBirrString } from '@vamos/core';
import { createSmsDepositIntent, ingestSms, schema } from '@vamos/db';
import {
  SmsRailProvider,
  type PaymentProviderRegistry,
  type ReceiptVerifier,
  type ReceiptVerdict,
} from '@vamos/payments';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskContext } from '../src/tasks/context';
import { runDepositReconciliation } from '../src/tasks/deposit-reconcile';
import {
  BALANCE_RESULT_KEY,
  runBalanceReconciliation,
  runReceiptAudit,
  runSmsRailWatch,
  smsRailTasks,
} from '../src/tasks/smsrail';
import { createWorkerTestContext, SETUP_TIMEOUT, type WorkerTestContext } from './helpers';

let t: WorkerTestContext;
beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

const live = new SmsRailProvider({
  mode: 'live',
  gatewaySecret: 'w'.repeat(40),
  collectionAccounts: [
    { institution: 'telebirr', account: '0911678426', name: 'Vamos Betting PLC' },
    { institution: 'cbe', account: '1000123456789', name: 'Vamos Betting PLC' },
  ],
});

function withLive(base: PaymentProviderRegistry): PaymentProviderRegistry {
  return {
    names: [...base.names, 'sms'],
    get: (name) => (name === 'sms' ? live : base.get(name)),
    require: (name) => (name === 'sms' ? live : base.require(name)),
  };
}

/** A logger that records every alarm (error lines with `alarm`). */
function capture(): { logger: Logger; alarms: string[] } {
  const alarms: string[] = [];
  const noop = () => undefined;
  const logger = {
    error: (obj: { alarm?: string }) => {
      if (typeof obj?.alarm === 'string') alarms.push(obj.alarm);
    },
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, alarms };
}

let phoneCounter = 0;
async function createPlayer(): Promise<{ userId: string; phone: string }> {
  phoneCounter += 1;
  const phone = `+25991${String(phoneCounter).padStart(7, '0')}`;
  const [row] = await t.db.db
    .insert(schema.users)
    .values({
      phone,
      passwordHash: 'x',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  return { userId: row!.id, phone };
}

/** "dd/mm/yyyy at h:mm:ss AM" in EAT, as telebirr writes the time of a payment. */
function eatStamp(at: Date): string {
  const eat = new Date(at.getTime() + 3 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h24 = eat.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad(eat.getUTCDate())}/${pad(eat.getUTCMonth() + 1)}/${eat.getUTCFullYear()} at ${h12}:${pad(eat.getUTCMinutes())}:${pad(eat.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

let refCounter = 0;
async function creditedSms(balance?: bigint) {
  const player = await createPlayer();
  const { intent } = await t.db.db.transaction((tx) =>
    createSmsDepositIntent(tx, {
      userId: player.userId,
      amount: 10_000n,
      idempotencyKey: `w-${Math.random()}`,
      now: t.ctx.clock(),
      rules: { ...DEFAULT_PAYMENT_RULES },
    }),
  );
  refCounter += 1;
  const reference = `WK${String(refCounter).padStart(8, '0')}`;
  const tail =
    balance === undefined ? '' : ` Your telebirr balance is ETB ${santimToBirrString(balance)}.`;
  const text = `Dear CUSTOMER, you have received ETB ${santimToBirrString(intent.amount)} from P (${player.phone.slice(1)}) on ${eatStamp(t.ctx.clock())}. Your transaction number is ${reference}.${tail}`;
  const result = await t.db.db.transaction((tx) =>
    ingestSms(tx, { source: 'gateway', sender: 'telebirr', text, now: t.ctx.clock() }),
  );
  expect(result.outcome).toBe('credited');
  return { sms: result.sms, intent };
}

describe('receipt audit', () => {
  it('checks credited telebirr SMS against the receipt and raises an alarm for a contradiction', async () => {
    const genuine = await creditedSms();
    const forged = await creditedSms();
    const asked: string[] = [];
    const receipts: ReceiptVerifier = {
      verify: async (request): Promise<ReceiptVerdict> => {
        asked.push(request.reference);
        expect(request.receiverAccounts).toEqual(['0911678426']);
        if (request.reference === forged.sms.reference) {
          return { status: 'rejected', reason: 'not_a_receipt', facts: null, rawSample: '<html>' };
        }
        return {
          status: 'verified',
          amount: request.amount!,
          facts: {
            reference: request.reference,
            amounts: [request.amount!],
            payerName: 'P',
            payerAccount: null,
            receiverName: null,
            receiverAccount: '251911***426',
            completed: true,
            occurredAt: null,
          },
        };
      },
      state: () => ({ breaker: 'closed', consecutiveFailures: 0 }),
    };
    const { logger, alarms } = capture();
    const ctx: TaskContext = { ...t.ctx, payments: withLive(t.ctx.payments), receipts, logger };
    const summary = await runReceiptAudit(ctx, { limit: 50 });
    expect(asked).toEqual(expect.arrayContaining([genuine.sms.reference, forged.sms.reference]));
    expect(summary.outcomes).toMatchObject({ verified: 1, rejected: 1 });
    expect(alarms).toEqual(['sms_receipt_rejected']);
    const [row] = await t.db.db
      .select()
      .from(schema.receivedSms)
      .where(eq(schema.receivedSms.id, forged.sms.id));
    expect(row).toMatchObject({
      receiptStatus: 'rejected',
      receiptReason: 'not_a_receipt',
      status: 'matched',
    });
    // Nothing is reversed: the credit stands until staff decide.
    const [intent] = await t.db.db
      .select({ status: schema.paymentIntents.status })
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.id, forged.intent.id));
    expect(intent?.status).toBe('succeeded');
    // Checked messages are not asked about again.
    expect((await runReceiptAudit(ctx, { limit: 50 })).checked).toBe(0);
  });

  it('does nothing on the simulated rail or without a verifier', async () => {
    await creditedSms();
    expect((await runReceiptAudit(t.ctx)).checked).toBe(0);
    const ctx: TaskContext = { ...t.ctx, payments: withLive(t.ctx.payments) };
    expect((await runReceiptAudit(ctx)).checked).toBe(0);
  });
});

describe('balance reconciliation', () => {
  it('stores the result per institution and raises an alarm on drift', async () => {
    t.clock.advance(60 * 60_000);
    // The second credit's SMS reports the same balance as the first: its money never arrived
    // (what a forged SMS looks like once the next genuine one states the real balance).
    await creditedSms(5_000_000n);
    t.clock.advance(60_000);
    const forged = await creditedSms(5_000_000n);
    const { logger, alarms } = capture();
    const ctx: TaskContext = { ...t.ctx, payments: withLive(t.ctx.payments), logger };
    const [result] = await runBalanceReconciliation(ctx);
    expect(result?.institution).toBe('telebirr');
    expect(result?.result).toMatchObject({ status: 'drift', drift: -forged.intent.amount });
    expect(alarms).toContain('sms_balance_drift');
    const stored = await t.redis.get(`${BALANCE_RESULT_KEY}telebirr`);
    expect(JSON.parse(stored ?? '{}')).toMatchObject({
      institution: 'telebirr',
      result: { status: 'drift' },
    });
  });
});

describe('the watch', () => {
  it('raises an alarm when the live handset has been silent during active hours', async () => {
    // 10:00 EAT, two days after the last gateway SMS of this file.
    const now = t.clock.now;
    t.clock.set(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 7)),
    );
    const { logger, alarms } = capture();
    const ctx: TaskContext = { ...t.ctx, payments: withLive(t.ctx.payments), logger };
    const findings = await runSmsRailWatch(ctx);
    expect(findings.silent).toBe(true);
    expect(alarms).toContain('sms_gateway_silent');
    // The simulated rail has no handset to be silent.
    const quiet = await runSmsRailWatch({ ...t.ctx, logger });
    expect(quiet.silent).toBe(false);
  });

  it('builds no tasks without the sms provider', () => {
    expect(smsRailTasks(t.ctx)).toEqual([]);
    expect(smsRailTasks({ ...t.ctx, payments: withLive(t.ctx.payments) })).toHaveLength(3);
  });
});

describe('deposit reconciliation', () => {
  it('never asks the SMS rail about its deposits', async () => {
    const asked: string[] = [];
    const spy = new Proxy(live, {
      get(target, prop, receiver) {
        if (prop === 'queryDeposit') {
          return async (ref: string) => {
            asked.push(ref);
            return target.queryDeposit(ref);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const registry: PaymentProviderRegistry = {
      names: [...t.ctx.payments.names, 'sms'],
      get: (name) => (name === 'sms' ? spy : t.ctx.payments.get(name)),
      require: (name) => (name === 'sms' ? spy : t.ctx.payments.require(name)),
    };
    const player = await createPlayer();
    await t.db.db.transaction((tx) =>
      createSmsDepositIntent(tx, {
        userId: player.userId,
        amount: 20_000n,
        idempotencyKey: 'never-asked',
        now: new Date(t.ctx.clock().getTime() - 10 * 60_000),
        rules: { ...DEFAULT_PAYMENT_RULES },
      }),
    );
    await runDepositReconciliation({ ...t.ctx, payments: registry }, { queryAfterMs: 0 });
    expect(asked).toEqual([]);
  });
});
