import { birr } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDepositEvent,
  createDepositIntent,
  creditDepositByAdmin,
  markDepositInitiated,
  OWNER_ALERT,
} from '../src/index';
import { adminUsers, auditLog, ledgerTransactions, outboxEvents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { cashOf, createPlayer, domainError, idemKey, NOW, rules } from './payments-fixtures';

/**
 * A deposit an admin credits by hand (owner's decision O5: one admin, no second approval;
 * docs/plans/counter-codes-and-deposit-recovery.md, G5.2): once per provider transaction id, an
 * existing deposit credited as itself (a late provider confirmation then changes nothing), the
 * owner told above ETB 5,000.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: string;
const ALERTS = { phones: ['+251911000001'], minIntervalMinutes: 30 };

beforeAll(async () => {
  db = await createTestDatabase();
  const [row] = await db.db
    .insert(adminUsers)
    .values({
      email: 'manual-deposits@example.com',
      passwordHash: 'not-a-real-hash',
      displayName: 'Admin',
      role: 'admin',
    })
    .returning({ id: adminUsers.id });
  admin = row!.id;
});
afterAll(async () => {
  await dropTestDatabase(db);
});

const credit = (input: Partial<Parameters<typeof creditDepositByAdmin>[1]> & { userId: string }) =>
  db.db.transaction((tx) =>
    creditDepositByAdmin(tx, {
      provider: 'telebirr',
      providerTransactionId: `TX${Math.random().toString(36).slice(2, 10)}`,
      reason: 'Player sent the telebirr receipt; no callback arrived',
      adminId: admin,
      ownerAlerts: ALERTS,
      now: NOW,
      ...input,
    }),
  );

const alertsFor = async (intentId: string) =>
  db.db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, OWNER_ALERT),
        eq(outboxEvents.aggregateId, `manual_deposit_credited|${intentId}`),
      ),
    );

describe('manual deposits', () => {
  it('credits a new deposit once per transaction id, as a deposit, audited', async () => {
    const { userId } = await createPlayer(db.db);
    const { intent, created } = await credit({
      userId,
      providerTransactionId: 'CG12 34AB',
      amount: birr(300),
    });
    expect(created).toBe(true);
    expect(intent).toMatchObject({ status: 'succeeded', provider: 'telebirr', amount: birr(300) });
    expect(await cashOf(db.db, userId)).toBe(birr(300));
    const [posting] = await db.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, intent.ledgerTransactionId!));
    expect(posting!.type).toBe('deposit');
    const [audit] = await db.db.select().from(auditLog).where(eq(auditLog.targetId, intent.id));
    expect(audit).toMatchObject({ action: 'payment.deposit_credited_by_admin', actorId: admin });
    // Below ETB 5,000: no owner alert.
    expect(await alertsFor(intent.id)).toHaveLength(0);

    // The same payment again (any spacing, any player): refused, nothing credited twice.
    for (const who of [userId, (await createPlayer(db.db)).userId]) {
      const again = await domainError(
        credit({ userId: who, providerTransactionId: 'CG1234AB', amount: birr(300) }),
      );
      expect(again).toMatchObject({ status: 409, code: 'already_credited' });
    }
    expect(await cashOf(db.db, userId)).toBe(birr(300));
  });

  it('credits the player own pending deposit as itself; the late confirmation changes nothing', async () => {
    const { userId } = await createPlayer(db.db);
    const { intent: pending } = await db.db.transaction((tx) =>
      createDepositIntent(tx, {
        userId,
        provider: 'telebirr',
        amount: birr(250),
        idempotencyKey: idemKey('dep'),
        now: NOW,
        rules: rules(),
      }),
    );
    await db.db.transaction((tx) =>
      markDepositInitiated(tx, {
        intentId: pending.id,
        initiation: { kind: 'redirect', providerRef: `tb-${pending.id}` },
        now: NOW,
      }),
    );
    // Its provider must match.
    expect(
      await domainError(credit({ userId, intentId: pending.id, provider: 'chapa' })),
    ).toMatchObject({ code: 'provider_invalid' });
    const { intent, created } = await credit({
      userId,
      intentId: pending.id,
      providerTransactionId: 'TB-PENDING-1',
      // A typed amount is ignored for an existing deposit: its own amount is credited.
      amount: birr(999),
    });
    expect(created).toBe(false);
    expect(intent).toMatchObject({ id: pending.id, status: 'succeeded', amount: birr(250) });
    expect(await cashOf(db.db, userId)).toBe(birr(250));
    const late = await db.db.transaction((tx) =>
      applyDepositEvent(tx, {
        provider: 'telebirr',
        event: {
          kind: 'deposit',
          providerEventId: 'late-confirmation-pending',
          providerRef: `tb-${pending.id}`,
          status: 'succeeded',
          amount: birr(250),
          currency: 'ETB',
          raw: {},
        },
        now: NOW,
      }),
    );
    expect(late.outcome).not.toBe('credited');
    expect(await cashOf(db.db, userId)).toBe(birr(250));
  });

  it('credits an existing telebirr deposit as itself and tells the owner above ETB 5,000', async () => {
    const { userId } = await createPlayer(db.db);
    const first = await credit({ userId, amount: birr(6_000), providerTransactionId: 'TB-BIG-1' });
    expect(await alertsFor(first.intent.id)).toHaveLength(1);
    // Already credited: refused.
    expect(
      await domainError(
        credit({ userId, intentId: first.intent.id, providerTransactionId: 'TB-BIG-2' }),
      ),
    ).toMatchObject({ code: 'already_credited' });
    // A provider confirmation for it later finds it credited: no second credit.
    const late = await db.db.transaction((tx) =>
      applyDepositEvent(tx, {
        provider: 'telebirr',
        event: {
          kind: 'deposit',
          providerEventId: 'late-confirmation-1',
          providerRef: first.intent.providerRef!,
          status: 'succeeded',
          amount: birr(6_000),
          currency: 'ETB',
          raw: {},
        },
        now: NOW,
      }),
    );
    expect(late.outcome).not.toBe('credited');
    expect(await cashOf(db.db, userId)).toBe(birr(6_000));
  });

  it('needs a reason, a transaction id and, for a new deposit, an amount', async () => {
    const { userId } = await createPlayer(db.db);
    expect(await domainError(credit({ userId, amount: birr(10), reason: ' ' }))).toMatchObject({
      code: 'reason_required',
    });
    expect(
      await domainError(credit({ userId, amount: birr(10), providerTransactionId: 'x' })),
    ).toMatchObject({ code: 'transaction_id_invalid' });
    expect(await domainError(credit({ userId }))).toMatchObject({ code: 'amount_invalid' });
    expect(await cashOf(db.db, userId)).toBe(0n);
  });
});
