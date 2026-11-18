import {
  ApiErrorSchema,
  CashDepositResponse,
  CashierDeskResponse,
  CashierPlayerResponse,
  CashierShiftListResponse,
  CashierShiftResponse,
  CashCodeResponse,
  CashReceiptResponse,
  CashWithdrawalResponse,
  DepositsResponse,
} from '@vamos/contracts';
import { getPlayerBalances, postTransaction } from '@vamos/db';
import { auditLog, kycProfiles } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';

/** The cashier desk routes (docs/plans/cashier-dashboard.md). */

let ctx: TestContext;
let cashier: StaffSession;
let finance: StaffSession;
let admin: StaffSession;
let compliance: StaffSession;
let support: StaffSession;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  cashier = await staffLogin(ctx, 'cashier');
  finance = await staffLogin(ctx, 'finance');
  admin = await staffLogin(ctx, 'admin');
  compliance = await staffLogin(ctx, 'compliance');
  support = await staffLogin(ctx, 'support');
});

afterAll(async () => {
  await ctx.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

async function desk(staff: StaffSession) {
  const response = await asStaff(ctx, staff, 'GET', '/admin/cashier/desk');
  expect(response.statusCode, response.body).toBe(200);
  return CashierDeskResponse.parse(response.json());
}

async function openShift(staff: StaffSession, openingFloat = '50000') {
  const { shops } = await desk(staff);
  const response = await asStaff(ctx, staff, 'POST', '/admin/cashier/shifts', {
    shopId: shops[0]!.id,
    openingFloat,
  });
  expect(response.statusCode, response.body).toBe(200);
  return CashierShiftResponse.parse(response.json()).shift;
}

const depositRequest = (
  staff: StaffSession,
  body: { shiftId: string; userId: string; amount: string; idempotencyKey?: string },
) =>
  asStaff(ctx, staff, 'POST', '/admin/cashier/deposits', {
    idempotencyKey: `desk-${randomUUID()}`,
    ...body,
  });

describe('who may use the desk', () => {
  it('cashier and supervisors work a desk; reports for finance and compliance only', async () => {
    expect((await asStaff(ctx, cashier, 'GET', '/admin/cashier/desk')).statusCode).toBe(200);
    expect((await asStaff(ctx, finance, 'GET', '/admin/cashier/desk')).statusCode).toBe(200);
    expect((await asStaff(ctx, support, 'GET', '/admin/cashier/desk')).statusCode).toBe(403);
    expect((await asStaff(ctx, compliance, 'GET', '/admin/cashier/desk')).statusCode).toBe(403);
    expect((await asStaff(ctx, cashier, 'GET', '/admin/cashier/shifts')).statusCode).toBe(403);
    expect((await asStaff(ctx, compliance, 'GET', '/admin/cashier/shifts')).statusCode).toBe(200);
    // The cashier sees no dashboard and no player list.
    expect((await asStaff(ctx, cashier, 'GET', '/admin/dashboard')).statusCode).toBe(403);
    expect((await asStaff(ctx, cashier, 'GET', '/admin/users')).statusCode).toBe(403);
  });
});

describe('a shift at the desk', () => {
  it('opens, finds the player, takes a deposit once per receipt key, prints and closes', async () => {
    const player = await registerAndLogin(ctx);
    const shift = await openShift(cashier, '50000');
    expect(shift).toMatchObject({
      status: 'open',
      openingFloat: '50000',
      staffName: 'Demo Cashier',
    });
    // One open shift per staff member.
    const again = await asStaff(ctx, cashier, 'POST', '/admin/cashier/shifts', {
      shopId: shift.shopId,
      openingFloat: '0',
    });
    expect(again.statusCode).toBe(409);
    expect(code(again.body)).toBe('shift_already_open');

    // Any form of the number finds the player.
    const local = `0${player.phone.slice(4)}`;
    const found = await asStaff(
      ctx,
      cashier,
      'GET',
      `/admin/cashier/players?phone=${encodeURIComponent(local)}`,
    );
    expect(found.statusCode, found.body).toBe(200);
    expect(CashierPlayerResponse.parse(found.json()).player).toMatchObject({
      id: player.userId,
      status: 'active',
      exclusion: null,
    });
    expect(
      (await asStaff(ctx, cashier, 'GET', '/admin/cashier/players?phone=0900000001')).statusCode,
    ).toBe(404);

    const before = (await getPlayerBalances(ctx.deps.db, player.userId)).cash;
    const idempotencyKey = `desk-${randomUUID()}`;
    const first = await depositRequest(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '25000',
      idempotencyKey,
    });
    expect(first.statusCode, first.body).toBe(200);
    const { receipt, replayed } = CashDepositResponse.parse(first.json());
    expect(replayed).toBe(false);
    expect(receipt.operation).toMatchObject({ kind: 'deposit', amount: '25000', reprints: 0 });
    expect(receipt.operation.reference).toBe(`R${receipt.operation.receiptNo}`);
    expect(receipt.playerPhone).toBe(`${player.phone.slice(0, 5)}****${player.phone.slice(-4)}`);
    expect(receipt.shop.receiptWidthMm).toBe(80);

    // The same key again: the same receipt, no second credit.
    const replay = await depositRequest(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '25000',
      idempotencyKey,
    });
    expect(CashDepositResponse.parse(replay.json())).toMatchObject({
      replayed: true,
      receipt: { operation: { id: receipt.operation.id } },
    });
    expect((await getPlayerBalances(ctx.deps.db, player.userId)).cash).toBe(before + 25_000n);

    // The player sees it among their deposits, as a cash deposit with the receipt number.
    const history = await ctx.app.inject({
      method: 'GET',
      url: '/payments/deposits',
      headers: { cookie: player.cookie },
    });
    expect(history.statusCode, history.body).toBe(200);
    const mine = DepositsResponse.parse(history.json());
    expect(JSON.stringify(mine)).toContain('"provider":"cash"');

    // The receipt: its cashier and supervisors; a copy is counted.
    const read = await asStaff(
      ctx,
      cashier,
      'GET',
      `/admin/cashier/receipts/${receipt.operation.id}`,
    );
    expect(read.statusCode).toBe(200);
    expect(
      (await asStaff(ctx, finance, 'GET', `/admin/cashier/receipts/${receipt.operation.id}`))
        .statusCode,
    ).toBe(200);
    const copy = await asStaff(
      ctx,
      cashier,
      'POST',
      `/admin/cashier/receipts/${receipt.operation.id}/reprint`,
    );
    expect(copy.statusCode, copy.body).toBe(200);
    expect(CashReceiptResponse.parse(copy.json()).receipt.operation.reprints).toBe(1);

    // The desk shows the shift with its deposit and the expected cash.
    const open = await desk(cashier);
    expect(open.shift).toMatchObject({
      id: shift.id,
      deposits: { count: 1, total: '25000' },
      expectedCash: '75000',
    });
    expect(open.operations.map((op) => op.id)).toEqual([receipt.operation.id]);
    expect(open.supervisor).toBe(false);

    // Close with ETB 5 missing.
    const closed = await asStaff(ctx, cashier, 'POST', `/admin/cashier/shifts/${shift.id}/close`, {
      countedCash: '74500',
      note: 'counted twice',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(CashierShiftResponse.parse(closed.json()).shift).toMatchObject({
      status: 'closed',
      expectedCash: '75000',
      countedCash: '74500',
      variance: '-500',
    });
    expect((await desk(cashier)).shift).toBeNull();
    const list = CashierShiftListResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/cashier/shifts')).json(),
    );
    expect(list.shifts.find((s) => s.id === shift.id)).toMatchObject({ variance: '-500' });
    const late = await depositRequest(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '1000',
    });
    expect(late.statusCode).toBe(409);
    expect(code(late.body)).toBe('shift_not_open');
  });

  it('above the shop threshold only a supervisor takes the deposit', async () => {
    const player = await registerAndLogin(ctx);
    const mine = await openShift(cashier);
    const big = await depositRequest(cashier, {
      shiftId: mine.id,
      userId: player.userId,
      amount: '1000100',
    });
    expect(big.statusCode).toBe(403);
    expect(code(big.body)).toBe('cashier_approval_required');
    const theirs = await openShift(finance);
    const ok = await depositRequest(finance, {
      shiftId: theirs.id,
      userId: player.userId,
      amount: '1000100',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // Nobody works in another's shift.
    const foreign = await depositRequest(cashier, {
      shiftId: theirs.id,
      userId: player.userId,
      amount: '1000',
    });
    expect(foreign.statusCode).toBe(404);
    for (const staff of [cashier, finance]) {
      const shift = (await desk(staff)).shift!;
      await asStaff(ctx, staff, 'POST', `/admin/cashier/shifts/${shift.id}/close`, {
        countedCash: shift.expectedCash,
      });
    }
  });
});

describe('shop settings', () => {
  it('only settings.edit changes a shop', async () => {
    const { shops } = await desk(admin);
    const shop = shops[0]!;
    const body = {
      name: 'Nahubet Piassa',
      address: 'Piassa, Addis Ababa',
      receiptWidthMm: 58,
      approvalThreshold: '2000000',
      active: true,
    };
    expect(
      (await asStaff(ctx, finance, 'PUT', `/admin/cashier/shops/${shop.id}`, body)).statusCode,
    ).toBe(403);
    const changed = await asStaff(ctx, admin, 'PUT', `/admin/cashier/shops/${shop.id}`, body);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ shop: { name: 'Nahubet Piassa', receiptWidthMm: 58 } });
    const all = await asStaff(ctx, compliance, 'GET', '/admin/cashier/shops');
    expect(all.statusCode).toBe(200);
  });

  it('adds shops (the owner runs more than 40): only settings.edit, a code once', async () => {
    const body = {
      code: 'Bole-02',
      name: 'Nahubet Bole 2',
      address: 'Bole, Addis Ababa',
      receiptWidthMm: 80,
      approvalThreshold: '1000000',
    };
    expect((await asStaff(ctx, finance, 'POST', '/admin/cashier/shops', body)).statusCode).toBe(
      403,
    );
    const created = await asStaff(ctx, admin, 'POST', '/admin/cashier/shops', body);
    expect(created.statusCode, created.body).toBe(201);
    // The code is stored lower case; the new shop is active and on the list, and opens shifts.
    expect(created.json()).toMatchObject({ shop: { code: 'bole-02', active: true } });
    const again = await asStaff(ctx, admin, 'POST', '/admin/cashier/shops', body);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'shop_code_taken' } });
    const bad = await asStaff(ctx, admin, 'POST', '/admin/cashier/shops', {
      ...body,
      code: 'no spaces!',
    });
    expect(bad.statusCode).toBe(400);
    const list = await asStaff(ctx, compliance, 'GET', '/admin/cashier/shops');
    expect(
      list.json<{ shops: Array<{ code: string }> }>().shops.map((shop) => shop.code),
    ).toContain('bole-02');
  });
});

