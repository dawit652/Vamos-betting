import { createHash, randomUUID } from 'node:crypto';
import { birr, businessDateOf } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CASH_PROVIDER,
  cashDeposit,
  cashWithdrawal,
  checkCashCode,
  expireUncollectedCashPayouts,
  postShiftVariance,
  closeShift,
  createCashCode,
  findDeskPayout,
  forceCloseShift,
  findDeskPlayer,
  getOpenShift,
  getReceipt,
  listShiftOperations,
  listShops,
  openShift,
  recordReprint,
  shiftTotals,
  shiftTotalsMany,
  updateShop,
} from '../src/cashier/index';
import { runReconciliationChecks } from '../src/compliance/index';
import { DomainError } from '../src/errors';
import { getBalance, getPlayerBalances } from '../src/ledger/index';
import {
  approveWithdrawal,
  claimDuePayouts,
  DEPOSIT_SUCCEEDED,
  markPayoutPaid,
} from '../src/payments/index';
import {
  adminUsers,
  auditLog,
  cashOperations,
  paymentIntents,
  payouts,
  rgExclusions,
  rgLimits,
  users,
} from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import {
  cashOf,
  createPlayer,
  expectBooksBalanced,
  NOW,
  outboxOf,
  rules,
} from './payments-fixtures';

/** The cashier desk (docs/plans/cashier-dashboard.md): shifts, cash deposits, receipts. */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let shopId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  const [shop] = await listShops(handle.db);
  shopId = shop!.id;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const RULES = rules();

