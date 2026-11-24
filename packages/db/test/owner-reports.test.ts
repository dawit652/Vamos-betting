import { randomBytes, randomUUID } from 'node:crypto';
import {
  addReportTotals,
  birr,
  reportTotalsOfPostings,
  summarizeReport,
  type ReportPosting,
} from '@vamos/core';
import { eq, gte, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignStaffShop,
  changedReportDays,
  closeReportDay,
  createAgent,
  createShop,
  decideAgentTopup,
  getOwnerReport,
  loadReportTotalsByDay,
  openShift,
  postTransaction,
  recordAgentTopup,
  sellRetailTicket,
  settleEventBets,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import {
  adminUsers,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  retailTickets,
} from '../src/schema/index';
import {
  cancel,
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
} from './betting-fixtures';
import { dropTestDatabase } from './helpers';
import { createPlayer, depositViaMock } from './payments-fixtures';

/**
 * Owner reports (docs/plans/owner-reports.md): the database groups real postings exactly as core's
 * reference does, a period is the sum of its days cut at midnight in Addis Ababa, and a closed day
 * that changes afterwards is caught.
 */

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
}, 60_000);

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

const SHOP_TYPES = new Set([
  'retail_ticket_cancel',
  'retail_ticket_payout',
  'retail_ticket_expiry',
  'agent_topup',
  'agent_take_back',
]);

/** Every posting since `start`, read raw, as core's reference input. */
async function rawPostings(start: Date): Promise<ReportPosting[]> {
  const txs = await handle.db
    .select()
    .from(ledgerTransactions)
    .where(gte(ledgerTransactions.createdAt, start));
  if (txs.length === 0) return [];
  const entries = await handle.db
    .select({
      tx: ledgerEntries.transactionId,
      amount: ledgerEntries.amount,
      kind: ledgerAccounts.kind,
      provider: ledgerAccounts.provider,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      inArray(
        ledgerEntries.transactionId,
        txs.map((t) => t.id),
      ),
    );
  const shopBets = new Set(
    (await handle.db.select({ betId: retailTickets.betId }).from(retailTickets)).map(
      (r) => r.betId,
    ),
  );
  const allTypes = new Map(
    (
      await handle.db
        .select({ key: ledgerTransactions.idempotencyKey, type: ledgerTransactions.type })
        .from(ledgerTransactions)
    ).map((t) => [t.key, t.type]),
  );
  return txs.map((t) => ({
    type: t.type,
    idempotencyKey: t.idempotencyKey,
    reversedType:
      t.type === 'settlement_reversal'
        ? (allTypes.get(`settle:${t.idempotencyKey.slice('reverse:'.length)}`) ?? null)
        : null,
    channel:
      SHOP_TYPES.has(t.type) || (t.refType === 'bet' && t.refId !== null && shopBets.has(t.refId))
        ? 'shop'
        : 'online',
    entries: entries
      .filter((e) => e.tx === t.id)
      .map((e) => ({ kind: e.kind, provider: e.provider, amount: e.amount })),
  }));
}

/** A deposit posted at `at` (Ethiopian midnight tests). */
const depositAt = (amount: bigint, at: Date) =>
  createPlayer(handle.db).then(({ userId }) =>
    handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'deposit',
        idempotencyKey: `deposit:test-${randomUUID()}`,
        createdAt: at,
        entries: [
          { account: { kind: 'house_psp_clearing', provider: 'chapa' }, amount: -amount },
          { account: { kind: 'player_cash', userId }, amount },
        ],
      }),
    ),
  );

