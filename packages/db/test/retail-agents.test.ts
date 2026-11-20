import { randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateStaffUser } from '../src/backoffice/staff-auth';
import {
  assignStaffShop,
  cashDeposit,
  createShop,
  getShop,
  listShops,
  openShift,
} from '../src/cashier/index';
import { DomainError } from '../src/errors';
import {
  createAgent,
  getAgent,
  listAgentCashiers,
  listAgents,
  setAgentBlocked,
  updateAgent,
} from '../src/retail/index';
import { adminUsers, agents, auditLog } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, NOW, rules } from './payments-fixtures';

/** Agent shops, phase 1 (docs/plans/agent-shops.md): numbers, owners, shops, blocking. */

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

const newAgent = (name: string, phone = '0911223344') =>
  handle.db.transaction((tx) =>
    createAgent(tx, {
      name,
      ownerName: 'Abebe Kebede',
      ownerPhone: phone,
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId,
      now: NOW,
    }),
  );

const newShop = (agentId: string | null, name: string) =>
  handle.db.transaction((tx) =>
    createShop(tx, {
      agentId,
      name,
      address: 'Bole',
      receiptWidthMm: 80,
      approvalThreshold: birr(10_000),
      adminId,
      now: NOW,
    }),
  );

describe('Nahubet HQ', () => {
  it('is agent 1000 after the migrations and owns the shop that existed before agents', async () => {
    const [hq] = await handle.db.select().from(agents).where(eq(agents.isHouse, true));
    expect(hq).toMatchObject({ number: 1000, name: 'Nahubet HQ', status: 'active' });
    const shops = await listShops(handle.db);
    expect(shops[0]).toMatchObject({
      code: 'main',
      agentId: hq!.id,
      number: 1,
      label: '1000-01',
      agentIsHouse: true,
    });
  });

  it('cannot be blocked and only changes its name', async () => {
    const [hq] = await handle.db.select().from(agents).where(eq(agents.isHouse, true));
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          setAgentBlocked(tx, {
            agentId: hq!.id,
            blocked: true,
            reason: 'test',
            adminId,
            now: NOW,
          }),
        ),
      ),
    ).toEqual({ status: 409, code: 'house_agent' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          updateAgent(tx, { agentId: hq!.id, commissionBps: 500, adminId, now: NOW }),
        ),
      ),
    ).toEqual({ status: 409, code: 'house_agent' });
    const renamed = await handle.db.transaction((tx) =>
      updateAgent(tx, { agentId: hq!.id, name: 'Nahubet Head Office', adminId, now: NOW }),
    );
    expect(renamed.name).toBe('Nahubet Head Office');
  });
});

describe('agents', () => {
  it('are numbered from 1001 with the owner phone normalised, and audited', async () => {
    const first = await newAgent('Bole Agent', '0911 22 33 44');
    const second = await newAgent('Piassa Agent', '+251 711 223 344');
    expect(first.number).toBe(1001);
    expect(second.number).toBe(1002);
    expect(first.ownerPhone).toBe('+251911223344');
    expect(second.ownerPhone).toBe('+251711223344');
    const audit = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'agent.created'), eq(auditLog.targetId, first.id)));
    expect(audit).toHaveLength(1);
  });

  it('refuse a bad phone, name or commission', async () => {
    expect(await refusal(newAgent('Bad Phone', '0111223344'))).toEqual({
      status: 422,
      code: 'invalid_owner_phone',
    });
    expect(await refusal(newAgent('X'))).toEqual({ status: 422, code: 'invalid_agent_name' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          createAgent(tx, {
            name: 'Too Much',
            ownerName: 'Owner Name',
            ownerPhone: '0911000000',
            commissionKind: 'stake',
            commissionBps: 10_001,
            adminId,
            now: NOW,
          }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_commission' });
  });

  it('change with an audit line, and nothing is written when nothing changes', async () => {
    const agent = await newAgent('Kazanchis Agent');
    const same = await handle.db.transaction((tx) =>
      updateAgent(tx, { agentId: agent.id, name: 'Kazanchis Agent', adminId, now: NOW }),
    );
    expect(same.updatedAt).toEqual(agent.updatedAt);
    const later = new Date(NOW.getTime() + 60_000);
    const changed = await handle.db.transaction((tx) =>
      updateAgent(tx, {
        agentId: agent.id,
        ownerPhone: '0922334455',
        commissionKind: 'stake',
        commissionBps: 750,
        adminId,
        now: later,
      }),
    );
    expect(changed).toMatchObject({
      ownerPhone: '+251922334455',
      commissionKind: 'stake',
      commissionBps: 750,
    });
    const audit = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'agent.updated'), eq(auditLog.targetId, agent.id)));
    expect(audit).toHaveLength(1);
  });
});

