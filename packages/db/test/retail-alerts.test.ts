import { randomBytes, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignStaffShop, createShop, openShift } from '../src/cashier/index';
import {
  acknowledgeRetailAlert,
  cancelRetailTicket,
  createAgent,
  decideAgentTopup,
  hashDeviceSecret,
  listRetailAlerts,
  recordAgentTopup,
  requestShopDevice,
  RETAIL_ALERT_RULES,
  scanRetailAlerts,
  sellRetailTicket,
  type RetailAlertRules,
} from '../src/retail/index';
import { adminUsers } from '../src/schema/index';
import type { CatalogIds } from '../src/catalog/index';
import type { GameSettings } from '../src/settings/index';
import { createBettingDatabase, createEvent, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';

/** Alerts about the agent shops (docs/plans/agent-shops.md, "Phase 5 design", step 4). */

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;
let admin: string;
let finance: string;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
  admin = await staff('admin');
  finance = await staff('finance');
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: 'admin' | 'finance' | 'cashier'): Promise<string> {
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

/** An agent with a balance and `shops` shops, each with a cashier on an open shift. */
async function agentWithShops(balance: bigint, shops = 1) {
  const agent = await handle.db.transaction((tx) =>
    createAgent(tx, {
      name: `Alert Agent ${randomUUID().slice(0, 8)}`,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId: admin,
      now: new Date(),
    }),
  );
  if (balance > 0n) {
    const topup = await handle.db.transaction((tx) =>
      recordAgentTopup(tx, {
        agentId: agent.id,
        direction: 'in',
        amount: balance,
        method: 'cash',
        adminId: admin,
        now: new Date(),
      }),
    );
    await handle.db.transaction((tx) =>
      decideAgentTopup(tx, {
        topupId: topup.id,
        decision: 'approve',
        adminId: finance,
        now: new Date(),
      }),
    );
  }
  const desks = [];
  for (let i = 0; i < shops; i += 1) {
    const shop = await handle.db.transaction((tx) =>
      createShop(tx, {
        agentId: agent.id,
        name: `Alert Counter ${i + 1}`,
        address: '',
        receiptWidthMm: 80,
        approvalThreshold: birr(10_000),
        adminId: admin,
        now: new Date(),
      }),
    );
    const cashier = await staff('cashier');
    await handle.db.transaction((tx) =>
      assignStaffShop(tx, { staffId: cashier, shopId: shop.id, adminId: admin, now: new Date() }),
    );
    const shift = await handle.db.transaction((tx) =>
      openShift(tx, { staffId: cashier, shopId: shop.id, openingFloat: 0n, now: new Date() }),
    );
    desks.push({ shop, cashier, shift });
  }
  return { agentId: agent.id, desks };
}

type Desk = Awaited<ReturnType<typeof agentWithShops>>['desks'][number];

const sell = (desk: Desk, stake: bigint, selectionId: string, oddsMilli: number) =>
  handle.db.transaction((tx) =>
    sellRetailTicket(tx, {
      staffId: desk.cashier,
      shiftId: desk.shift.id,
      legs: [{ selectionId, oddsMilli }],
      stake,
      policy: 'none',
      idempotencyKey: `ticket-${randomUUID()}`,
      settings,
      now: new Date(),
      randomBytes: (n) => randomBytes(n),
    }),
  );

const scan = (rules: Partial<RetailAlertRules> = {}) =>
  handle.db.transaction((tx) =>
    scanRetailAlerts(tx, new Date(), { ...RETAIL_ALERT_RULES, ...rules }),
  );

describe('retail alerts', () => {
  it('raise big wins, repeated picks, many cancels and late tickets once each', async () => {
    const { agentId, desks } = await agentWithShops(birr(5_000), 2);
    const match = await createEvent(handle.db, ids);
    const [one, two] = desks as [Desk, Desk];
    const big = await sell(one, birr(100), match.home, 2000);
    await sell(two, birr(10), match.home, 2000);
    await sell(one, birr(10), match.home, 2000);
    const c1 = await sell(one, birr(10), match.away, 3500);
    const c2 = await sell(one, birr(10), match.away, 3500);
    for (const ticket of [c1, c2]) {
      await handle.db.transaction((tx) =>
        cancelRetailTicket(tx, {
          ticketId: ticket.ticket.id,
          actor: { staffId: one.cashier, role: 'cashier' },
          now: new Date(),
        }),
      );
    }
    const raised = await scan({
      bigWin: birr(150),
      manyCancels: 2,
      // A kick-off a day away counts as "just before" here, so the rule is exercised.
      lateTicketMs: 7 * 24 * 3_600_000,
    });
    const kinds = raised.filter((a) => a.agentId === agentId || a.kind === 'repeated_picks');
    expect(kinds.find((a) => a.kind === 'big_win')).toMatchObject({
      dedupKey: `big_win:${big.ticket.id}`,
      shopId: one.shop.id,
    });
    const picks = raised.find((a) => a.kind === 'repeated_picks');
    expect(picks?.details).toMatchObject({ tickets: 3, shops: 2 });
    expect(kinds.find((a) => a.kind === 'many_cancels')?.details).toMatchObject({
      staffId: one.cashier,
      cancels: 2,
    });
    expect(kinds.filter((a) => a.kind === 'late_ticket').length).toBeGreaterThanOrEqual(3);
    // Raised once: the next scan adds nothing for the same subjects.
    const again = await scan({
      bigWin: birr(150),
      manyCancels: 2,
      lateTicketMs: 7 * 24 * 3_600_000,
    });
    expect(again.filter((a) => a.agentId === agentId)).toEqual([]);
  });

  it('raise a low balance and a waiting device; staff acknowledge them once', async () => {
    const { agentId, desks } = await agentWithShops(birr(500));
    const desk = desks[0]!;
    await handle.db.transaction((tx) =>
      requestShopDevice(tx, {
        staffId: desk.cashier,
        label: 'Counter PC',
        secretHash: hashDeviceSecret(randomBytes(32).toString('hex')),
        userAgent: 'test',
        now: new Date(),
      }),
    );
    const raised = (await scan()).filter((a) => a.agentId === agentId);
    const low = raised.find((a) => a.kind === 'low_balance');
    expect(low?.details).toMatchObject({ balance: '50000' });
    expect(raised.some((a) => a.kind === 'device_waiting')).toBe(true);

    const acknowledged = await handle.db.transaction((tx) =>
      acknowledgeRetailAlert(tx, { alertId: low!.id, staffId: admin, now: new Date() }),
    );
    expect(acknowledged.acknowledgedBy).toBe(admin);
    const twice = await handle.db.transaction((tx) =>
      acknowledgeRetailAlert(tx, { alertId: low!.id, staffId: finance, now: new Date() }),
    );
    expect(twice.acknowledgedBy).toBe(admin);
    const open = await listRetailAlerts(handle.db, { open: true, limit: 500 });
    expect(open.some((a) => a.id === low!.id)).toBe(false);
    const all = await listRetailAlerts(handle.db, { open: false, limit: 500 });
    expect(all.some((a) => a.id === low!.id)).toBe(true);
  });
});
