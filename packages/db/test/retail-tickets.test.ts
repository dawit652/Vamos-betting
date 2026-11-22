import { randomBytes, randomUUID } from 'node:crypto';
import { birr, businessDateOf, serializeRetailTicketLimits } from '@vamos/core';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBetById, settleEventBets } from '../src/betting/index';
import { assignStaffShop, createShop, openShift, shiftTotals } from '../src/cashier/index';
import { runReconciliationChecks } from '../src/compliance/index';
import { DomainError } from '../src/errors';
import { getBalance } from '../src/ledger/index';
import {
  cancelRetailTicket,
  createAgent,
  expireRetailTickets,
  findTicketByNumber,
  payRetailTicket,
  decideAgentTopup,
  getAgentBalance,
  recordAgentTopup,
  resolvePayoutCode,
  sellRetailTicket,
} from '../src/retail/index';
import { adminUsers, agents, cashierShifts, retailTickets, users } from '../src/schema/index';
import type { GameSettings } from '../src/settings/index';
import type { CatalogIds } from '../src/catalog/index';
import {
  createBettingDatabase,
  createEvent,
  finish,
  goLive,
  type TestDb,
} from './betting-fixtures';
import { dropTestDatabase } from './helpers';

/** Shop tickets (docs/plans/agent-shops.md, "Phase 3 design", step 1). */

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

