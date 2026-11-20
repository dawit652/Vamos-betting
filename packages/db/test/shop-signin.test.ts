import { randomBytes } from 'node:crypto';
import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argon2PasswordHasher } from '../src/backoffice/argon2';
import { DomainError } from '../src/errors';
import {
  approveShopDevice,
  assignStaffShop,
  authenticateStaffSession,
  base32Decode,
  createAgent,
  createShop,
  createStaffUser,
  hashDeviceSecret,
  loginStaff,
  requestShopDeviceWithPassword,
  revokeShopDevice,
  setAgentBlocked,
  totpCode,
  updateShop,
  type StaffAuthDeps,
  type StaffRole,
} from '../src/index';
import { adminSessions, adminUsers } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

/**
 * The shop app's sign-in (docs/plans/agent-shops.md phase 1b): a cashier signs in with the password
 * on an approved device of their own shop (no TOTP code); the session works only on the shop side,
 * and stops at once when the device is revoked, the shop closed or the agent blocked.
 */

const KEY = Buffer.alloc(32, 0x5a);
const PASSWORD = 'correct horse battery staple';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let now = new Date('2026-11-19T08:00:00.000Z');
const clock = () => now;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const deps = (): StaffAuthDeps => ({
  db: handle.db,
  clock,
  randomBytes,
  totpKey: KEY,
  passwords: argon2PasswordHasher,
});