describe('owner reports from the ledger', () => {
  it('groups real postings (bets, a void, a deposit, a shop ticket, a top-up) exactly as core does', async () => {
    const start = new Date(
      Number(
        (
          await handle.db.execute<{ ms: string }>(
            sql`SELECT (floor(extract(epoch FROM now()) * 1000) - 1000)::bigint::text AS ms`,
          )
        ).rows[0]!.ms,
      ),
    );
    const { userId } = await createPlayer(handle.db, { kyc: 'verified' });
    await depositViaMock(handle.db, userId, birr(1000), { now: new Date() });
    const won = await createEvent(handle.db, ids, { odds: { home: 2000 } });
    const voided = await createEvent(handle.db, ids);
    const open = await createEvent(handle.db, ids);
    await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: won.home, oddsMilli: 2000 }],
      settings,
    });
    await place(handle.db, userId, {
      stake: birr(50),
      legs: [{ selectionId: won.away, oddsMilli: 3000 }],
      policy: 'any',
      settings,
    });
    await place(handle.db, userId, {
      stake: birr(30),
      legs: [{ selectionId: voided.home, oddsMilli: 2000 }],
      settings,
    });
    await finish(handle.db, won.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, won.eventId, new Date()));
    await cancel(handle.db, voided.eventId);
    await handle.db.transaction((tx) => settleEventBets(tx, voided.eventId, new Date()));

    // A shop: an agent topped up (four eyes), a cashier sells one ticket.
    const admin = await staff('admin');
    const finance = await staff('finance');
    const agent = await handle.db.transaction((tx) =>
      createAgent(tx, {
        name: `Report Agent ${randomUUID().slice(0, 8)}`,
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
        name: 'Report Counter',
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
      openShift(tx, {
        staffId: cashier,
        shopId: shop.id,
        openingFloat: birr(500),
        now: new Date(),
      }),
    );
    const topup = await handle.db.transaction((tx) =>
      recordAgentTopup(tx, {
        agentId: agent.id,
        direction: 'in',
        amount: birr(500),
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
    await handle.db.transaction((tx) =>
      sellRetailTicket(tx, {
        staffId: cashier,
        shiftId: shift.id,
        legs: [{ selectionId: open.home, oddsMilli: 2000 }],
        stake: birr(20),
        policy: 'none',
        idempotencyKey: `ticket-${randomUUID()}`,
        settings,
        now: new Date(),
        randomBytes: (n) => randomBytes(n),
      }),
    );

    const fromSql = addReportTotals(
      ...(await loadReportTotalsByDay(handle.db, { start, end: null })).values(),
    );
    expect(fromSql).toEqual(reportTotalsOfPostings(await rawPostings(start)));

    const f = summarizeReport(fromSql);
    expect(f.online).toMatchObject({ bets: 3, stakes: birr(180), refunds: birr(30) });
    expect(f.online.payouts).toBe(f.online.wonPayouts + f.online.refunds + f.online.cashOuts);
    expect(f.online.ggr).toBe(f.online.stakes - f.online.payouts);
    expect(f.online.wonPayouts).toBeGreaterThan(0n);
    expect(f.shop).toMatchObject({ bets: 1, stakes: birr(20), agentTopups: birr(500) });
    expect(f.deposits.byProvider).toEqual([{ provider: 'mock', amount: birr(1000), count: 1 }]);
  }, 60_000);

  it('cuts days at midnight in Addis Ababa, and a week, a month and a year are the sum of their days', async () => {
    // 31 Jan 2026 23:59:59 and 1 Feb 2026 00:00:00 in Addis Ababa (UTC+3).
    await depositAt(birr(100), new Date('2026-01-31T20:59:59Z'));
    await depositAt(birr(200), new Date('2026-01-31T21:00:00Z'));
    const now = new Date();
    const report = (period: 'day' | 'week' | 'month' | 'year', date: string) =>
      getOwnerReport(handle.db, { period, date, now });

    expect((await report('day', '2026-01-31')).figures.deposits.total).toBe(birr(100));
    expect((await report('day', '2026-02-01')).figures.deposits.total).toBe(birr(200));
    expect((await report('month', '2026-01-15')).figures.deposits.total).toBe(birr(100));
    expect((await report('month', '2026-02-15')).figures.deposits.total).toBe(birr(200));
    // 31 Jan 2026 is a Saturday: its week runs from Monday 26 Jan to Sunday 1 Feb.
    const week = await report('week', '2026-01-31');
    expect(week.window).toMatchObject({ firstDay: '2026-01-26', lastDay: '2026-02-01' });
    expect(week.figures.deposits.total).toBe(birr(300));

    // The year's rows are exactly the twelve months' rows added up.
    const year = await report('year', '2026-06-01');
    const months = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        report('month', `2026-${String(i + 1).padStart(2, '0')}-01`),
      ),
    );
    expect(year.totals).toEqual(addReportTotals(...months.map((m) => m.totals)));
    for (const check of year.checks.filter((c) => c.id !== 'balances_roll_forward')) {
      expect(check, check.id).toMatchObject({ ok: true });
    }
  });

  it('a closed day is written once; a posting back-dated into it afterwards is caught', async () => {
    const now = new Date();
    await expect(closeReportDay(handle.db, { date: '2099-01-01', now })).rejects.toThrow(
      RangeError,
    );

    const first = await closeReportDay(handle.db, { date: '2026-01-31', now });
    expect(first).toMatchObject({
      closedNow: true,
      checks: { balanced: true, everyPostingBalanced: true, rollForward: null },
    });
    const second = await closeReportDay(handle.db, { date: '2026-02-01', now });
    expect(second.checks).toEqual({
      balanced: true,
      everyPostingBalanced: true,
      rollForward: true,
    });
    expect((await closeReportDay(handle.db, { date: '2026-01-31', now })).closedNow).toBe(false);

    const day = await getOwnerReport(handle.db, { period: 'day', date: '2026-02-01', now });
    expect(day.checks.every((c) => c.ok)).toBe(true);
    expect(day.days).toEqual([{ date: '2026-02-01', closed: true, changed: false }]);
    const week = await getOwnerReport(handle.db, { period: 'week', date: '2026-01-31', now });
    expect(
      week.checks.every((c) => c.ok),
      JSON.stringify(week.checks),
    ).toBe(true);

    // Someone back-dates a deposit into 31 January after it was closed.
    await depositAt(birr(7), new Date('2026-01-31T09:00:00Z'));
    expect(await changedReportDays(handle.db, { from: '2026-01-31', to: '2026-02-01' })).toEqual([
      '2026-01-31',
    ]);
    const changed = await getOwnerReport(handle.db, { period: 'day', date: '2026-01-31', now });
    expect(changed.checks.find((c) => c.id === 'unchanged_since_close')).toMatchObject({
      ok: false,
      detail: 'changed after their close: 2026-01-31',
    });
    expect(changed.days).toEqual([{ date: '2026-01-31', closed: true, changed: true }]);
    // The month no longer rolls forward to the closed balances either.
    const month = await getOwnerReport(handle.db, { period: 'month', date: '2026-01-10', now });
    expect(month.checks.find((c) => c.id === 'balances_roll_forward')?.ok).toBe(false);
  }, 60_000);
});