async function staff(role: 'admin' | 'finance' | 'cashier' | 'agent_owner'): Promise<string> {
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

const RETAIL_PAYABLE = { kind: 'house_retail_payable' } as const;
const RETAIL_CASH = { kind: 'house_retail_cash' } as const;
const STAKES = { kind: 'house_stakes' } as const;

/** A cashier with an open shift at a shop; an agent's shop gets `balance` topped up. */
async function counter(options: { balance?: bigint; hq?: boolean; limits?: object } = {}) {
  const agentId = options.hq
    ? (await handle.db.select().from(agents).where(eq(agents.isHouse, true)))[0]!.id
    : (
        await handle.db.transaction((tx) =>
          createAgent(tx, {
            name: `Ticket Agent ${randomUUID().slice(0, 8)}`,
            ownerName: 'Owner Name',
            ownerPhone: '0911223344',
            commissionKind: 'ggr',
            commissionBps: 1_000,
            adminId: admin,
            now: new Date(),
          }),
        )
      ).id;
  if (options.limits !== undefined) {
    await handle.db
      .update(agents)
      .set({ ticketLimits: serializeRetailTicketLimits(options.limits) })
      .where(eq(agents.id, agentId));
  }
  const shop = await handle.db.transaction((tx) =>
    createShop(tx, {
      agentId,
      ...(options.hq ? { code: `tickets-${randomUUID().slice(0, 6)}` } : {}),
      name: 'Ticket Counter',
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
  if (!options.hq && (options.balance ?? 0n) > 0n) {
    const topup = await handle.db.transaction((tx) =>
      recordAgentTopup(tx, {
        agentId,
        direction: 'in',
        amount: options.balance!,
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
  return { agentId, shop, cashier, shift };
}

type Counter = Awaited<ReturnType<typeof counter>>;

/** The payout code printed on each ticket sold here, by ticket number (what the customer holds). */
const printedCodes = new Map<string, string>();

const sell = async (
  desk: Counter,
  stake: bigint,
  legs: Array<{ selectionId: string; oddsMilli: number }>,
  options: { key?: string; now?: Date; staffId?: string } = {},
) => {
  const sold = await handle.db.transaction((tx) =>
    sellRetailTicket(tx, {
      staffId: options.staffId ?? desk.cashier,
      shiftId: desk.shift.id,
      legs,
      stake,
      policy: 'none',
      idempotencyKey: options.key ?? `ticket-${randomUUID()}`,
      settings,
      now: options.now ?? new Date(),
      randomBytes: (n) => randomBytes(n),
    }),
  );
  if (sold.payoutCode !== null) printedCodes.set(sold.bet.shortId, sold.payoutCode);
  return sold;
};

const cancel = (
  ticketId: string,
  actor: { staffId: string; role: 'cashier' | 'owner' | 'admin' },
  now = new Date(),
) => handle.db.transaction((tx) => cancelRetailTicket(tx, { ticketId, actor, now }));

const settle = (eventId: string) =>
  handle.db.transaction((tx) => settleEventBets(tx, eventId, new Date()));

describe('selling a shop ticket', () => {
  it("takes the stake from the agent's balance; the bettor is the agent's counter account", async () => {
    const desk = await counter({ balance: birr(1_000) });
    const event = await createEvent(handle.db, ids);
    const stakesBefore = await getBalance(handle.db, STAKES);
    const key = `ticket-${randomUUID()}`;
    const sold = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }], {
      key,
    });
    expect(sold.replayed).toBe(false);
    expect(sold.ticket).toMatchObject({ status: 'sold', stake: birr(100), shopId: desk.shop.id });
    expect(sold.bet).toMatchObject({ channel: 'shop', status: 'open', stake: birr(100) });
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(900));
    expect(await getBalance(handle.db, STAKES)).toBe(stakesBefore + birr(100));
    const [bettor] = await handle.db.select().from(users).where(eq(users.id, sold.bet.userId));
    const [agent] = await handle.db.select().from(agents).where(eq(agents.id, desk.agentId));
    expect(agent!.counterUserId).toBe(bettor!.id);
    expect(bettor!.phone).toBe(`shop:${agent!.number}`);

    // The same key: the same ticket, nothing taken twice.
    const again = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }], {
      key,
    });
    expect(again).toMatchObject({ replayed: true, ticket: { id: sold.ticket.id } });
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(900));
  });

  it('refuses a stake above the balance, a started match, and limits; nothing is written', async () => {
    const desk = await counter({ balance: birr(200), limits: { maxStake: birr(150) } });
    const event = await createEvent(handle.db, ids);
    expect(
      await refusal(sell(desk, birr(160), [{ selectionId: event.home, oddsMilli: 2000 }])),
    ).toEqual({ status: 422, code: 'slip_invalid' });
    const low = await counter({ balance: birr(50) });
    expect(
      await refusal(sell(low, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }])),
    ).toEqual({ status: 409, code: 'agent_balance_low' });
    expect(await getAgentBalance(handle.db, low.agentId)).toBe(birr(50));

    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    expect(
      await refusal(sell(desk, birr(100), [{ selectionId: live.home, oddsMilli: 2000 }])),
    ).toEqual({ status: 409, code: 'selection_unavailable' });
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(200));
  });

  it("caps the win at the agent's maximum and stops at its sales for the day", async () => {
    const desk = await counter({
      balance: birr(5_000),
      limits: { maxWin: birr(1_000), dailySales: birr(300) },
    });
    const event = await createEvent(handle.db, ids, { odds: { away: 30_000 } });
    const sold = await sell(desk, birr(200), [{ selectionId: event.away, oddsMilli: 30_000 }]);
    expect(sold.bet.potentialGrossPayout).toBe(birr(1_000));
    expect(
      await refusal(sell(desk, birr(150), [{ selectionId: event.home, oddsMilli: 2000 }])),
    ).toEqual({ status: 409, code: 'daily_sales_limit' });
    // A cancelled ticket no longer counts.
    await cancel(sold.ticket.id, { staffId: desk.cashier, role: 'cashier' });
    expect(
      (await sell(desk, birr(150), [{ selectionId: event.home, oddsMilli: 2000 }])).ticket.status,
    ).toBe('sold');
  });
});

