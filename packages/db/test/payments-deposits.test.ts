import { birr } from '@vamos/core';
import { eventFromStatusQuery, mockDepositRef, type VerifiedWebhookEvent } from '@vamos/payments';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDepositEvent,
  createDepositIntent,
  DEPOSIT_FAILED,
  DEPOSIT_FLAGGED,
  DEPOSIT_SUCCEEDED,
  depositLedgerKey,
  expireStaleDepositIntents,
  getBalance,
  getDepositIntent,
  getUserDepositIntent,
  listFlaggedDepositIntents,
  listOpenDepositIntentsForPhone,
  listPendingDepositIntents,
  listUserDepositIntents,
  markDepositInitiated,
  markDepositInitiationFailed,
  resolveFlaggedDeposit,
  type PaymentIntent,
} from '../src/index';
import {
  ledgerEntries,
  ledgerTransactions,
  paymentEvents,
  paymentIntents,
  rgExclusions,
  rgLimits,
  users,
} from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import {
  auditCount,
  cashOf,
  createPlayer,
  depositViaMock,
  domainError,
  expectBooksBalanced,
  idemKey,
  NOW,
  outboxOf,
  psp,
  rules,
} from './payments-fixtures';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const MINUTE = 60_000;

async function intentFor(
  userId: string,
  amount: bigint,
  options: { key?: string; now?: Date; phone?: string; provider?: string } = {},
) {
  return handle.db.transaction((tx) =>
    createDepositIntent(tx, {
      userId,
      provider: options.provider ?? 'mock',
      amount,
      ...(options.phone === undefined ? {} : { phone: options.phone }),
      idempotencyKey: options.key ?? idemKey('dep'),
      now: options.now ?? NOW,
      rules: rules(),
    }),
  );
}

/** An intent that the mock provider accepted (status pending, reference recorded). */
async function pendingIntent(userId: string, amount: bigint, now = NOW): Promise<PaymentIntent> {
  const { intent } = await intentFor(userId, amount, { now });
  return handle.db.transaction((tx) =>
    markDepositInitiated(tx, {
      intentId: intent.id,
      initiation: { kind: 'push', providerRef: mockDepositRef(intent.id), instructions: 'Approve' },
      now,
    }),
  );
}

function event(intent: PaymentIntent, overrides: Partial<VerifiedWebhookEvent> = {}) {
  return {
    providerEventId: `evt-${intent.id}-${overrides.status ?? 'succeeded'}`,
    kind: 'deposit' as const,
    providerRef: intent.providerRef ?? mockDepositRef(intent.id),
    status: 'succeeded' as const,
    amount: intent.amount,
    currency: 'ETB',
    raw: { test: true },
    ...overrides,
  };
}

const apply = (e: ReturnType<typeof event>, now = NOW) =>
  handle.db.transaction((tx) => applyDepositEvent(tx, { provider: 'mock', event: e, now }));

async function depositPostings(intentId: string) {
  const [row] = await handle.db
    .select({ n: count() })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, depositLedgerKey(intentId)));
  return row?.n ?? 0;
}

