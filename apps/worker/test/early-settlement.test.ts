import { randomUUID } from 'node:crypto';
import { MARKET_RESULTED, schema, type GameSettings } from '@vamos/db';
import { isSuspended, type MockFeedProvider } from '@vamos/feed';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockFeedProvider } from '../src/tasks/feed-ingest';
import {
  certainResultOf,
  newSimRecord,
  runLiveSimTick,
  simulateTo,
  type LiveSimOptions,
} from '../src/tasks/live-sim';
import { createOutboxDispatcher, type OutboxDispatcher } from '../src/tasks/outbox-dispatch';
import { settleEvent, settlementTask } from '../src/tasks/settlement';
import { userNotifyTask } from '../src/tasks/user-notify';
import type { WorkerTask } from '../src/worker';
import {
  balances,
  betRow,
  createEvent,
  eventually,
  fundedUser,
  place,
  testSettings,
} from './betting';
import {
  createWorkerTestContext,
  feedFixture,
  insertFixture,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/**
 * Early market settlement end to end: the live simulator results a market
 * whose outcome the score already decides (resultMarket → market.resulted),
 * the dispatcher queues it, the settlement consumer settles the bets on that
 * market before full time, and the player hears it on their push channel.
 */

let t: WorkerTestContext;
let provider: MockFeedProvider;
let settings: GameSettings;
let dispatcher: OutboxDispatcher;
let consumers: WorkerTask[];

beforeAll(async () => {
  t = await createWorkerTestContext();
  provider = await createMockFeedProvider(t.db.db, { rolling: null });
  settings = await testSettings(t.db.db);
  dispatcher = createOutboxDispatcher(t.ctx);
  consumers = [settlementTask(t.ctx), userNotifyTask(t.ctx)];
  for (const task of consumers) await task.start();
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const task of [...(consumers ?? [])].reverse()) await task.stop();
  await dispatcher?.close();
  await t?.close();
}, SETUP_TIMEOUT);

const KEY_PREFIX = 'early:';

function options(feedProvider: string): LiveSimOptions {
  return { simSpeed: 1, feedProvider, keyPrefix: KEY_PREFIX };
}

/**
 * A football fixture whose seeded simulation has its first goal within 80
 * simulated minutes and is still running 10 minutes later (SIM_SPEED 1:
 * a second is a minute). Returns the second of the goal.
 */
async function fixtureWithEarlyGoal(feedProvider: string, start: Date) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const fixture = feedFixture('football', 'premier-league', 'Man City', 'Burnley', start);
    const eventId = await insertFixture(t, provider, fixture, feedProvider);
    const seed = `early-${eventId}`;
    await t.db.pool.query('UPDATE events SET sim_seed = $2 WHERE id = $1', [eventId, seed]);
    let record = newSimRecord({ id: eventId, sport: 'football', startTime: start }, seed);
    for (let second = 1; second <= 80; second++) {
      record = simulateTo(
        record,
        provider.strengths(fixture),
        new Date(start.getTime() + second * 1000),
        1,
      );
      if (record.state.home + record.state.away > 0) {
        if (second < 2) break;
        return { eventId, goalAt: second, suspendedAtGoal: isSuspended(record.state) };
      }
    }
  }
  throw new Error('no fixture with an early goal found');
}

async function selectionIds(eventId: string) {
  const { rows } = await t.db.pool.query<{
    id: string;
    key: string;
    code: string;
    odds_milli: number;
  }>(
    `SELECT s.id, m.key, s.code, s.odds_milli
       FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.event_id = $1`,
    [eventId],
  );
  const find = (key: string, code: string) => {
    const row = rows.find((r) => r.key === key && r.code === code);
    if (row === undefined) throw new Error(`no ${key}/${code}`);
    return { selectionId: row.id, oddsMilli: row.odds_milli };
  };
  return find;
}

async function eventStatus(eventId: string): Promise<string> {
  const { rows } = await t.db.pool.query<{ status: string }>(
    'SELECT status FROM events WHERE id = $1',
    [eventId],
  );
  return rows[0]!.status;
}

