import {
  AgentResponse,
  CashierShopResponse,
  CreateStaffResponse,
  SHOP_CSRF_HEADER,
  ShopDeviceAskResponse,
  ShopSessionResponse,
  STAFF_SESSION_COOKIE,
} from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsOriginsFor } from '../src/app';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/** The shop app's API (docs/plans/agent-shops.md phase 1b): device, sign-in, session, sign-out. */

let ctx: TestContext;
let admin: StaffSession;
const PASSWORD = 'shop desk password 2026';

beforeAll(async () => {
  ctx = await createTestContext({ SHOP_WEB_URL: 'http://shop.localhost:3002' });
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
});

afterAll(async () => {
  await ctx?.close();
});

/** An agent shop with a cashier (password chosen by the admin), as the back office makes them. */
async function setUp(name: string) {
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
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}@shop.example.com`;
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
  const assigned = await asStaff(ctx, admin, 'PUT', `/admin/cashier/staff/${user.id}/shop`, {
    shopId: shop.id,
  });
  expect(assigned.statusCode).toBe(200);
  return { agent, shop, email, cashierId: user.id };
}

const post = (url: string, payload: unknown, cookie = '', headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { cookie, ...headers },
  });

describe('/shop', () => {
  it('registers a device with the password, signs in only once an admin approved it', async () => {
    const { agent, shop, email } = await setUp('Shop Route Agent');
    const wrong = await post('/shop/devices/request', {
      email,
      password: 'not the password',
      label: 'Counter PC',
    });
    expect(wrong.statusCode).toBe(401);

    const asked = await post('/shop/devices/request', {
      email,
      password: PASSWORD,
      label: 'Counter PC',
    });
    expect(asked.statusCode).toBe(201);
    const { device } = ShopDeviceAskResponse.parse(asked.json());
    const deviceCookie = asked.cookies.find((c) => c.name.endsWith('vamos_device'));
    expect(deviceCookie?.httpOnly).toBe(true);
    const deviceHeader = `${deviceCookie!.name}=${deviceCookie!.value}`;

    // Not approved yet: no sign-in.
    expect(
      (await post('/shop/auth/login', { email, password: PASSWORD }, deviceHeader)).statusCode,
    ).toBe(401);
    // Approved: sign-in with the device; without it, still refused.
    const approved = await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect((await post('/shop/auth/login', { email, password: PASSWORD })).statusCode).toBe(401);
    const login = await post('/shop/auth/login', { email, password: PASSWORD }, deviceHeader);
    expect(login.statusCode).toBe(200);
    const session = ShopSessionResponse.parse(login.json());
    expect(session).toMatchObject({
      staff: { role: 'cashier', passwordChangeRequired: true },
      shop: { id: shop.id, label: `${agent.number}-01`, receiptWidthMm: 58 },
      deviceId: device.id,
    });
    const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'));
    const cookie = `${deviceHeader}; ${shopCookie!.name}=${shopCookie!.value}`;

    const me = await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    // The shop session never works in the back office.
    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${shopCookie!.value}` },
    });
    expect(asAdmin.statusCode).toBe(401);

    // A password the admin chose is replaced on the device (no TOTP code here).
    const csrf = { [SHOP_CSRF_HEADER]: session.csrfToken };
    const weak = await post(
      '/shop/auth/password',
      { currentPassword: 'wrong password!!', newPassword: 'a brand new shop password 7' },
      cookie,
      csrf,
    );
    expect(weak.statusCode).toBe(403);
    const changed = await post(
      '/shop/auth/password',
      { currentPassword: PASSWORD, newPassword: 'a brand new shop password 7' },
      cookie,
      csrf,
    );
    expect(changed.statusCode).toBe(200);
    const after = ShopSessionResponse.parse(
      (await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie } })).json(),
    );
    expect(after.staff.passwordChangeRequired).toBe(false);

    // Sign-out needs the CSRF token, then the session is gone.
    expect((await post('/shop/auth/logout', {}, cookie)).statusCode).toBe(403);
    const out = await post('/shop/auth/logout', {}, cookie, {
      [SHOP_CSRF_HEADER]: session.csrfToken,
    });
    expect(out.statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('ends the session at once when the agent is blocked', async () => {
    const { agent, email } = await setUp('Blocked Route Agent');
    const asked = await post('/shop/devices/request', { email, password: PASSWORD, label: 'POS' });
    const { device } = ShopDeviceAskResponse.parse(asked.json());
    const deviceCookie = asked.cookies.find((c) => c.name.endsWith('vamos_device'))!;
    await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/approve`);
    const deviceHeader = `${deviceCookie.name}=${deviceCookie.value}`;
    const login = await post('/shop/auth/login', { email, password: PASSWORD }, deviceHeader);
    const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
    const cookie = `${deviceHeader}; ${shopCookie.name}=${shopCookie.value}`;
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie } })).statusCode,
    ).toBe(200);
    await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/block`, {
      reason: 'checks pending',
    });
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('gives the shop origin, and only it, CORS on /shop', () => {
    const config = ctx.deps.config;
    expect(corsOriginsFor(config, '/shop/me')).toEqual(['http://shop.localhost:3002']);
    expect(corsOriginsFor(config, '/admin/session')).not.toContain('http://shop.localhost:3002');
    expect(corsOriginsFor(config, '/catalog/sports')).not.toContain('http://shop.localhost:3002');
  });
});
