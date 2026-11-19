import { randomBytes } from 'node:crypto';
import {
  AgentDetailResponse,
  AgentListResponse,
  AgentResponse,
  CashierShopListResponse,
  CashierShopResponse,
  CreateStaffResponse,
  ShopDeviceResponse,
} from '@vamos/contracts';
import { assignStaffShop, hashDeviceSecret, requestShopDevice } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/** Agent shops, phase 1 (docs/plans/agent-shops.md): the /admin/agents routes and staff phones. */

let ctx: TestContext;
let admin: StaffSession;
let finance: StaffSession;
let cashier: StaffSession;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');
  cashier = await staffLogin(ctx, 'cashier');
});

afterAll(async () => {
  await ctx?.close();
});

const newAgent = {
  name: 'Bole Agent',
  ownerName: 'Abebe Kebede',
  ownerPhone: '0911 22 33 44',
  commissionKind: 'ggr',
  commissionBps: 1_000,
};

describe('/admin/agents', () => {
  it('lets an admin add an agent, its shop, change it, and block and unblock it', async () => {
    const created = await asStaff(ctx, admin, 'POST', '/admin/agents', newAgent);
    expect(created.statusCode).toBe(201);
    const { agent } = AgentResponse.parse(created.json());
    expect(agent.number).toBeGreaterThanOrEqual(1001);
    expect(agent).toMatchObject({ ownerPhone: '+251911223344', status: 'active', isHouse: false });

    const shop = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/shops`, {
      name: 'Bole 1',
      address: 'Bole road',
      receiptWidthMm: 80,
      approvalThreshold: '1000000',
    });
    expect(shop.statusCode).toBe(201);
    expect(CashierShopResponse.parse(shop.json()).shop).toMatchObject({
      agentId: agent.id,
      agentNumber: agent.number,
      number: 1,
      label: `${agent.number}-01`,
      code: `${agent.number}-01`,
    });

    const detail = AgentDetailResponse.parse(
      (await asStaff(ctx, finance, 'GET', `/admin/agents/${agent.id}`)).json(),
    );
    expect(detail.shops.map((s) => s.label)).toEqual([`${agent.number}-01`]);
    expect(detail.cashiers).toEqual([]);

    const patched = await asStaff(ctx, admin, 'PATCH', `/admin/agents/${agent.id}`, {
      commissionKind: 'stake',
      commissionBps: 500,
    });
    expect(patched.statusCode).toBe(200);
    expect(AgentResponse.parse(patched.json()).agent).toMatchObject({
      commissionKind: 'stake',
      commissionBps: 500,
    });

    const blocked = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/block`, {
      reason: 'balance not paid',
    });
    expect(AgentResponse.parse(blocked.json()).agent).toMatchObject({
      status: 'blocked',
      blockedReason: 'balance not paid',
    });
    const unblocked = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/unblock`, {
      reason: 'paid',
    });
    expect(AgentResponse.parse(unblocked.json()).agent.status).toBe('active');
  });

  it('keeps Nahubet HQ as agent 1000: never blocked, only renamed', async () => {
    const list = AgentListResponse.parse(
      (await asStaff(ctx, admin, 'GET', '/admin/agents')).json(),
    );
    const hq = list.items.find((a) => a.isHouse);
    expect(hq).toMatchObject({ number: 1000 });
    expect(list.items[0]?.isHouse).toBe(true);
    const block = await asStaff(ctx, admin, 'POST', `/admin/agents/${hq!.id}/block`, {
      reason: 'testing the house rule',
    });
    expect(block.statusCode).toBe(409);
    expect(block.json()).toMatchObject({ error: { code: 'house_agent' } });
    const commission = await asStaff(ctx, admin, 'PATCH', `/admin/agents/${hq!.id}`, {
      commissionBps: 100,
    });
    expect(commission.statusCode).toBe(409);
    expect(commission.json()).toMatchObject({ error: { code: 'house_agent' } });
  });

  it('refuses a bad phone with 422 and an unknown agent with 404', async () => {
    const bad = await asStaff(ctx, admin, 'POST', '/admin/agents', {
      ...newAgent,
      ownerPhone: '0111223344',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_owner_phone' } });
    const missing = await asStaff(
      ctx,
      admin,
      'GET',
      '/admin/agents/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.statusCode).toBe(404);
  });

  it('lets finance read but not change, and refuses a cashier', async () => {
    expect((await asStaff(ctx, finance, 'GET', '/admin/agents')).statusCode).toBe(200);
    expect((await asStaff(ctx, finance, 'POST', '/admin/agents', newAgent)).statusCode).toBe(403);
    expect((await asStaff(ctx, cashier, 'GET', '/admin/agents')).statusCode).toBe(403);
  });

  it('shows every shop with its agent and printed number', async () => {
    const shops = CashierShopListResponse.parse(
      (await asStaff(ctx, admin, 'GET', '/admin/cashier/shops')).json(),
    ).shops;
    expect(shops.find((s) => s.code === 'main')).toMatchObject({ label: '1000-01', number: 1 });
  });
});

describe('staff phone numbers', () => {
  it('are required for a new cashier and stored as E.164', async () => {
    const without = await asStaff(ctx, admin, 'POST', '/admin/staff', {
      email: 'desk-nophone@example.com',
      displayName: 'Desk No Phone',
      role: 'cashier',
    });
    expect(without.statusCode).toBe(400);
    const withPhone = await asStaff(ctx, admin, 'POST', '/admin/staff', {
      email: 'desk-phone@example.com',
      displayName: 'Desk Phone',
      role: 'cashier',
      phone: '0911 99 88 77',
    });
    expect(withPhone.statusCode).toBe(201);
    const { user } = CreateStaffResponse.parse(withPhone.json());
    expect(user.phone).toBe('+251911998877');
    const cleared = await asStaff(ctx, admin, 'PATCH', `/admin/staff/${user.id}`, { phone: null });
    expect(cleared.json()).toMatchObject({ phone: null });
  });
});

describe('shop devices', () => {
  it('are listed on the agent, approved and revoked by an admin, never by finance', async () => {
    const { agent } = AgentResponse.parse(
      (
        await asStaff(ctx, admin, 'POST', '/admin/agents', {
          ...newAgent,
          name: 'Device Agent',
        })
      ).json(),
    );
    const { shop } = CashierShopResponse.parse(
      (
        await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/shops`, {
          name: 'Device shop',
          address: '',
          receiptWidthMm: 80,
          approvalThreshold: '1000000',
        })
      ).json(),
    );
    const desk = CreateStaffResponse.parse(
      (
        await asStaff(ctx, admin, 'POST', '/admin/staff', {
          email: 'device-desk@example.com',
          displayName: 'Device Desk',
          role: 'cashier',
          phone: '0911445566',
        })
      ).json(),
    ).user;
    const now = ctx.clock.now;
    await ctx.deps.db.transaction((tx) =>
      assignStaffShop(tx, { staffId: desk.id, shopId: shop.id, adminId: admin.id, now }),
    );
    const device = await ctx.deps.db.transaction((tx) =>
      requestShopDevice(tx, {
        staffId: desk.id,
        label: 'Counter PC',
        secretHash: hashDeviceSecret(randomBytes(32).toString('base64url')),
        userAgent: 'test',
        now,
      }),
    );
    const detail = AgentDetailResponse.parse(
      (await asStaff(ctx, finance, 'GET', `/admin/agents/${agent.id}`)).json(),
    );
    expect(detail.devices).toEqual([
      expect.objectContaining({ id: device.id, status: 'pending', shopLabel: shop.label }),
    ]);
    expect(
      (await asStaff(ctx, finance, 'POST', `/admin/shop-devices/${device.id}/approve`)).statusCode,
    ).toBe(403);
    const approved = await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/approve`);
    expect(ShopDeviceResponse.parse(approved.json()).device.status).toBe('approved');
    const revoked = await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/revoke`, {
      reason: 'laptop replaced',
    });
    expect(ShopDeviceResponse.parse(revoked.json()).device).toMatchObject({
      status: 'revoked',
      revokedReason: 'laptop replaced',
    });
  });
});
