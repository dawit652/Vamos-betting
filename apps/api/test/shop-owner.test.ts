import {
  AgentDetailResponse,
  AgentResponse,
  ApiErrorSchema,
  CashierShopResponse,
  RetailAlertThresholds,
  ShopOwnerCashierResponse,
  CreateAgentOwnerResponse,
  SHOP_CSRF_HEADER,
  ShopOwnerResponse,
  ShopSessionResponse,
} from '@vamos/contracts';
import { base32Decode, totpCode } from '@vamos/db';
import { adminUsers } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/** Agent owner accounts (docs/plans/agent-shops.md, phase 1b step 1): the shop app only. */

let ctx: TestContext;
let admin: StaffSession;
let finance: StaffSession;

beforeAll(async () => {
  ctx = await createTestContext({ SHOP_WEB_URL: 'http://shop.localhost:3002' });
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');
});

afterAll(async () => {
  await ctx?.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

/** The authenticator code of the next 30-second step (a code is accepted once per step). */
function nextCode(secret: Buffer): string {
  ctx.clock.advance(30_000);
  return totpCode(secret, ctx.clock.now.getTime());
}

async function agentWithOwner(name: string) {
  const { agent } = AgentResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/agents', {
        name,
        ownerName: 'Tadesse Owner',
        ownerPhone: '0911223344',
        commissionKind: 'ggr',
        commissionBps: 1_000,
      })
    ).json(),
  );
  const email = `owner-${randomUUID()}@agents.example.com`;
  const made = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/owner-account`, {
    email,
  });
  expect(made.statusCode, made.body).toBe(201);
  const { user, generatedPassword, totp } = CreateAgentOwnerResponse.parse(made.json());
  return {
    agent,
    email,
    password: generatedPassword!,
    secret: base32Decode(totp.secret),
    staffId: user.id,
  };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers });

describe('agent owner accounts', () => {
  it('is made on the agent page once, by agents.manage only', async () => {
    const owner = await agentWithOwner('Owner Route Agent');
    const detail = AgentDetailResponse.parse(
      (await asStaff(ctx, admin, 'GET', `/admin/agents/${owner.agent.id}`)).json(),
    );
    expect(detail.owner).toMatchObject({
      id: owner.staffId,
      email: owner.email,
      displayName: 'Tadesse Owner',
      passwordChangeRequired: true,
      disabled: false,
    });
    const again = await asStaff(
      ctx,
      admin,
      'POST',
      `/admin/agents/${owner.agent.id}/owner-account`,
      {
        email: `x-${randomUUID()}@agents.example.com`,
      },
    );
    expect(again.statusCode).toBe(409);
    expect(code(again.body)).toBe('agent_owner_exists');
    const byFinance = await asStaff(
      ctx,
      finance,
      'POST',
      `/admin/agents/${owner.agent.id}/owner-account`,
      { email: `y-${randomUUID()}@agents.example.com` },
    );
    expect(byFinance.statusCode).toBe(403);
    // The Staff screen cannot make an owner (no agent to link).
    const viaStaff = await asStaff(ctx, admin, 'POST', '/admin/staff', {
      email: `z-${randomUUID()}@agents.example.com`,
      displayName: 'Loose Owner',
      role: 'agent_owner',
    });
    expect(viaStaff.statusCode).toBe(400);
  });

  it('signs in to the shop app with the authenticator code, never to the back office', async () => {
    const owner = await agentWithOwner('Owner Sign-in Agent');
    const backOffice = await post('/admin/auth/login', {
      email: owner.email,
      password: owner.password,
      code: nextCode(owner.secret),
    });
    expect(backOffice.statusCode).toBe(401);
    // Without the code (a cashier's device sign-in): refused.
    expect(
      (await post('/shop/auth/login', { email: owner.email, password: owner.password })).statusCode,
    ).toBe(401);

    const login = await post('/shop/auth/login', {
      email: owner.email,
      password: owner.password,
      code: nextCode(owner.secret),
    });
    expect(login.statusCode, login.body).toBe(200);
    const session = ShopSessionResponse.parse(login.json());
    expect(session).toMatchObject({
      staff: { role: 'agent_owner', passwordChangeRequired: true },
      agent: { id: owner.agent.id, number: owner.agent.number },
      shop: null,
      deviceId: null,
    });
    const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
    const cookie = `${shopCookie.name}=${shopCookie.value}`;
    const csrf = { cookie, [SHOP_CSRF_HEADER]: session.csrfToken };
    const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

    // The generated password first; the desk is for cashiers.
    const early = await get('/shop/owner');
    expect(early.statusCode).toBe(403);
    expect(code(early.body)).toBe('password_change_required');
    const newPassword = 'a long owner password 2026';
    const noCode = await post(
      '/shop/auth/password',
      { currentPassword: owner.password, newPassword },
      csrf,
    );
    expect(noCode.statusCode).toBe(403);
    expect(code(noCode.body)).toBe('reauth_failed');
    const changed = await post(
      '/shop/auth/password',
      { currentPassword: owner.password, newPassword, code: nextCode(owner.secret) },
      csrf,
    );
    expect(changed.statusCode, changed.body).toBe(200);

    // The password change ended the other sessions: sign in again with the new password.
    const again = await post('/shop/auth/login', {
      email: owner.email,
      password: newPassword,
      code: nextCode(owner.secret),
    });
    expect(again.statusCode, again.body).toBe(200);
    const fresh = again.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
    const freshCookie = `${fresh.name}=${fresh.value}`;
    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/shop/owner',
      headers: { cookie: freshCookie },
    });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(ShopOwnerResponse.parse(overview.json())).toMatchObject({
      agent: { id: owner.agent.id },
      balance: '0',
      shops: [],
      cashiers: [],
      devices: [],
    });
    const desk = await ctx.app.inject({
      method: 'GET',
      url: '/shop/desk',
      headers: { cookie: freshCookie },
    });
    expect(desk.statusCode).toBe(403);
    expect(code(desk.body)).toBe('cashier_only');

    // Blocking the agent ends the owner's session at once.
    const blocked = await asStaff(ctx, admin, 'POST', `/admin/agents/${owner.agent.id}/block`, {
      reason: 'licence check',
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/shop/me', headers: { cookie: freshCookie } }))
        .statusCode,
    ).toBe(401);
  });

  it("adds and blocks the owner's own cashiers, never another agent's", async () => {
    const owner = await agentWithOwner('Owner Cashier Agent');
    const other = await agentWithOwner('Owner Cashier Other');
    const shopOf = async (agentId: string, name: string) =>
      CashierShopResponse.parse(
        (
          await asStaff(ctx, admin, 'POST', `/admin/agents/${agentId}/shops`, {
            name,
            address: '',
            receiptWidthMm: 80,
            approvalThreshold: '1000000',
          })
        ).json(),
      ).shop;
    const mine = await shopOf(owner.agent.id, 'Owner Cashier Shop');
    const theirs = await shopOf(other.agent.id, 'Other Cashier Shop');

    // Sign in, replace the generated password, sign in again.
    const first = await post('/shop/auth/login', {
      email: owner.email,
      password: owner.password,
      code: nextCode(owner.secret),
    });
    const firstCookie = first.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
    const newPassword = 'a long owner password 2026';
    await post(
      '/shop/auth/password',
      { currentPassword: owner.password, newPassword, code: nextCode(owner.secret) },
      {
        cookie: `${firstCookie.name}=${firstCookie.value}`,
        [SHOP_CSRF_HEADER]: ShopSessionResponse.parse(first.json()).csrfToken,
      },
    );
    const login = await post('/shop/auth/login', {
      email: owner.email,
      password: newPassword,
      code: nextCode(owner.secret),
    });
    expect(login.statusCode, login.body).toBe(200);
    const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
    const headers = {
      cookie: `${shopCookie.name}=${shopCookie.value}`,
      [SHOP_CSRF_HEADER]: ShopSessionResponse.parse(login.json()).csrfToken,
    };
    const cashier = (shopId: string) => ({
      shopId,
      email: `cashier-${randomUUID().slice(0, 8)}@agents.example.com`,
      displayName: 'Counter Cashier',
      phone: '0911556677',
      password: 'a counter password 2026',
    });

    const foreign = await post('/shop/owner/cashiers', cashier(theirs.id), headers);
    expect(foreign.statusCode).toBe(404);
    const made = await post('/shop/owner/cashiers', cashier(mine.id), headers);
    expect(made.statusCode, made.body).toBe(201);
    const created = ShopOwnerCashierResponse.parse(made.json()).cashier;
    expect(created).toMatchObject({ shopId: mine.id, disabledAt: null });
    // The cashier replaces the owner's password at first sign-in (as with an admin's).
    const detail = await asStaff(ctx, admin, 'GET', `/admin/staff/${created.staffId}`);
    expect(detail.json()).toMatchObject({ role: 'cashier', disabledAt: null });
    const [row] = await ctx.deps.db
      .select({ passwordChangeRequired: adminUsers.passwordChangeRequired })
      .from(adminUsers)
      .where(eq(adminUsers.id, created.staffId));
    expect(row?.passwordChangeRequired).toBe(true);

    const blocked = await post(`/shop/owner/cashiers/${created.staffId}/block`, {}, headers);
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(ShopOwnerCashierResponse.parse(blocked.json()).cashier.disabledAt).not.toBeNull();
    const unblocked = await post(`/shop/owner/cashiers/${created.staffId}/unblock`, {}, headers);
    expect(ShopOwnerCashierResponse.parse(unblocked.json()).cashier.disabledAt).toBeNull();
    // Head office's block stays with head office: the owner cannot undo it.
    const office = await asStaff(ctx, admin, 'POST', `/admin/staff/${created.staffId}/disable`);
    expect(office.statusCode, office.body).toBe(200);
    const undo = await post(`/shop/owner/cashiers/${created.staffId}/unblock`, {}, headers);
    expect(undo.statusCode).toBe(403);
    expect(code(undo.body)).toBe('blocked_by_head_office');
    await asStaff(ctx, admin, 'POST', `/admin/staff/${created.staffId}/enable`);
    // Someone who is not their cashier: not found.
    expect(
      (await post(`/shop/owner/cashiers/${other.staffId}/block`, {}, headers)).statusCode,
    ).toBe(404);
  });
});

describe('shop alert thresholds', () => {
  it('an admin sets the big-win and low-balance thresholds; finance reads them', async () => {
    const read = await asStaff(ctx, finance, 'GET', '/admin/retail/alert-thresholds');
    expect(RetailAlertThresholds.parse(read.json())).toEqual({
      bigWin: '10000000',
      lowBalance: '100000',
    });
    expect(
      (
        await asStaff(ctx, finance, 'PUT', '/admin/retail/alert-thresholds', {
          bigWin: '5000000',
          lowBalance: '50000',
        })
      ).statusCode,
    ).toBe(403);
    const bad = await asStaff(ctx, admin, 'PUT', '/admin/retail/alert-thresholds', {
      bigWin: '0',
      lowBalance: '50000',
    });
    expect(bad.statusCode).toBe(400);
    const set = await asStaff(ctx, admin, 'PUT', '/admin/retail/alert-thresholds', {
      bigWin: '5000000',
      lowBalance: '50000',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(RetailAlertThresholds.parse(set.json())).toEqual({
      bigWin: '5000000',
      lowBalance: '50000',
    });
  });
});
