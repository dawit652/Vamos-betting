import { randomBytes, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argon2PasswordHasher } from '../src/backoffice/argon2';
import {
  authenticateStaffSession,
  base32Decode,
  changeOwnStaffPassword,
  createStaffUser,
  loginStaff,
  totpCode,
  type StaffAuthDeps,
} from '../src/backoffice/index';
import { assignStaffShop, createShop } from '../src/cashier/index';
import { DomainError } from '../src/errors';
import {
  approveShopDevice,
  createAgent,
  createAgentOwnerAccount,
  getAgent,
  requestShopDevice,
  setAgentBlocked,
} from '../src/retail/index';
import { adminSessions, adminUsers, agents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

/** Agent owner accounts (docs/plans/agent-shops.md, phase 1b step 1). */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let adminId: string;
const KEY = Buffer.alloc(32, 0x5a);
let now = new Date('2026-11-19T08:00:00.000Z');
const clock = () => now;
const deps = (): StaffAuthDeps => ({
  db: handle.db,
  clock,
  randomBytes,
  totpKey: KEY,
  passwords: argon2PasswordHasher,
});

beforeAll(async () => {
  handle = await createTestDatabase();
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `admin-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Admin',
      role: 'admin',
    })
    .returning({ id: adminUsers.id });
  adminId = row!.id;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

const newAgent = (name: string) =>
  handle.db.transaction((tx) =>
    createAgent(tx, {
      name,
      ownerName: 'Tadesse Owner',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId,
      now,
    }),
  );

/** The next 30-second step's code, so a code is never replayed within a test. */
function code(secret: Buffer): string {
  now = new Date(now.getTime() + 30_000);
  return totpCode(secret, now.getTime());
}

async function ownerOf(name: string) {
  const agent = await newAgent(name);
  const email = `owner-${randomUUID()}@example.com`;
  const made = await createAgentOwnerAccount(deps(), { agentId: agent.id, email, adminId });
  return {
    agent,
    email,
    password: made.generatedPassword!,
    secret: base32Decode(made.totp.secret),
    staffId: made.user.id,
  };
}

const shopLogin = (email: string, password: string, typed: string) =>
  loginStaff(deps(), { email, password, code: typed, channel: 'shop' });

describe('an agent owner account', () => {
  it('is made from the agent, with its owner name and phone, linked once', async () => {
    const owner = await ownerOf('Bole Bets');
    const [user] = await handle.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, owner.staffId));
    expect(user).toMatchObject({
      role: 'agent_owner',
      displayName: 'Tadesse Owner',
      phone: '+251911223344',
      passwordChangeRequired: true,
    });
    expect((await getAgent(handle.db, owner.agent.id))?.ownerStaffId).toBe(owner.staffId);
    expect(
      await refusal(
        createAgentOwnerAccount(deps(), {
          agentId: owner.agent.id,
          email: `other-${randomUUID()}@example.com`,
          adminId,
        }),
      ),
    ).toEqual({ status: 409, code: 'agent_owner_exists' });
    // Nahubet HQ has none.
    const [hq] = await handle.db.select().from(agents).where(eq(agents.isHouse, true));
    expect(
      await refusal(
        createAgentOwnerAccount(deps(), {
          agentId: hq!.id,
          email: `hq-${randomUUID()}@example.com`,
          adminId,
        }),
      ),
    ).toEqual({ status: 409, code: 'agent_is_house' });
  });

  it('signs in to the shop app with password and authenticator, never to the back office', async () => {
    const owner = await ownerOf('Piassa Bets');
    // The back office refuses the owner even with everything right.
    await expect(
      loginStaff(deps(), {
        email: owner.email,
        password: owner.password,
        code: code(owner.secret),
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    // The shop app without the code (a cashier's device sign-in) refuses too.
    await expect(shopLogin(owner.email, owner.password, '')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const { session, staff } = await shopLogin(owner.email, owner.password, code(owner.secret));
    expect(staff).toMatchObject({ role: 'agent_owner', channel: 'shop', deviceId: null });
    const [row] = await handle.db
      .select({ channel: adminSessions.channel, deviceId: adminSessions.deviceId })
      .from(adminSessions)
      .where(eq(adminSessions.id, session.id));
    expect(row).toEqual({ channel: 'shop', deviceId: null });

    // The session works in the shop app only, and stops when the agent is blocked.
    const check = () => authenticateStaffSession(deps(), { token: session.token, channel: 'shop' });
    expect((await check()).status).toBe('ok');
    expect(
      (await authenticateStaffSession(deps(), { token: session.token, channel: 'admin' })).status,
    ).toBe('none');
    await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: owner.agent.id,
        blocked: true,
        reason: 'audit',
        adminId,
        now,
      }),
    );
    expect((await check()).status).toBe('none');
  });

  it('changes the password in the shop app with the authenticator code', async () => {
    const owner = await ownerOf('Merkato Bets');
    const { staff } = await shopLogin(owner.email, owner.password, code(owner.secret));
    const change = (typed: string, newPassword: string) =>
      changeOwnStaffPassword(deps(), {
        adminUserId: owner.staffId,
        sessionId: staff.sessionId,
        currentPassword: owner.password,
        code: typed,
        newPassword,
        channel: 'shop',
      });
    await expect(change('000000', 'a-new-long-owner-password-1')).rejects.toBeInstanceOf(Error);
    const changed = await change(code(owner.secret), 'a-new-long-owner-password-1');
    expect(changed.passwordChangeRequired).toBe(false);
  });

  it('a cashier cannot use the authenticator sign-in of the shop app', async () => {
    const agent = await newAgent('Kazanchis Bets');
    const shop = await handle.db.transaction((tx) =>
      createShop(tx, {
        agentId: agent.id,
        name: 'Kazanchis 1',
        address: '',
        receiptWidthMm: 80,
        approvalThreshold: birr(10_000),
        adminId,
        now,
      }),
    );
    const email = `cashier-${randomUUID()}@example.com`;
    const made = await createStaffUser(deps(), {
      email,
      displayName: 'Cashier',
      role: 'cashier',
      phone: '0912345678',
      actor: { type: 'system', via: 'test' },
      requirePasswordChange: false,
    });
    await handle.db.transaction((tx) =>
      assignStaffShop(tx, { staffId: made.user.id, shopId: shop.id, adminId, now }),
    );
    const secret = base32Decode(made.totp.secret);
    await expect(shopLogin(email, made.generatedPassword!, code(secret))).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    // Its device sign-in still works.
    const device = await handle.db.transaction((tx) =>
      requestShopDevice(tx, {
        staffId: made.user.id,
        label: 'Counter',
        secretHash: 'a'.repeat(64),
        userAgent: 'test',
        now,
      }),
    );
    await handle.db.transaction((tx) =>
      approveShopDevice(tx, { deviceId: device.id, adminId, now }),
    );
    const { staff } = await loginStaff(deps(), {
      email,
      password: made.generatedPassword!,
      code: '',
      channel: 'shop',
      deviceSecretHash: 'a'.repeat(64),
    });
    expect(staff).toMatchObject({ role: 'cashier', deviceId: device.id });
  });
});
