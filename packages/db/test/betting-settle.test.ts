import { birr } from '@vamos/core';
import { and, count, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORRECTION_RETRY_DELAY_MS,
  getBetById,
  listBetsToSettle,
  postTransaction,
  settleEventBets,
  settlePlacedBet,
  type CatalogIds,
  type GameSettings,
  type UserBet,
} from '../src/index';
import {
  auditLog,
  betLegs,
  bets,
  ledgerAccounts,
  ledgerTransactions,
  outboxEvents,
} from '../src/schema/index';
import {
  balances,
  cancel,
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
} from './betting-fixtures';
import { cash, createUser, dropTestDatabase, fund, pgCode, sleep, uniqueKey } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function player(amount = birr(10_000)): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, amount);
  return userId;
}

const settle = (eventId: string) =>
  handle.db.transaction((tx) => settleEventBets(tx, eventId, new Date()));

async function bet(id: string): Promise<UserBet> {
  const row = await getBetById(handle.db, id);
  if (row === null) throw new Error(`no bet ${id}`);
  return row;
}

/** Ledger transactions of a bet, oldest first: [type, idempotency key prefix]. */
async function postingsOf(betId: string) {
  const rows = await handle.db
    .select({ type: ledgerTransactions.type, key: ledgerTransactions.idempotencyKey })
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refType, 'bet'), eq(ledgerTransactions.refId, betId)))
    .orderBy(ledgerTransactions.createdAt, ledgerTransactions.idempotencyKey);
  return rows.map((row) => [row.type, row.key.replace(betId, 'ID').replace(/^bet:.*$/, 'bet:…')]);
}

async function outboxTypes(betId: string): Promise<string[]> {
  const rows = await handle.db
    .select({ type: outboxEvents.type })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, betId))
    .orderBy(outboxEvents.id);
  return rows.map((row) => row.type);
}

/** The player spends (here: withdraws) `amount` of their cash. */
async function withdraw(userId: string, amount: bigint): Promise<void> {
  await handle.db.transaction((tx) =>
    postTransaction(tx, {
      type: 'withdrawal',
      idempotencyKey: uniqueKey('withdraw'),
      entries: [
        { account: cash(userId), amount: -amount },
        { account: { kind: 'house_demo_funding' }, amount },
      ],
    }),
  );
}

const settleBet = (betId: string, now = new Date()) =>
  handle.db.transaction((tx) => settlePlacedBet(tx, betId, now));

async function betRow(betId: string) {
  const [row] = await handle.db.select().from(bets).where(eq(bets.id, betId));
  if (row === undefined) throw new Error(`no bet ${betId}`);
  return row;
}

type Balances = Awaited<ReturnType<typeof balances>>;
function delta(before: Balances, after: Balances) {
  return {
    cash: after.cash - before.cash,
    stakes: after.stakes - before.stakes,
    revenue: after.revenue - before.revenue,
    tax: after.tax - before.tax,
  };
}