describe('createDepositIntent', () => {
  it('creates an intent from the registered phone, expiring after the TTL, with an audit record', async () => {
    const player = await createPlayer(handle.db);
    const { intent, replayed } = await intentFor(player.userId, birr(150));
    expect(replayed).toBe(false);
    expect(intent).toMatchObject({
      userId: player.userId,
      provider: 'mock',
      amount: birr(150),
      currency: 'ETB',
      phone: player.phone,
      status: 'created',
      providerRef: null,
      flaggedAt: null,
      ledgerTransactionId: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + rules().depositIntentTtlMinutes * MINUTE),
    });
    expect(await auditCount(handle.db, intent.id, 'payment.deposit_created')).toBe(1);
  });

  it('replays an idempotency key without writing, and refuses it for another deposit', async () => {
    const player = await createPlayer(handle.db);
    const key = idemKey();
    const first = await intentFor(player.userId, birr(100), { key });
    const again = await intentFor(player.userId, birr(100), { key, phone: player.phone });
    expect(again).toEqual({ intent: first.intent, replayed: true });
    expect(await auditCount(handle.db, first.intent.id)).toBe(1);
    const reused = await domainError(intentFor(player.userId, birr(200), { key }));
    expect(reused).toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    // Keys are scoped per player.
    const other = await createPlayer(handle.db);
    expect((await intentFor(other.userId, birr(200), { key })).replayed).toBe(false);
  });

  it('refuses amounts outside the limits and other phones', async () => {
    const player = await createPlayer(handle.db);
    const low = await domainError(intentFor(player.userId, birr(9)));
    expect(low).toMatchObject({
      status: 422,
      code: 'deposit_amount_out_of_range',
      details: { min: '1000', max: '10000000', amount: '900' },
    });
    expect((await domainError(intentFor(player.userId, birr(100_001)))).code).toBe(
      'deposit_amount_out_of_range',
    );
    const other = await createPlayer(handle.db);
    for (const phone of [other.phone, 'not a phone']) {
      expect(await domainError(intentFor(player.userId, birr(100), { phone }))).toMatchObject({
        status: 422,
        code: 'deposit_phone_mismatch',
      });
    }
    // The local form of the player's own number is fine.
    const local = `0${player.phone.slice(4)}`;
    expect((await intentFor(player.userId, birr(100), { phone: local })).intent.phone).toBe(
      player.phone,
    );
  });

  it('applies responsible gambling: exclusions and deposit limits (open intents count)', async () => {
    const excluded = await createPlayer(handle.db);
    await handle.db.insert(rgExclusions).values({
      userId: excluded.userId,
      kind: 'self_exclusion',
      startsAt: new Date(NOW.getTime() - MINUTE),
      endsAt: null,
    });
    expect(await domainError(intentFor(excluded.userId, birr(100)))).toMatchObject({
      status: 403,
      code: 'self_excluded',
    });

    const limited = await createPlayer(handle.db);
    await handle.db.insert(rgLimits).values({
      userId: limited.userId,
      kind: 'deposit',
      period: 'day',
      amount: birr(500),
      effectiveFrom: new Date(NOW.getTime() - MINUTE),
      createdAt: new Date(NOW.getTime() - MINUTE),
    });
    await intentFor(limited.userId, birr(300));
    const over = await domainError(intentFor(limited.userId, birr(250)));
    expect(over).toMatchObject({
      status: 422,
      code: 'deposit_limit_exceeded',
      details: { period: 'day', limit: '50000', used: '0', pending: '30000' },
    });
    expect((await intentFor(limited.userId, birr(200))).replayed).toBe(false);

    const disabled = await createPlayer(handle.db);
    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, disabled.userId));
    expect((await domainError(intentFor(disabled.userId, birr(100)))).code).toBe(
      'account_disabled',
    );
  });

  it('serialises concurrent intents of one player against the deposit limit', async () => {
    const player = await createPlayer(handle.db);
    await handle.db.insert(rgLimits).values({
      userId: player.userId,
      kind: 'deposit',
      period: 'day',
      amount: birr(1_000),
      effectiveFrom: new Date(NOW.getTime() - MINUTE),
      createdAt: new Date(NOW.getTime() - MINUTE),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => intentFor(player.userId, birr(300))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected')
        expect((r.reason as { code: string }).code).toBe('deposit_limit_exceeded');
    }
  });
});

