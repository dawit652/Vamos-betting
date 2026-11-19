import { randomBytes, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignStaffShop, createShop } from '../src/cashier/index';
import { DomainError } from '../src/errors';
import {
  approveShopDevice,
  createAgent,
  findApprovedStaffDevice,
  hashDeviceSecret,
  listAgentDevices,
  MAX_PENDING_DEVICES_PER_SHOP,
  requestShopDevice,
  revokeShopDevice,
  setAgentBlocked,
  touchShopDevice,
} from '../src/retail/index';
import { adminUsers } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { NOW } from './payments-fixtures';

/** Shop devices, phase 1b (docs/plans/agent-shops.md): ask, approve, revoke, find. */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let adminId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  adminId = await staff('admin');
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: 'admin' | 'cashier' | 'finance'): Promise<string> {
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

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** An agent with one shop and a cashier assigned to it. */
async function agentShopCashier(name: string) {
  const agent = await handle.db.transaction((tx) =>
    createAgent(tx, {
      name,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId,
      now: NOW,
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
      now: NOW,
    }),
  );
  const cashier = await staff('cashier');
  await handle.db.transaction((tx) =>
    assignStaffShop(tx, { staffId: cashier, shopId: shop.id, adminId, now: NOW }),
  );
  return { agent, shop, cashier };
}

const secret = () => randomBytes(32).toString('base64url');

const ask = (staffId: string, secretHash: string, label = 'Counter PC') =>
  handle.db.transaction((tx) =>
    requestShopDevice(tx, { staffId, label, secretHash, userAgent: 'test browser', now: NOW }),
  );

describe('a shop device', () => {
  it('is asked by a cashier for their own shop, works once approved, and stops when revoked', async () => {
    const { agent, cashier } = await agentShopCashier('Device Agent');
    const devSecret = secret();
    const hash = hashDeviceSecret(devSecret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const device = await ask(cashier, hash);
    expect(device.status).toBe('pending');
    // Waiting: not usable.
    expect(
      await findApprovedStaffDevice(handle.db, { staffId: cashier, secretHash: hash }),
    ).toBeNull();

    const approved = await handle.db.transaction((tx) =>
      approveShopDevice(tx, { deviceId: device.id, adminId, now: NOW }),
    );
    expect(approved).toMatchObject({ status: 'approved', decidedBy: adminId });
    expect(
      (await findApprovedStaffDevice(handle.db, { staffId: cashier, secretHash: hash }))?.id,
    ).toBe(device.id);
    // Another secret, or another cashier, does not find it.
    expect(
      await findApprovedStaffDevice(handle.db, {
        staffId: cashier,
        secretHash: hashDeviceSecret(secret()),
      }),
    ).toBeNull();
    const other = await agentShopCashier('Other Agent');
    expect(
      await findApprovedStaffDevice(handle.db, { staffId: other.cashier, secretHash: hash }),
    ).toBeNull();

    await touchShopDevice(handle.db, device.id, NOW);
    const listed = await listAgentDevices(handle.db, agent.id);
    expect(listed).toEqual([
      expect.objectContaining({
        id: device.id,
        status: 'approved',
        shopLabel: `${agent.number}-01`,
        requestedByName: 'Test cashier',
        lastSeenAt: NOW,
      }),
    ]);

    expect(
      await refusal(
        handle.db.transaction((tx) =>
          revokeShopDevice(tx, { deviceId: device.id, adminId, reason: 'x', now: NOW }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_reason' });
    const revoked = await handle.db.transaction((tx) =>
      revokeShopDevice(tx, { deviceId: device.id, adminId, reason: 'stolen laptop', now: NOW }),
    );
    expect(revoked).toMatchObject({ status: 'revoked', revokedReason: 'stolen laptop' });
    expect(
      await findApprovedStaffDevice(handle.db, { staffId: cashier, secretHash: hash }),
    ).toBeNull();
    // A revoked device cannot be approved again.
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          approveShopDevice(tx, { deviceId: device.id, adminId, now: NOW }),
        ),
      ),
    ).toEqual({ status: 409, code: 'device_not_pending' });
  });

  it('is refused for anyone but a cashier with an open shop, and when too many wait', async () => {
    const supervisor = await staff('finance');
    expect(await refusal(ask(supervisor, hashDeviceSecret(secret())))).toEqual({
      status: 403,
      code: 'device_staff_only',
    });
    const unassigned = await staff('cashier');
    expect(await refusal(ask(unassigned, hashDeviceSecret(secret())))).toEqual({
      status: 409,
      code: 'shop_assignment_required',
    });
    const { agent, cashier } = await agentShopCashier('Busy Agent');
    for (let i = 0; i < MAX_PENDING_DEVICES_PER_SHOP; i += 1) {
      await ask(cashier, hashDeviceSecret(secret()), `PC ${i}`);
    }
    expect(await refusal(ask(cashier, hashDeviceSecret(secret())))).toEqual({
      status: 409,
      code: 'too_many_device_requests',
    });
    await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: agent.id,
        blocked: true,
        reason: 'checks',
        adminId,
        now: NOW,
      }),
    );
    const blocked = await agentShopCashier('Blocked Device Agent');
    await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: blocked.agent.id,
        blocked: true,
        reason: 'checks',
        adminId,
        now: NOW,
      }),
    );
    expect(await refusal(ask(blocked.cashier, hashDeviceSecret(secret())))).toEqual({
      status: 409,
      code: 'agent_blocked',
    });
    expect(await refusal(ask(cashier, hashDeviceSecret(secret()), '   '))).toEqual({
      status: 422,
      code: 'invalid_device_label',
    });
  });
});