describe('cash withdrawals', () => {
  beforeAll(async () => {
    // The test money is not wagered: the owner's wagering rule is turned off here.
    const current = await asStaff(ctx, admin, 'GET', '/admin/settings');
    const payments = current.json<{ settings: { payments: Record<string, unknown> } }>().settings
      .payments;
    const changed = await asStaff(ctx, admin, 'PUT', '/admin/settings/payments', {
      value: { ...payments, wageringMultiplierBps: 0 },
    });
    expect(changed.statusCode, changed.body).toBe(200);
  });

  async function verifiedPlayerWith(amount: bigint) {
    const player = await registerAndLogin(ctx);
    await ctx.deps.db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'verified',
      provider: 'mock',
      idNumberLast4: '1234',
      verifiedName: 'Abebe Kebede',
      submittedAt: ctx.clock.now,
    });
    // Winnings-like money (not a deposit), so no wagering is owed.
    await ctx.deps.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'demo_topup',
        idempotencyKey: `test:${randomUUID()}`,
        entries: [
          { account: { kind: 'house_demo_funding' }, amount: -amount },
          { account: { kind: 'player_cash', userId: player.userId }, amount },
        ],
      }),
    );
    return player;
  }
  const makeCode = async (player: Awaited<ReturnType<typeof registerAndLogin>>) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/payments/cash-codes',
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    });
    expect(response.statusCode, response.body).toBe(201);
    return CashCodeResponse.parse(response.json()).code;
  };
  const withdraw = (
    staff: StaffSession,
    body: {
      shiftId: string;
      userId: string;
      amount: string;
      code: string;
      idempotencyKey?: string;
    },
  ) =>
    asStaff(ctx, staff, 'POST', '/admin/cashier/withdrawals', {
      idempotencyKey: `desk-${randomUUID()}`,
      ...body,
    });

  it('the player makes a code; the desk pays with it once, prints a receipt; a wrong code counts', async () => {
    const player = await verifiedPlayerWith(200_000n);
    // Only a signed-in player makes a code.
    expect((await ctx.app.inject({ method: 'POST', url: '/payments/cash-codes' })).statusCode).toBe(
      401,
    );
    const shopCode = await makeCode(player);
    expect(shopCode).toMatch(/^\d{6}$/);

    const shift = await openShift(cashier);
    const wrong = shopCode === '000000' ? '111111' : '000000';
    const refused = await withdraw(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '50000',
      code: wrong,
    });
    expect(refused.statusCode).toBe(400);
    expect(code(refused.body)).toBe('cash_code_invalid');

    const idempotencyKey = `desk-${randomUUID()}`;
    const paid = await withdraw(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '50000',
      code: shopCode,
      idempotencyKey,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const result = CashWithdrawalResponse.parse(paid.json());
    if (result.outcome !== 'paid') throw new Error('expected paid');
    expect(result.receipt.operation).toMatchObject({ kind: 'withdrawal', amount: '50000' });
    expect((await getPlayerBalances(ctx.deps.db, player.userId)).cash).toBe(150_000n);

    // The same key again: the same receipt (the code is spent, so no code check), no second payout.
    const again = await withdraw(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '50000',
      code: shopCode,
      idempotencyKey,
    });
    expect(CashWithdrawalResponse.parse(again.json())).toMatchObject({
      outcome: 'paid',
      replayed: true,
    });
    expect((await getPlayerBalances(ctx.deps.db, player.userId)).cash).toBe(150_000n);
    // A new desk key with the spent code: refused.
    const spent = await withdraw(cashier, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '1000',
      code: shopCode,
    });
    expect(spent.statusCode).toBe(400);

    // The shift's cash: float 500 − 500 paid out.
    expect((await desk(cashier)).shift).toMatchObject({
      withdrawals: { count: 1, total: '50000' },
      expectedCash: '0',
    });
    await asStaff(ctx, cashier, 'POST', `/admin/cashier/shifts/${shift.id}/close`, {
      countedCash: '0',
    });
  });

  it('a large withdrawal waits for review, like an online one', async () => {
    const player = await verifiedPlayerWith(1_000_000n);
    const shift = await openShift(finance);
    const shopCode = await makeCode(player);
    const response = await withdraw(finance, {
      shiftId: shift.id,
      userId: player.userId,
      amount: '600000',
      code: shopCode,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(CashWithdrawalResponse.parse(response.json())).toMatchObject({
      outcome: 'review',
      amount: '600000',
      reviewReason: 'above_auto_approve_threshold',
    });
    // Held for the back office review.
    expect((await getPlayerBalances(ctx.deps.db, player.userId)).cash).toBe(400_000n);
    await asStaff(ctx, finance, 'POST', `/admin/cashier/shifts/${shift.id}/close`, {
      countedCash: shift.openingFloat,
    });
  });
});