describe('settlement outcomes', () => {
  it('won single: net to the player, tax withheld, winnings out of revenue', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    const before = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 2, 1);
    const summary = await settle(event.eventId);
    expect(summary).toMatchObject({ bets: 1, outcomes: { settled: 1 }, pendingAcceptance: 0 });

    const settled = await bet(placed.bet.id);
    expect(settled).toMatchObject({
      status: 'won',
      settlementVersion: 0,
      settledGrossPayout: birr(200),
      settledTax: birr(20),
      settledNetPayout: birr(180),
    });
    expect(settled.settledAt).toBeInstanceOf(Date);
    expect(settled.legs[0]?.state).toBe('won');
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: birr(180),
      stakes: -birr(100),
      revenue: -birr(100),
      tax: birr(20),
    });
    expect(await postingsOf(placed.bet.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_payout', 'settle:ID:0'],
    ]);
    expect(await outboxTypes(placed.bet.id)).toEqual(['bet.placed', 'bet.settled']);
  });

  it('lost single: the stake moves to revenue (a bet_payout of nothing)', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(50),
      legs: [{ selectionId: event.away, oddsMilli: 3500 }],
      settings,
    });
    const before = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'lost',
      settledGrossPayout: 0n,
      settledTax: 0n,
      settledNetPayout: 0n,
    });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: 0n,
      stakes: -birr(50),
      revenue: birr(50),
      tax: 0n,
    });
    expect((await postingsOf(placed.bet.id))[1]).toEqual(['bet_payout', 'settle:ID:0']);
  });

  it('a void leg counts as 1.00', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: a.home, oddsMilli: 2000 },
        { selectionId: b.dnbHome, oddsMilli: 1500 },
      ],
      settings,
    });
    const before = await balances(handle.db, userId);
    await finish(handle.db, a.eventId, 1, 0);
    expect((await settle(a.eventId)).outcomes.unchanged).toBe(1);
    expect((await bet(placed.bet.id)).status).toBe('open');
    // A draw voids draw-no-bet.
    await finish(handle.db, b.eventId, 1, 1);
    await settle(b.eventId);
    const settled = await bet(placed.bet.id);
    expect(settled.legs.map((leg) => leg.state)).toEqual(['won', 'void']);
    expect(settled).toMatchObject({
      status: 'won',
      settledGrossPayout: birr(200),
      settledTax: birr(20),
      settledNetPayout: birr(180),
    });
    expect(delta(before, await balances(handle.db, userId)).cash).toBe(birr(180));
  });

  it('all legs void: the stake is refunded without tax', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(30),
      legs: [
        { selectionId: a.home, oddsMilli: 2000 },
        { selectionId: b.over, oddsMilli: 1900 },
      ],
      settings,
    });
    const before = await balances(handle.db, userId);
    await cancel(handle.db, a.eventId);
    await settle(a.eventId);
    await cancel(handle.db, b.eventId);
    await settle(b.eventId);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'void',
      settledGrossPayout: birr(30),
      settledTax: 0n,
      settledNetPayout: birr(30),
    });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: birr(30),
      stakes: -birr(30),
      revenue: 0n,
      tax: 0n,
    });
    expect((await postingsOf(placed.bet.id))[1]).toEqual(['bet_refund', 'settle:ID:0']);
  });

  it('the max-payout cap of the terms at placement applies', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const capped: GameSettings = {
      ...settings,
      betRules: { ...settings.betRules, maxStake: birr(150), maxPayout: birr(150) },
    };
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings: capped,
    });
    expect(placed.bet.potentialGrossPayout).toBe(birr(150));
    const before = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 3, 0);
    await settle(event.eventId);
    // 50 ETB of winnings is under the 100 ETB tax exemption.
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'won',
      settledGrossPayout: birr(150),
      settledTax: 0n,
      settledNetPayout: birr(150),
    });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: birr(150),
      stakes: -birr(100),
      revenue: -birr(50),
      tax: 0n,
    });
  });

  it('the multi bonus is paid on a 3-leg accumulator and taxed with the winnings', async () => {
    const events = await Promise.all([1, 2, 3].map(() => createEvent(handle.db, ids)));
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: events.map((e) => ({ selectionId: e.home, oddsMilli: 2000 })),
      settings,
    });
    // 100 × 8 = 800; bonus 3% of the 700 winnings = 21; tax 20% of 721 = 144.20.
    expect(placed.bet).toMatchObject({
      totalOddsMilli: 8000n,
      bonusPercentBps: 300,
      potentialBonus: birr(21),
      potentialGrossPayout: birr(821),
      potentialTax: 14_420n,
      potentialNetPayout: 67_680n,
    });
    const before = await balances(handle.db, userId);
    for (const e of events) {
      await finish(handle.db, e.eventId, 1, 0);
      await settle(e.eventId);
    }
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'won',
      settledGrossPayout: birr(821),
      settledTax: 14_420n,
      settledNetPayout: 67_680n,
    });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: 67_680n,
      stakes: -birr(100),
      revenue: -birr(721),
      tax: 14_420n,
    });
  });

  it('winnings under the tax exemption post no tax entry', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(50),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await finish(handle.db, event.eventId, 1, 0);
    await settle(event.eventId);
    expect(await bet(placed.bet.id)).toMatchObject({ settledTax: 0n, settledNetPayout: birr(100) });
    const [tx] = await handle.db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `settle:${placed.bet.id}:0`));
    const accounts = await handle.db.execute<{ key: string }>(
      sql`SELECT a.key FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.transaction_id = ${tx!.id} ORDER BY a.key`,
    );
    expect(accounts.rows.map((r) => r.key).sort()).toEqual(
      ['house:revenue', 'house:stakes', `user:${userId}:cash`].sort(),
    );
  });

  it('an accumulator is lost as soon as one leg loses', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(20),
      legs: [
        { selectionId: a.away, oddsMilli: 3500 },
        { selectionId: b.home, oddsMilli: 2000 },
      ],
      settings,
    });
    await finish(handle.db, a.eventId, 2, 1);
    await settle(a.eventId);
    const settled = await bet(placed.bet.id);
    expect(settled.status).toBe('lost');
    expect(settled.legs.map((leg) => leg.state)).toEqual(['lost', 'open']);
    // The other leg resolving later changes no money.
    await finish(handle.db, b.eventId, 1, 0);
    expect((await settle(b.eventId)).outcomes).toMatchObject({ unchanged: 1 });
    expect((await bet(placed.bet.id)).legs.map((leg) => leg.state)).toEqual(['lost', 'won']);
    expect(await postingsOf(placed.bet.id)).toHaveLength(2);
  });
});