describe("an agent's shops", () => {
  it('are numbered per agent, printed as 1001-01, with the label as the default code', async () => {
    const agent = await newAgent('Megenagna Agent');
    const one = await newShop(agent.id, 'Megenagna 1');
    const two = await newShop(agent.id, 'Megenagna 2');
    expect([one.number, two.number]).toEqual([1, 2]);
    const label = `${agent.number}-02`;
    expect(two.code).toBe(label);
    expect((await getShop(handle.db, two.id))?.label).toBe(label);
    // A shop without an agent is an HQ shop.
    const hqShop = await newShop(null, 'HQ second desk');
    expect((await getShop(handle.db, hqShop.id))?.label).toBe('1000-02');
  });

  it('get different numbers when two are added at the same moment', async () => {
    const agent = await newAgent('Concurrent Agent');
    const created = await Promise.all([
      newShop(agent.id, 'Parallel A'),
      newShop(agent.id, 'Parallel B'),
      newShop(agent.id, 'Parallel C'),
    ]);
    expect(created.map((s) => s.number).sort()).toEqual([1, 2, 3]);
  });

  it('are counted on the agent list with their cashiers', async () => {
    const agent = await newAgent('Counted Agent');
    const shop = await newShop(agent.id, 'Counted 1');
    await newShop(agent.id, 'Counted 2');
    const cashier = await staff('cashier');
    await handle.db.transaction((tx) =>
      assignStaffShop(tx, { staffId: cashier, shopId: shop.id, adminId, now: NOW }),
    );
    const row = (await listAgents(handle.db)).find((a) => a.id === agent.id);
    expect(row).toMatchObject({ shops: 2, openShops: 2, cashiers: 1 });
    const cashiers = await listAgentCashiers(handle.db, agent.id);
    expect(cashiers).toEqual([
      expect.objectContaining({ staffId: cashier, shopLabel: `${agent.number}-01` }),
    ]);
  });
});

describe('blocking an agent', () => {
  it('stops its shops at once, needs a reason, and is undone by unblocking', async () => {
    const agent = await newAgent('Blocked Agent');
    const shop = await newShop(agent.id, 'Blocked 1');
    const supervisor = await staff('finance');
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          setAgentBlocked(tx, { agentId: agent.id, blocked: true, reason: 'x', adminId, now: NOW }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_reason' });
    const blocked = await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: agent.id,
        blocked: true,
        reason: 'unpaid balance',
        adminId,
        now: NOW,
      }),
    );
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'unpaid balance' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          openShift(tx, { staffId: supervisor, shopId: shop.id, openingFloat: 0n, now: NOW }),
        ),
      ),
    ).toEqual({ status: 409, code: 'agent_blocked' });
    await handle.db.transaction((tx) =>
      setAgentBlocked(tx, {
        agentId: agent.id,
        blocked: false,
        reason: 'paid',
        adminId,
        now: NOW,
      }),
    );
    expect((await getAgent(handle.db, agent.id))?.status).toBe('active');
    const shift = await handle.db.transaction((tx) =>
      openShift(tx, { staffId: supervisor, shopId: shop.id, openingFloat: 0n, now: NOW }),
    );
    expect(shift.status).toBe('open');
  });
});

describe("player cash at an independent agent's shop", () => {
  it('is refused until the agent balance exists (phase 2)', async () => {
    const agent = await newAgent('Cashless Agent');
    const shop = await newShop(agent.id, 'Cashless 1');
    const supervisor = await staff('finance');
    const shift = await handle.db.transaction((tx) =>
      openShift(tx, { staffId: supervisor, shopId: shop.id, openingFloat: 0n, now: NOW }),
    );
    const { userId } = await createPlayer(handle.db, { kyc: 'verified' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          cashDeposit(tx, {
            staffId: supervisor,
            shiftId: shift.id,
            userId,
            amount: birr(100),
            idempotencyKey: `desk-${randomUUID()}`,
            rules: rules(),
            now: NOW,
          }),
        ),
      ),
    ).toEqual({ status: 409, code: 'agent_player_cash_off' });
  });
});

describe('staff phone numbers', () => {
  it('are normalised, refused when not a mobile, and removable', async () => {
    const cashier = await staff('cashier');
    const actor = { type: 'admin' as const, adminId };
    const set = await handle.db.transaction((tx) =>
      updateStaffUser(tx, { adminUserId: cashier, phone: '0911 556677', actor, now: NOW }),
    );
    expect(set.phone).toBe('+251911556677');
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          updateStaffUser(tx, { adminUserId: cashier, phone: '12345', actor, now: NOW }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_staff_phone' });
    const cleared = await handle.db.transaction((tx) =>
      updateStaffUser(tx, { adminUserId: cashier, phone: null, actor, now: NOW }),
    );
    expect(cleared.phone).toBeNull();
  });
});