describe('early market settlement', () => {
  it(
    'settles a bet on a totals market as soon as the line is passed, before full time',
    async () => {
      const feedProvider = `mock-early-${randomUUID()}`;
      const start = new Date(Date.now() + 3600_000);
      t.clock.set(new Date(start.getTime() - 60_000));
      const { eventId, goalAt } = await fixtureWithEarlyGoal(feedProvider, start);
      const find = await selectionIds(eventId);
      const over = find('ou:0.5', 'over');
      const under = find('ou:0.5', 'under');
      const other = await createEvent(t);
      const otherHome = { selectionId: other.home, oddsMilli: 2000 };

      const backer = await fundedUser(t.db.db);
      const layer = await fundedUser(t.db.db);
      const now = t.clock.now;
      const overBet = await place(t.db.db, backer, { stake: 1_000n, legs: [over], settings, now });
      const underBet = await place(t.db.db, layer, { stake: 1_000n, legs: [under], settings, now });
      // An accumulator with a leg on another match still to be played stays open.
      const acca = await place(t.db.db, backer, {
        stake: 500n,
        legs: [over, otherHome],
        settings,
        now,
      });
      for (const placed of [overBet, underBet, acca]) expect(placed.bet.status).toBe('open');
      const placedBalances = await balances(t.db.db, backer);
      await dispatcher.run();

      // Kick-off, then the minute of the first goal.
      t.clock.set(new Date(start.getTime() + 1000));
      expect((await runLiveSimTick(t.ctx, options(feedProvider))).failed).toEqual([]);
      t.clock.set(new Date(start.getTime() + goalAt * 1000));
      const tick = await runLiveSimTick(t.ctx, options(feedProvider));
      expect(tick.failed).toEqual([]);
      expect(tick.marketsResulted).toBeGreaterThanOrEqual(1);
      expect(await eventStatus(eventId)).toBe('live');

      const [market] = await t.db.db
        .select()
        .from(schema.markets)
        .where(and(eq(schema.markets.eventId, eventId), eq(schema.markets.key, 'ou:0.5')));
      expect(market?.status).toBe('settled');
      const resulted = await t.db.db
        .select()
        .from(schema.outboxEvents)
        .where(
          and(
            eq(schema.outboxEvents.type, MARKET_RESULTED),
            eq(schema.outboxEvents.aggregateId, market!.id),
          ),
        );
      expect(resulted).toHaveLength(1);
      // The market delta went out on the live channel.
      await t.waitForMessages((messages) =>
        messages.some(
          (m) => m.type === 'market' && m.data.k === market!.id && m.data.st === 'settled',
        ),
      );

      // market.resulted → settlement: both singles settle while the match is live.
      await dispatcher.run();
      await eventually(
        async () => (await betRow(t.db.db, overBet.bet.id)).status === 'won',
        10_000,
        'the over bet to win',
      );
      await eventually(
        async () => (await betRow(t.db.db, underBet.bet.id)).status === 'lost',
        10_000,
        'the under bet to lose',
      );
      expect(await eventStatus(eventId)).toBe('live');
      const won = await betRow(t.db.db, overBet.bet.id);
      expect(won.settledGrossPayout).toBe((1_000n * BigInt(over.oddsMilli)) / 1000n);
      expect((await balances(t.db.db, backer)).cash).toBe(
        placedBalances.cash + won.settledNetPayout!,
      );
      expect((await betRow(t.db.db, acca.bet.id)).status).toBe('open');
      const accaLegs = await t.db.db
        .select()
        .from(schema.betLegs)
        .where(eq(schema.betLegs.betId, acca.bet.id));
      expect(accaLegs.find((leg) => leg.selectionId === over.selectionId)?.state).toBe('won');

      // The players hear it on their own channels (after the settlement committed).
      await dispatcher.run();
      await eventually(
        async () =>
          t.userMessages.some((m) => m.userId === backer && m.message.type === 'bet.settled') &&
          t.userMessages.some((m) => m.userId === layer && m.message.type === 'bet.settled'),
        10_000,
        'the bet.settled pushes',
      );
      const backerPushes = t.userMessages.filter((m) => m.userId === backer);
      const settledPush = backerPushes.find((m) => m.message.type === 'bet.settled');
      expect(settledPush?.message).toEqual({
        type: 'bet.settled',
        data: {
          betId: overBet.bet.id,
          shortId: overBet.bet.shortId,
          status: 'won',
          gross: won.settledGrossPayout!.toString(),
          tax: won.settledTax!.toString(),
          net: won.settledNetPayout!.toString(),
          corrected: false,
        },
      });
      expect(
        t.userMessages
          .filter((m) => m.userId === layer)
          .every(
            (m) => m.message.type !== 'bet.settled' || m.message.data.betId === underBet.bet.id,
          ),
      ).toBe(true);

      // Play the match out: full time leaves the early result as it is and settles the rest.
      for (
        let second = goalAt + 1;
        second <= 140 && (await eventStatus(eventId)) === 'live';
        second++
      ) {
        t.clock.set(new Date(start.getTime() + second * 1000));
        expect((await runLiveSimTick(t.ctx, options(feedProvider))).failed).toEqual([]);
      }
      expect(await eventStatus(eventId)).toBe('finished');
      // Full time left the early result as it was.
      const [final] = await t.db.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market!.id));
      expect(final?.status).toBe('settled');
      await dispatcher.run();
      // (The event.resulted job runs too; settling again here is idempotent.)
      const fullTime = await settleEvent(t.ctx, eventId);
      expect(fullTime.failed).toEqual([]);
      expect(fullTime.outcomes.settled + fullTime.outcomes.resettled).toBe(0);
      expect((await betRow(t.db.db, acca.bet.id)).status).toBe('open');
      const after = await betRow(t.db.db, overBet.bet.id);
      expect(after.status).toBe('won');
      expect(after.settlementVersion).toBe(0);
      expect(after.settledNetPayout).toBe(won.settledNetPayout);
    },
    TEST_TIMEOUT * 2,
  );
});

describe('certainResultOf', () => {
  it('decides only markets whose outcome the score fixes, and never throws', () => {
    const score = { home: 1, away: 1, htHome: null, htAway: null };
    expect(certainResultOf({ type: 'ou', line: '1.5' }, score)).toEqual({
      over: 'won',
      under: 'lost',
    });
    expect(certainResultOf({ type: 'ou', line: '2.5' }, score)).toBeNull();
    expect(certainResultOf({ type: 'btts', line: null }, score)).toEqual({
      yes: 'won',
      no: 'lost',
    });
    expect(certainResultOf({ type: '1x2', line: null }, score)).toBeNull();
    // Unknown types and malformed lines are left alone (closed as before).
    expect(certainResultOf({ type: 'corners', line: null }, score)).toBeNull();
    expect(certainResultOf({ type: 'ou', line: 'abc' }, score)).toBeNull();
  });
});