let adminId: string;
let counter = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  adminId = (await staff('admin')).id;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: StaffRole) {
  counter += 1;
  const created = await createStaffUser(deps(), {
    email: `${role}-${counter}@shop.example.com`,
    displayName: `Test ${role} ${counter}`,
    role,
    password: PASSWORD,
    ...(role === 'cashier' ? { phone: '0911223344' } : {}),
    actor: { type: 'system', via: 'test' },
  });
  return { id: created.user.id, email: created.user.email, secret: created.totp.secret };
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

/** An agent shop with a cashier and an approved device: what the shop app needs. */
async function counter_(name: string) {
  const agent = await handle.db.transaction((tx) =>
    createAgent(tx, {
      name,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId,
      now,
    }),
  );
  const shop = await handle.db.transaction((tx) =>
    createShop(tx, {
      agentId: agent.id,
      name: `${name} 1`,
      address: '',
      receiptWidthMm: 80,
      approvalThreshold: birr(10_000),
      adminId,
      now,
    }),
  );
  const cashier = await staff('cashier');
  await handle.db.transaction((tx) =>
    assignStaffShop(tx, { staffId: cashier.id, shopId: shop.id, adminId, now }),
  );
  const secret = randomBytes(32).toString('base64url');
  const device = await requestShopDeviceWithPassword(deps(), {
    email: cashier.email,
    password: PASSWORD,
    label: 'Counter PC',
    secretHash: hashDeviceSecret(secret),
    userAgent: 'test',
    ip: '10.0.0.1',
  });
  await handle.db.transaction((tx) => approveShopDevice(tx, { deviceId: device.id, adminId, now }));
  return { agent, shop, cashier, device, secretHash: hashDeviceSecret(secret) };
}

const shopLogin = (email: string, secretHash: string, password = PASSWORD, ip = '10.0.0.1') =>
  loginStaff(deps(), {
    email,
    password,
    code: '',
    channel: 'shop',
    deviceSecretHash: secretHash,
    ip,
  });

const check = (token: string, channel: 'admin' | 'shop') =>
  authenticateStaffSession(deps(), { token, checkCsrf: false, channel });

describe('the shop sign-in', () => {
  it('opens a shop session on an approved device, which never works in the back office', async () => {
    const { cashier, device, secretHash } = await counter_('Signin Agent');
    const result = await shopLogin(cashier.email, secretHash);
    expect(result.staff).toMatchObject({ channel: 'shop', deviceId: device.id, role: 'cashier' });
    const [row] = await handle.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, result.session.id));
    expect(row).toMatchObject({ channel: 'shop', deviceId: device.id });
    const onShop = await check(result.session.token, 'shop');
    expect(onShop).toMatchObject({ status: 'ok', staff: { deviceId: device.id } });
    expect(await check(result.session.token, 'admin')).toEqual({ status: 'none' });
    // A back-office session (password and TOTP code) does not work on the shop side either.
    const admin = await loginStaff(deps(), {
      email: cashier.email,
      password: PASSWORD,
      code: totpCode(base32Decode(cashier.secret), now.getTime()),
      ip: '10.0.0.2',
    });
    expect(admin.staff.channel).toBe('admin');
    expect(await check(admin.session.token, 'admin')).toMatchObject({ status: 'ok' });
    expect(await check(admin.session.token, 'shop')).toEqual({ status: 'none' });
  });

  it('refuses a wrong device, counting it like a wrong password, and anyone but a cashier', async () => {
    const { cashier } = await counter_('Wrong Device Agent');
    expect(
      await refusal(shopLogin(cashier.email, hashDeviceSecret(randomBytes(32).toString('hex')))),
    ).toEqual({ status: 401, code: 'invalid_credentials' });
    const [row] = await handle.db
      .select({ attempts: adminUsers.failedLoginAttempts })
      .from(adminUsers)
      .where(eq(adminUsers.id, cashier.id));
    expect(row?.attempts).toBe(1);
    const finance = await staff('finance');
    const { secretHash } = await counter_('Finance Agent');
    expect(await refusal(shopLogin(finance.email, secretHash))).toEqual({
      status: 401,
      code: 'invalid_credentials',
    });
  });

  it('stops working at once when the device is revoked, the shop closed or the agent blocked', async () => {
    advance(60_000);
    const one = await counter_('Revoke Agent');
    const s1 = await shopLogin(one.cashier.email, one.secretHash);
    await handle.db.transaction((tx) =>
      revokeShopDevice(tx, { deviceId: one.device.id, adminId, reason: 'stolen', now }),
    );
    expect(await check(s1.session.token, 'shop')).toEqual({ status: 'none' });
    expect(await refusal(shopLogin(one.cashier.email, one.secretHash))).toEqual({
      status: 401,
      code: 'invalid_credentials',
    });

    const two = await counter_('Close Agent');
    const s2 = await shopLogin(two.cashier.email, two.secretHash);
    await handle.db.transaction((tx) =>
      updateShop(tx, {
        shopId: two.shop.id,
        name: two.shop.name,
        address: '',
        receiptWidthMm: 80,
        approvalThreshold: birr(10_000),
        active: false,
        adminId,
        now,
      }),
    );
    expect(await check(s2.session.token, 'shop')).toEqual({ status: 'none' });

    const three = await counter_('Block Agent');
    const s3 = await shopLogin(three.cashier.email, three.secretHash);
    expect(await check(s3.session.token, 'shop')).toMatchObject({ status: 'ok' });
    await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: three.agent.id,
        blocked: true,
        reason: 'checks',
        adminId,
        now,
      }),
    );
    expect(await check(s3.session.token, 'shop')).toEqual({ status: 'none' });
  });
});

describe('a device asking with the password', () => {
  it('refuses a wrong password like a sign-in and anyone but a cashier', async () => {
    const { cashier } = await counter_('Ask Agent');
    const ask = (email: string, password: string) =>
      requestShopDeviceWithPassword(deps(), {
        email,
        password,
        label: 'POS',
        secretHash: hashDeviceSecret(randomBytes(32).toString('hex')),
        ip: '10.0.0.9',
      });
    expect(await refusal(ask(cashier.email, 'wrong password!!'))).toEqual({
      status: 401,
      code: 'invalid_credentials',
    });
    expect(await refusal(ask('nobody@shop.example.com', PASSWORD))).toEqual({
      status: 401,
      code: 'invalid_credentials',
    });
    const support = await staff('support');
    expect(await refusal(ask(support.email, PASSWORD))).toEqual({
      status: 401,
      code: 'invalid_credentials',
    });
    expect((await ask(cashier.email, PASSWORD)).status).toBe('pending');
  });
});
