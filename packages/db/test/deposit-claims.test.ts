import { createHash, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDepositClaim,
  creditDepositByAdmin,
  creditDepositClaim,
  fileDepositClaim,
  listMoneyNotCredited,
  listPlayerDepositClaims,
  MAX_OPEN_DEPOSIT_CLAIMS,
  nearAmount,
} from '../src/payments/index';
import {
  adminUsers,
  auditLog,
  depositClaims,
  paymentIntents,
  receivedSms,
} from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, domainError, NOW } from './payments-fixtures';

/**
 * Deposits that did not arrive (docs/plans/counter-codes-and-deposit-recovery.md, G5.3 and G6):
 * players' claims, and the back office's "Money not credited" with the players it may belong to.
 * Nothing here credits money by itself.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: string;
const HOUR = 3_600_000;

beforeAll(async () => {
  db = await createTestDatabase();
  const [row] = await db.db
    .insert(adminUsers)
    .values({
      email: 'deposit-claims@example.com',
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

const file = (input: Partial<Parameters<typeof fileDepositClaim>[1]> & { userId: string }) =>
  db.db.transaction((tx) =>
    fileDepositClaim(tx, {
      method: 'telebirr',
      amount: birr(500),
      paidAt: new Date(NOW.getTime() - HOUR),
      now: NOW,
      ...input,
    }),
  );

/** An incoming SMS that credited nobody. */
async function unmatchedSms(input: {
  amount: bigint;
  payerPhone?: string | null;
  reference?: string | null;
  at?: Date;
  status?: 'unmatched' | 'ambiguous' | 'flagged';
  flaggedIntentId?: string | null;
}) {
  const text = `credit ${randomUUID()}`;
  const at = input.at ?? NOW;
  const [row] = await db.db
    .insert(receivedSms)
    .values({
      source: 'gateway',
      sender: 'telebirr',
      rawText: text,
      textHash: createHash('sha256').update(text).digest('hex'),
      institution: 'telebirr',
      direction: 'credit',
      amount: input.amount,
      reference: input.reference ?? `R${randomUUID().slice(0, 10)}`,
      counterpartyPhone: input.payerPhone ?? null,
      occurredAt: at,
      receivedAt: at,
      status: input.status ?? 'unmatched',
      statusReason: 'no open deposit of this amount',
      flaggedIntentId: input.flaggedIntentId ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return row!;
}

async function deposit(input: {
  userId: string;
  phone: string;
  amount: bigint;
  provider?: string;
  status?: 'pending' | 'expired';
  createdAt?: Date;
  flagged?: string | null;
}) {
  const createdAt = input.createdAt ?? new Date(NOW.getTime() - 2 * HOUR);
  const [row] = await db.db
    .insert(paymentIntents)
    .values({
      userId: input.userId,
      provider: input.provider ?? 'sms',
      amount: input.amount,
      phone: input.phone,
      status: input.status ?? 'expired',
      idempotencyKey: `dep-${randomUUID()}`,
      providerRef: `REF${randomUUID().slice(0, 8)}`,
      expiresAt: new Date(createdAt.getTime() + HOUR),
      ...(input.flagged ? { flagReason: input.flagged, flaggedAt: NOW } : {}),
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  return row!;
}

describe('a player files a claim', () => {
  it('keeps what the player said, and refuses what cannot be a payment', async () => {
    const player = await createPlayer(db.db);
    const claim = await file({
      userId: player.userId,
      reference: ' ck 51 x2 ',
      payerPhone: '0911223344',
      note: 'Sent from my brother’s phone',
    });
    expect(claim).toMatchObject({
      status: 'open',
      method: 'telebirr',
      amount: birr(500),
      reference: 'CK51X2',
      payerPhone: '+251911223344',
    });
    const [audit] = await db.db.select().from(auditLog).where(eq(auditLog.targetId, claim.id));
    expect(audit?.action).toBe('payment.deposit_claim_filed');
    expect((await listPlayerDepositClaims(db.db, player.userId)).map((c) => c.id)).toEqual([
      claim.id,
    ]);

    const refused = async (input: Partial<Parameters<typeof fileDepositClaim>[1]>) =>
      (await domainError(file({ userId: player.userId, ...input }))).code;
    expect(await refused({ method: 'crypto' })).toBe('claim_method_invalid');
    expect(await refused({ amount: 0n })).toBe('claim_amount_invalid');
    expect(await refused({ paidAt: new Date(NOW.getTime() + HOUR) })).toBe('claim_time_invalid');
    expect(await refused({ paidAt: new Date(NOW.getTime() - 31 * 24 * HOUR) })).toBe(
      'claim_too_old',
    );
    expect(await refused({ reference: 'a!' })).toBe('claim_reference_invalid');
    expect(await refused({ payerPhone: '12' })).toBe('claim_phone_invalid');
    expect(await refused({ reference: 'CK51X2' })).toBe('claim_exists');
  });

  it(`allows at most ${MAX_OPEN_DEPOSIT_CLAIMS} open claims at a time`, async () => {
    const player = await createPlayer(db.db);
    for (let i = 0; i < MAX_OPEN_DEPOSIT_CLAIMS; i += 1) await file({ userId: player.userId });
    expect((await domainError(file({ userId: player.userId }))).code).toBe('too_many_open_claims');
  });
});

describe('Money not credited', () => {
  it('suggests the players an incoming SMS may belong to, and why', async () => {
    const payer = await createPlayer(db.db);
    const claimant = await createPlayer(db.db);
    const depositor = await createPlayer(db.db);
    // The payer's phone is a player's; another player opened a near SMS deposit an hour before;
    // a third filed a claim with the same reference.
    await deposit({ userId: depositor.userId, phone: depositor.phone, amount: birr(300) + 37n });
    const claim = await file({ userId: claimant.userId, amount: birr(300), reference: 'DK90QA' });
    const sms = await unmatchedSms({
      amount: birr(300),
      payerPhone: payer.phone,
      reference: 'dk90qa',
    });
    const list = await listMoneyNotCredited(db.db);
    const item = list.items.find((i) => i.id === sms.id)!;
    expect(item).toMatchObject({ kind: 'sms', amount: birr(300), status: 'unmatched' });
    const reasons = Object.fromEntries(item.suggestions.map((s) => [s.userId, s.reasons]));
    expect(reasons[claimant.userId]).toEqual(['claim_reference']);
    expect(reasons[payer.userId]).toEqual(['payer_phone']);
    expect(reasons[depositor.userId]).toEqual(['near_deposit']);
    // Strongest first: the claim with the same reference.
    expect(item.suggestions[0]).toMatchObject({ userId: claimant.userId, claimId: claim.id });
    expect(list.claims.find((c) => c.claim.id === claim.id)?.pairs).toEqual([
      { kind: 'sms', id: sms.id, reason: 'claim_reference' },
    ]);
    expect(list.waiting.count).toBeGreaterThanOrEqual(1);
    expect(list.waiting.amount).toBeGreaterThanOrEqual(birr(300));

    // A deposit opened after the money moved, or far from the amount, is not suggested.
    const late = await createPlayer(db.db);
    await deposit({
      userId: late.userId,
      phone: late.phone,
      amount: birr(300),
      createdAt: new Date(NOW.getTime() + HOUR),
    });
    const again = (await listMoneyNotCredited(db.db)).items.find((i) => i.id === sms.id)!;
    expect(again.suggestions.map((s) => s.userId)).not.toContain(late.userId);
  });

  it('names the player of a flagged deposit, SMS or provider', async () => {
    const player = await createPlayer(db.db);
    const smsDeposit = await deposit({
      userId: player.userId,
      phone: player.phone,
      amount: birr(150) + 12n,
      status: 'pending',
      flagged: 'third_party_payer',
    });
    const flaggedSms = await unmatchedSms({
      amount: birr(150) + 12n,
      status: 'flagged',
      flaggedIntentId: smsDeposit.id,
    });
    const chapa = await deposit({
      userId: player.userId,
      phone: player.phone,
      amount: birr(800),
      provider: 'chapa',
      status: 'pending',
      flagged: 'amount_mismatch',
    });
    const claim = await file({ userId: player.userId, method: 'chapa', amount: birr(800) });
    const list = await listMoneyNotCredited(db.db);
    expect(list.items.find((i) => i.id === flaggedSms.id)?.suggestions[0]).toMatchObject({
      userId: player.userId,
      reasons: ['flagged_deposit'],
    });
    // The SMS deposit itself is not listed twice (its SMS is).
    expect(list.items.some((i) => i.id === smsDeposit.id)).toBe(false);
    const provider = list.items.find((i) => i.id === chapa.id)!;
    expect(provider).toMatchObject({
      kind: 'provider',
      source: 'chapa',
      reason: 'amount_mismatch',
    });
    expect(provider.suggestions).toEqual([
      expect.objectContaining({
        userId: player.userId,
        reasons: ['own_deposit', 'claim_amount'],
        claimId: claim.id,
      }),
    ]);
  });

  it('an admin credits a claim with a manual deposit, once; or closes it with a note', async () => {
    const player = await createPlayer(db.db);
    const other = await createPlayer(db.db);
    const claim = await file({ userId: player.userId, reference: 'TX77AB12' });
    const credited = await db.db.transaction(async (tx) => {
      const { intent } = await creditDepositByAdmin(tx, {
        userId: player.userId,
        provider: 'telebirr',
        providerTransactionId: 'TX77AB12',
        amount: birr(500),
        reason: 'Claim checked against the telebirr statement',
        adminId: admin,
        now: NOW,
      });
      return creditDepositClaim(tx, {
        claimId: claim.id,
        userId: player.userId,
        intentId: intent.id,
        adminId: admin,
        now: NOW,
      });
    });
    expect(credited).toMatchObject({ status: 'credited', resolvedBy: admin });
    expect(credited.creditedIntentId).not.toBeNull();
    expect(
      (
        await domainError(
          db.db.transaction((tx) =>
            closeDepositClaim(tx, { claimId: claim.id, note: 'dup', adminId: admin, now: NOW }),
          ),
        )
      ).code,
    ).toBe('claim_not_open');

    // Money credited to another player cannot answer this player's claim: nothing is written.
    const second = await file({ userId: player.userId, reference: 'TX88CD34' });
    const wrong = await domainError(
      db.db.transaction(async (tx) => {
        const { intent } = await creditDepositByAdmin(tx, {
          userId: other.userId,
          provider: 'telebirr',
          providerTransactionId: 'TX88CD34',
          amount: birr(500),
          reason: 'Credited to the wrong player on purpose',
          adminId: admin,
          now: NOW,
        });
        return creditDepositClaim(tx, {
          claimId: second.id,
          userId: other.userId,
          intentId: intent.id,
          adminId: admin,
          now: NOW,
        });
      }),
    );
    expect(wrong.code).toBe('claim_other_player');
    const otherDeposits = await db.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.userId, other.userId));
    expect(otherDeposits).toEqual([]);

    expect(
      (
        await domainError(
          db.db.transaction((tx) =>
            closeDepositClaim(tx, { claimId: second.id, note: '', adminId: admin, now: NOW }),
          ),
        )
      ).code,
    ).toBe('reason_required');
    const closed = await db.db.transaction((tx) =>
      closeDepositClaim(tx, {
        claimId: second.id,
        note: 'No such payment on the statement',
        adminId: admin,
        now: NOW,
      }),
    );
    expect(closed).toMatchObject({
      status: 'closed',
      resolutionNote: 'No such payment on the statement',
    });
    const [row] = await db.db.select().from(depositClaims).where(eq(depositClaims.id, second.id));
    expect(row?.creditedIntentId).toBeNull();
  });

  it('near amounts: ETB 1 or 1 %', () => {
    expect(nearAmount(birr(300), birr(300) + 99n)).toBe(true);
    expect(nearAmount(birr(300), birr(304))).toBe(false);
    expect(nearAmount(birr(10_000), birr(10_090))).toBe(true);
    expect(nearAmount(birr(10_000), birr(10_200))).toBe(false);
  });
});
