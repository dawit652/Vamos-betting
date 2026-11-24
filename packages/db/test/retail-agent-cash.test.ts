import { createHash, randomUUID } from 'node:crypto';
import { birr, businessDateOf } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignStaffShop,
  cashDeposit,
  cashWithdrawal,
  checkCashCode,
  createCashCode,
  createShop,
  openShift,
} from '../src/cashier/index';
import { runReconciliationChecks } from '../src/compliance/index';
import { DomainError } from '../src/errors';
import { getBalance } from '../src/ledger/index';
import {
  createAgent,
  decideAgentTopup,
  getAgentBalance,
  recordAgentTopup,
  setAgentPlayerCash,
} from '../src/retail/index';
import { adminUsers, paymentIntents, payouts } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { cashOf, createPlayer, NOW, rules } from './payments-fixtures';

/** Player cash at an agent's shop (docs/plans/agent-shops.md, phase 2 step 4). */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let admin: string;
let finance: string;
const RULES = rules();

beforeAll(async () => {
  handle = await createTestDatabase();
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

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** An agent with a balance, one shop, a cashier there with an open shift. */
async function agentDesk(balance: bigint) {
  const agent = await handle.db.transaction((tx) =>
    createAgent(tx, {
      name: `Cash Agent ${randomUUID().slice(0, 8)}`,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId: admin,
      now: NOW,
    }),
  );
  const shop = await handle.db.transaction((tx) =>
    createShop(tx, {
      agentId: agent.id,
      name: 'Agent Counter',
      address: '',
      receiptWidthMm: 80,
      approvalThreshold: birr(10_000),
      adminId: admin,
      now: NOW,
    }),
  );
  const cashier = await staff('cashier');
  await handle.db.transaction((tx) =>
    assignStaffShop(tx, { staffId: cashier, shopId: shop.id, adminId: admin, now: NOW }),
  );
  const shift = await handle.db.transaction((tx) =>
    openShift(tx, { staffId: cashier, shopId: shop.id, openingFloat: birr(500), now: NOW }),
  );
  if (balance > 0n) {
    const topup = await handle.db.transaction((tx) =>
      recordAgentTopup(tx, {
        agentId: agent.id,
        direction: 'in',
        amount: balance,
        method: 'cash',
        adminId: admin,
        now: NOW,
      }),
    );
    await handle.db.transaction((tx) =>
      decideAgentTopup(tx, { topupId: topup.id, decision: 'approve', adminId: finance, now: NOW }),
    );
  }
  return { agent, shop, cashier, shift };
}

const switchCash = (agentId: string, enabled: boolean) =>
  handle.db.transaction((tx) =>
    setAgentPlayerCash(tx, { agentId, enabled, adminId: admin, now: NOW }),
  );

const deposit = (cashier: string, shiftId: string, userId: string, amount: bigint) =>
  handle.db.transaction((tx) =>
    cashDeposit(tx, {
      staffId: cashier,
      shiftId,
      userId,
      amount,
      idempotencyKey: `desk-${randomUUID()}`,
      rules: RULES,
      now: NOW,
    }),
  );

describe('player cash at an agent shop', () => {
  it('is refused while switched off; switched on, the agent balance pays the deposit', async () => {
    const desk = await agentDesk(birr(10_000));
    const { userId } = await createPlayer(handle.db);
    expect(await refusal(deposit(desk.cashier, desk.shift.id, userId, birr(2_000)))).toEqual({
      status: 409,
      code: 'agent_player_cash_off',
    });

    await switchCash(desk.agent.id, true);
    const cashBefore = await getBalance(handle.db, {
      kind: 'house_psp_clearing',
      provider: 'cash',
    });
    const { operation } = await deposit(desk.cashier, desk.shift.id, userId, birr(2_000));
    expect(await cashOf(handle.db, userId)).toBe(birr(2_000));
    expect(await getAgentBalance(handle.db, desk.agent.id)).toBe(birr(8_000));
    // Nahubet's own cash account does not move: the cash is in the agent's drawer.
    expect(await getBalance(handle.db, { kind: 'house_psp_clearing', provider: 'cash' })).toBe(
      cashBefore,
    );
    const [intent] = await handle.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, operation.paymentIntentId!));
    expect(intent).toMatchObject({ provider: 'agent_cash', status: 'succeeded' });

    // Above the balance: refused, nothing moves (another player: the shop's approval threshold
    // counts one player's deposits in the shift).
    const other = (await createPlayer(handle.db)).userId;
    expect(await refusal(deposit(desk.cashier, desk.shift.id, other, birr(8_001)))).toEqual({
      status: 409,
      code: 'agent_balance_low',
    });
    expect(await getAgentBalance(handle.db, desk.agent.id)).toBe(birr(8_000));
  });

  it('a cash withdrawal paid at the agent shop grows the agent balance', async () => {
    const desk = await agentDesk(birr(5_000));
    await switchCash(desk.agent.id, true);
    const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Hana G.' });
    await deposit(desk.cashier, desk.shift.id, userId, birr(1_000));
    expect(await getAgentBalance(handle.db, desk.agent.id)).toBe(birr(4_000));

    const hash = (code: string) => createHash('sha256').update(code).digest('hex');
    await handle.db.transaction((tx) =>
      createCashCode(tx, { userId, codeHash: hash('121212'), now: NOW }),
    );
    const codeId = await checkCashCode(handle.db, {
      userId,
      codeHash: hash('121212'),
      now: NOW,
    });
    const result = await handle.db.transaction((tx) =>
      cashWithdrawal(tx, {
        staffId: desk.cashier,
        shiftId: desk.shift.id,
        userId,
        amount: birr(300),
        idempotencyKey: `desk-${randomUUID()}`,
        code: { id: codeId, hash: hash('121212') },
        rules: RULES,
        now: NOW,
      }),
    );
    if (result.outcome !== 'paid') throw new Error('expected paid');
    expect(await cashOf(handle.db, userId)).toBe(birr(700));
    expect(await getAgentBalance(handle.db, desk.agent.id)).toBe(birr(4_300));
    const [payout] = await handle.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, result.operation.payoutId!));
    expect(payout).toMatchObject({ provider: 'agent_cash', status: 'paid' });
  });

  it('reconciliation is clean after a day of top-ups and player cash at agent shops', async () => {
    const result = await runReconciliationChecks(handle.db, {
      businessDate: businessDateOf(NOW),
      balanceAfterGraceMs: 0,
    });
    expect(result.checks.map((check) => check.check)).toContain('agent_cash_records');
    expect(result.mismatches).toEqual([]);
  });
});