describe('cancelling a shop ticket', () => {
  it('the cashier within 5 minutes, the owner later, nobody after kick-off; once only', async () => {
    const desk = await counter({ balance: birr(1_000) });
    const owner = await staff('agent_owner');
    await handle.db.update(agents).set({ ownerStaffId: owner }).where(eq(agents.id, desk.agentId));
    const event = await createEvent(handle.db, ids);
    const soldAt = new Date();
    const first = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }], {
      now: soldAt,
    });
    const second = await sell(desk, birr(100), [{ selectionId: event.draw, oddsMilli: 3200 }], {
      now: soldAt,
    });
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(800));

    // Another cashier never sees it; the seller within the window cancels it.
    const other = await staff('cashier');
    expect(await refusal(cancel(first.ticket.id, { staffId: other, role: 'cashier' }))).toEqual({
      status: 404,
      code: 'not_found',
    });
    const done = await cancel(first.ticket.id, { staffId: desk.cashier, role: 'cashier' });
    expect(done).toMatchObject({ changed: true, ticket: { status: 'cancelled' } });
    expect((await getBetById(handle.db, first.bet.id))?.status).toBe('cancelled');
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(900));
    expect(
      (await cancel(first.ticket.id, { staffId: desk.cashier, role: 'cashier' })).changed,
    ).toBe(false);
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(900));

    // Six minutes later: not the cashier, but the owner.
    const later = new Date(soldAt.getTime() + 6 * 60_000);
    expect(
      await refusal(cancel(second.ticket.id, { staffId: desk.cashier, role: 'cashier' }, later)),
    ).toEqual({ status: 409, code: 'cancel_window_passed' });
    const third = await sell(desk, birr(100), [{ selectionId: event.away, oddsMilli: 3500 }]);
    expect((await cancel(second.ticket.id, { staffId: owner, role: 'owner' }, later)).changed).toBe(
      true,
    );

    // The match went live (even before its scheduled kick-off): it stands, whoever asks.
    await goLive(handle.db, event.eventId);
    expect(await refusal(cancel(third.ticket.id, { staffId: admin, role: 'admin' }))).toEqual({
      status: 409,
      code: 'ticket_match_started',
    });
  });
});

describe('settling shop tickets', () => {
  it('a win waits in retail payable (never a wallet or the balance); void too; a correction reverses it', async () => {
    const desk = await counter({ balance: birr(1_000) });
    const event = await createEvent(handle.db, ids);
    const winner = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    const loser = await sell(desk, birr(100), [{ selectionId: event.away, oddsMilli: 3500 }]);
    const payableBefore = await getBalance(handle.db, RETAIL_PAYABLE);
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    const won = await getBetById(handle.db, winner.bet.id);
    expect(won).toMatchObject({ status: 'won' });
    expect((await getBetById(handle.db, loser.bet.id))?.status).toBe('lost');
    expect(await getBalance(handle.db, RETAIL_PAYABLE)).toBe(
      payableBefore + won!.settledNetPayout!,
    );
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(800));
    expect(await getBalance(handle.db, { kind: 'player_cash', userId: winner.bet.userId })).toBe(
      0n,
    );

    // The result is corrected: the payable goes back exactly.
    await finish(handle.db, event.eventId, 0, 1);
    await settle(event.eventId);
    expect((await getBetById(handle.db, winner.bet.id))?.status).toBe('lost');
    const backAt = await getBalance(handle.db, RETAIL_PAYABLE);
    const loserNow = await getBetById(handle.db, loser.bet.id);
    expect(backAt).toBe(payableBefore + loserNow!.settledNetPayout!);

    const voided = await createEvent(handle.db, ids);
    const refund = await sell(desk, birr(50), [{ selectionId: voided.home, oddsMilli: 2000 }]);
    const before = await getBalance(handle.db, RETAIL_PAYABLE);
    await handle.db.transaction(async (tx) => {
      const { resultEvent } = await import('../src/catalog/index');
      await resultEvent(tx, voided.eventId, { status: 'cancelled' });
    });
    await settle(voided.eventId);
    expect((await getBetById(handle.db, refund.bet.id))?.status).toBe('void');
    expect(await getBalance(handle.db, RETAIL_PAYABLE)).toBe(before + birr(50));
  });
});

