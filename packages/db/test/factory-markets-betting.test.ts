import { randomBytes, randomUUID } from 'node:crypto';
import {
  ACTIVE_FAMILY,
  birr,
  factoryMarket,
  familyDecision,
  settleBet,
  type LegState,
} from '@vamos/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBookingCode,
  DomainError,
  familyMoneyBetween,
  getBalance,
  getBetById,
  getCashOutOffer,
  listMarketFamilyMoves,
  listMarketFamilyStates,
  loadBookingCode,
  loadFactoryPricingPlan,
  marketFamilyReviewExists,
  recordMarketFamilyMove,
  resultEvent,
  setMarketStatus,
  settleEventBets,
  upsertFixture,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { markets, selections } from '../src/schema/index';
import {
  balances,
  createBettingDatabase,
  createEvent,
  place,
  type TestDb,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund, cash } from './helpers';

/**
 * Plan task 2.3 (d): the money path on market-factory legs, end to end on a real database:
 * placing, settling (win, loss, push), cash-out, booking codes and price expiry.
 */

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

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

const ODDS = 2500;

function priced(type: string, line: string | null) {
  return {
    type,
    line,
    selections: factoryMarket(type, line).selections.map((code) => ({ code, oddsMilli: ODDS })),
  };
}

interface FactoryEvent {
  eventId: string;
  /** selection id by `${marketKey}/${code}` */
  sel: Map<string, string>;
  /** market id by market key */
  market: Map<string, string>;
}

async function createFactoryEvent(): Promise<FactoryEvent> {
  const competitionId = ids.competitions.get('football/premier-league');
  const home = ids.teams.get('football/Arsenal');
  const away = ids.teams.get('football/Chelsea');
  if (competitionId === undefined || home === undefined || away === undefined) {
    throw new Error('seed is missing the premier league, Arsenal or Chelsea');
  }
  const created = await handle.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'test-factory-bet',
        feedRef: `factory-bet:${randomUUID()}`,
        sport: 'football',
        competitionId,
        homeTeamId: home,
        awayTeamId: away,
        startTime: new Date(Date.now() + 3 * 3_600_000),
      },
      [
        priced('htft', null),
        priced('multigoals', '1-3'),
        priced('h2_1x2', null),
        priced('asian_total', '3'),
        priced('ft_dc_btts', null),
      ],
    ),
  );
  const rows = await handle.db
    .select({ id: selections.id, code: selections.code, key: markets.key, marketId: markets.id })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, created.eventId));
  const sel = new Map<string, string>();
  const market = new Map<string, string>();
  for (const row of rows) {
    sel.set(`${row.key}/${row.code}`, row.id);
    market.set(row.key, row.marketId);
  }
  return { eventId: created.eventId, sel, market };
}

function pick(event: FactoryEvent, key: string, code: string): string {
  const id = event.sel.get(`${key}/${code}`);
  if (id === undefined) throw new Error(`no selection ${key}/${code}`);
  return id;
}

function marketOf(event: FactoryEvent, key: string): string {
  const id = event.market.get(key);
  if (id === undefined) throw new Error(`no market ${key}`);
  return id;
}

/** Results the event as finished with a full-time and half-time score. */
async function finishWithHalfTime(eventId: string, score: [number, number], ht: [number, number]) {
  await handle.db.transaction((tx) =>
    resultEvent(tx, eventId, {
      status: 'finished',
      score: { home: score[0], away: score[1], htHome: ht[0], htAway: ht[1] },
    }),
  );
}

const settle = (eventId: string) =>
  handle.db.transaction((tx) => settleEventBets(tx, eventId, new Date()));

/** Every ledger transaction of a bet balances to zero. */
async function expectLedgerBalanced(betId: string): Promise<number> {
  const rows = await handle.db.execute<{ id: string; total: string }>(
    sql`SELECT t.id, COALESCE(SUM(e.amount), 0)::text AS total
        FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
        WHERE t.ref_type = 'bet' AND t.ref_id = ${betId} GROUP BY t.id`,
  );
  for (const row of rows.rows) expect(row.total).toBe('0');
  return rows.rows.length;
}

async function bet(id: string) {
  const row = await getBetById(handle.db, id);
  if (row === null) throw new Error(`no bet ${id}`);
  return row;
}