describe('result corrections', () => {
  it('won → lost: the payout is reversed exactly and the bet settles lost', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player(birr(1_000));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    const start = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    expect((await bet(placed.bet.id)).status).toBe('won');

    await finish(handle.db, event.eventId, 0, 1);
    const summary = await settle(event.eventId);
    expect(summary.outcomes.resettled).toBe(1);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'lost',
      settlementVersion: 1,
      settledNetPayout: 0n,
    });
    expect(await postingsOf(placed.bet.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_payout', 'settle:ID:0'],
      ['settlement_reversal', 'reverse:ID:0'],
      ['bet_payout', 'settle:ID:1'],
    ]);
    // Net effect since placement: exactly a lost bet.
    expect(delta(start, await balances(handle.db, userId))).toEqual({
      cash: 0n,
      stakes: -birr(100),
      revenue: birr(100),
      tax: 0n,
    });
    expect(await outboxTypes(placed.bet.id)).toEqual(['bet.placed', 'bet.settled', 'bet.settled']);
    const [last] = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, placed.bet.id), eq(outboxEvents.type, 'bet.settled')))
      .orderBy(sql`${outboxEvents.id} DESC`)
      .limit(1);
    expect(last?.payload).toMatchObject({
      status: 'lost',
      version: 1,
      corrected: true,
      previous: { status: 'won', netPayout: '18000' },
    });
  });

  it('lost → won: the lost posting is reversed and the winnings paid', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player(birr(1_000));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.away, oddsMilli: 3500 }],
      settings,
    });
    const start = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    expect((await bet(placed.bet.id)).status).toBe('lost');
    await finish(handle.db, event.eventId, 1, 2);
    await settle(event.eventId);
    // 350 gross, 250 winnings → 50 tax.
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'won',
      settlementVersion: 1,
      settledGrossPayout: birr(350),
      settledTax: birr(50),
      settledNetPayout: birr(300),
    });
    expect(delta(start, await balances(handle.db, userId))).toEqual({
      cash: birr(300),
      stakes: -birr(100),
      revenue: -birr(250),
      tax: birr(50),
    });
  });

  it('a correction that reopens a leg reopens the bet, which settles again later', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player(birr(1_000));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: a.away, oddsMilli: 3500 },
        { selectionId: b.home, oddsMilli: 2000 },
      ],
      settings,
    });
    const start = await balances(handle.db, userId);
    await finish(handle.db, a.eventId, 2, 1);
    await settle(a.eventId);
    expect((await bet(placed.bet.id)).status).toBe('lost');

    await finish(handle.db, a.eventId, 0, 1);
    expect((await settle(a.eventId)).outcomes.reopened).toBe(1);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'open',
      settlementVersion: 1,
      settledGrossPayout: null,
      settledTax: null,
      settledNetPayout: null,
      settledAt: null,
    });
    expect(delta(start, await balances(handle.db, userId))).toEqual({
      cash: 0n,
      stakes: 0n,
      revenue: 0n,
      tax: 0n,
    });

    await finish(handle.db, b.eventId, 2, 0);
    await settle(b.eventId);
    // 3.5 × 2.0 = 7.00 → 700 gross, 600 winnings, 120 tax.
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'won',
      settlementVersion: 1,
      settledNetPayout: birr(580),
    });
    expect(await postingsOf(placed.bet.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_payout', 'settle:ID:0'],
      ['settlement_reversal', 'reverse:ID:0'],
      ['bet_payout', 'settle:ID:1'],
    ]);
    expect(await outboxTypes(placed.bet.id)).toEqual([
      'bet.placed',
      'bet.settled',
      'bet.reopened',
      'bet.settled',
    ]);
  });

  it('a correction that would overdraw the player is blocked, reported once and retried by the sweep', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player(birr(100));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    // The player withdraws all but 50 ETB of the 180 ETB payout.
    await withdraw(userId, birr(130));
    await finish(handle.db, event.eventId, 0, 1);
    const now = new Date();
    const result = await settleBet(placed.bet.id, now);
    expect(result).toMatchObject({ outcome: 'correction_blocked', status: 'won', version: 0 });
    const after = await bet(placed.bet.id);
    expect(after).toMatchObject({ status: 'won', settledNetPayout: birr(180) });
    expect(after.legs[0]?.state).toBe('lost');
    expect((await betRow(placed.bet.id)).settlementRetryAt).toEqual(
      new Date(now.getTime() + CORRECTION_RETRY_DELAY_MS),
    );
    expect(await outboxTypes(placed.bet.id)).toEqual([
      'bet.placed',
      'bet.settled',
      'bet.correction_blocked',
    ]);
    const [blocked] = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, placed.bet.id),
          eq(outboxEvents.type, 'bet.correction_blocked'),
        ),
      );
    // The player owes the whole 180 ETB and holds 50.
    expect(blocked?.payload).toMatchObject({
      current: 'won',
      corrected: 'lost',
      shortfall: '13000',
    });
    expect(await postingsOf(placed.bet.id)).toHaveLength(2);
    expect((await balances(handle.db, userId)).cash).toBe(birr(50));

    // The sweep picks the bet up only once its retry is due.
    const sweep = { graceMs: 0, lookbackMs: 3600_000, limit: 1000 };
    expect(await listBetsToSettle(handle.db, now, sweep)).not.toContain(placed.bet.id);
    const due = new Date(now.getTime() + CORRECTION_RETRY_DELAY_MS);
    expect(await listBetsToSettle(handle.db, due, sweep)).toContain(placed.bet.id);
    // Still blocked: the retry moves on, and nothing is reported again.
    expect(await settleBet(placed.bet.id, due)).toMatchObject({ outcome: 'correction_blocked' });
    expect((await betRow(placed.bet.id)).settlementRetryAt).toEqual(
      new Date(due.getTime() + CORRECTION_RETRY_DELAY_MS),
    );
    expect(
      (await outboxTypes(placed.bet.id)).filter((t) => t === 'bet.correction_blocked'),
    ).toHaveLength(1);
    const [audits] = await handle.db
      .select({ n: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, placed.bet.id), eq(auditLog.action, 'bet.correction_blocked')),
      );
    expect(audits?.n).toBe(1);

    // Once the money is back, the next retry completes the correction.
    await fund(handle.db, userId, birr(130));
    const later = new Date(due.getTime() + CORRECTION_RETRY_DELAY_MS);
    expect(await listBetsToSettle(handle.db, later, sweep)).toContain(placed.bet.id);
    const retried = await settleBet(placed.bet.id, later);
    expect(retried).toMatchObject({ outcome: 'resettled', status: 'lost', version: 1 });
    expect((await betRow(placed.bet.id)).settlementRetryAt).toBeNull();
    expect((await balances(handle.db, userId)).cash).toBe(0n);
    expect(await listBetsToSettle(handle.db, later, sweep)).not.toContain(placed.bet.id);
  });

  it('void → won pays the player even when the refund was spent', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player(birr(100));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await cancel(handle.db, event.eventId);
    await settle(event.eventId);
    expect((await bet(placed.bet.id)).status).toBe('void');
    // The 100 ETB refund is withdrawn: the player holds nothing.
    await withdraw(userId, birr(100));
    await finish(handle.db, event.eventId, 2, 0);
    expect(await settleBet(placed.bet.id)).toMatchObject({
      outcome: 'resettled',
      status: 'won',
      version: 1,
    });
    expect(await bet(placed.bet.id)).toMatchObject({ status: 'won', settledNetPayout: birr(180) });
    // Net change: +180 payout − 100 refund already paid.
    expect((await balances(handle.db, userId)).cash).toBe(birr(80));
    expect(await postingsOf(placed.bet.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_refund', 'settle:ID:0'],
      ['settlement_reversal', 'reverse:ID:0'],
      ['bet_payout', 'settle:ID:1'],
    ]);
  });

  it('won → won higher (a void leg corrected to won) pays the difference from a zero balance', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player(birr(100));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: a.home, oddsMilli: 2000 },
        { selectionId: b.dnbHome, oddsMilli: 1500 },
      ],
      settings,
    });
    await finish(handle.db, a.eventId, 1, 0);
    await settle(a.eventId);
    await finish(handle.db, b.eventId, 1, 1);
    await settle(b.eventId);
    expect(await bet(placed.bet.id)).toMatchObject({ status: 'won', settledNetPayout: birr(180) });
    await withdraw(userId, birr(180));

    await finish(handle.db, b.eventId, 2, 0);
    expect(await settleBet(placed.bet.id)).toMatchObject({ outcome: 'resettled', status: 'won' });
    const corrected = await bet(placed.bet.id);
    // 2.00 × 1.50 = 3.00 → 300 gross, 200 winnings, 40 tax.
    expect(corrected).toMatchObject({
      settledGrossPayout: birr(300),
      settledTax: birr(40),
      settledNetPayout: birr(260),
    });
    expect((await balances(handle.db, userId)).cash).toBe(birr(80));
  });

  it('won → won lower goes through when the balance covers the difference', async () => {
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const userId = await player(birr(100));
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: a.home, oddsMilli: 2000 },
        { selectionId: b.dnbHome, oddsMilli: 1500 },
      ],
      settings,
    });
    await finish(handle.db, a.eventId, 1, 0);
    await finish(handle.db, b.eventId, 2, 0);
    await settle(b.eventId);
    expect(await bet(placed.bet.id)).toMatchObject({ status: 'won', settledNetPayout: birr(260) });
    // 100 ETB left: less than the old 260 net, more than the 80 owed.
    await withdraw(userId, birr(160));

    await finish(handle.db, b.eventId, 1, 1);
    expect(await settleBet(placed.bet.id)).toMatchObject({ outcome: 'resettled', status: 'won' });
    expect(await bet(placed.bet.id)).toMatchObject({ settledNetPayout: birr(180) });
    expect((await balances(handle.db, userId)).cash).toBe(birr(20));
    expect((await betRow(placed.bet.id)).settlementRetryAt).toBeNull();
  });
});

