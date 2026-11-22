import { randomBytes, randomUUID } from 'node:crypto';
import { birr, businessDateOf, businessDayWindow, businessWeekStartOf } from '@vamos/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settleEventBets } from '../src/betting/index';
import { assignStaffShop, createShop, openShift } from '../src/cashier/index';
import { DomainError } from '../src/errors';
import {
  cancelRetailTicket,
  computeAgentWeek,
  createAgent,
  decideAgentTopup,
  findTicketByNumber,
  generateAgentStatements,
  lastStatementWeek,
  listAgentStatements,
  listMonitorAgentDays,
  listMonitorTickets,
  markAgentStatementPaid,
  payRetailTicket,
  recordAgentTopup,
  sellRetailTicket,
} from '../src/retail/index';
import { adminUsers, agents, auditLog } from '../src/schema/index';
import type { CatalogIds } from '../src/catalog/index';
import type { GameSettings } from '../src/settings/index';
import { createBettingDatabase, createEvent, finish, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';

/** Agents' weekly statements (docs/plans/agent-shops.md, "Phase 5 design", step 1). */

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

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The database's own message of a refused query (drizzle wraps it in `cause`). */
async function dbRefusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error('expected the database to refuse');
}

/** An agent with a prepaid balance, one shop, a cashier and an open shift. */
async function counter(balance: bigint) {
  const agent = await handle.db.transaction((tx) =>
    createAgent(tx, {
      name: `Statement Agent ${randomUUID().slice(0, 8)}`,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId: admin,
      now: new Date(),
    }),
  );
  const shop = await handle.db.transaction((tx) =>
    createShop(tx, {
      agentId: agent.id,
      name: 'Statement Counter',
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
    openShift(tx, { staffId: cashier, shopId: shop.id, openingFloat: birr(500), now: new Date() }),
  );
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
  return { agentId: agent.id, shop, cashier, shift };
}

type Counter = Awaited<ReturnType<typeof counter>>;

const sell = (desk: Counter, stake: bigint, selectionId: string, oddsMilli: number) =>
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

describe("an agent's week", () => {
  it('counts sales, cancels, settled stakes and payouts (GGR), counter payouts and the balance', async () => {
    const desk = await counter(birr(1_000));
    const week = businessWeekStartOf(new Date());
    const match = await createEvent(handle.db, ids);
    const other = await createEvent(handle.db, ids);
    const winner = await sell(desk, birr(10), match.home, 2000);
    await sell(desk, birr(5), match.away, 3500);
    const cancelled = await sell(desk, birr(6), other.home, 2000);
    await handle.db.transaction((tx) =>
      cancelRetailTicket(tx, {
        ticketId: cancelled.ticket.id,
        actor: { staffId: desk.cashier, role: 'cashier' },
        now: new Date(),
      }),
    );
    await finish(handle.db, match.eventId, 2, 1);
    await handle.db.transaction((tx) => settleEventBets(tx, match.eventId, new Date()));
    const found = await findTicketByNumber(handle.db, winner.bet.shortId.toLowerCase());
    const net = found!.amount;
    await handle.db.transaction((tx) =>
      payRetailTicket(tx, {
        number: winner.bet.shortId,
        staffId: desk.cashier,
        shiftId: desk.shift.id,
        idempotencyKey: `payout-${randomUUID()}`,
        // The code printed on the customer's ticket.
        payoutCode: winner.payoutCode,
        now: new Date(),
      }),
    );

    const figures = await computeAgentWeek(handle.db, desk.agentId, week);
    expect(figures).toMatchObject({
      ticketsSold: 3,
      soldStakes: birr(21),
      ticketsCancelled: 1,
      cancelledStakes: birr(6),
      ticketsSettled: 2,
      settledStakes: birr(15),
      settledPayouts: birr(20),
      ggr: -birr(5),
      ticketsPaid: 1,
      paidAmount: net,
      ticketsExpired: 0,
      expiredAmount: 0n,
      playerDeposits: 0,
      playerCashIn: 0n,
      balanceStart: 0n,
      // 1000 topped up - 21 sold + 6 cancelled + the winner paid at the counter.
      balanceEnd: birr(1_000) - birr(21) + birr(6) + net,
    });

    // The week's statement once it closed: the figures and the commission are fixed then.
    await handle.db
      .update(agents)
      .set({ commissionKind: 'stake', commissionBps: 500 })
      .where(eq(agents.id, desk.agentId));
    const afterTheWeek = new Date(Date.now() + 8 * 24 * 3_600_000);
    const made = await handle.db.transaction((tx) =>
      generateAgentStatements(tx, { weekStart: week, now: afterTheWeek }),
    );
    expect(made.created).toBeGreaterThanOrEqual(1);
    const again = await handle.db.transaction((tx) =>
      generateAgentStatements(tx, { weekStart: week, now: afterTheWeek }),
    );
    expect(again.created).toBe(0);
    const [statement] = await listAgentStatements(handle.db, { agentId: desk.agentId, limit: 5 });
    expect(statement).toMatchObject({
      weekStart: week,
      ...figures,
      commissionKind: 'stake',
      commissionBps: 500,
      // (21 - 6) birr x 5% = 75 santim.
      commission: 75n,
      paidAt: null,
    });

    // A statement's figures never change; its payment is recorded once.
    expect(
      await dbRefusal(
        handle.db.execute(
          sql`UPDATE agent_statements SET commission = 0 WHERE id = ${statement!.id}`,
        ),
      ),
    ).toMatch(/fixed/);
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          markAgentStatementPaid(tx, {
            statementId: statement!.id,
            reference: 'x',
            adminId: admin,
            now: new Date(),
          }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_reference' });
    const paid = await handle.db.transaction((tx) =>
      markAgentStatementPaid(tx, {
        statementId: statement!.id,
        reference: 'CBE-TRX-20261123-01',
        adminId: admin,
        now: new Date(),
      }),
    );
    expect(paid).toMatchObject({ paidBy: admin, paidReference: 'CBE-TRX-20261123-01' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          markAgentStatementPaid(tx, {
            statementId: statement!.id,
            reference: 'second time',
            adminId: admin,
            now: new Date(),
          }),
        ),
      ),
    ).toEqual({ status: 409, code: 'statement_already_paid' });
    expect(
      await dbRefusal(
        handle.db.execute(
          sql`UPDATE agent_statements SET paid_reference = 'changed' WHERE id = ${statement!.id}`,
        ),
      ),
    ).toMatch(/fixed/);
    const audit = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent.statement_paid'));
    expect(audit.some((row) => row.targetId === desk.agentId)).toBe(true);
  });

  it('is made only for a closed week, never for Nahubet HQ', async () => {
    const week = businessWeekStartOf(new Date());
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          generateAgentStatements(tx, { weekStart: week, now: new Date() }),
        ),
      ),
    ).toEqual({ status: 409, code: 'week_not_closed' });
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          generateAgentStatements(tx, { weekStart: '2026-11-17', now: new Date() }),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_week' });
    const [hq] = await handle.db.select().from(agents).where(eq(agents.isHouse, true));
    expect(await listAgentStatements(handle.db, { agentId: hq!.id, limit: 5 })).toEqual([]);
  });
});

