import { randomBytes } from 'node:crypto';
import { BET_SHORT_ID_LENGTH, birr, isValidCode } from '@vamos/core';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  getBalance,
  placeBet,
  quoteSlip,
  setMarketStatus,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import {
  auditLog,
  betLegs,
  bets,
  competitions,
  events,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
  rgLimits,
} from '../src/schema/index';
import * as schema from '../src/schema/index';
import {
  balances,
  betKey,
  createBettingDatabase,
  createEvent,
  place,
  reprice,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { cash, createUser, dropTestDatabase, fund } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function player(amount = birr(1_000)): Promise<string> {
  const userId = await createUser(handle.db);
  if (amount > 0n) await fund(handle.db, userId, amount);
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

async function countWhere(table: typeof outboxEvents | typeof auditLog, id: string) {
  const column = table === outboxEvents ? outboxEvents.aggregateId : auditLog.targetId;
  const [row] = await handle.db.select({ n: count() }).from(table).where(eq(column, id));
  return row?.n ?? 0;
}

describe('placeBet', () => {
  let event: TestEvent;

  beforeAll(async () => {
    event = await createEvent(handle.db, ids);
  });

  it('places a prematch single: open bet, legs, stake posting, outbox and audit', async () => {
    const userId = await player();
    const before = await balances(handle.db, userId);
    const now = new Date();
    const { bet, replayed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
      now,
    });
    expect(replayed).toBe(false);
    expect(bet).toMatchObject({
      userId,
      betType: 'single',
      status: 'open',
      stake: birr(100),
      totalOddsMilli: 2000n,
      potentialGrossPayout: birr(200),
      potentialBonus: 0n,
      // 20% of the 100 ETB winnings.
      potentialTax: birr(20),
      potentialNetPayout: birr(180),
      oddsChangePolicy: 'none',
      channel: 'web',
      settlementVersion: 0,
      settledNetPayout: null,
      placedAt: now,
      acceptedAt: now,
      acceptAfter: null,
    });
    expect(bet.shortId).toHaveLength(BET_SHORT_ID_LENGTH);
    expect(isValidCode(bet.shortId, BET_SHORT_ID_LENGTH)).toBe(true);
    expect(bet.legs).toHaveLength(1);
    expect(bet.legs[0]).toMatchObject({
      position: 0,
      selectionId: event.home,
      eventId: event.eventId,
      marketId: event.marketIds['1x2'],
      oddsMilli: 2000,
      requestedOddsMilli: 2000,
      isLive: false,
      state: 'open',
      selection: {
        code: '1',
        marketType: '1x2',
        homeTeam: { en: 'Arsenal' },
        awayTeam: { en: 'Chelsea' },
        competitionName: { en: 'Premier League' },
      },
    });

    const after = await balances(handle.db, userId);
    expect(after.cash).toBe(before.cash - birr(100));
    expect(after.stakes).toBe(before.stakes + birr(100));
    const [posting] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `bet:${userId}:${await keyOf(bet.id)}`));
    expect(posting).toMatchObject({ type: 'bet_stake', refType: 'bet', refId: bet.id });
    expect(await countWhere(outboxEvents, bet.id)).toBe(1);
    expect(await countWhere(auditLog, bet.id)).toBe(1);
    const [outbox] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, bet.id));
    expect(outbox).toMatchObject({
      type: 'bet.placed',
      aggregateType: 'bet',
      payload: { betId: bet.id, userId, stake: '10000', status: 'open' },
    });
  });

  async function keyOf(betId: string): Promise<string> {
    const [row] = await handle.db
      .select({ key: bets.idempotencyKey })
      .from(bets)
      .where(eq(bets.id, betId));
    return row!.key;
  }

  it('places an accumulator priced at the product of the odds', async () => {
    const other = await createEvent(handle.db, ids, { odds: { over: 1500 } });
    const userId = await player();
    const { bet } = await place(handle.db, userId, {
      stake: birr(10),
      legs: [
        { selectionId: event.home, oddsMilli: 2000 },
        { selectionId: other.over, oddsMilli: 1500 },
      ],
      settings,
    });
    expect(bet).toMatchObject({ betType: 'multi', totalOddsMilli: 3000n });
    expect(bet.legs.map((leg) => [leg.position, leg.selectionId])).toEqual([
      [0, event.home],
      [1, other.over],
    ]);
  });

  describe('idempotency', () => {
    it('a replay returns the same bet and writes nothing', async () => {
      const userId = await player();
      const key = betKey();
      const legs = [{ selectionId: event.draw, oddsMilli: 3200 }];
      const first = await place(handle.db, userId, { stake: birr(20), legs, key, settings });
      const balance = await getBalance(handle.db, cash(userId));
      const second = await place(handle.db, userId, { stake: birr(20), legs, key, settings });
      expect(second.replayed).toBe(true);
      expect(second.bet).toEqual(first.bet);
      expect(await getBalance(handle.db, cash(userId))).toBe(balance);
      expect(await countWhere(outboxEvents, first.bet.id)).toBe(1);
      expect(await countWhere(auditLog, first.bet.id)).toBe(1);
      const [n] = await handle.db.select({ n: count() }).from(bets).where(eq(bets.userId, userId));
      expect(n?.n).toBe(1);
    });

    it('a replay still returns the bet after the odds moved', async () => {
      const own = await createEvent(handle.db, ids);
      const userId = await player();
      const key = betKey();
      const legs = [{ selectionId: own.away, oddsMilli: 3500 }];
      const first = await place(handle.db, userId, { stake: birr(20), legs, key, settings });
      await reprice(handle.db, own.away, 3000);
      const again = await place(handle.db, userId, { stake: birr(20), legs, key, settings });
      expect(again).toMatchObject({ replayed: true, bet: { id: first.bet.id } });
    });

    interface Change {
      stake?: bigint;
      legs?: Array<{ selectionId: 'draw' | 'away'; oddsMilli: number }>;
      policy?: 'any';
    }
    it.each<[string, Change]>([
      ['stake', { stake: birr(21) }],
      ['odds', { legs: [{ selectionId: 'draw', oddsMilli: 3300 }] }],
      ['selection', { legs: [{ selectionId: 'away', oddsMilli: 3500 }] }],
      ['policy', { policy: 'any' }],
    ])('a reused key with a different %s is 422 idempotency_key_reused', async (_, change) => {
      const userId = await player();
      const key = betKey();
      const legs = [{ selectionId: event.draw, oddsMilli: 3200 }];
      await place(handle.db, userId, { stake: birr(20), legs, key, settings });
      const changedLegs = change.legs?.map((leg) => ({
        selectionId: leg.selectionId === 'draw' ? event.draw : event.away,
        oddsMilli: leg.oddsMilli,
      }));
      const error = await domainError(
        place(handle.db, userId, {
          stake: change.stake ?? birr(20),
          legs: changedLegs ?? legs,
          policy: change.policy ?? 'none',
          key,
          settings,
        }),
      );
      expect(error).toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    });

    it('a replay returns the bet even after the bet rules were tightened', async () => {
      const legsOn = await Promise.all([1, 2, 3].map(() => createEvent(handle.db, ids)));
      const userId = await player();
      const key = betKey();
      const legs = legsOn.map((e) => ({ selectionId: e.home, oddsMilli: 2000 }));
      const first = await place(handle.db, userId, { stake: birr(5), legs, key, settings });
      const balance = await getBalance(handle.db, cash(userId));
      // The back office lowers the leg limit and raises the minimum stake afterwards.
      const tightened: GameSettings = {
        ...settings,
        betRules: { ...settings.betRules, maxLegs: 2, minStake: birr(10) },
      };
      const again = await place(handle.db, userId, {
        stake: birr(5),
        legs,
        key,
        settings: tightened,
      });
      expect(again).toMatchObject({ replayed: true, bet: { id: first.bet.id } });
      expect(await getBalance(handle.db, cash(userId))).toBe(balance);
      // A new key is checked against the new rules.
      const error = await domainError(
        place(handle.db, userId, { stake: birr(5), legs, settings: tightened }),
      );
      expect(error).toMatchObject({ status: 422, code: 'slip_invalid' });
      expect(JSON.stringify(error.details)).toContain('too_many_legs');
    });

    it('the same key may be used by another player', async () => {
      const key = betKey();
      const legs = [{ selectionId: event.draw, oddsMilli: 3200 }];
      const a = await place(handle.db, await player(), { stake: birr(5), legs, key, settings });
      const b = await place(handle.db, await player(), { stake: birr(5), legs, key, settings });
      expect(a.bet.id).not.toBe(b.bet.id);
      expect(b.replayed).toBe(false);
    });

    it('concurrent requests with one key place one bet', async () => {
      const userId = await player();
      const key = betKey();
      const legs = [{ selectionId: event.draw, oddsMilli: 3200 }];
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          place(handle.db, userId, { stake: birr(10), legs, key, settings }),
        ),
      );
      expect(new Set(results.map((r) => r.bet.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await getBalance(handle.db, cash(userId))).toBe(birr(990));
    });
  });

  describe('selection availability', () => {
    it('409 selection_unavailable for unknown, malformed and suspended selections', async () => {
      const own = await createEvent(handle.db, ids);
      await handle.db.transaction((tx) => setMarketStatus(tx, own.marketIds.ou, 'suspended'));
      const userId = await player();
      const error = await domainError(
        place(handle.db, userId, {
          stake: birr(10),
          legs: [
            { selectionId: '00000000-0000-4000-8000-000000000000', oddsMilli: 2000 },
            { selectionId: 'not-a-uuid', oddsMilli: 2000 },
            { selectionId: own.over, oddsMilli: 1900 },
            { selectionId: event.home, oddsMilli: 2000 },
          ],
          settings,
        }),
      );
      expect(error).toMatchObject({ status: 409, code: 'selection_unavailable' });
      expect(error.details).toEqual({
        selections: [
          { selectionId: '00000000-0000-4000-8000-000000000000', reason: 'not_found' },
          { selectionId: 'not-a-uuid', reason: 'not_found' },
          { selectionId: own.over, reason: 'suspended' },
        ],
      });
      expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
    });

    it('refuses an event past its start time and an event with betting closed', async () => {
      const started = await createEvent(handle.db, ids, {
        startTime: new Date(Date.now() + 60_000),
      });
      const userId = await player();
      const later = new Date(Date.now() + 120_000);
      const error = await domainError(
        place(handle.db, userId, {
          stake: birr(10),
          legs: [{ selectionId: started.home, oddsMilli: 2000 }],
          settings,
          now: later,
        }),
      );
      expect(error.details).toEqual({
        selections: [{ selectionId: started.home, reason: 'event_started' }],
      });

      const closed = await createEvent(handle.db, ids);
      await handle.db
        .update(events)
        .set({ bettingOpen: false })
        .where(eq(events.id, closed.eventId));
      expect(
        (
          await domainError(
            place(handle.db, userId, {
              stake: birr(10),
              legs: [{ selectionId: closed.home, oddsMilli: 2000 }],
              settings,
            }),
          )
        ).details,
      ).toEqual({ selections: [{ selectionId: closed.home, reason: 'suspended' }] });
    });

    it('refuses a selection of an inactive competition', async () => {
      const own = await createEvent(handle.db, ids);
      const competitionId = ids.competitions.get('football/premier-league')!;
      await handle.db
        .update(competitions)
        .set({ active: false })
        .where(eq(competitions.id, competitionId));
      try {
        const error = await domainError(
          place(handle.db, await player(), {
            stake: birr(10),
            legs: [{ selectionId: own.home, oddsMilli: 2000 }],
            settings,
          }),
        );
        expect(error.details).toEqual({
          selections: [{ selectionId: own.home, reason: 'inactive' }],
        });
      } finally {
        await handle.db
          .update(competitions)
          .set({ active: true })
          .where(eq(competitions.id, competitionId));
      }
    });
  });

  describe('odds-change policy', () => {
    let own: TestEvent;
    let down: TestEvent;
    beforeAll(async () => {
      own = await createEvent(handle.db, ids, { odds: { home: 2100 } });
      down = await createEvent(handle.db, ids, { odds: { away: 2900 } });
    });
    // The client still shows 2.00 / 3.00: one home win has gone up, the other away win down.
    const legsSeen = () => [
      { selectionId: own.home, oddsMilli: 2000 },
      { selectionId: down.away, oddsMilli: 3000 },
    ];

    it('none: any change is 409 odds_changed listing every changed leg', async () => {
      const own2 = await createEvent(handle.db, ids, { odds: { home: 2100 } });
      const error = await domainError(
        place(handle.db, await player(), {
          stake: birr(10),
          legs: [{ selectionId: own2.home, oddsMilli: 2000 }],
          policy: 'none',
          settings,
        }),
      );
      expect(error).toMatchObject({ status: 409, code: 'odds_changed' });
      expect(error.details).toEqual({
        policy: 'none',
        changes: [
          {
            selectionId: own2.home,
            requestedOddsMilli: 2000,
            currentOddsMilli: 2100,
            direction: 'up',
          },
        ],
      });
    });

    it('higher: a higher price is taken at the current odds', async () => {
      const { bet } = await place(handle.db, await player(), {
        stake: birr(10),
        legs: [{ selectionId: own.home, oddsMilli: 2000 }],
        policy: 'higher',
        settings,
      });
      expect(bet.totalOddsMilli).toBe(2100n);
      expect(bet.legs[0]).toMatchObject({ oddsMilli: 2100, requestedOddsMilli: 2000 });
      expect(bet.potentialGrossPayout).toBe(birr(21));
    });

    it('higher: a lower price is refused', async () => {
      const error = await domainError(
        place(handle.db, await player(), {
          stake: birr(10),
          legs: legsSeen(),
          policy: 'higher',
          settings,
        }),
      );
      expect(error.code).toBe('odds_changed');
      expect(
        (error.details as { changes: Array<{ direction: string }> }).changes.map(
          (c) => c.direction,
        ),
      ).toEqual(['up', 'down']);
    });

    it('any: the current odds are taken, up or down', async () => {
      const { bet } = await place(handle.db, await player(), {
        stake: birr(10),
        legs: legsSeen(),
        policy: 'any',
        settings,
      });
      // 2.1 × 2.9 = 6.09
      expect(bet.totalOddsMilli).toBe(6090n);
      expect(bet.legs.map((l) => [l.oddsMilli, l.requestedOddsMilli])).toEqual([
        [2100, 2000],
        [2900, 3000],
      ]);
    });
  });

  describe('slip validation', () => {
    it.each([
      ['no legs', [], birr(10), 'no_selections'],
      ['a stake of zero', 'home', 0n, 'invalid_stake'],
      ['invalid client odds', 'bad-odds', birr(10), 'invalid_odds'],
      ['the same selection twice', 'twice', birr(10), 'duplicate_selection'],
      ['two selections of one event', 'same-event', birr(10), 'duplicate_event'],
      ['a stake below the minimum', 'home', birr(4), 'stake_below_minimum'],
      ['a stake above the maximum', 'home', birr(100_001), 'stake_above_maximum'],
    ] as const)('%s is 422 slip_invalid', async (_, legsKind, stake, code) => {
      const legs =
        legsKind === 'home'
          ? [{ selectionId: event.home, oddsMilli: 2000 }]
          : legsKind === 'bad-odds'
            ? [{ selectionId: event.home, oddsMilli: 999 }]
            : legsKind === 'twice'
              ? [
                  { selectionId: event.home, oddsMilli: 2000 },
                  { selectionId: event.home, oddsMilli: 2000 },
                ]
              : legsKind === 'same-event'
                ? [
                    { selectionId: event.home, oddsMilli: 2000 },
                    { selectionId: event.over, oddsMilli: 1900 },
                  ]
                : [];
      const userId = await player(birr(200_000));
      const error = await domainError(
        place(handle.db, userId, { stake, legs: [...legs], settings }),
      );
      expect(error).toMatchObject({ status: 422, code: 'slip_invalid' });
      expect(
        (error.details as { errors: Array<{ code: string }> }).errors.map((e) => e.code),
      ).toContain(code);
    });

    it('odds below the per-leg minimum are refused', async () => {
      const low = await createEvent(handle.db, ids, { odds: { home: 1005 } });
      const error = await domainError(
        place(handle.db, await player(), {
          stake: birr(10),
          legs: [{ selectionId: low.home, oddsMilli: 1005 }],
          settings,
        }),
      );
      expect((error.details as { errors: Array<{ code: string }> }).errors[0]?.code).toBe(
        'odds_below_minimum',
      );
    });
  });

  it('posts the stake last, so the shared house_stakes lock is held only until commit', async () => {
    // Every bet locks the house_stakes account row from its stake posting until commit; any
    // write after the posting would make every other bet in the system wait for it too.
    const userId = await player();
    const queries: string[] = [];
    const logged = drizzle(handle.pool, {
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });
    await place(logged, userId, {
      stake: birr(10),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
      policy: 'any',
    });
    const firstLock = queries.findIndex((q) => /^update "ledger_accounts"/.test(q));
    expect(firstLock).toBeGreaterThan(0);
    const afterLock = queries.slice(firstLock);
    expect(
      afterLock.filter((q) => /^(insert|update|delete)/.test(q) && !/"ledger_/.test(q)),
    ).toEqual([]);
    expect(afterLock.filter((q) => /^select/.test(q))).toEqual([]);
    for (const table of ['bets', 'bet_legs', 'outbox_events', 'audit_log']) {
      const write = queries.findIndex((q) => q.startsWith(`insert into "${table}"`));
      expect(write, table).toBeGreaterThanOrEqual(0);
      expect(write, table).toBeLessThan(firstLock);
    }
  });

  describe('funds and responsible gambling', () => {
    it('422 insufficient_funds without writing anything', async () => {
      const userId = await player(birr(5));
      const error = await domainError(
        place(handle.db, userId, {
          stake: birr(6),
          legs: [{ selectionId: event.home, oddsMilli: 2000 }],
          settings,
        }),
      );
      expect(error).toMatchObject({
        status: 422,
        code: 'insufficient_funds',
        details: { balance: '500', stake: '600' },
      });
      const [n] = await handle.db.select({ n: count() }).from(bets).where(eq(bets.userId, userId));
      expect(n?.n).toBe(0);
    });

    it('a self-excluded player is refused (403 self_excluded)', async () => {
      const userId = await player();
      const now = new Date();
      await handle.db
        .insert(rgExclusions)
        .values({ userId, kind: 'self_exclusion', startsAt: now, endsAt: null });
      const error = await domainError(
        place(handle.db, userId, {
          stake: birr(10),
          legs: [{ selectionId: event.home, oddsMilli: 2000 }],
          settings,
          now,
        }),
      );
      expect(error).toMatchObject({ status: 403, code: 'self_excluded' });
      expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
    });

    it('a loss limit is enforced: open stakes count as lost', async () => {
      const userId = await player();
      const now = new Date();
      await handle.db.insert(rgLimits).values({
        userId,
        kind: 'loss',
        period: 'day',
        amount: birr(50),
        effectiveFrom: now,
        createdAt: now,
      });
      const legs = [{ selectionId: event.home, oddsMilli: 2000 }];
      await place(handle.db, userId, { stake: birr(30), legs, settings, now });
      const error = await domainError(
        place(handle.db, userId, { stake: birr(30), legs, settings, now }),
      );
      expect(error).toMatchObject({
        status: 422,
        code: 'loss_limit_exceeded',
        details: { period: 'day', limit: '5000', used: '3000' },
      });
      await place(handle.db, userId, { stake: birr(20), legs, settings, now });
    });

    it('50 concurrent bets never overdraw the balance', async () => {
      const userId = await player(birr(100));
      const legs = [{ selectionId: event.home, oddsMilli: 2000 }];
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          // Each call is its own transaction on its own pool connection.
          place(handle.db, userId, { stake: birr(10), legs, settings }),
        ),
      );
      const placed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(placed).toHaveLength(10);
      for (const r of refused) {
        expect((r.reason as DomainError).code).toBe('insufficient_funds');
      }
      expect(await getBalance(handle.db, cash(userId))).toBe(0n);
      const [n] = await handle.db
        .select({ n: count() })
        .from(bets)
        .where(and(eq(bets.userId, userId), eq(bets.status, 'open')));
      expect(n?.n).toBe(10);
    });
  });

  it('draws a new short id on a collision', async () => {
    const fixed = Uint8Array.from({ length: BET_SHORT_ID_LENGTH }, (_, i) => i);
    const run = (userId: string, bytes: (n: number) => Uint8Array) =>
      handle.db.transaction((tx) =>
        placeBet(tx, {
          userId,
          legs: [{ selectionId: event.home, oddsMilli: 2000 }],
          stake: birr(5),
          policy: 'none',
          idempotencyKey: betKey(),
          now: new Date(),
          settings,
          randomBytes: bytes,
        }),
      );
    const first = await run(await player(), () => fixed);
    let calls = 0;
    const second = await run(await player(), (n) => {
      calls += 1;
      return calls === 1 ? fixed : randomBytes(n);
    });
    expect(calls).toBe(2);
    expect(second.bet.shortId).not.toBe(first.bet.shortId);
    const legRows = await handle.db.select().from(betLegs).where(eq(betLegs.betId, second.bet.id));
    expect(legRows).toHaveLength(1);
  });
});

