import {
  AgentResponse,
  AgentTopupResponse,
  ApiErrorSchema,
  CashCodeResponse,
  CashDepositResponse,
  CashierPlayerResponse,
  CashierShopResponse,
  CashReceiptPrintResponse,
  CashReceiptResponse,
  CashWithdrawalResponse,
  CreateStaffResponse,
  SHOP_CSRF_HEADER,
  ShopDeskResponse,
  ShopDeviceAskResponse,
  ShopSessionResponse,
  ShopShiftResponse,
} from '@vamos/contracts';
import { postTransaction } from '@vamos/db';
import { kycProfiles } from '@vamos/db/schema';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

/** Player cash at the shop app's desk (docs/plans/agent-shops.md phase 2). */

let ctx: TestContext;
let admin: StaffSession;
let finance: StaffSession;
const PASSWORD = 'shop desk password 2026';
const NEW_PASSWORD = 'a brand new shop password 7';

beforeAll(async () => {
  ctx = await createTestContext({ SHOP_WEB_URL: 'http://shop.localhost:3002' });
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');
  // Withdrawals here pay winnings-like money: no wagering owed.
  const payments = (
    await asStaff(ctx, admin, 'GET', '/admin/settings').then((r) =>
      r.json<{ settings: { payments: Record<string, unknown> } }>(),
    )
  ).settings.payments;
  const changed = await asStaff(ctx, admin, 'PUT', '/admin/settings/payments', {
    value: { ...payments, wageringMultiplierBps: 0 },
  });
  expect(changed.statusCode, changed.body).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

interface Desk {
  cookie: string;
  csrf: string;
  shiftId: string;
}

async function agentShop(name: string) {
  const { agent } = AgentResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/agents', {
        name,
        ownerName: 'Owner Name',
        ownerPhone: '0911223344',
        commissionKind: 'ggr',
        commissionBps: 1_000,
      })
    ).json(),
  );
  const { shop } = CashierShopResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/shops`, {
        name: `${name} 1`,
        address: '',
        receiptWidthMm: 58,
        approvalThreshold: '1000000',
      })
    ).json(),
  );
  return { agent, shop };
}

async function hqShop(shopCode: string) {
  const created = await asStaff(ctx, admin, 'POST', '/admin/cashier/shops', {
    code: shopCode,
    name: `Nahubet ${shopCode}`,
    address: '',
    receiptWidthMm: 80,
    approvalThreshold: '1000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  return CashierShopResponse.parse(created.json()).shop;
}

const post = (url: string, payload: unknown, cookie = '', headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { cookie, ...headers },
  });

/** A cashier of `shopId` signed in on an approved device, password changed, with a shift open. */
async function deskAt(shopId: string, name: string, options: { changePassword?: boolean } = {}) {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 6)}@shop.example.com`;
  const { user } = CreateStaffResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/staff', {
        email,
        displayName: `${name} Desk`,
        role: 'cashier',
        password: PASSWORD,
        phone: '0911556677',
      })
    ).json(),
  );
  await asStaff(ctx, admin, 'PUT', `/admin/cashier/staff/${user.id}/shop`, { shopId });
  const asked = await post('/shop/devices/request', {
    email,
    password: PASSWORD,
    label: 'Counter',
  });
  const { device } = ShopDeviceAskResponse.parse(asked.json());
  const deviceCookie = asked.cookies.find((c) => c.name.endsWith('vamos_device'))!;
  await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/approve`);
  const deviceHeader = `${deviceCookie.name}=${deviceCookie.value}`;
  const login = await post('/shop/auth/login', { email, password: PASSWORD }, deviceHeader);
  expect(login.statusCode, login.body).toBe(200);
  const session = ShopSessionResponse.parse(login.json());
  const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
  const cookie = `${deviceHeader}; ${shopCookie.name}=${shopCookie.value}`;
  const csrf = session.csrfToken;
  if (options.changePassword === false) return { cookie, csrf, shiftId: '' };
  const changed = await post(
    '/shop/auth/password',
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    cookie,
    { [SHOP_CSRF_HEADER]: csrf },
  );
  expect(changed.statusCode, changed.body).toBe(200);
  const opened = await post('/shop/desk/shifts', { openingFloat: '50000' }, cookie, {
    [SHOP_CSRF_HEADER]: csrf,
  });
  expect(opened.statusCode, opened.body).toBe(200);
  return { cookie, csrf, shiftId: ShopShiftResponse.parse(opened.json()).shift.id };
}

const asDesk = (desk: Desk, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { cookie: desk.cookie, [SHOP_CSRF_HEADER]: desk.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const deskView = async (desk: Desk) =>
  ShopDeskResponse.parse((await asDesk(desk, 'GET', '/shop/desk')).json());

const deposit = (desk: Desk, userId: string, amount: string, idempotencyKey = randomUUID()) =>
  asDesk(desk, 'POST', '/shop/desk/deposits', {
    shiftId: desk.shiftId,
    userId,
    amount,
    idempotencyKey: `desk-${idempotencyKey}`,
  });

async function verifiedPlayerWith(amount: bigint): Promise<LoggedInUser> {
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

async function shopCode(player: LoggedInUser): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/payments/cash-codes',
    headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
  });
  expect(response.statusCode, response.body).toBe(201);
  return CashCodeResponse.parse(response.json()).code;
}

describe('player cash at the shop app desk', () => {
  it('at an HQ shop: finds the player, takes a deposit, pays with the shop code, prints receipts', async () => {
    const shop = await hqShop('shopapp-01');
    const desk = await deskAt(shop.id, 'HQ Shop App');
    expect(await deskView(desk)).toMatchObject({
      playerCash: true,
      agentBalance: null,
      agentBalanceLowAt: null,
    });

    const player = await verifiedPlayerWith(100_000n);
    const found = await asDesk(
      desk,
      'GET',
      `/shop/desk/players?phone=${encodeURIComponent(player.phone)}`,
    );
    expect(found.statusCode, found.body).toBe(200);
    expect(CashierPlayerResponse.parse(found.json()).player.id).toBe(player.userId);

    const key = randomUUID();
    const taken = await deposit(desk, player.userId, '20000', key);
    expect(taken.statusCode, taken.body).toBe(200);
    const { receipt, replayed } = CashDepositResponse.parse(taken.json());
    expect(replayed).toBe(false);
    expect(receipt.operation).toMatchObject({ kind: 'deposit', amount: '20000' });
    // The same key again: the same receipt, nothing taken twice.
    const again = CashDepositResponse.parse(
      (await deposit(desk, player.userId, '20000', key)).json(),
    );
    expect(again).toMatchObject({
      replayed: true,
      receipt: { operation: { id: receipt.operation.id } },
    });

    // The original once, then counted copies.
    const id = receipt.operation.id;
    const first = await asDesk(desk, 'POST', `/shop/desk/receipts/${id}/print`);
    expect(CashReceiptPrintResponse.parse(first.json()).copy).toBe(false);
    const second = await asDesk(desk, 'POST', `/shop/desk/receipts/${id}/print`);
    expect(CashReceiptPrintResponse.parse(second.json()).copy).toBe(true);
    const read = await asDesk(desk, 'GET', `/shop/desk/receipts/${id}`);
    expect(CashReceiptResponse.parse(read.json()).receipt.operation.id).toBe(id);

    const paid = await asDesk(desk, 'POST', '/shop/desk/withdrawals', {
      shiftId: desk.shiftId,
      userId: player.userId,
      amount: '10000',
      code: await shopCode(player),
      idempotencyKey: `desk-${randomUUID()}`,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(CashWithdrawalResponse.parse(paid.json())).toMatchObject({ outcome: 'paid' });

    // Another cashier never sees this cashier's receipts.
    const other = await deskAt(shop.id, 'HQ Shop App Two');
    expect((await asDesk(other, 'GET', `/shop/desk/receipts/${id}`)).statusCode).toBe(404);
    expect((await asDesk(other, 'POST', `/shop/desk/receipts/${id}/reprint`)).statusCode).toBe(404);
  });

  it("at an agent's shop: refused until switched on, then paid from the agent balance", async () => {
    const { agent, shop } = await agentShop('Desk Cash Agent');
    const desk = await deskAt(shop.id, 'Agent Shop App');
    // The top-up balance and HQ's low-balance threshold (ETB 1,000 by default) for the desk.
    expect(await deskView(desk)).toMatchObject({
      playerCash: false,
      agentBalance: '0',
      agentBalanceLowAt: '100000',
    });
    const player = await registerAndLogin(ctx);

    const off = await deposit(desk, player.userId, '20000');
    expect(off.statusCode).toBe(409);
    expect(code(off.body)).toBe('agent_player_cash_off');

    await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/player-cash`, { enabled: true });
    const low = await deposit(desk, player.userId, '20000');
    expect(low.statusCode).toBe(409);
    expect(code(low.body)).toBe('agent_balance_low');

    const recorded = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
      direction: 'in',
      amount: '500000',
      method: 'cash',
    });
    const { topup } = AgentTopupResponse.parse(recorded.json());
    await asStaff(ctx, finance, 'POST', `/admin/agent-topups/${topup.id}/approve`, {});

    const taken = await deposit(desk, player.userId, '200000');
    expect(taken.statusCode, taken.body).toBe(200);
    expect(await deskView(desk)).toMatchObject({ playerCash: true, agentBalance: '300000' });

    // Above the shop's threshold the shop app's cashier never takes it alone.
    const big = await deposit(desk, player.userId, '900000');
    expect(big.statusCode).toBe(403);
    expect(code(big.body)).toBe('cashier_approval_required');
  });

  it('is closed until the password is changed, needs the session and its CSRF token', async () => {
    const shop = await hqShop('shopapp-02');
    const fresh = await deskAt(shop.id, 'Fresh Shop App', { changePassword: false });
    const lookup = await asDesk(fresh, 'GET', '/shop/desk/players?phone=0911000000');
    expect(lookup.statusCode).toBe(403);
    expect(code(lookup.body)).toBe('password_change_required');
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/shop/desk/players?phone=0911000000' }))
        .statusCode,
    ).toBe(401);

    const desk = await deskAt(shop.id, 'Ready Shop App');
    const player = await registerAndLogin(ctx);
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/shop/desk/deposits',
      headers: { cookie: desk.cookie },
      payload: {
        shiftId: desk.shiftId,
        userId: player.userId,
        amount: '20000',
        idempotencyKey: `desk-${randomUUID()}`,
      },
    });
    expect(noCsrf.statusCode).toBe(403);
    // Someone else's shift is not this cashier's.
    const fresh2 = await deskAt(shop.id, 'Other Shift Shop App');
    const foreign = await asDesk(desk, 'POST', '/shop/desk/deposits', {
      shiftId: fresh2.shiftId,
      userId: player.userId,
      amount: '20000',
      idempotencyKey: `desk-${randomUUID()}`,
    });
    expect(foreign.statusCode).toBe(404);
  });
});