function expected(stake: bigint, legs: Array<{ oddsMilli: number; state: LegState }>) {
  return settleBet({
    stake,
    legs: legs.map((l) => ({ oddsMilli: l.oddsMilli, state: l.state })),
    maxPayout: settings.betRules.maxPayout,
    multiBonus: settings.multiBonus,
    tax: settings.tax,
  });
}

describe('placing bets on factory selections', () => {
  it('places a single; the stake posting balances', async () => {
    const event = await createFactoryEvent();
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
      settings,
    });
    expect(placed.bet).toMatchObject({ status: 'open', totalOddsMilli: BigInt(ODDS) });
    expect(placed.bet.legs[0]?.state).toBe('open');
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(9_900));
    expect(await expectLedgerBalanced(placed.bet.id)).toBe(1);
  });

  it('places an accumulator of a factory leg and a legacy 1x2 leg of another event', async () => {
    const event = await createFactoryEvent();
    const legacy = await createEvent(handle.db, ids);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: pick(event, 'multigoals:1-3', 'yes'), oddsMilli: ODDS },
        { selectionId: legacy.home, oddsMilli: 2000 },
      ],
      settings,
    });
    expect(placed.bet.status).toBe('open');
    expect(placed.bet.legs).toHaveLength(2);
    expect(placed.bet.totalOddsMilli).toBe(5000n);
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(9_900));
    expect(await expectLedgerBalanced(placed.bet.id)).toBe(1);
  });
});

describe('settling bets on factory selections', () => {
  it('pays a winning single stake × odds less tax, and a losing single nothing', async () => {
    const event = await createFactoryEvent();
    const winner = await player();
    const loser = await player();
    const stake = birr(100);
    const won = await place(handle.db, winner, {
      stake,
      legs: [{ selectionId: pick(event, 'htft', 'X/1'), oddsMilli: ODDS }],
      settings,
    });
    const lost = await place(handle.db, loser, {
      stake,
      legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
      settings,
    });
    const winnerBefore = await balances(handle.db, winner);
    const loserBefore = await balances(handle.db, loser);
    // Half time 1-1, full time 2-1: X/1 wins, 1/1 loses.
    await finishWithHalfTime(event.eventId, [2, 1], [1, 1]);
    await settle(event.eventId);

    const wonExpected = expected(stake, [{ oddsMilli: ODDS, state: 'won' }]);
    expect(wonExpected.status).toBe('won');
    expect(await bet(won.bet.id)).toMatchObject({
      status: 'won',
      settledGrossPayout: wonExpected.grossPayout,
      settledTax: wonExpected.taxAmount,
      settledNetPayout: wonExpected.netPayout,
    });
    const winnerAfter = await balances(handle.db, winner);
    expect(winnerAfter.cash - winnerBefore.cash).toBe(wonExpected.netPayout);
    expect(winnerAfter.tax - winnerBefore.tax).toBe(wonExpected.taxAmount);
    expect(await expectLedgerBalanced(won.bet.id)).toBe(2);

    expect(await bet(lost.bet.id)).toMatchObject({
      status: 'lost',
      settledGrossPayout: 0n,
      settledNetPayout: 0n,
    });
    const loserAfter = await balances(handle.db, loser);
    expect(loserAfter.cash - loserBefore.cash).toBe(0n);
    expect(await expectLedgerBalanced(lost.bet.id)).toBe(2);
  });

  it('refunds a pushed asian_total single (void)', async () => {
    const event = await createFactoryEvent();
    const userId = await player();
    const stake = birr(40);
    const placed = await place(handle.db, userId, {
      stake,
      legs: [{ selectionId: pick(event, 'asian_total:3', 'over'), oddsMilli: ODDS }],
      settings,
    });
    const before = await balances(handle.db, userId);
    await finishWithHalfTime(event.eventId, [2, 1], [0, 1]);
    await settle(event.eventId);
    const refund = expected(stake, [{ oddsMilli: ODDS, state: 'void' }]);
    expect(await bet(placed.bet.id)).toMatchObject({
      status: 'void',
      settledGrossPayout: refund.grossPayout,
      settledTax: 0n,
    });
    const after = await balances(handle.db, userId);
    expect(after.cash - before.cash).toBe(stake);
    expect(after.revenue - before.revenue).toBe(0n);
    expect(await expectLedgerBalanced(placed.bet.id)).toBe(2);
  });

  it('prices a void factory leg of an accumulator at 1.000', async () => {
    const event = await createFactoryEvent();
    const legacy = await createEvent(handle.db, ids);
    const userId = await player();
    const stake = birr(100);
    const placed = await place(handle.db, userId, {
      stake,
      legs: [
        { selectionId: pick(event, 'asian_total:3', 'under'), oddsMilli: ODDS },
        { selectionId: legacy.home, oddsMilli: 2000 },
      ],
      settings,
    });
    const before = await balances(handle.db, userId);
    await finishWithHalfTime(event.eventId, [2, 1], [0, 1]);
    await settle(event.eventId);
    expect((await bet(placed.bet.id)).status).toBe('open');

    await handle.db.transaction((tx) =>
      resultEvent(tx, legacy.eventId, { status: 'finished', score: { home: 2, away: 0 } }),
    );
    await settle(legacy.eventId);
    const want = expected(stake, [
      { oddsMilli: ODDS, state: 'void' },
      { oddsMilli: 2000, state: 'won' },
    ]);
    expect(want.effectiveOddsMilli).toEqual([1000, 2000]);
    const settled = await bet(placed.bet.id);
    expect(settled.legs.map((l) => l.state)).toEqual(['void', 'won']);
    expect(settled).toMatchObject({
      status: 'won',
      settledGrossPayout: want.grossPayout,
      settledTax: want.taxAmount,
      settledNetPayout: want.netPayout,
    });
    expect(want.grossPayout).toBe(birr(200));
    const after = await balances(handle.db, userId);
    expect(after.cash - before.cash).toBe(want.netPayout);
    expect(await expectLedgerBalanced(placed.bet.id)).toBe(2);
  });

  it('settles ft_dc_btts with two winning selections per score', async () => {
    const event = await createFactoryEvent();
    const a = await player();
    const b = await player();
    const c = await player();
    const stake = birr(10);
    const mk = (userId: string, code: string) =>
      place(handle.db, userId, {
        stake,
        legs: [{ selectionId: pick(event, 'ft_dc_btts', code), oddsMilli: ODDS }],
        settings,
      });
    const [p1, p2, p3] = [await mk(a, '1X&yes'), await mk(b, '12&yes'), await mk(c, 'X2&yes')];
    await finishWithHalfTime(event.eventId, [2, 1], [0, 0]);
    await settle(event.eventId);
    expect((await bet(p1.bet.id)).status).toBe('won');
    expect((await bet(p2.bet.id)).status).toBe('won');
    expect((await bet(p3.bet.id)).status).toBe('lost');
    for (const p of [p1, p2, p3]) await expectLedgerBalanced(p.bet.id);
  });
});