describe('deposit initiation', () => {
  it('records the provider reference once (created → pending) and refuses another', async () => {
    const player = await createPlayer(handle.db);
    const { intent } = await intentFor(player.userId, birr(100));
    const initiation = { kind: 'push' as const, providerRef: mockDepositRef(intent.id) };
    const pending = await handle.db.transaction((tx) =>
      markDepositInitiated(tx, { intentId: intent.id, initiation, now: NOW }),
    );
    expect(pending).toMatchObject({
      status: 'pending',
      providerRef: mockDepositRef(intent.id),
      initiationKind: 'push',
    });
    const again = await handle.db.transaction((tx) =>
      markDepositInitiated(tx, { intentId: intent.id, initiation, now: NOW }),
    );
    expect(again).toEqual(pending);
    const conflict = await domainError(
      handle.db.transaction((tx) =>
        markDepositInitiated(tx, {
          intentId: intent.id,
          initiation: { ...initiation, providerRef: 'other' },
          now: NOW,
        }),
      ),
    );
    expect(conflict).toMatchObject({ status: 409, code: 'provider_ref_conflict' });
    // A failed initiation cannot fail an intent the provider accepted.
    const unchanged = await handle.db.transaction((tx) =>
      markDepositInitiationFailed(tx, { intentId: intent.id, reason: 'late', now: NOW }),
    );
    expect(unchanged.status).toBe('pending');
  });

  it('fails an intent whose provider call failed', async () => {
    const player = await createPlayer(handle.db);
    const { intent } = await intentFor(player.userId, birr(100));
    const failed = await handle.db.transaction((tx) =>
      markDepositInitiationFailed(tx, { intentId: intent.id, reason: 'provider down', now: NOW }),
    );
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'provider down' });
  });
});

