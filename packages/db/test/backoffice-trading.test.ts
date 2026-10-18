import { birr } from '@vamos/core';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBalance,
  getBetById,
  getTradingEvent,
  listBetsToSettle,
  searchTradingEvents,
  settleEventBets,
  settleMarketBets,
  staffResultEvent,
  staffSetEventSuspended,
  staffSetMarketStatus,
  staffSetOdds,
  staffVoidMarket,
  staffVoidSelection,
  type CatalogIds,
  type GameSettings,
  type UserBet,
} from '../src/index';
import {
  auditLog,
  bets,
  ledgerAccounts,
  ledgerEntries,
  markets,
  outboxEvents,
  selections,
} from '../src/schema/index';
import {
  balances,
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';
import { createGames, openRound } from './jackpot-fixtures';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

const ADMIN = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const actor = { adminId: ADMIN, ip: '10.1.2.3' };
/** Staff result events "later": every test event has started by then. */
const LATER = () => new Date(Date.now() + 6 * 3600_000);

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

async function bet(id: string): Promise<UserBet> {
  const row = await getBetById(handle.db, id);
  if (row === null) throw new Error(`no bet ${id}`);
  return row;
}

/** What the worker does for `market.resulted`. */
const settleMarket = (marketId: string) =>
  handle.db.transaction((tx) => settleMarketBets(tx, marketId, new Date()));
/** What the worker does for `event.resulted` / `event.result_corrected`. */
const settleEvent = (eventId: string) =>
  handle.db.transaction((tx) => settleEventBets(tx, eventId, new Date()));

const single = (userId: string, selectionId: string, oddsMilli: number, stake: bigint) =>
  place(handle.db, userId, { stake, legs: [{ selectionId, oddsMilli }], settings });

async function outboxCount(type: string, aggregateId: string): Promise<number> {
  const [row] = await handle.db
    .select({ n: count() })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.type, type), eq(outboxEvents.aggregateId, aggregateId)));
  return row?.n ?? 0;
}

async function auditRows(action: string, targetId: string) {
  return handle.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
    .orderBy(auditLog.id);
}

/**
 * The ledger reconciles: every account's cached balance is the sum of its
 * entries, all balances sum to zero, and house_stakes holds exactly the
 * stakes of the open (and pending) bets.
 */