describe('cash-out on a factory leg', () => {
  it('offers a cash-out like a legacy leg, and refuses it once the market is suspended by the feed', async () => {
    const event = await createFactoryEvent();
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: pick(event, 'h2_1x2', '1'), oddsMilli: ODDS }],
      settings,
    });
    const offer = await getCashOutOffer(handle.db, {
      userId,
      betId: placed.bet.id,
      config: settings.cashOut,
      now: new Date(),
    });
    expect(offer).not.toBeNull();
    // At unchanged odds the offer is the stake less the margin; a legacy leg gives the same.
    expect(offer).toMatchObject({ status: 'open', available: true, reason: null });
    expect(offer!.gross).toBeGreaterThan(0n);
    expect(offer!.gross).toBeLessThanOrEqual(birr(100));

    await handle.db.transaction((tx) =>
      setMarketStatus(tx, marketOf(event, 'h2_1x2'), 'suspended'),
    );
    const suspended = await getCashOutOffer(handle.db, {
      userId,
      betId: placed.bet.id,
      config: settings.cashOut,
      now: new Date(),
    });
    expect(suspended).toMatchObject({ available: false, reason: 'leg_suspended', gross: 0n });
    expect(suspended!.legs[0]?.currentOddsMilli).toBeNull();
  });
});