describe('settlement sweep (listBetsToSettle)', () => {
  it('lists a bet whose event was resulted but never settled, after the grace period', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    const options = { graceMs: 0, lookbackMs: 3600_000, limit: 1000 };
    expect(await listBetsToSettle(handle.db, new Date(), options)).not.toContain(placed.bet.id);
    // Resulted, but its settlement job never ran.
    await finish(handle.db, event.eventId, 1, 0);
    const now = new Date(Date.now() + 1000);
    expect(await listBetsToSettle(handle.db, now, options)).toContain(placed.bet.id);
    // Within the grace period the job goes first; outside the lookback it is not looked at.
    expect(await listBetsToSettle(handle.db, now, { ...options, graceMs: 60_000 })).not.toContain(
      placed.bet.id,
    );
    expect(
      await listBetsToSettle(handle.db, new Date(now.getTime() + 2 * 3600_000), options),
    ).not.toContain(placed.bet.id);

    expect(await settleBet(placed.bet.id)).toMatchObject({ outcome: 'settled', status: 'won' });
    expect(await listBetsToSettle(handle.db, now, options)).not.toContain(placed.bet.id);
    // A correction whose job is lost makes the settled bet due again.
    await finish(handle.db, event.eventId, 0, 1);
    const later = new Date(Date.now() + 1000);
    expect(await listBetsToSettle(handle.db, later, options)).toContain(placed.bet.id);
    expect(await settleBet(placed.bet.id)).toMatchObject({ outcome: 'resettled', status: 'lost' });
    expect(await listBetsToSettle(handle.db, later, options)).not.toContain(placed.bet.id);
  });
});