describe('applyDepositEvent', () => {
  it('credits a verified success once: ledger, intent, payment event, outbox, audit', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(250));
    const pspBefore = await getBalance(handle.db, psp());
    const result = await apply(event(intent));
    expect(result.outcome).toBe('credited');
    expect(result.intent).toMatchObject({ status: 'succeeded', completedAt: NOW });
    expect(result.intent.ledgerTransactionId).not.toBeNull();

    expect(await cashOf(handle.db, player.userId)).toBe(birr(250));
    expect(await getBalance(handle.db, psp())).toBe(pspBefore - birr(250));
    const [posting] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, result.intent.ledgerTransactionId!));
    expect(posting).toMatchObject({
      type: 'deposit',
      idempotencyKey: depositLedgerKey(intent.id),
      refType: 'payment_intent',
      refId: intent.id,
    });
    const entries = await handle.db
      .select({ amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, posting!.id));
    expect(entries.map((e) => e.amount).sort()).toEqual([-birr(250), birr(250)].sort());

    const events = await handle.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.intentId, intent.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'mock',
      kind: 'deposit',
      status: 'succeeded',
      amount: birr(250),
      outcome: 'credited',
      payload: { test: true },
      receivedAt: NOW,
    });
    expect(await outboxOf(handle.db, intent.id)).toEqual([
      [
        DEPOSIT_SUCCEEDED,
        {
          intentId: intent.id,
          userId: player.userId,
          provider: 'mock',
          amount: '25000',
          providerRef: intent.providerRef,
        },
      ],
    ]);
    expect(await auditCount(handle.db, intent.id, DEPOSIT_SUCCEEDED)).toBe(1);
  });

  it('is idempotent: a replayed webhook is a duplicate and a second success is ignored', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(100));
    expect((await apply(event(intent))).outcome).toBe('credited');
    expect((await apply(event(intent))).outcome).toBe('duplicate');
    const poll = await apply(event(intent, { providerEventId: `poll-${intent.id}` }));
    expect(poll.outcome).toBe('ignored');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect(await depositPostings(intent.id)).toBe(1);
    expect((await outboxOf(handle.db, intent.id)).map(([type]) => type)).toEqual([
      DEPOSIT_SUCCEEDED,
    ]);
    const recorded = await handle.db
      .select({ outcome: paymentEvents.outcome })
      .from(paymentEvents)
      .where(eq(paymentEvents.intentId, intent.id));
    expect(recorded.map((r) => r.outcome).sort()).toEqual(['credited', 'ignored']);
  });

  it('credits exactly once when the same and different events race', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(100));
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => apply(event(intent))),
      ...Array.from({ length: 4 }, (_, i) =>
        apply(event(intent, { providerEventId: `race-${i}-${intent.id}` })),
      ),
    ]);
    expect(results.filter((r) => r.outcome === 'credited')).toHaveLength(1);
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect(await depositPostings(intent.id)).toBe(1);
  });

  it('flags an amount mismatch and credits nothing; the flag holds against later events', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(150));
    const result = await apply(event(intent, { amount: birr(1_500) }));
    expect(result).toMatchObject({ outcome: 'flagged', flagReason: 'amount_mismatch' });
    expect(result.intent).toMatchObject({
      status: 'pending',
      flagReason: 'amount_mismatch',
      flaggedAt: NOW,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(0n);
    expect(await depositPostings(intent.id)).toBe(0);
    const outbox = await outboxOf(handle.db, intent.id);
    expect(outbox).toEqual([
      [
        DEPOSIT_FLAGGED,
        expect.objectContaining({
          reason: 'amount_mismatch',
          amount: '15000',
          reportedAmount: '150000',
        }),
      ],
    ]);
    // A correct success afterwards does not slip past the flag.
    const later = await apply(event(intent, { providerEventId: `later-${intent.id}` }));
    expect(later.outcome).toBe('ignored');
    expect(await cashOf(handle.db, player.userId)).toBe(0n);
    const [recorded] = await handle.db
      .select({ outcome: paymentEvents.outcome })
      .from(paymentEvents)
      .where(eq(paymentEvents.providerEventId, `evt-${intent.id}-succeeded`));
    expect(recorded?.outcome).toBe('flagged:amount_mismatch');
  });

  it('flags a missing amount and another currency', async () => {
    const player = await createPlayer(handle.db);
    const noAmount = await pendingIntent(player.userId, birr(100));
    expect(await apply(event(noAmount, { amount: null }))).toMatchObject({
      outcome: 'flagged',
      flagReason: 'amount_missing',
    });
    const usd = await pendingIntent(player.userId, birr(100));
    expect(await apply(event(usd, { currency: 'USD' }))).toMatchObject({
      outcome: 'flagged',
      flagReason: 'currency_mismatch',
    });
    // Lower-case ETB is the same currency.
    const lower = await pendingIntent(player.userId, birr(100));
    expect((await apply(event(lower, { currency: 'etb' }))).outcome).toBe('credited');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
  });

  it('fails a declined deposit and flags a success that arrives after it', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(100));
    const declined = await apply(event(intent, { status: 'failed' }));
    expect(declined.outcome).toBe('failed');
    expect(declined.intent).toMatchObject({
      status: 'failed',
      failureReason: 'declined_by_provider',
      completedAt: NOW,
    });
    expect((await outboxOf(handle.db, intent.id)).map(([type]) => type)).toEqual([DEPOSIT_FAILED]);
    const late = await apply(event(intent, { status: 'succeeded' }));
    expect(late).toMatchObject({ outcome: 'flagged', flagReason: 'success_after_failure' });
    expect(await cashOf(handle.db, player.userId)).toBe(0n);
  });

  it('flags a failure after a success and leaves the credit alone', async () => {
    const player = await createPlayer(handle.db);
    const intent = await pendingIntent(player.userId, birr(100));
    await apply(event(intent));
    const reversal = await apply(event(intent, { status: 'failed' }));
    expect(reversal).toMatchObject({ outcome: 'flagged', flagReason: 'failure_after_success' });
    expect(reversal.intent.status).toBe('succeeded');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
  });

  it('moves a created intent to pending on a pending event and ignores it otherwise', async () => {
    const player = await createPlayer(handle.db);
    const { intent } = await intentFor(player.userId, birr(100));
    // The reference is recorded without the status change (a late initiation answer).
    await handle.db
      .update(paymentIntents)
      .set({ providerRef: `ref-${intent.id}` })
      .where(eq(paymentIntents.id, intent.id));
    const withRef = { ...intent, providerRef: `ref-${intent.id}` };
    expect((await apply(event(withRef, { status: 'pending' }))).intent.status).toBe('pending');
    expect(
      (await apply(event(withRef, { status: 'pending', providerEventId: `p2-${intent.id}` })))
        .outcome,
    ).toBe('ignored');
  });

  it('refuses an unknown reference without recording it, so a retry can match later', async () => {
    const player = await createPlayer(handle.db);
    const { intent } = await intentFor(player.userId, birr(100));
    const early = event({ ...intent, providerRef: mockDepositRef(intent.id) });
    expect(await domainError(apply(early))).toMatchObject({
      status: 404,
      code: 'unknown_payment_reference',
    });
    const [none] = await handle.db
      .select({ n: count() })
      .from(paymentEvents)
      .where(eq(paymentEvents.providerEventId, early.providerEventId));
    expect(none?.n).toBe(0);
    await handle.db.transaction((tx) =>
      markDepositInitiated(tx, {
        intentId: intent.id,
        initiation: { kind: 'push', providerRef: mockDepositRef(intent.id) },
        now: NOW,
      }),
    );
    expect((await apply(early)).outcome).toBe('credited');
    // Another provider's reference space is separate.
    const other = await domainError(
      handle.db.transaction((tx) =>
        applyDepositEvent(tx, { provider: 'chapa', event: early, now: NOW }),
      ),
    );
    expect(other.code).toBe('unknown_payment_reference');
    await expect(
      handle.db.transaction((tx) =>
        applyDepositEvent(tx, { provider: 'mock', event: { ...early, kind: 'payout' }, now: NOW }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('accepts the mock provider’s signed webhook and status-poll events end to end', async () => {
    const player = await createPlayer(handle.db);
    const intent = await depositViaMock(handle.db, player.userId, birr(320));
    expect(intent.status).toBe('succeeded');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(320));
    // A poll that reports success afterwards changes nothing.
    const pending = await pendingIntent(player.userId, birr(10));
    const polled = eventFromStatusQuery('deposit', {
      providerRef: pending.providerRef!,
      status: 'succeeded',
      amount: birr(10),
      currency: 'ETB',
      raw: {},
    });
    expect((await apply(polled)).outcome).toBe('credited');
    expect((await apply(polled)).outcome).toBe('duplicate');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(330));
  });
});

describe('expiry', () => {
  it('expires open intents at their expiry, skipping flagged ones; a late success still credits', async () => {
    const player = await createPlayer(handle.db);
    const t0 = new Date('2026-10-11T12:00:00Z');
    const created = await intentFor(player.userId, birr(100), { now: t0 });
    const pending = await pendingIntent(player.userId, birr(120), t0);
    const flagged = await pendingIntent(player.userId, birr(130), t0);
    await apply(event(flagged, { amount: birr(1) }));
    const fresh = await pendingIntent(
      player.userId,
      birr(140),
      new Date(t0.getTime() + 20 * MINUTE),
    );

    const expiry = new Date(t0.getTime() + rules().depositIntentTtlMinutes * MINUTE);
    const before = await handle.db.transaction((tx) =>
      expireStaleDepositIntents(tx, { now: new Date(expiry.getTime() - 1) }),
    );
    expect(before.map((i) => i.id)).not.toContain(pending.id);
    const expired = await handle.db.transaction((tx) =>
      expireStaleDepositIntents(tx, { now: expiry }),
    );
    const ids = expired.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([created.intent.id, pending.id]));
    expect(ids).not.toContain(flagged.id);
    expect(ids).not.toContain(fresh.id);
    expect((await getDepositIntent(handle.db, pending.id))?.status).toBe('expired');
    expect((await getDepositIntent(handle.db, flagged.id))?.status).toBe('pending');

    // The money did move: a verified success after expiry is credited.
    const late = await apply(event(pending), new Date(expiry.getTime() + MINUTE));
    expect(late.outcome).toBe('credited');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(120));
  });
});