async function expectLedgerReconciles(): Promise<void> {
  const mismatched = await handle.db.execute<{ key: string }>(sql`
    SELECT a.key FROM ${ledgerAccounts} a
    LEFT JOIN ${ledgerEntries} e ON e.account_id = a.id
    GROUP BY a.id, a.key, a.balance
    HAVING a.balance <> COALESCE(SUM(e.amount), 0)
  `);
  expect(mismatched.rows).toEqual([]);
  const [total] = await handle.db
    .select({ sum: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
    .from(ledgerAccounts);
  expect(total?.sum).toBe('0');
  const [open] = await handle.db
    .select({ sum: sql<string>`COALESCE(SUM(${bets.stake}), 0)::text` })
    .from(bets)
    .where(inArray(bets.status, ['open', 'pending_acceptance']));
  expect(await getBalance(handle.db, { kind: 'house_stakes' })).toBe(BigInt(open?.sum ?? '0'));
}

describe('void a market', () => {
  let e1: TestEvent;
  let e2: TestEvent;
  let userId: string;
  let singleOnMarket: string;
  let doubleWithLeg: string;
  let otherMarket: string;
  let startCash: bigint;

  beforeAll(async () => {
    e1 = await createEvent(handle.db, ids);
    e2 = await createEvent(handle.db, ids);
    userId = await player();
    startCash = (await balances(handle.db, userId)).cash;
    singleOnMarket = (await single(userId, e1.home, 2000, birr(100))).bet.id;
    doubleWithLeg = (
      await place(handle.db, userId, {
        stake: birr(50),
        legs: [
          { selectionId: e1.home, oddsMilli: 2000 },
          { selectionId: e2.home, oddsMilli: 2000 },
        ],
        settings,
      })
    ).bet.id;
    otherMarket = (await single(userId, e1.over, 1900, birr(20))).bet.id;
  });

  it('voids every selection for good and settles the bets on it through market.resulted', async () => {
    const marketId = e1.marketIds['1x2'];
    const outcome = await handle.db.transaction((tx) =>
      staffVoidMarket(tx, { marketId, reason: 'Palpable error: home and away swapped', actor }),
    );
    expect(outcome).toMatchObject({
      outcome: 'voided',
      eventId: e1.eventId,
      marketId,
      marketStatus: 'void',
      affectedBets: 2,
    });
    expect(new Set(outcome.selectionIds)).toEqual(new Set([e1.home, e1.draw, e1.away]));
    const [market] = await handle.db.select().from(markets).where(eq(markets.id, marketId));
    expect(market).toMatchObject({ status: 'void' });
    expect(market?.voidedAt).not.toBeNull();
    const rows = await handle.db.select().from(selections).where(eq(selections.marketId, marketId));
    expect(rows.every((row) => row.status === 'settled' && row.result === 'void')).toBe(true);
    expect(rows.every((row) => row.voidedAt !== null)).toBe(true);
    expect(await outboxCount('market.resulted', marketId)).toBe(1);
    const [audit] = await auditRows('catalog.market.voided', marketId);
    expect(audit).toMatchObject({ actorType: 'admin', actorId: ADMIN, ip: '10.1.2.3' });
    expect(audit?.metadata).toMatchObject({
      eventId: e1.eventId,
      previousStatus: 'open',
      affectedBets: 2,
      reason: 'Palpable error: home and away swapped',
    });

    const summary = await settleMarket(marketId);
    expect(summary.bets).toBe(2);
    expect(summary.outcomes).toMatchObject({ settled: 1, unchanged: 1 });
    // The single is refunded in full.
    expect(await bet(singleOnMarket)).toMatchObject({
      status: 'void',
      settledNetPayout: birr(100),
      settledTax: 0n,
    });
    // The double now waits on its other leg; its voided leg counts 1.00.
    const double = await bet(doubleWithLeg);
    expect(double.status).toBe('open');
    expect(double.legs.find((leg) => leg.selectionId === e1.home)?.state).toBe('void');
    // A bet on another market of the event is not touched.
    expect((await bet(otherMarket)).status).toBe('open');
    expect((await balances(handle.db, userId)).cash).toBe(startCash - birr(170) + birr(100));
    await expectLedgerReconciles();
  });

  it('is idempotent: voiding again and settling again change nothing', async () => {
    const marketId = e1.marketIds['1x2'];
    const auditsBefore = (await auditRows('catalog.market.voided', marketId)).length;
    const again = await handle.db.transaction((tx) =>
      staffVoidMarket(tx, { marketId, reason: 'again', actor }),
    );
    expect(again).toMatchObject({ outcome: 'unchanged', selectionIds: [], messages: [] });
    expect(await outboxCount('market.resulted', marketId)).toBe(1);
    expect((await auditRows('catalog.market.voided', marketId)).length).toBe(auditsBefore);
    const cash = (await balances(handle.db, userId)).cash;
    const summary = await settleMarket(marketId);
    expect(summary.outcomes.settled + summary.outcomes.resettled).toBe(0);
    expect((await balances(handle.db, userId)).cash).toBe(cash);
  });

  it('keeps the void through the result and its corrections; the other legs settle normally', async () => {
    await finish(handle.db, e2.eventId, 2, 1);
    await settleEvent(e2.eventId);
    // 50 ETB at 1.00 × 2.00: 100 ETB back, winnings of 50 ETB are below the 100 ETB tax exemption.
    expect(await bet(doubleWithLeg)).toMatchObject({
      status: 'won',
      settledGrossPayout: birr(100),
      settledTax: 0n,
      settledNetPayout: birr(100),
    });

    await finish(handle.db, e1.eventId, 1, 0);
    await settleEvent(e1.eventId);
    const [market] = await handle.db
      .select()
      .from(markets)
      .where(eq(markets.id, e1.marketIds['1x2']));
    expect(market?.status).toBe('void');
    expect(await bet(singleOnMarket)).toMatchObject({ status: 'void', settlementVersion: 0 });
    expect((await bet(otherMarket)).status).toBe('lost');

    // A correction to 2-0 leaves the voided market void.
    await handle.db.transaction((tx) =>
      staffResultEvent(tx, {
        eventId: e1.eventId,
        result: { status: 'finished', score: { home: 2, away: 0 } },
        reason: 'Second goal missed by the feed',
        actor,
        now: LATER(),
      }),
    );
    await settleEvent(e1.eventId);
    const rows = await handle.db
      .select()
      .from(selections)
      .where(eq(selections.marketId, e1.marketIds['1x2']));
    expect(rows.every((row) => row.result === 'void')).toBe(true);
    expect(await bet(singleOnMarket)).toMatchObject({ status: 'void', settlementVersion: 0 });
    // 2 goals: under 2.5 still wins, so the over bet stays lost.
    expect((await bet(otherMarket)).status).toBe('lost');
    // Stakes 170, back 100 (void) + 100 (double).
    expect((await balances(handle.db, userId)).cash).toBe(startCash - birr(170) + birr(200));
    await expectLedgerReconciles();
  });

  it('corrects a settled market: a winning bet is reversed exactly and refunded', async () => {
    const e3 = await createEvent(handle.db, ids);
    const bettor = await player();
    const before = await balances(handle.db, bettor);
    const placed = await single(bettor, e3.home, 2000, birr(1_000));
    await finish(handle.db, e3.eventId, 1, 0);
    await settleEvent(e3.eventId);
    // 2,000 ETB gross, 1,000 ETB winnings taxed 20%: 1,800 ETB net.
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'won',
      settledGrossPayout: birr(2_000),
      settledTax: birr(200),
      settledNetPayout: birr(1_800),
    });
    const taxBefore = (await balances(handle.db, bettor)).tax;

    const outcome = await handle.db.transaction((tx) =>
      staffVoidMarket(tx, {
        marketId: e3.marketIds['1x2'],
        reason: 'Match fixing investigation',
        actor,
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'voided', affectedBets: 1 });
    const [audit] = await auditRows('catalog.market.voided', e3.marketIds['1x2']);
    expect(audit?.metadata).toMatchObject({
      previousStatus: 'settled',
      previousResults: { '1': 'won', X: 'lost', '2': 'lost' },
    });
    const summary = await settleMarket(e3.marketIds['1x2']);
    expect(summary.outcomes.resettled).toBe(1);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'void',
      settlementVersion: 1,
      settledGrossPayout: birr(1_000),
      settledTax: 0n,
      settledNetPayout: birr(1_000),
    });
    const after = await balances(handle.db, bettor);
    expect(after.cash).toBe(before.cash);
    expect(after.tax).toBe(taxBefore - birr(200));
    await expectLedgerReconciles();
  });
});