describe('booking codes with factory selections', () => {
  it('round-trips a booking code and reports a suspended factory selection as unavailable', async () => {
    const event = await createFactoryEvent();
    const other = await createFactoryEvent();
    const legacy = await createEvent(handle.db, ids);
    const booked = await createBookingCode(handle.db, {
      legs: [
        { selectionId: pick(event, 'htft', '2/1') },
        { selectionId: pick(other, 'multigoals:1-3', 'no') },
        { selectionId: legacy.home },
      ],
      now: new Date(),
      userId: null,
      randomBytes: (n) => randomBytes(n),
    });
    const loaded = await loadBookingCode(handle.db, booked.code, new Date());
    expect(loaded.legs.map((l) => [l.selectionId, l.available, l.currentOddsMilli])).toEqual([
      [pick(event, 'htft', '2/1'), true, ODDS],
      [pick(other, 'multigoals:1-3', 'no'), true, ODDS],
      [legacy.home, true, 2000],
    ]);

    await handle.db.transaction((tx) => setMarketStatus(tx, marketOf(event, 'htft'), 'suspended'));
    const after = await loadBookingCode(handle.db, booked.code, new Date());
    expect(after.legs[0]).toMatchObject({ available: false, reason: 'suspended' });
    expect(after.legs[1]?.available).toBe(true);
  });
});

describe('price expiry on factory markets', () => {
  it('refuses a factory selection whose market price has expired, taking no stake', async () => {
    const event = await createFactoryEvent();
    const userId = await player();
    const now = new Date();
    await handle.db
      .update(markets)
      .set({ priceValidUntil: new Date(now.getTime() - 1_000) })
      .where(eq(markets.id, marketOf(event, 'htft')));
    const error = await domainError(
      place(handle.db, userId, {
        stake: birr(10),
        legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
        settings,
        now,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'selection_unavailable' });
    expect(error.details).toEqual({
      selections: [{ selectionId: pick(event, 'htft', '1/1'), reason: 'suspended' }],
    });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(10_000));
    // The other factory markets of the event are unaffected.
    const ok = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: pick(event, 'multigoals:1-3', 'yes'), oddsMilli: ODDS }],
      settings,
      now,
    });
    expect(ok.bet.status).toBe('open');
  });
});

describe('lower liability cap on factory selections (plan task 2.5)', () => {
  it('refuses a factory single past a quarter of the selection cap, offering the stake that fits', async () => {
    const event = await createFactoryEvent();
    const legacy = await createEvent(handle.db, ids);
    const capped: GameSettings = {
      ...settings,
      riskLimits: { maxSelectionLiability: birr(1_000), maxEventLiability: null },
    };
    const userId = await player();
    // At odds ODDS a stake of 120 ETB pays 300 ETB: over a factory cap of 250, under the plain 1,000.
    const stake = birr(120);
    const error = await domainError(
      place(handle.db, userId, {
        stake,
        legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
        settings: capped,
      }),
    );
    expect(error).toMatchObject({ status: 422, code: 'liability_limit' });
    const maxStake = BigInt((error.details as { maxStake: string }).maxStake);
    expect((maxStake * BigInt(ODDS)) / 1000n <= birr(250)).toBe(true);
    expect(maxStake > 0n).toBe(true);
    // A selection of today's markets takes the same stake (its cap is the plain one).
    const placed = await place(handle.db, userId, {
      stake,
      legs: [{ selectionId: legacy.home, oddsMilli: 2000 }],
      settings: capped,
    });
    expect(placed.bet.status).toBe('open');
  });
});