describe('review fixes at the desk', () => {
  async function verifiedPlayerWith(amount: bigint) {
    const player = await registerAndLogin(ctx);
    await ctx.deps.db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'verified',
      provider: 'mock',
      idNumberLast4: '1234',
      verifiedName: 'Abebe Kebede',
      submittedAt: ctx.clock.now,
    });
    await ctx.deps.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'demo_topup',
        idempotencyKey: `test:${randomUUID()}`,
        entries: [
          { account: { kind: 'house_demo_funding' }, amount: -amount },
          { account: { kind: 'player_cash', userId: player.userId }, amount },
        ],
      }),
    );
    return player;
  }
  const makeCode = async (player: Awaited<ReturnType<typeof registerAndLogin>>) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/payments/cash-codes',
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    });
    return CashCodeResponse.parse(response.json()).code;
  };

  it('a retry after a review answer gets the same answer, not a code error', async () => {
    const player = await verifiedPlayerWith(1_000_000n);
    const shift = await openShift(finance);
    const shopCode = await makeCode(player);
    const body = {
      shiftId: shift.id,
      userId: player.userId,
      amount: '600000',
      code: shopCode,
      idempotencyKey: `desk-${randomUUID()}`,
    };
    const first = await asStaff(ctx, finance, 'POST', '/admin/cashier/withdrawals', body);
    expect(CashWithdrawalResponse.parse(first.json())).toMatchObject({ outcome: 'review' });
    const again = await asStaff(ctx, finance, 'POST', '/admin/cashier/withdrawals', body);
    expect(again.statusCode, again.body).toBe(200);
    expect(CashWithdrawalResponse.parse(again.json())).toMatchObject({
      outcome: 'review',
      replayed: true,
    });
    await asStaff(ctx, finance, 'POST', `/admin/cashier/shifts/${shift.id}/close`, {
      countedCash: shift.openingFloat,
    });
  });

  it('the desk blocks a player; only users.status unblocks; lookups are audited', async () => {
    const player = await registerAndLogin(ctx);
    const found = await asStaff(
      ctx,
      cashier,
      'GET',
      `/admin/cashier/players?phone=${encodeURIComponent(player.phone)}`,
    );
    expect(found.statusCode).toBe(200);
    const [lookup] = await ctx.deps.db
      .select({ actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'cashier.player_lookup'), eq(auditLog.targetId, player.userId)),
      );
    expect(lookup?.actorId).toBe(cashier.id);

    const blocked = await asStaff(
      ctx,
      cashier,
      'POST',
      `/admin/cashier/players/${player.userId}/block`,
      {
        reason: 'phone reported stolen',
      },
    );
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json()).toEqual({ status: 'suspended', changed: true });
    // Blocked: their session stops working.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: player.cookie },
    });
    expect(me.statusCode).toBe(401);
    // A cashier cannot unblock; compliance can.
    const unblock = { status: 'active', reason: 'owner confirmed the phone' };
    expect(
      (await asStaff(ctx, cashier, 'POST', `/admin/users/${player.userId}/status`, unblock))
        .statusCode,
    ).toBe(403);
    const done = await asStaff(
      ctx,
      compliance,
      'POST',
      `/admin/users/${player.userId}/status`,
      unblock,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({ status: 'active', changed: true });
  });

  it('paying cash is rate limited per staff member', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const response = await asStaff(ctx, cashier, 'POST', '/admin/cashier/withdrawals', {});
      statuses.push(response.statusCode);
    }
    // Earlier tests in this file used part of this minute's budget: at most 20 get through.
    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('a forgotten shift', () => {
  it('a supervisor closes it; compliance (reports only) cannot', async () => {
    const shift = await openShift(cashier, '10000');
    const url = `/admin/cashier/shifts/${shift.id}/force-close`;
    const refused = await asStaff(ctx, compliance, 'POST', url, { countedCash: '10000' });
    expect(refused.statusCode).toBe(403);
    expect(code(refused.body)).toBe('supervisor_required');
    const closed = await asStaff(ctx, finance, 'POST', url, {
      countedCash: '10000',
      note: 'cashier went home',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(CashierShiftResponse.parse(closed.json()).shift).toMatchObject({
      status: 'closed',
      variance: '0',
      closeNote: 'Closed by a supervisor: cashier went home',
    });
    expect((await desk(cashier)).shift).toBeNull();
  });
});