describe('quoteSlip', () => {
  it('quotes the available legs at current odds and flags the rest', async () => {
    const a = await createEvent(handle.db, ids, { odds: { home: 2000 } });
    const b = await createEvent(handle.db, ids, { odds: { over: 1500 } });
    const c = await createEvent(handle.db, ids);
    await handle.db.transaction((tx) => setMarketStatus(tx, c.marketIds['1x2'], 'suspended'));
    const result = await quoteSlip(handle.db, {
      legs: [
        { selectionId: a.home, oddsMilli: 1900 },
        { selectionId: b.over },
        { selectionId: c.home, oddsMilli: 2000 },
        { selectionId: '00000000-0000-4000-8000-000000000001' },
      ],
      stake: birr(100),
      settings,
      now: new Date(),
    });
    expect(
      result.legs.map((leg) => [leg.available, leg.reason, leg.currentOddsMilli, leg.oddsChanged]),
    ).toEqual([
      [true, null, 2000, true],
      [true, null, 1500, false],
      [false, 'suspended', 2000, false],
      [false, 'not_found', null, false],
    ]);
    expect(result.quote).toMatchObject({
      legCount: 2,
      totalOddsMilli: 3000n,
      grossPayout: birr(300),
      // 20% of 200 ETB winnings.
      taxAmount: birr(40),
      netPayout: birr(260),
      errors: [],
    });
    expect(result.legs[0]?.selection?.homeTeam.en).toBe('Arsenal');
  });

  it('returns slip errors (stake below minimum) with the potential payout', async () => {
    const a = await createEvent(handle.db, ids);
    const result = await quoteSlip(handle.db, {
      legs: [{ selectionId: a.home }],
      stake: birr(1),
      settings,
      now: new Date(),
    });
    expect(result.quote.errors.map((e) => e.code)).toEqual(['stake_below_minimum']);
    expect(result.quote.grossPayout).toBe(birr(2));
  });
});
