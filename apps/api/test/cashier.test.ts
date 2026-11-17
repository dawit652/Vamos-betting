import {
  ApiErrorSchema,
  CashDepositResponse,
  CashierDeskResponse,
  CashierPlayerResponse,
  CashierShiftListResponse,
  CashierShiftResponse,
  CashReceiptResponse,
  DepositsResponse,
} from '@vamos/contracts';
import { getPlayerBalances } from '@vamos/db';
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
});