describe('idempotency and concurrency', () => {
  it('settling again with the same results changes nothing', async () => {
    const event = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    const snapshot = async () => ({
      balances: await balances(handle.db, userId),
      postings: await postingsOf(placed.bet.id),
      outbox: await outboxTypes(placed.bet.id),
      bet: await bet(placed.bet.id),
    });
    const before = await snapshot();
    const again = await settle(event.eventId);
    expect(again.outcomes).toMatchObject({ unchanged: 1, settled: 0 });
    // The same result given again is a no-op for resulting and for settlement.
    await finish(handle.db, event.eventId, 2, 1);
    await settle(event.eventId);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['lost → won', 'away', [2, 1], [1, 2], 'won'],
    ['won → lost', 'home', [2, 1], [1, 2], 'lost'],
  ] as const)(
    'a %s correction does not deadlock with a posting on the player cash (accounts locked up front)',
    async (_, pick, first, second, final) => {
      // The deadlock needs the player's cash account to sort (by id) before
      // the house accounts: a placement then locks cash and waits for
      // house_stakes. The cash account is opened with the smallest id.
      const [stakes] = await handle.db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.key, 'house:stakes'));
      const userId = await createUser(handle.db);
      const cashId = `00000000-0000-4000-8000-${String(final === 'won' ? 1 : 2).padStart(12, '0')}`;
      await handle.db.insert(ledgerAccounts).values({
        id: cashId,
        key: `user:${userId}:cash`,
        ownerType: 'user',
        userId,
        kind: 'player_cash',
        allowNegative: false,
      });
      await fund(handle.db, userId, birr(1_000));
      expect(cashId < stakes!.id).toBe(true);

      const event = await createEvent(handle.db, ids);
      const placed = await place(handle.db, userId, {
        stake: birr(100),
        legs: [{ selectionId: event[pick], oddsMilli: pick === 'home' ? 2000 : 3500 }],
        settings,
      });
      await finish(handle.db, event.eventId, ...first);
      await settle(event.eventId);
      expect((await bet(placed.bet.id)).status).not.toBe(final);
      await finish(handle.db, event.eventId, ...second);

      // Another transaction (as placeBet's stake posting does, in id order)
      // holds the player's cash, then wants house_stakes.
      const waiting = async () => {
        const r = await handle.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return r.rows[0]?.n ?? 0;
      };
      const client = await handle.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE', [cashId]);
        // The correction posts two ledger transactions; one of them needs the cash.
        const correction = settleBet(placed.bet.id).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        for (let i = 0; i < 200 && (await waiting()) === 0; i += 1) await sleep(10);
        expect(await waiting()).toBeGreaterThan(0);
        let failure: string | undefined;
        try {
          await client.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE', [
            stakes!.id,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          failure = pgCode(error) ?? String(error);
          await client.query('ROLLBACK');
        }
        const outcome = await correction;
        expect(failure).toBeUndefined();
        expect(outcome).toMatchObject({ result: { outcome: 'resettled', status: final } });
      } finally {
        client.release();
      }
    },
  );

  it('concurrent settlement runs post once', async () => {
    const event = await createEvent(handle.db, ids);
    const userIds = await Promise.all([1, 2, 3].map(() => player()));
    const placed = await Promise.all(
      userIds.map((userId) =>
        place(handle.db, userId, {
          stake: birr(100),
          legs: [{ selectionId: event.home, oddsMilli: 2000 }],
          settings,
        }),
      ),
    );
    await finish(handle.db, event.eventId, 1, 0);
    const runs = await Promise.all(Array.from({ length: 6 }, () => settle(event.eventId)));
    expect(runs.reduce((n, r) => n + r.outcomes.settled, 0)).toBe(3);
    const [n] = await handle.db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(
        inArray(
          ledgerTransactions.idempotencyKey,
          placed.map((p) => `settle:${p.bet.id}:0`),
        ),
      );
    expect(n?.n).toBe(3);
    for (const userId of userIds) {
      expect((await balances(handle.db, userId)).cash).toBe(birr(10_080));
    }
  });
});