async function staff(role: 'cashier' | 'finance' | 'support' = 'cashier'): Promise<string> {
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `${role}-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `Test ${role}`,
      role,
    })
    .returning({ id: adminUsers.id });
  return row!.id;
}

async function shiftFor(staffId: string, openingFloat = birr(500)) {
  return handle.db.transaction((tx) => openShift(tx, { staffId, shopId, openingFloat, now: NOW }));
}

function deposit(
  staffId: string,
  shiftId: string,
  userId: string,
  amount: bigint,
  key = `desk-${randomUUID()}`,
  now = NOW,
) {
  return handle.db.transaction((tx) =>
    cashDeposit(tx, {
      staffId,
      shiftId,
      userId,
      amount,
      idempotencyKey: key,
      rules: RULES,
      now,
    }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the first shop', () => {
  it('exists after the migrations, with 80 mm receipts and an ETB 10,000 threshold', async () => {
    const shops = await listShops(handle.db);
    expect(shops).toHaveLength(1);
    expect(shops[0]).toMatchObject({
      code: 'main',
      receiptWidthMm: 80,
      approvalThreshold: birr(10_000),
      active: true,
    });
  });
});

describe('shifts', () => {
  it('opens one shift per staff member and closes it with the expected cash and the variance', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier, birr(1_000));
    expect(shift.status).toBe('open');
    expect(await refusal(shiftFor(cashier))).toEqual({ status: 409, code: 'shift_already_open' });

    const { userId } = await createPlayer(handle.db);
    await deposit(cashier, shift.id, userId, birr(300));
    await deposit(cashier, shift.id, userId, birr(200));

    // Only the owner closes it.
    const other = await staff();
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          closeShift(tx, { staffId: other, shiftId: shift.id, countedCash: 0n, now: NOW }),
        ),
      ),
    ).toEqual({ status: 404, code: 'not_found' });

    const closed = await handle.db.transaction((tx) =>
      closeShift(tx, {
        staffId: cashier,
        shiftId: shift.id,
        countedCash: birr(1_490),
        note: ' short by 10 ',
        now: new Date(NOW.getTime() + 8 * 3_600_000),
      }),
    );
    expect(closed.shift).toMatchObject({
      status: 'closed',
      expectedCash: birr(1_500),
      countedCash: birr(1_490),
      closeNote: 'short by 10',
    });
    expect(closed.totals.deposits).toEqual({ count: 2, total: birr(500) });
    const [audit] = await handle.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.targetId, shift.id));
    expect(audit).toBeDefined();
    expect(await getOpenShift(handle.db, cashier)).toBeNull();

    // Closed: no more operations in it, and a new shift may open.
    expect(await refusal(deposit(cashier, shift.id, userId, birr(50)))).toEqual({
      status: 409,
      code: 'shift_not_open',
    });
    expect((await shiftFor(cashier)).status).toBe('open');
  });

  it('refuses a closed shop', async () => {
    const admin = await staff('finance');
    const [shop] = await listShops(handle.db);
    await handle.db.transaction((tx) =>
      updateShop(tx, {
        shopId,
        name: shop!.name,
        address: shop!.address,
        receiptWidthMm: 80,
        approvalThreshold: shop!.approvalThreshold,
        active: false,
        adminId: admin,
        now: NOW,
      }),
    );
    try {
      expect(await refusal(shiftFor(await staff()))).toEqual({
        status: 409,
        code: 'shop_inactive',
      });
    } finally {
      await handle.db.transaction((tx) =>
        updateShop(tx, {
          shopId,
          name: shop!.name,
          address: shop!.address,
          receiptWidthMm: 80,
          approvalThreshold: shop!.approvalThreshold,
          active: true,
          adminId: admin,
          now: NOW,
        }),
      );
    }
  });
});

describe('cash deposits', () => {
  it('credit the player like any deposit: a cash intent, the deposit posting and its event', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId, phone } = await createPlayer(handle.db);

    const { operation, replayed } = await deposit(cashier, shift.id, userId, birr(250));
    expect(replayed).toBe(false);
    expect(operation).toMatchObject({ kind: 'deposit', amount: birr(250), reprints: 0 });
    expect(await cashOf(handle.db, userId)).toBe(birr(250));

    const [intent] = await handle.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, operation.paymentIntentId!));
    expect(intent).toMatchObject({
      provider: CASH_PROVIDER,
      status: 'succeeded',
      amount: birr(250),
      phone,
      providerRef: `R${operation.receiptNo}`,
    });
    expect(intent?.ledgerTransactionId).not.toBeNull();
    // The cash drawer is a PSP clearing account: house:psp:cash -amount.
    expect(await getBalance(handle.db, { kind: 'house_psp_clearing', provider: 'cash' })).toBe(
      -(await cashOperationsTotal()),
    );
    const events = await outboxOf(handle.db, intent!.id);
    expect(events.map(([type]) => type)).toEqual([DEPOSIT_SUCCEEDED]);
    expect(events[0]?.[1]).toMatchObject({ userId, provider: 'cash' });
    await expectBooksBalanced(handle.db);
  });

  it('a replayed key gives the same receipt and credits once; another use of it is refused', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db);
    const key = `desk-${randomUUID()}`;
    const first = await deposit(cashier, shift.id, userId, birr(100), key);
    const again = await deposit(cashier, shift.id, userId, birr(100), key);
    expect(again.replayed).toBe(true);
    expect(again.operation.id).toBe(first.operation.id);
    expect(await cashOf(handle.db, userId)).toBe(birr(100));
    expect(await refusal(deposit(cashier, shift.id, userId, birr(101), key))).toEqual({
      status: 422,
      code: 'idempotency_key_reused',
    });
    // Two at once with one key: one credit.
    const key2 = `desk-${randomUUID()}`;
    const both = await Promise.all([
      deposit(cashier, shift.id, userId, birr(40), key2),
      deposit(cashier, shift.id, userId, birr(40), key2),
    ]);
    expect(both.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await cashOf(handle.db, userId)).toBe(birr(140));
  });

  it('respect the payment rules, the shop threshold for cashiers, and the player state', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db);

    expect(await refusal(deposit(cashier, shift.id, userId, RULES.minDeposit - 1n))).toEqual({
      status: 422,
      code: 'deposit_amount_out_of_range',
    });
    // Above the shop's threshold (ETB 10,000): a supervisor only.
    expect(await refusal(deposit(cashier, shift.id, userId, birr(10_001)))).toEqual({
      status: 403,
      code: 'cashier_approval_required',
    });
    const supervisor = await staff('finance');
    const theirs = await shiftFor(supervisor);
    expect((await deposit(supervisor, theirs.id, userId, birr(10_001))).replayed).toBe(false);

    // A deposit limit counts cash like any other deposit.
    await handle.db.insert(rgLimits).values({
      userId,
      kind: 'deposit',
      period: 'day',
      amount: birr(10_100),
      effectiveFrom: new Date(NOW.getTime() - 86_400_000),
    });
    expect(await refusal(deposit(cashier, shift.id, userId, birr(100)))).toEqual({
      status: 422,
      code: 'deposit_limit_exceeded',
    });

    // Excluded or disabled players are not served.
    const excluded = (await createPlayer(handle.db)).userId;
    await handle.db.insert(rgExclusions).values({
      userId: excluded,
      kind: 'self_exclusion',
      startsAt: new Date(NOW.getTime() - 60_000),
      endsAt: null,
    });
    expect((await refusal(deposit(cashier, shift.id, excluded, birr(50)))).status).toBe(403);
    const suspended = (await createPlayer(handle.db)).userId;
    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended));
    expect(await refusal(deposit(cashier, shift.id, suspended, birr(50)))).toEqual({
      status: 403,
      code: 'account_disabled',
    });
    // Someone else's shift is not found.
    expect(await refusal(deposit(cashier, theirs.id, userId, birr(50)))).toEqual({
      status: 404,
      code: 'not_found',
    });
    await expectBooksBalanced(handle.db);
  });
});

describe('players and receipts', () => {
  it('finds a player by any form of the phone number, with balance, KYC and exclusion', async () => {
    const { userId, phone } = await createPlayer(handle.db, { kyc: 'verified', name: 'Abebe K.' });
    const local = `0${phone.slice(4)}`;
    const found = await findDeskPlayer(handle.db, local, NOW);
    expect(found).toMatchObject({ id: userId, phone, kycStatus: 'verified', exclusion: null });
    expect(await findDeskPlayer(handle.db, '+251900000001', NOW)).toBeNull();
    expect(await findDeskPlayer(handle.db, 'not a phone', NOW)).toBeNull();
  });

  it('prints a receipt with the shop, the cashier and the masked player; copies are counted', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId, phone } = await createPlayer(handle.db);
    const { operation } = await deposit(cashier, shift.id, userId, birr(75));

    const receipt = await getReceipt(handle.db, operation.id);
    expect(receipt).toMatchObject({
      shop: { code: 'main' },
      staffName: 'Test cashier',
      player: { phone },
      reference: `R${operation.receiptNo}`,
    });
    const ops = await listShiftOperations(handle.db, shift.id);
    expect(ops.map((o) => o.id)).toEqual([operation.id]);
    expect((await shiftTotals(handle.db, shift)).expectedCash).toBe(birr(575));
    // The shift list reads every shift's totals in one grouped query: the same figures.
    const many = await shiftTotalsMany(handle.db, [shift]);
    expect(many.get(shift.id)).toEqual(await shiftTotals(handle.db, shift));
    expect((await shiftTotalsMany(handle.db, [])).size).toBe(0);

    // A copy by its cashier or a supervisor; nobody else sees it.
    const copy = await handle.db.transaction((tx) =>
      recordReprint(tx, { operationId: operation.id, staffId: cashier, supervisor: false }),
    );
    expect(copy.reprints).toBe(1);
    const stranger = await staff();
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          recordReprint(tx, { operationId: operation.id, staffId: stranger, supervisor: false }),
        ),
      ),
    ).toEqual({ status: 404, code: 'not_found' });
  });
});

describe('reconciliation', () => {
  it('finds every cash deposit consistent: an intent, its clearing entry, the daily totals', async () => {
    const result = await runReconciliationChecks(handle.db, {
      businessDate: businessDateOf(NOW),
      balanceAfterGraceMs: 0,
    });
    const psp = result.checks.filter((check) => check.check.startsWith('psp_'));
    expect(psp.map((check) => check.check).sort()).toEqual([
      'psp_daily_totals',
      'psp_movements',
      'psp_records',
    ]);
    expect(result.mismatches.filter((m) => m.check.startsWith('psp_'))).toEqual([]);
  });
});

async function cashOperationsTotal(): Promise<bigint> {
  const rows = await handle.db
    .select({ amount: cashOperations.amount })
    .from(cashOperations)
    .where(eq(cashOperations.kind, 'deposit'));
  return rows.reduce((sum, row) => sum + row.amount, 0n);
}

describe('cash withdrawals', () => {
  // The API keys this with its secret; any hex hash will do here.
  const hash = (code: string) => createHash('sha256').update(code).digest('hex');
  const makeCode = (userId: string, code = '123456') =>
    handle.db.transaction((tx) => createCashCode(tx, { userId, codeHash: hash(code), now: NOW }));
  async function withdraw(
    staffId: string,
    shiftId: string,
    userId: string,
    amount: bigint,
    options: { code?: string; key?: string } = {},
  ) {
    const code = options.code ?? '123456';
    const codeId = await checkCashCode(handle.db, { userId, codeHash: hash(code), now: NOW });
    return handle.db.transaction((tx) =>
      cashWithdrawal(tx, {
        staffId,
        shiftId,
        userId,
        amount,
        idempotencyKey: options.key ?? `desk-${randomUUID()}`,
        code: { id: codeId, hash: hash(code) },
        rules: RULES,
        now: NOW,
      }),
    );
  }
  async function payout(id: string) {
    const [row] = await handle.db.select().from(payouts).where(eq(payouts.id, id));
    return row!;
  }

  it('pays at once when the online rules approve it, with the hold moved to the cash drawer', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier, birr(1_000));
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Abebe Kebede' });
    await deposit(cashier, shift.id, userId, birr(2_000));
    await makeCode(userId);

    const result = await withdraw(cashier, shift.id, userId, birr(500));
    if (result.outcome !== 'paid') throw new Error(`expected paid, got ${result.outcome}`);
    expect(result.operation).toMatchObject({ kind: 'withdrawal', amount: birr(500) });
    expect(await cashOf(handle.db, userId)).toBe(birr(1_500));
    expect(await payout(result.operation.payoutId!)).toMatchObject({
      provider: 'cash',
      status: 'paid',
      providerRef: `R${result.operation.receiptNo}`,
    });
    expect((await shiftTotals(handle.db, shift)).expectedCash).toBe(birr(2_500));
    const receipt = await getReceipt(handle.db, result.operation.id);
    expect(receipt?.operation.kind).toBe('withdrawal');
    await expectBooksBalanced(handle.db);

    // The code is spent.
    expect(await refusal(withdraw(cashier, shift.id, userId, birr(100)))).toEqual({
      status: 400,
      code: 'cash_code_invalid',
    });
  });

  it('counts every wrong code; a code dies after five wrong tries', async () => {
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Almaz T.' });
    await makeCode(userId, '111111');
    const left: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      try {
        await checkCashCode(handle.db, { userId, codeHash: hash('222222'), now: NOW });
      } catch (error) {
        left.push(((error as DomainError).details as { attemptsLeft: number }).attemptsLeft);
      }
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(
      await refusal(checkCashCode(handle.db, { userId, codeHash: hash('111111'), now: NOW })),
    ).toEqual({ status: 400, code: 'cash_code_invalid' });
    // A newer code retires the older one.
    await makeCode(userId, '333333');
    await makeCode(userId, '444444');
    expect(
      await refusal(checkCashCode(handle.db, { userId, codeHash: hash('333333'), now: NOW })),
    ).toEqual({ status: 400, code: 'cash_code_invalid' });
    expect(
      await checkCashCode(handle.db, { userId, codeHash: hash('444444'), now: NOW }),
    ).toBeTruthy();
  });

  it('follows the online rules; above auto-approval it waits for review and is paid on the next visit', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);

    // No verified identity: refused, and the code stays live (nothing was written).
    const unverified = (await createPlayer(handle.db, { kyc: 'none' })).userId;
    await deposit(cashier, shift.id, unverified, birr(300));
    await makeCode(unverified);
    expect(await refusal(withdraw(cashier, shift.id, unverified, birr(100)))).toEqual({
      status: 403,
      code: 'kyc_required',
    });
    expect(
      await checkCashCode(handle.db, { userId: unverified, codeHash: hash('123456'), now: NOW }),
    ).toBeTruthy();

    // At or above autoApproveBelow (ETB 5,000): held for review, the money on hold.
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Kebede A.' });
    await deposit(cashier, shift.id, userId, birr(6_000));
    await makeCode(userId);
    const held = await withdraw(cashier, shift.id, userId, birr(5_000));
    if (held.outcome !== 'review') throw new Error('expected review');
    expect(held.reviewReason).toBe('above_auto_approve_threshold');
    expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
    expect((await payout(held.payoutId)).status).toBe('requested');

    // Approved by finance: the payout worker never takes a cash payout.
    const supervisor = await staff('finance');
    await handle.db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: held.payoutId, adminId: supervisor, now: NOW }),
    );
    const claimed = await handle.db.transaction((tx) =>
      claimDuePayouts(tx, { now: NOW, limit: 100 }),
    );
    expect(claimed.map((row) => row.id)).not.toContain(held.payoutId);

    // Next visit, new code: the waiting payout is paid first, for its own amount.
    await makeCode(userId, '654321');
    expect(
      await refusal(withdraw(cashier, shift.id, userId, birr(4_000), { code: '654321' })),
    ).toEqual({ status: 409, code: 'cash_payout_waiting' });
    // The supervisor who approved it may not pay it (four eyes).
    const theirShift = await shiftFor(supervisor);
    expect(
      await refusal(withdraw(supervisor, theirShift.id, userId, birr(5_000), { code: '654321' })),
    ).toEqual({ status: 409, code: 'cashier_four_eyes' });
    const paid = await withdraw(cashier, shift.id, userId, birr(5_000), { code: '654321' });
    expect(paid.outcome).toBe('paid');
    expect((await payout(held.payoutId)).status).toBe('paid');
    expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
    await expectBooksBalanced(handle.db);
  });

  it('a replayed desk key gives the same receipt; the threshold binds cashiers', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Tigist M.' });
    await deposit(cashier, shift.id, userId, birr(1_000));
    await makeCode(userId);
    const key = `desk-${randomUUID()}`;
    const first = await withdraw(cashier, shift.id, userId, birr(200), { key });
    const again = await handle.db.transaction((tx) =>
      cashWithdrawal(tx, {
        staffId: cashier,
        shiftId: shift.id,
        userId,
        amount: birr(200),
        idempotencyKey: key,
        code: { id: randomUUID(), hash: hash('000000') },
        rules: RULES,
        now: NOW,
      }),
    );
    expect(again).toMatchObject({ outcome: 'paid', replayed: true });
    if (first.outcome === 'paid' && again.outcome === 'paid') {
      expect(again.operation.id).toBe(first.operation.id);
    }
    expect(await cashOf(handle.db, userId)).toBe(birr(800));

    await makeCode(userId, '777777');
    expect(
      await refusal(withdraw(cashier, shift.id, userId, birr(10_001), { code: '777777' })),
    ).toEqual({ status: 403, code: 'cashier_approval_required' });
  });
});

describe('review findings', () => {
  const hash = (code: string) => createHash('sha256').update(code).digest('hex');
  const makeCode = (userId: string, code: string) =>
    handle.db.transaction((tx) => createCashCode(tx, { userId, codeHash: hash(code), now: NOW }));
  async function withdraw(
    staffId: string,
    shiftId: string,
    userId: string,
    amount: bigint,
    code: string,
    key = `desk-${randomUUID()}`,
  ) {
    const codeId = await checkCashCode(handle.db, { userId, codeHash: hash(code), now: NOW });
    return handle.db.transaction((tx) =>
      cashWithdrawal(tx, {
        staffId,
        shiftId,
        userId,
        amount,
        idempotencyKey: key,
        code: { id: codeId, hash: hash(code) },
        rules: RULES,
        now: NOW,
      }),
    );
  }

  it('the threshold counts what the desk already took from the player in the shift', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db);
    await deposit(cashier, shift.id, userId, birr(6_000));
    expect(await refusal(deposit(cashier, shift.id, userId, birr(5_000)))).toEqual({
      status: 403,
      code: 'cashier_approval_required',
    });
    // Another player is not affected; up to the threshold is fine.
    const other = (await createPlayer(handle.db)).userId;
    await deposit(cashier, shift.id, other, birr(5_000));
    await deposit(cashier, shift.id, userId, birr(4_000));
  });

  it('an approved withdrawal waiting at the desk is not paid to a blocked account', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Hana G.' });
    await deposit(cashier, shift.id, userId, birr(6_000));
    await makeCode(userId, '101010');
    const key = `desk-${randomUUID()}`;
    const held = await withdraw(cashier, shift.id, userId, birr(5_000), '101010', key);
    if (held.outcome !== 'review') throw new Error('expected review');
    // A retry of that request finds it by its desk key.
    expect((await findDeskPayout(handle.db, { userId, idempotencyKey: key }))?.id).toBe(
      held.payoutId,
    );
    await handle.db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: held.payoutId, adminId: supervisor, now: NOW }),
    );
    // The back office cannot settle a cash payout: only the desk pays it, with a receipt.
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          markPayoutPaid(tx, {
            payoutId: held.payoutId,
            now: NOW,
            admin: { adminId: supervisor },
          }),
        ),
      ),
    ).toEqual({ status: 409, code: 'cash_payout_desk_only' });

    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));
    await makeCode(userId, '202020').catch(() => undefined);
    // A blocked account cannot make a code; with one made before, the desk still refuses.
    await handle.db.update(users).set({ status: 'active' }).where(eq(users.id, userId));
    await makeCode(userId, '303030');
    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));
    expect(await refusal(withdraw(cashier, shift.id, userId, birr(5_000), '303030'))).toEqual({
      status: 403,
      code: 'account_disabled',
    });
    expect(
      (await handle.db.select().from(payouts).where(eq(payouts.id, held.payoutId)))[0]?.status,
    ).toBe('approved');
  });
});

describe('uncollected approved cash withdrawals', () => {
  const hash = (code: string) => createHash('sha256').update(code).digest('hex');

  it('go back to the player after the collect period, not before, and once', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Selam T.' });
    await deposit(cashier, shift.id, userId, birr(6_000));
    await handle.db.transaction((tx) =>
      createCashCode(tx, { userId, codeHash: hash('404040'), now: NOW }),
    );
    const codeId = await checkCashCode(handle.db, { userId, codeHash: hash('404040'), now: NOW });
    const held = await handle.db.transaction((tx) =>
      cashWithdrawal(tx, {
        staffId: cashier,
        shiftId: shift.id,
        userId,
        amount: birr(5_000),
        idempotencyKey: `desk-${randomUUID()}`,
        code: { id: codeId, hash: hash('404040') },
        rules: RULES,
        now: NOW,
      }),
    );
    if (held.outcome !== 'review') throw new Error('expected review');
    await handle.db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: held.payoutId, adminId: supervisor, now: NOW }),
    );
    const cashBefore = (await getPlayerBalances(handle.db, userId)).cash;
    const DAY = 86_400_000;
    const statusOf = async () =>
      (await handle.db.select().from(payouts).where(eq(payouts.id, held.payoutId)))[0]?.status;

    // Flagged for staff (AML, review), it is the staff's to decide: never returned by age.
    await handle.db
      .update(payouts)
      .set({ flaggedAt: NOW, flagReason: 'aml_hold' })
      .where(eq(payouts.id, held.payoutId));
    await expireUncollectedCashPayouts(handle.db, {
      now: new Date(NOW.getTime() + 30 * DAY),
      maxAgeMs: 7 * DAY,
    });
    expect(await statusOf()).toBe('approved');
    await handle.db
      .update(payouts)
      .set({ flaggedAt: null, flagReason: null })
      .where(eq(payouts.id, held.payoutId));

    // Within the period (and with the setting at 0) nothing happens.
    expect(
      await expireUncollectedCashPayouts(handle.db, {
        now: new Date(NOW.getTime() + 6 * DAY),
        maxAgeMs: 7 * DAY,
      }),
    ).toBe(0);
    expect(
      await expireUncollectedCashPayouts(handle.db, {
        now: new Date(NOW.getTime() + 30 * DAY),
        maxAgeMs: 0,
      }),
    ).toBe(0);
    expect(await statusOf()).toBe('approved');

    // After it: failed with cash_not_collected, and the hold is back on the player's balance (an
    // approved one an earlier test left waiting goes back too).
    expect(
      await expireUncollectedCashPayouts(handle.db, {
        now: new Date(NOW.getTime() + 8 * DAY),
        maxAgeMs: 7 * DAY,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await statusOf()).toBe('failed');
    const [row] = await handle.db.select().from(payouts).where(eq(payouts.id, held.payoutId));
    expect(row?.failureReason).toBe('cash_not_collected');
    expect((await getPlayerBalances(handle.db, userId)).cash).toBe(cashBefore + birr(5_000));
    // Idempotent.
    expect(
      await expireUncollectedCashPayouts(handle.db, {
        now: new Date(NOW.getTime() + 9 * DAY),
        maxAgeMs: 7 * DAY,
      }),
    ).toBe(0);
  });
});

describe("booking a closed shift's cash difference", () => {
  it('a supervisor (not the cashier) books it once against house:cash_variance; the books reconcile', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const shift = await shiftFor(cashier, birr(500));
    const { userId } = await createPlayer(handle.db);
    await deposit(cashier, shift.id, userId, birr(100));
    const post = (supervisorId: string) =>
      handle.db.transaction((tx) =>
        postShiftVariance(tx, { shiftId: shift.id, supervisorId, now: NOW }),
      );
    // An open shift has no difference to book yet.
    expect(await refusal(post(supervisor))).toEqual({ status: 409, code: 'shift_not_closed' });
    // Expected 600, counted 570: 30 short.
    await handle.db.transaction((tx) =>
      closeShift(tx, { staffId: cashier, shiftId: shift.id, countedCash: birr(570), now: NOW }),
    );
    expect(await refusal(post(cashier))).toEqual({ status: 403, code: 'cashier_four_eyes' });
    const varianceBefore = await getBalance(handle.db, { kind: 'house_cash_variance' }).catch(
      () => 0n,
    );
    const pspBefore = await getBalance(handle.db, { kind: 'house_psp_clearing', provider: 'cash' });
    const booked = await post(supervisor);
    expect(booked).toMatchObject({ shiftId: shift.id, amount: -birr(30), postedBy: supervisor });
    expect(await getBalance(handle.db, { kind: 'house_cash_variance' })).toBe(
      varianceBefore - birr(30),
    );
    expect(await getBalance(handle.db, { kind: 'house_psp_clearing', provider: 'cash' })).toBe(
      pspBefore + birr(30),
    );
    expect(await refusal(post(supervisor))).toEqual({
      status: 409,
      code: 'variance_already_posted',
    });
    // The PSP checks accept the booking (it matches its shift row) and find nothing else.
    const result = await runReconciliationChecks(handle.db, {
      businessDate: businessDateOf(NOW),
      balanceAfterGraceMs: 0,
    });
    expect(result.mismatches.filter((m) => m.check.startsWith('psp_'))).toEqual([]);
  });

  it('a shift whose count matched has nothing to book', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const shift = await shiftFor(cashier, birr(200));
    await handle.db.transaction((tx) =>
      closeShift(tx, { staffId: cashier, shiftId: shift.id, countedCash: birr(200), now: NOW }),
    );
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          postShiftVariance(tx, { shiftId: shift.id, supervisorId: supervisor, now: NOW }),
        ),
      ),
    ).toEqual({ status: 409, code: 'no_variance' });
  });
});

describe('closing a forgotten shift, and closed records', () => {
  it("a supervisor closes a cashier's open shift; others may not", async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier, birr(200));
    const { userId } = await createPlayer(handle.db);
    await deposit(cashier, shift.id, userId, birr(100));
    const other = await staff();
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          forceCloseShift(tx, {
            supervisorId: other,
            shiftId: shift.id,
            countedCash: 0n,
            now: NOW,
          }),
        ),
      ),
    ).toEqual({ status: 403, code: 'supervisor_required' });
    const supervisor = await staff('finance');
    const { shift: closed } = await handle.db.transaction((tx) =>
      forceCloseShift(tx, {
        supervisorId: supervisor,
        shiftId: shift.id,
        countedCash: birr(300),
        note: 'cashier went home ill',
        now: NOW,
      }),
    );
    expect(closed).toMatchObject({
      status: 'closed',
      expectedCash: birr(300),
      countedCash: birr(300),
      closeNote: 'Closed by a supervisor: cashier went home ill',
    });
    // The cashier may open a new shift now.
    expect((await shiftFor(cashier)).status).toBe('open');
  });

  it('the database refuses changes to a closed shift and to a receipt (copies only go up)', async () => {
    const cashier = await staff();
    const shift = await shiftFor(cashier);
    const { userId } = await createPlayer(handle.db);
    const { operation } = await deposit(cashier, shift.id, userId, birr(50));
    await handle.db.transaction((tx) =>
      closeShift(tx, { staffId: cashier, shiftId: shift.id, countedCash: birr(550), now: NOW }),
    );
    await expect(
      handle.pool.query('UPDATE cashier_shifts SET counted_cash = 0 WHERE id = $1', [shift.id]),
    ).rejects.toThrow(/closed and cannot change/);
    await expect(
      handle.pool.query('UPDATE cash_operations SET amount = 1 WHERE id = $1', [operation.id]),
    ).rejects.toThrow(/only its copies are counted/);
    await expect(
      handle.pool.query('UPDATE cash_operations SET reprints = reprints - 1 WHERE id = $1', [
        operation.id,
      ]),
    ).rejects.toThrow(/only its copies are counted/);
    const copy = await handle.db.transaction((tx) =>
      recordReprint(tx, { operationId: operation.id, staffId: cashier, supervisor: false }),
    );
    expect(copy.reprints).toBe(1);
  });
});