describe('paying shop tickets (phase 4)', () => {
  const pay = (
    desk: Counter,
    number: string,
    key = `payout-${randomUUID()}`,
    staffId?: string,
    code?: string | null,
  ) =>
    handle.db.transaction((tx) =>
      payRetailTicket(tx, {
        number,
        staffId: staffId ?? desk.cashier,
        shiftId: desk.shift.id,
        idempotencyKey: key,
        // The customer says the code printed on their ticket (unless the test says otherwise).
        payoutCode:
          code === undefined
            ? (printedCodes.get(number.toUpperCase().replace(/\s/g, '')) ?? null)
            : code,
        now: new Date(),
      }),
    );

  it("pays a winner once at the shop that sold it, into the agent's balance", async () => {
    const desk = await counter({ balance: birr(1_000) });
    const event = await createEvent(handle.db, ids);
    const winner = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    const loser = await sell(desk, birr(100), [{ selectionId: event.away, oddsMilli: 3500 }]);
    expect(await refusal(pay(desk, winner.bet.shortId))).toEqual({
      status: 409,
      code: 'ticket_not_payable',
    });
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    const found = await findTicketByNumber(handle.db, winner.bet.shortId.toLowerCase());
    expect(found).toMatchObject({ state: 'payable' });
    const net = found!.amount;
    expect(await refusal(pay(desk, loser.bet.shortId))).toEqual({
      status: 409,
      code: 'ticket_not_payable',
    });

    // Another shop of another agent: not here.
    const elsewhere = await counter({ balance: birr(100) });
    expect(await refusal(pay(elsewhere, winner.bet.shortId))).toEqual({
      status: 409,
      code: 'ticket_other_shop',
    });

    const payableBefore = await getBalance(handle.db, RETAIL_PAYABLE);
    const key = `payout-${randomUUID()}`;
    const paid = await pay(desk, winner.bet.shortId, key);
    expect(paid).toMatchObject({ outcome: 'paid', amount: net, replayed: false });
    expect(await getBalance(handle.db, RETAIL_PAYABLE)).toBe(payableBefore - net);
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(800) + net);
    expect((await pay(desk, winner.bet.shortId, key)).outcome).toBe('paid');
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(800) + net);
    expect(await refusal(pay(desk, winner.bet.shortId))).toEqual({
      status: 409,
      code: 'ticket_not_payable',
    });
    const [shift] = await handle.db
      .select()
      .from(cashierShifts)
      .where(eq(cashierShifts.id, desk.shift.id));
    const totals = await shiftTotals(handle.db, shift!);
    expect(totals.tickets).toMatchObject({ paidCount: 1, paid: net });
    expect(totals.expectedCash).toBe(birr(500) + birr(200) - net);

    // A correction after the payout is blocked for the paid ticket (the money left with its
    // holder); the other ticket, now a winner, owes its payout as usual.
    await finish(handle.db, event.eventId, 0, 1);
    await settle(event.eventId);
    expect((await getBetById(handle.db, winner.bet.id))?.status).toBe('won');
    const nowWinning = await findTicketByNumber(handle.db, loser.bet.shortId);
    expect(nowWinning?.state).toBe('payable');
    expect(await getBalance(handle.db, RETAIL_PAYABLE)).toBe(
      payableBefore - net + nowWinning!.amount,
    );
  });

  it('the cashier pays a big win alone: no HQ approval (owner, 21 Nov 2026)', async () => {
    // An old per-agent "HQ approval above" limit is ignored.
    const desk = await counter({ balance: birr(5_000), limits: { hqApprovalAbove: birr(50) } });
    const event = await createEvent(handle.db, ids);
    const winner = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    const asked = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    await finish(handle.db, event.eventId, 1, 0);
    await settle(event.eventId);
    expect((await findTicketByNumber(handle.db, winner.bet.shortId))?.state).toBe('payable');
    expect((await pay(desk, winner.bet.shortId)).outcome).toBe('paid');
    // A ticket whose approval was asked for before the rule changed is payable as well.
    await handle.db
      .update(retailTickets)
      .set({ approvalRequestedAt: new Date(), approvalRequestedBy: desk.cashier })
      .where(eq(retailTickets.id, asked.ticket.id));
    expect((await findTicketByNumber(handle.db, asked.bet.shortId))?.state).toBe('payable');
    expect((await pay(desk, asked.bet.shortId)).outcome).toBe('paid');
  });

  it('asks for the payout code printed at sale; five wrong ones lock the ticket until HQ unlocks it', async () => {
    const desk = await counter({ balance: birr(1_000) });
    const event = await createEvent(handle.db, ids);
    const key = `ticket-${randomUUID()}`;
    const winner = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }], {
      key,
    });
    // Printed once: 6 digits, stored only as a salted hash; a replay of the sale shows none.
    expect(winner.payoutCode).toMatch(/^[1-9]\d{5}$/);
    const [row] = await handle.db
      .select()
      .from(retailTickets)
      .where(eq(retailTickets.id, winner.ticket.id));
    expect(row!.payoutCodeHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(row!.payoutCodeHash).not.toContain(winner.payoutCode!);
    const replay = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }], {
      key,
    });
    expect(replay).toMatchObject({ replayed: true, payoutCode: null });
    await finish(handle.db, event.eventId, 1, 0);
    await settle(event.eventId);
    const number = winner.bet.shortId;
    const code = winner.payoutCode!;
    const wrong = code === '999999' ? '111111' : '999999';

    expect(await refusal(pay(desk, number, undefined, undefined, null))).toEqual({
      status: 409,
      code: 'payout_code_required',
    });
    // A wrong code is counted although nothing is paid (the count is committed).
    for (let left = 4; left >= 1; left -= 1) {
      expect(await pay(desk, number, undefined, undefined, wrong)).toEqual({
        outcome: 'payout_code_wrong',
        attemptsLeft: left,
        locked: false,
      });
    }
    expect(await pay(desk, number, undefined, undefined, wrong)).toEqual({
      outcome: 'payout_code_wrong',
      attemptsLeft: 0,
      locked: true,
    });
    // Locked: even the right code is refused now, and nothing was paid.
    expect(await refusal(pay(desk, number, undefined, undefined, code))).toEqual({
      status: 409,
      code: 'payout_code_locked',
    });
    expect(await getAgentBalance(handle.db, desk.agentId)).toBe(birr(900));

    // HQ unlocks (a reason is required): the code is still asked for.
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          resolvePayoutCode(tx, {
            ticketId: winner.ticket.id,
            action: 'unlock',
            reason: '',
            staffId: admin,
            now: new Date(),
          }),
        ),
      ),
    ).toEqual({ status: 422, code: 'reason_required' });
    await handle.db.transaction((tx) =>
      resolvePayoutCode(tx, {
        ticketId: winner.ticket.id,
        action: 'unlock',
        reason: 'Customer mistyped, came to HQ',
        staffId: admin,
        now: new Date(),
      }),
    );
    expect(await pay(desk, number, undefined, undefined, wrong)).toMatchObject({
      outcome: 'payout_code_wrong',
      attemptsLeft: 4,
    });
    // The right code, as the customer says it ("482 913"), pays.
    const spoken = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(await pay(desk, number, undefined, undefined, spoken)).toMatchObject({
      outcome: 'paid',
    });
  });

  it('a lost paper: HQ waives the code after checking an ID; a ticket sold before codes needs none', async () => {
    const desk = await counter({ balance: birr(1_000) });
    const event = await createEvent(handle.db, ids);
    const lostPaper = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    const older = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    // As if sold before migration 0081: no hash.
    await handle.db
      .update(retailTickets)
      .set({ payoutCodeHash: null })
      .where(eq(retailTickets.id, older.ticket.id));
    await finish(handle.db, event.eventId, 1, 0);
    await settle(event.eventId);
    expect(await pay(desk, older.bet.shortId, undefined, undefined, null)).toMatchObject({
      outcome: 'paid',
    });
    expect(await refusal(pay(desk, lostPaper.bet.shortId, undefined, undefined, null))).toEqual({
      status: 409,
      code: 'payout_code_required',
    });
    await handle.db.transaction((tx) =>
      resolvePayoutCode(tx, {
        ticketId: lostPaper.ticket.id,
        action: 'waive',
        reason: 'Paper lost; ID checked at HQ',
        staffId: admin,
        now: new Date(),
      }),
    );
    expect(await pay(desk, lostPaper.bet.shortId, undefined, undefined, null)).toMatchObject({
      outcome: 'paid',
    });
    // Nothing to unlock on a paid ticket.
    expect(
      await refusal(
        handle.db.transaction((tx) =>
          resolvePayoutCode(tx, {
            ticketId: lostPaper.ticket.id,
            action: 'unlock',
            reason: 'too late',
            staffId: admin,
            now: new Date(),
          }),
        ),
      ),
    ).toEqual({ status: 409, code: 'ticket_not_payable' });
  });

  it('a winner not paid within the expiry days expires into revenue', async () => {
    const desk = await counter({ balance: birr(1_000), limits: { expiryDays: 1 } });
    const kickoff = new Date(Date.now() + 3 * 3600_000);
    const event = await createEvent(handle.db, ids, { startTime: kickoff });
    const winner = await sell(desk, birr(100), [{ selectionId: event.home, oddsMilli: 2000 }]);
    await finish(handle.db, event.eventId, 3, 0);
    await settle(event.eventId);
    const net = (await findTicketByNumber(handle.db, winner.bet.shortId))!.amount;
    const payable = await getBalance(handle.db, RETAIL_PAYABLE);
    const soon = await handle.db.transaction((tx) => expireRetailTickets(tx, { now: new Date() }));
    expect(soon).toBe(0);
    const later = new Date(kickoff.getTime() + 2 * 86_400_000);
    expect(await handle.db.transaction((tx) => expireRetailTickets(tx, { now: later }))).toBe(1);
    expect((await findTicketByNumber(handle.db, winner.bet.shortId))?.state).toBe('expired');
    expect(await getBalance(handle.db, RETAIL_PAYABLE)).toBe(payable - net);
    expect(await refusal(pay(desk, winner.bet.shortId))).toEqual({
      status: 409,
      code: 'ticket_not_payable',
    });
  });
});