describe('market families (plan task 2.5)', () => {
  it('takes the factory share of the selection cap from the market_families setting', async () => {
    const event = await createFactoryEvent();
    const userId = await player();
    const limits = { maxSelectionLiability: birr(1_000), maxEventLiability: null };
    // At odds ODDS a stake of 90 ETB pays 225 ETB: under the default quarter (250).
    const byDefault: GameSettings = { ...settings, riskLimits: limits };
    expect(byDefault.marketFamilies.factoryLiabilityShareBps).toBe(2_500);
    const tenth: GameSettings = {
      ...byDefault,
      marketFamilies: { ...settings.marketFamilies, factoryLiabilityShareBps: 1_000 },
    };
    const error = await domainError(
      place(handle.db, userId, {
        stake: birr(90),
        legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
        settings: tenth,
      }),
    );
    expect(error).toMatchObject({ status: 422, code: 'liability_limit' });
    const maxStake = BigInt((error.details as { maxStake: string }).maxStake);
    expect((maxStake * BigInt(ODDS)) / 1000n <= birr(100)).toBe(true);
    const placed = await place(handle.db, userId, {
      stake: birr(90),
      legs: [{ selectionId: pick(event, 'htft', '1/1'), oddsMilli: ODDS }],
      settings: byDefault,
    });
    expect(placed.bet.status).toBe('open');
  });

  it('familyMoneyBetween: settled singles per family; multis, voids and other weeks left out', async () => {
    const event = await createFactoryEvent();
    const other = await createFactoryEvent();
    const userId = await player();
    const single = (selectionId: string, stake: bigint) =>
      place(handle.db, userId, { stake, legs: [{ selectionId, oddsMilli: ODDS }], settings });
    await single(pick(event, 'htft', '1/1'), birr(10)); // wins 25 ETB
    await single(pick(event, 'htft', 'X/X'), birr(20)); // loses
    await single(pick(event, 'multigoals:1-3', 'yes'), birr(40)); // wins 100 ETB
    await place(handle.db, userId, {
      stake: birr(50),
      legs: [
        { selectionId: pick(event, 'htft', '2/2'), oddsMilli: ODDS },
        { selectionId: pick(other, 'h2_1x2', '1'), oddsMilli: ODDS },
      ],
      settings,
    });
    await finishWithHalfTime(event.eventId, [2, 0], [1, 0]);
    const at = new Date('2031-01-07T12:00:00Z');
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, at));

    const week = { from: new Date('2031-01-06T00:00:00Z'), to: new Date('2031-01-13T00:00:00Z') };
    const money = await familyMoneyBetween(handle.db, week);
    expect(money.get('htft')).toEqual({ stakes: birr(30), kept: birr(30) - birr(25) });
    expect(money.get('multigoals')).toEqual({ stakes: birr(40), kept: birr(40) - birr(100) });
    expect(money.has('h2_1x2')).toBe(false);
    expect(money.has('1x2')).toBe(false);
    const before = await familyMoneyBetween(handle.db, {
      from: new Date('2030-12-30T00:00:00Z'),
      to: week.from,
    });
    expect(before.size).toBe(0);
  });

  it('records moves, and the pricing plan leaves a suspended family out', async () => {
    const now = new Date('2031-02-01T00:00:00Z');
    const decision = familyDecision({
      family: 'htft_ou',
      state: ACTIVE_FAMILY,
      week: '2031-W05',
      weeks: ['2031-W03', '2031-W04', '2031-W05'].map((week) => ({
        week,
        stakes: birr(200_000),
        kept: 0n,
        marginBps: 1200,
      })),
      minWeeklyStake: birr(100_000),
      historyTestPassed: false,
    });
    expect(decision.move).toBe('suspend');
    expect(await marketFamilyReviewExists(handle.db, '2031-W05')).toBe(false);
    await handle.db.transaction((tx) =>
      recordMarketFamilyMove(tx, {
        week: '2031-W05',
        decision,
        from: ACTIVE_FAMILY,
        marginBps: 1200,
        weeks: [],
        now,
      }),
    );
    expect((await listMarketFamilyStates(handle.db)).get('htft_ou')).toEqual({
      status: 'suspended',
      sinceWeek: '2031-W05',
      raisedMarginBps: 1400,
    });
    const plan = await loadFactoryPricingPlan(handle.db);
    expect(plan.excluded).toEqual(['htft_ou']);
    expect(plan.types).not.toContain('htft_ou');
    expect(plan.tag).not.toBe('');
    expect(await listMarketFamilyMoves(handle.db, '2031-W05')).toEqual([
      expect.objectContaining({
        family: 'htft_ou',
        move: 'suspend',
        fromStatus: 'active',
        toStatus: 'suspended',
        marginBps: 1200,
        raisedMarginBps: 1400,
      }),
    ]);
    // A keep is not a move.
    await expect(
      recordMarketFamilyMove(handle.db, {
        week: '2031-W06',
        decision: { ...decision, move: 'keep' },
        from: ACTIVE_FAMILY,
        marginBps: 1200,
        weeks: [],
        now,
      }),
    ).rejects.toThrow(RangeError);
    // Put the family back for the other tests of this database.
    await handle.db.execute(sql`DELETE FROM market_family_state WHERE family = 'htft_ou'`);
    expect((await loadFactoryPricingPlan(handle.db)).tag).toBe('');
  });
});