describe('resolveFlaggedDeposit', () => {
  it('credits a flagged intent once confirmed by staff, or closes it', async () => {
    const player = await createPlayer(handle.db);
    const admin = '9a3e1d4c-5b6f-4a7e-8d9c-0b1a2c3d4e5f';
    const toCredit = await pendingIntent(player.userId, birr(100));
    await apply(event(toCredit, { amount: null }));
    const toClose = await pendingIntent(player.userId, birr(200));
    await apply(event(toClose, { amount: birr(2) }));

    const flaggedIds = (await listFlaggedDepositIntents(handle.db)).map((i) => i.id);
    expect(flaggedIds).toEqual(expect.arrayContaining([toCredit.id, toClose.id]));

    const credited = await handle.db.transaction((tx) =>
      resolveFlaggedDeposit(tx, {
        intentId: toCredit.id,
        adminId: admin,
        resolution: 'credit',
        note: 'PSP statement shows 100 ETB collected',
        now: NOW,
      }),
    );
    expect(credited).toMatchObject({ status: 'succeeded', flagReason: null, flaggedAt: null });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect(await depositPostings(toCredit.id)).toBe(1);

    const closed = await handle.db.transaction((tx) =>
      resolveFlaggedDeposit(tx, {
        intentId: toClose.id,
        adminId: admin,
        resolution: 'close',
        note: 'PSP has no such payment',
        now: NOW,
      }),
    );
    expect(closed).toMatchObject({
      status: 'failed',
      failureReason: 'closed_by_staff',
      flaggedAt: null,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect((await outboxOf(handle.db, toClose.id)).map(([type]) => type)).toEqual([
      DEPOSIT_FLAGGED,
      DEPOSIT_FAILED,
    ]);
    expect(await auditCount(handle.db, toCredit.id, 'payment.deposit_resolved')).toBe(1);

    expect(
      await domainError(
        handle.db.transaction((tx) =>
          resolveFlaggedDeposit(tx, {
            intentId: toClose.id,
            adminId: admin,
            resolution: 'credit',
            note: 'again',
            now: NOW,
          }),
        ),
      ),
    ).toMatchObject({ status: 409, code: 'deposit_not_flagged' });

    // A failure after a credit: the credit cannot be repeated, only the flag closed.
    const refunded = await pendingIntent(player.userId, birr(50));
    await apply(event(refunded));
    await apply(event(refunded, { status: 'failed' }));
    expect(
      (
        await domainError(
          handle.db.transaction((tx) =>
            resolveFlaggedDeposit(tx, {
              intentId: refunded.id,
              adminId: admin,
              resolution: 'credit',
              note: 'x',
              now: NOW,
            }),
          ),
        )
      ).code,
    ).toBe('deposit_already_credited');
    const kept = await handle.db.transaction((tx) =>
      resolveFlaggedDeposit(tx, {
        intentId: refunded.id,
        adminId: admin,
        resolution: 'close',
        note: 'refund handled with the PSP',
        now: NOW,
      }),
    );
    expect(kept).toMatchObject({ status: 'succeeded', flaggedAt: null });
  });
});

describe('deposit queries', () => {
  it('lists intents for the simulator, pollers and the player', async () => {
    const player = await createPlayer(handle.db);
    const other = await createPlayer(handle.db);
    const t0 = new Date('2026-10-12T08:00:00Z');
    const first = await pendingIntent(player.userId, birr(10), t0);
    const second = await pendingIntent(player.userId, birr(20), new Date(t0.getTime() + MINUTE));
    await intentFor(player.userId, birr(30), { now: t0 }); // created, no reference

    const open = await listOpenDepositIntentsForPhone(handle.db, {
      provider: 'mock',
      phone: player.phone,
      now: t0,
    });
    expect(open.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(
      await listOpenDepositIntentsForPhone(handle.db, {
        provider: 'mock',
        phone: player.phone,
        now: new Date(t0.getTime() + 2 * 3_600_000),
      }),
    ).toEqual([]);
    await expect(
      listOpenDepositIntentsForPhone(handle.db, { provider: 'mock', phone: 'x', now: t0 }),
    ).rejects.toMatchObject({ code: 'invalid_phone' });

    const due = await listPendingDepositIntents(handle.db, {
      createdBefore: new Date(t0.getTime() + 30_000),
      provider: 'mock',
      limit: 500,
    });
    expect(due.map((i) => i.id)).toContain(first.id);
    expect(due.map((i) => i.id)).not.toContain(second.id);

    const mine = await listUserDepositIntents(handle.db, player.userId);
    expect(mine.map((i) => i.amount)).toEqual(
      expect.arrayContaining([birr(10), birr(20), birr(30)]),
    );
    expect(mine.every((i) => i.userId === player.userId)).toBe(true);
    expect(await getUserDepositIntent(handle.db, other.userId, first.id)).toBeNull();
    expect((await getUserDepositIntent(handle.db, player.userId, first.id))?.id).toBe(first.id);
  });

  it('keeps the books balanced', async () => {
    await expectBooksBalanced(handle.db);
  });
});