describe('reconciliation', () => {
  it('stakes, revenue, tax and the player balance reconcile through the ledger', async () => {
    const userId = await player(birr(5_000));
    const start = await balances(handle.db, userId);
    const [e1, e2, e3, e4, e5] = await Promise.all(
      [1, 2, 3, 4, 5].map(() => createEvent(handle.db, ids)),
    );
    const legs = (...pairs: Array<[string, number]>) =>
      pairs.map(([selectionId, oddsMilli]) => ({ selectionId, oddsMilli }));
    const slips = [
      { stake: birr(100), legs: legs([e1!.home, 2000]) },
      { stake: birr(250), legs: legs([e1!.away, 3500]) },
      { stake: birr(80), legs: legs([e2!.over, 1900], [e3!.home, 2000]) },
      { stake: birr(40), legs: legs([e3!.draw, 3200], [e4!.dnbAway, 2500]) },
      { stake: birr(60), legs: legs([e4!.home, 2000], [e5!.under, 1850]) },
      { stake: birr(500), legs: legs([e5!.home, 2000], [e2!.home, 2000], [e1!.under, 1850]) },
    ];
    const betIds: string[] = [];
    for (const slip of slips) {
      betIds.push((await place(handle.db, userId, { ...slip, settings })).bet.id);
    }
    const results: Array<[string, number, number] | [string, 'cancel']> = [
      [e1!.eventId, 2, 1],
      [e2!.eventId, 2, 2],
      [e3!.eventId, 1, 1],
      [e4!.eventId, 'cancel'],
      [e5!.eventId, 1, 0],
      // Corrections.
      [e1!.eventId, 1, 2],
      [e3!.eventId, 2, 0],
      [e5!.eventId, 0, 0],
    ];
    for (const result of results) {
      if (result[1] === 'cancel') await cancel(handle.db, result[0]);
      else await finish(handle.db, result[0], result[1], result[2]);
      await settle(result[0]);
    }

    const final = await Promise.all(betIds.map((id) => bet(id)));
    for (const b of final) expect(['won', 'lost', 'void']).toContain(b.status);
    const stakes = final.reduce((s, b) => s + b.stake, 0n);
    const gross = final.reduce((s, b) => s + (b.settledGrossPayout ?? 0n), 0n);
    const tax = final.reduce((s, b) => s + (b.settledTax ?? 0n), 0n);
    const net = final.reduce((s, b) => s + (b.settledNetPayout ?? 0n), 0n);
    expect(delta(start, await balances(handle.db, userId))).toEqual({
      cash: net - stakes,
      stakes: 0n,
      revenue: stakes - gross,
      tax,
    });
    // Every ledger account together still sums to zero.
    const [total] = await handle.db
      .select({ sum: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
      .from(ledgerAccounts);
    expect(total?.sum).toBe('0');
    // Every leg ended in a final state.
    const open = await handle.db
      .select({ n: count() })
      .from(betLegs)
      .where(and(inArray(betLegs.betId, betIds), eq(betLegs.state, 'open')));
    expect(open[0]?.n).toBe(0);
    const reversals = await handle.db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(
        and(
          like(ledgerTransactions.idempotencyKey, 'reverse:%'),
          inArray(ledgerTransactions.refId, betIds),
        ),
      );
    expect(reversals[0]?.n).toBeGreaterThan(0);
  });
});