describe('the week a statement is due for', () => {
  it('is the last week that closed at least an hour ago (Monday 01:00 Addis Ababa time)', () => {
    // Monday 23 Nov 00:30 Addis: the week of 16 Nov closed 30 minutes ago, not yet due.
    expect(lastStatementWeek(new Date('2026-11-22T21:30:00.000Z'))).toBe('2026-11-09');
    // Monday 23 Nov 01:00 Addis: due.
    expect(lastStatementWeek(new Date('2026-11-22T22:00:00.000Z'))).toBe('2026-11-16');
    expect(lastStatementWeek(new Date('2026-11-26T12:00:00.000Z'))).toBe('2026-11-16');
  });
});

describe('the live monitor', () => {
  it("lists the newest tickets with their shop and cashier, and each agent's day", async () => {
    const desk = await counter(birr(500));
    const match = await createEvent(handle.db, ids);
    const first = await sell(desk, birr(10), match.home, 2000);
    const second = await sell(desk, birr(7), match.away, 3500);
    await handle.db.transaction((tx) =>
      cancelRetailTicket(tx, {
        ticketId: second.ticket.id,
        actor: { staffId: desk.cashier, role: 'cashier' },
        now: new Date(),
      }),
    );
    const tickets = await listMonitorTickets(handle.db, { agentId: desk.agentId, limit: 10 });
    expect(tickets.map((t) => t.id)).toEqual([second.ticket.id, first.ticket.id]);
    expect(tickets[1]).toMatchObject({
      number: first.bet.shortId,
      shopLabel: desk.shop.code,
      stake: birr(10),
      possibleWin: first.bet.potentialNetPayout,
      status: 'sold',
    });
    expect(tickets[0]!.status).toBe('cancelled');
    expect(await listMonitorTickets(handle.db, { staffId: desk.cashier, limit: 1 })).toHaveLength(
      1,
    );

    const days = await listMonitorAgentDays(
      handle.db,
      businessDayWindow(businessDateOf(new Date())),
    );
    expect(days.find((d) => d.agentId === desk.agentId)).toEqual({
      agentId: desk.agentId,
      ticketsSold: 2,
      soldStakes: birr(17),
      ticketsCancelled: 1,
      cancelledStakes: birr(7),
      ticketsPaid: 0,
      paidAmount: 0n,
    });
  });
});