describe('the drawer, HQ shops and reconciliation', () => {
  it("counts tickets in the shift's expected cash; an HQ shop sells from its retail cash", async () => {
    const hq = await counter({ hq: true });
    const event = await createEvent(handle.db, ids);
    const cashBefore = await getBalance(handle.db, RETAIL_CASH);
    const sold = await sell(hq, birr(120), [{ selectionId: event.home, oddsMilli: 2000 }]);
    await sell(hq, birr(80), [{ selectionId: event.draw, oddsMilli: 3200 }]);
    expect(await getBalance(handle.db, RETAIL_CASH)).toBe(cashBefore - birr(200));
    await cancel(sold.ticket.id, { staffId: hq.cashier, role: 'cashier' });
    expect(await getBalance(handle.db, RETAIL_CASH)).toBe(cashBefore - birr(80));
    const [shift] = await handle.db
      .select()
      .from(cashierShifts)
      .where(eq(cashierShifts.id, hq.shift.id));
    const totals = await shiftTotals(handle.db, shift!);
    expect(totals.tickets).toEqual({
      soldCount: 2,
      sold: birr(200),
      cancelledCount: 1,
      cancelled: birr(120),
      paidCount: 0,
      paid: 0n,
    });
    expect(totals.expectedCash).toBe(birr(500) + birr(80));
  });

  it('any order of sales and cancels keeps the balance and the stakes in step', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ birr: fc.integer({ min: 5, max: 300 }), cancel: fc.boolean() }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (steps) => {
          const desk = await counter({ balance: birr(1_000) });
          const event = await createEvent(handle.db, ids);
          let expected = birr(1_000);
          for (const step of steps) {
            const stake = birr(step.birr);
            if (stake > expected) {
              expect(
                (await refusal(sell(desk, stake, [{ selectionId: event.home, oddsMilli: 2000 }])))
                  .code,
              ).toBe('agent_balance_low');
              continue;
            }
            const sold = await sell(desk, stake, [{ selectionId: event.home, oddsMilli: 2000 }]);
            expected -= stake;
            if (step.cancel) {
              await cancel(sold.ticket.id, { staffId: desk.cashier, role: 'cashier' });
              expected += stake;
            }
            expect(await getAgentBalance(handle.db, desk.agentId)).toBe(expected);
          }
        },
      ),
      { numRuns: 6 },
    );
  });

  it('reconciliation is clean after a day of selling, cancelling and settling', async () => {
    const result = await runReconciliationChecks(handle.db, {
      businessDate: businessDateOf(new Date()),
      balanceAfterGraceMs: 0,
    });
    const names = result.checks.map((check) => check.check);
    expect(names).toEqual(expect.arrayContaining(['retail_payable', 'retail_cash']));
    expect(result.mismatches).toEqual([]);
  });
});
