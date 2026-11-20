import { randomUUID } from 'node:crypto';
import { birr, businessDateOf, santimToBirrString } from '@vamos/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmsDepositIntent, ingestSms, runReconciliationChecks } from '../src/index';
import type { Database } from '../src/client';
import { paymentIntents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, idemKey, NOW, rules } from './payments-fixtures';

/** The daily reconciliation sees a missing or an unbacked SMS credit (B6). */

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const DAY = businessDateOf(new Date(NOW.getTime() + 60_000));
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function smsChecks() {
  const out = await runReconciliationChecks(db, { businessDate: DAY, balanceAfterGraceMs: 0 });
  const summary = out.checks.find((c) => c.check === 'sms_credits');
  return {
    summary,
    mismatches: out.mismatches.filter((m) => m.check === 'sms_credits'),
  };
}

let refs = 0;
async function creditedDeposit(amount: bigint) {
  const player = await createPlayer(db);
  const { intent } = await db.transaction((tx) =>
    createSmsDepositIntent(tx, {
      userId: player.userId,
      amount,
      idempotencyKey: idemKey('rec'),
      now: NOW,
      rules: rules(),
    }),
  );
  refs += 1;
  const reference = `REC${String(refs).padStart(7, '0')}`;
  const result = await db.transaction((tx) =>
    ingestSms(tx, {
      source: 'gateway',
      sender: 'telebirr',
      text: `Dear CUSTOMER, you have received ETB ${santimToBirrString(intent.amount)} from SENDER NAME (${player.phone.slice(1)}) on 10/10/2026 at 12:01:00 PM. Your transaction number is ${reference}.`,
      now: at(1),
    }),
  );
  expect(result.outcome).toBe('credited');
  // The deposit as credited (ledger transaction and completion time set).
  return { player, intent: result.intent!, sms: result.sms };
}

describe('the sms_credits reconciliation check', () => {
  it('is clean when every credit has its message and every message its credit', async () => {
    await creditedDeposit(birr(100));
    await creditedDeposit(birr(250));
    const { summary, mismatches } = await smsChecks();
    expect(summary).toMatchObject({ ok: true, checked: 4, mismatches: 0 });
    expect(mismatches).toEqual([]);
  });

  it('shows a message that credited a deposit which is no longer credited (a missing credit)', async () => {
    const { intent, sms } = await creditedDeposit(birr(300));
    // Simulates a lost ledger credit: the deposit is open again though the message says it paid.
    await db.execute(sql`ALTER TABLE payment_intents DISABLE TRIGGER USER`);
    try {
      await db.execute(
        sql`UPDATE payment_intents SET status = 'pending', ledger_transaction_id = NULL, completed_at = NULL WHERE id = ${intent.id}`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
    }
    const { summary, mismatches } = await smsChecks();
    expect(summary?.ok).toBe(false);
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        subjectType: 'received_sms',
        subjectId: sms.id,
        details: expect.objectContaining({
          problem: 'the deposit it credited is pending, not succeeded',
        }),
      }),
    );
    // Put it back so the next test starts clean.
    await db.execute(sql`ALTER TABLE payment_intents DISABLE TRIGGER USER`);
    try {
      await db.execute(
        sql`UPDATE payment_intents SET status = 'succeeded', ledger_transaction_id = ${intent.ledgerTransactionId}, completed_at = ${intent.completedAt} WHERE id = ${intent.id}`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
    }
    expect((await smsChecks()).summary?.ok).toBe(true);
  });

  it('shows a second credit for one message (a doubled credit: no message behind it)', async () => {
    const { intent, player } = await creditedDeposit(birr(400));
    const twin = randomUUID();
    await db.insert(paymentIntents).values({
      id: twin,
      userId: intent.userId,
      provider: 'sms',
      phone: player.phone,
      amount: intent.amount + 1n,
      requestedAmount: intent.amount,
      status: 'succeeded',
      providerRef: twin,
      initiationKind: 'transfer',
      idempotencyKey: `twin:${twin}`,
      ledgerTransactionId: intent.ledgerTransactionId,
      expiresAt: at(1),
      completedAt: at(1),
      createdAt: at(0),
      updatedAt: at(1),
    });
    const { summary, mismatches } = await smsChecks();
    expect(summary?.ok).toBe(false);
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        subjectType: 'payment_intent',
        subjectId: twin,
        details: expect.objectContaining({
          problem: 'an SMS deposit was credited with no received SMS behind it',
        }),
      }),
    );
    await db.delete(paymentIntents).where(eq(paymentIntents.id, twin));
    expect((await smsChecks()).summary?.ok).toBe(true);
  });
});