describe('void a selection', () => {
  let e4: TestEvent;
  let userId: string;
  let onHome: string;
  let onDraw: string;
  let onAway: string;
  let startCash: bigint;

  beforeAll(async () => {
    e4 = await createEvent(handle.db, ids);
    userId = await player();
    startCash = (await balances(handle.db, userId)).cash;
    onHome = (await single(userId, e4.home, 2000, birr(100))).bet.id;
    onDraw = (await single(userId, e4.draw, 3200, birr(100))).bet.id;
    onAway = (await single(userId, e4.away, 3500, birr(10))).bet.id;
  });

  it('voids one selection, leaving the market and its other selections trading', async () => {
    const outcome = await handle.db.transaction((tx) =>
      staffVoidSelection(tx, { selectionId: e4.home, reason: 'Wrong price published', actor }),
    );
    expect(outcome).toMatchObject({
      outcome: 'voided',
      selectionIds: [e4.home],
      marketStatus: 'open',
      affectedBets: 1,
    });
    // The selection is shown as no longer bettable.
    expect(outcome.messages).toEqual([
      {
        type: 'odds',
        eventId: e4.eventId,
        data: { s: e4.home, o: 2000, st: 'suspended' },
      },
    ]);
    const summary = await settleMarket(e4.marketIds['1x2']);
    expect(summary.outcomes).toMatchObject({ settled: 1, unchanged: 2 });
    expect(await bet(onHome)).toMatchObject({ status: 'void', settledNetPayout: birr(100) });
    expect((await bet(onDraw)).status).toBe('open');
    expect((await bet(onAway)).status).toBe('open');

    // The voided selection takes no bets; the others still do.
    await expect(single(userId, e4.home, 2000, birr(10))).rejects.toMatchObject({
      code: 'selection_unavailable',
    });
    const extra = await single(userId, e4.draw, 3200, birr(10));
    expect(extra.bet.status).toBe('open');
    // Its price can no longer be changed.
    await expect(
      handle.db.transaction((tx) =>
        staffSetOdds(tx, { selectionId: e4.home, oddsMilli: 2100, actor, now: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_trading_state' });

    // Idempotent.
    const again = await handle.db.transaction((tx) =>
      staffVoidSelection(tx, { selectionId: e4.home, reason: 'again', actor }),
    );
    expect(again.outcome).toBe('unchanged');
    expect(await outboxCount('market.resulted', e4.marketIds['1x2'])).toBe(1);
    expect(await auditRows('catalog.selection.voided', e4.home)).toHaveLength(1);
    await expectLedgerReconciles();
  });

  it('keeps the selection void when the event is resulted and corrected by staff', async () => {
    // 1-0: the home win the voided selection would have paid.
    await finish(handle.db, e4.eventId, 1, 0);
    await settleEvent(e4.eventId);
    expect((await bet(onHome)).status).toBe('void');
    expect((await bet(onDraw)).status).toBe('lost');
    expect((await bet(onAway)).status).toBe('lost');

    // A correction needs a reason.
    await expect(
      handle.db.transaction((tx) =>
        staffResultEvent(tx, {
          eventId: e4.eventId,
          result: { status: 'finished', score: { home: 0, away: 0 } },
          actor,
          now: LATER(),
        }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'correction_reason_required' });

    const corrected = await handle.db.transaction((tx) =>
      staffResultEvent(tx, {
        eventId: e4.eventId,
        result: { status: 'finished', score: { home: 0, away: 0 } },
        reason: 'Goal disallowed after review',
        actor,
        now: LATER(),
      }),
    );
    expect(corrected.outcome).toBe('corrected');
    const [audit] = await auditRows('catalog.event.result_corrected', e4.eventId);
    expect(audit).toMatchObject({ actorType: 'admin', actorId: ADMIN });
    expect(audit?.metadata).toMatchObject({
      previous: { status: 'finished', score: { home: 1, away: 0 } },
      result: { status: 'finished', score: { home: 0, away: 0 } },
      reason: 'Goal disallowed after review',
    });
    await settleEvent(e4.eventId);
    expect((await bet(onHome)).status).toBe('void');
    // 100 ETB at 3.20: 320 gross, 220 winnings taxed 20% (44): 276 net.
    expect(await bet(onDraw)).toMatchObject({
      status: 'won',
      settlementVersion: 1,
      settledGrossPayout: birr(320),
      settledTax: birr(44),
      settledNetPayout: birr(276),
    });
    expect((await bet(onAway)).status).toBe('lost');
    const [home] = await handle.db.select().from(selections).where(eq(selections.id, e4.home));
    expect(home).toMatchObject({ result: 'void', status: 'settled' });

    // The same result again is unchanged and audits nothing.
    const same = await handle.db.transaction((tx) =>
      staffResultEvent(tx, {
        eventId: e4.eventId,
        result: { status: 'finished', score: { home: 0, away: 0 } },
        reason: 'repeat',
        actor,
        now: LATER(),
      }),
    );
    expect(same.outcome).toBe('unchanged');
    expect(await auditRows('catalog.event.result_corrected', e4.eventId)).toHaveLength(1);

    // Stakes 100 + 100 + 10 + 10 (the extra draw bet); back 100 (void) + 276 + 10 × 3.2 = 32.
    expect((await balances(handle.db, userId)).cash).toBe(
      startCash - birr(220) + birr(100) + birr(276) + birr(32),
    );
    await expectLedgerReconciles();
  });

  it('voids the market once every selection is void', async () => {
    const e5 = await createEvent(handle.db, ids);
    for (const selectionId of [e5.dnbHome, e5.dnbAway]) {
      await handle.db.transaction((tx) =>
        staffVoidSelection(tx, { selectionId, reason: 'Market offered by mistake', actor }),
      );
    }
    const [market] = await handle.db.select().from(markets).where(eq(markets.id, e5.marketIds.dnb));
    expect(market?.status).toBe('void');
  });

  it('lets the settlement sweep find bets on a voided selection whose job was lost', async () => {
    const e6 = await createEvent(handle.db, ids);
    const bettor = await player();
    const placed = await single(bettor, e6.over, 1900, birr(10));
    await handle.db.transaction((tx) =>
      staffVoidSelection(tx, { selectionId: e6.over, reason: 'Line posted wrongly', actor }),
    );
    const due = await listBetsToSettle(handle.db, new Date(Date.now() + 120_000), {
      graceMs: 60_000,
      lookbackMs: 3_600_000,
      limit: 1_000,
    });
    expect(due).toContain(placed.bet.id);
  });

  it('refuses to void one outcome of a game in an unsettled jackpot round', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + 2 * 3600_000));
    await openRound(handle.db, games);
    await expect(
      handle.db.transaction((tx) =>
        staffVoidSelection(tx, { selectionId: games[0]!.home, reason: 'x', actor }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_trading_state' });
    // The whole market can be voided (the game then counts as cancelled).
    const outcome = await handle.db.transaction((tx) =>
      staffVoidMarket(tx, { marketId: games[0]!.marketIds['1x2'], reason: 'Venue change', actor }),
    );
    expect(outcome.outcome).toBe('voided');
  });

  it('needs a reason and a known selection', async () => {
    const e7 = await createEvent(handle.db, ids);
    await expect(
      handle.db.transaction((tx) =>
        staffVoidSelection(tx, { selectionId: e7.home, reason: '   ', actor }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_trading_input' });
    await expect(
      handle.db.transaction((tx) =>
        staffVoidMarket(tx, {
          marketId: '00000000-0000-4000-8000-000000000000',
          reason: 'x',
          actor,
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});

describe('trading screen', () => {
  it('suspends, resumes, reprices and refuses a finished result before kick-off, all audited', async () => {
    const event = await createEvent(handle.db, ids);
    const suspended = await handle.db.transaction((tx) =>
      staffSetEventSuspended(tx, { eventId: event.eventId, suspended: true, actor }),
    );
    expect(suspended.changed).toBe(true);
    const resumed = await handle.db.transaction((tx) =>
      staffSetEventSuspended(tx, { eventId: event.eventId, suspended: false, actor }),
    );
    expect(resumed.changed).toBe(true);
    await handle.db.transaction((tx) =>
      staffSetMarketStatus(tx, { marketId: event.marketIds.ou, status: 'suspended', actor }),
    );
    const odds = await handle.db.transaction((tx) =>
      staffSetOdds(tx, {
        selectionId: event.home,
        oddsMilli: 2150,
        reason: 'Team news',
        actor,
        now: new Date(),
      }),
    );
    expect(odds).toMatchObject({ changed: true, previousOddsMilli: 2000, oddsMilli: 2150 });
    await expect(
      handle.db.transaction((tx) =>
        staffSetOdds(tx, { selectionId: event.home, oddsMilli: 1000, actor, now: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_trading_input' });
    await expect(
      handle.db.transaction((tx) =>
        staffResultEvent(tx, {
          eventId: event.eventId,
          result: { status: 'finished', score: { home: 1, away: 0 } },
          actor,
          now: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'event_not_started' });
    const actions = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorId, ADMIN));
    const names = actions.map((row) => row.action);
    for (const action of [
      'catalog.event.suspended',
      'catalog.event.resumed',
      'catalog.market.suspended',
      'catalog.odds.manual',
    ]) {
      expect(names).toContain(action);
    }

    const detail = await getTradingEvent(handle.db, event.eventId);
    expect(detail?.markets).toHaveLength(3);
    const ou = detail?.markets.find((market) => market.id === event.marketIds.ou);
    expect(ou).toMatchObject({ status: 'suspended', suspendedBy: 'trader' });
    const home = detail?.markets
      .flatMap((market) => market.selections)
      .find((selection) => selection.id === event.home);
    expect(home?.oddsMilli).toBe(2150);
    expect(await getTradingEvent(handle.db, 'not-a-uuid')).toBeNull();
  });

  it('shows the open bets per selection and finds events by Game ID or team', async () => {
    const event = await createEvent(handle.db, ids);
    const a = await player();
    const b = await player();
    await single(a, event.home, 2000, birr(100));
    await single(b, event.home, 2000, birr(50));
    await single(b, event.away, 3500, birr(20));
    const detail = await getTradingEvent(handle.db, event.eventId);
    const all = detail!.markets.flatMap((market) => market.selections);
    expect(all.find((s) => s.id === event.home)).toMatchObject({
      openBets: 2,
      openStake: birr(150),
      liability: birr(300),
    });
    expect(all.find((s) => s.id === event.away)).toMatchObject({
      openBets: 1,
      openStake: birr(20),
      liability: birr(70),
    });
    expect(detail).toMatchObject({ openBets: 3, openStake: birr(170) });

    const byGameId = await searchTradingEvents(handle.db, { q: String(detail!.gameId) });
    expect(byGameId.items.map((item) => item.id)).toContain(event.eventId);
    const found = byGameId.items.find((item) => item.id === event.eventId);
    expect(found).toMatchObject({ openBets: 3, openStake: birr(170) });
    const byTeam = await searchTradingEvents(handle.db, { q: 'arsenal', limit: 2 });
    expect(byTeam.items).toHaveLength(2);
    expect(byTeam.nextCursor).not.toBeNull();
    const next = await searchTradingEvents(handle.db, {
      q: 'arsenal',
      limit: 2,
      cursor: byTeam.nextCursor!,
    });
    expect(next.items[0]?.id).not.toBe(byTeam.items[1]?.id);
    expect(next.items[0]!.startTime.getTime() >= byTeam.items[1]!.startTime.getTime()).toBe(true);
  });
});
