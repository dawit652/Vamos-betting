import { BET_PLACED, schema, type GameSettings } from '@vamos/db';
import { Queue } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/lib/queues';
import {
  betAcceptanceTask,
  decidePendingBet,
  runAcceptanceSweep,
} from '../src/tasks/bet-acceptance';
import {
  createOutboxDispatcher,
  outboxJobId,
  type OutboxDispatcher,
} from '../src/tasks/outbox-dispatch';
import { processSettlementJob, settlementTask } from '../src/tasks/settlement';
import type { WorkerTask } from '../src/worker';
import {
  balances,
  betRow,
  createEvent,
  eventually,
  finish,
  fundedUser,
  goLive,
  place,
  reprice,
  testSettings,
} from './betting';
import {
  createWorkerTestContext,
  REDIS_URL,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/** Live bets wait this long (fake clock) before acceptance. */
const LIVE_DELAY_MS = 300;

let t: WorkerTestContext;
let settings: GameSettings;
let dispatcher: OutboxDispatcher;
let consumers: WorkerTask[];
let settlementQueue: Queue;

beforeAll(async () => {
  t = await createWorkerTestContext();
  settings = await testSettings(t.db.db, LIVE_DELAY_MS);
  dispatcher = createOutboxDispatcher(t.ctx);
  consumers = [settlementTask(t.ctx), betAcceptanceTask(t.ctx)];
  for (const task of consumers) await task.start();
  settlementQueue = new Queue(QUEUE_NAMES.settlement, {
    connection: { url: REDIS_URL },
    prefix: t.queuePrefix,
  });
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const task of [...(consumers ?? [])].reverse()) await task.stop();
  await dispatcher?.close();
  await settlementQueue?.close();
  await t?.close();
}, SETUP_TIMEOUT);

const status = async (betId: string) => (await betRow(t.db.db, betId)).status;

async function waitForStatus(betId: string, wanted: string, ms = 10_000) {
  await eventually(async () => (await status(betId)) === wanted, ms, `bet ${betId} ${wanted}`);
}

describe('settlement consumer', () => {
  it(
    'settles the bets of a resulted event and re-settles them after a correction',
    async () => {
      const event = await createEvent(t);
      const other = await createEvent(t);
      const now = t.clock.now;
      const winner = await fundedUser(t.db.db);
      const loser = await fundedUser(t.db.db);
      const acca = await fundedUser(t.db.db);
      const startWinner = await balances(t.db.db, winner);

      const homeBet = await place(t.db.db, winner, {
        stake: 10_000n,
        legs: [{ selectionId: event.home, oddsMilli: 2000 }],
        settings,
        now,
      });
      const awayBet = await place(t.db.db, loser, {
        stake: 5_000n,
        legs: [{ selectionId: event.away, oddsMilli: 3500 }],
        settings,
        now,
      });
      // An accumulator with a leg on an event that has not been resulted stays open.
      const accaBet = await place(t.db.db, acca, {
        stake: 2_000n,
        legs: [
          { selectionId: event.home, oddsMilli: 2000 },
          { selectionId: other.home, oddsMilli: 2000 },
        ],
        settings,
        now,
      });
      expect(homeBet.bet.status).toBe('open');
      const placed = await balances(t.db.db, winner);
      expect(placed.cash).toBe(startWinner.cash - 10_000n);

      t.clock.advance(3 * 3600_000);
      await finish(t.db.db, event.eventId, 2, 1);
      expect((await dispatcher.run()).jobs).toBeGreaterThanOrEqual(1);
      await waitForStatus(homeBet.bet.id, 'won');
      await waitForStatus(awayBet.bet.id, 'lost');

      const won = await betRow(t.db.db, homeBet.bet.id);
      expect(won.settlementVersion).toBe(0);
      expect(won.settledNetPayout).not.toBeNull();
      expect(won.settledNetPayout!).toBeGreaterThan(10_000n);
      expect(won.settledGrossPayout).toBe(20_000n);
      expect(won.settledAt).toEqual(t.clock.now);
      const afterWin = await balances(t.db.db, winner);
      expect(afterWin.cash).toBe(startWinner.cash - 10_000n + won.settledNetPayout!);
      expect((await balances(t.db.db, loser)).cash).toBe(100_000n - 5_000n);
      expect(await status(accaBet.bet.id)).toBe('open');

      // The house: both settled stakes left house_stakes; only the acca's stake is still open.
      // (house accounts are shared by the whole file, so compare with the state before resulting)
      expect(afterWin.stakes).toBe(placed.stakes - 10_000n - 5_000n);
      expect(afterWin.tax).toBe(placed.tax + won.settledTax!);
      expect(afterWin.revenue).toBe(placed.revenue + 5_000n - (20_000n - 10_000n));

      // A replay of the same job changes nothing.
      const replay = await processSettlementJob(t.ctx, {
        outboxId: '0',
        type: 'event.resulted',
        eventId: event.eventId,
      });
      expect(replay.outcomes).toMatchObject({ settled: 0, resettled: 0, unchanged: 3 });
      expect(await balances(t.db.db, winner)).toEqual(afterWin);

      // Correction 0-1: the home bet loses, the away bet wins (settlement version 1).
      t.clock.advance(60_000);
      const corrected = await finish(t.db.db, event.eventId, 0, 1);
      expect(corrected.outcome).toBe('corrected');
      await dispatcher.run();
      await waitForStatus(homeBet.bet.id, 'lost');
      await waitForStatus(awayBet.bet.id, 'won');
      // The accumulator's home leg lost too (settled by the same job, after the singles).
      await waitForStatus(accaBet.bet.id, 'lost');
      const relost = await betRow(t.db.db, homeBet.bet.id);
      const rewon = await betRow(t.db.db, awayBet.bet.id);
      expect(relost.settlementVersion).toBe(1);
      expect(rewon.settlementVersion).toBe(1);
      expect(rewon.settledGrossPayout).toBe(17_500n);
      const afterCorrection = await balances(t.db.db, winner);
      expect(afterCorrection.cash).toBe(startWinner.cash - 10_000n);
      expect((await balances(t.db.db, loser)).cash).toBe(
        100_000n - 5_000n + rewon.settledNetPayout!,
      );
      // Every stake has left house_stakes.
      expect(afterCorrection.stakes).toBe(placed.stakes - 17_000n);
      expect(afterCorrection.tax).toBe(placed.tax + rewon.settledTax!);
      expect(afterCorrection.revenue).toBe(placed.revenue + 10_000n + 2_000n - (17_500n - 5_000n));

      // Every job of this file ran once per outbox row.
      const completed = await settlementQueue.getCompleted();
      const ids = completed.map((job) => job.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id?.startsWith('outbox-'))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('live bet acceptance', () => {
  async function liveEvent() {
    const event = await createEvent(t);
    await goLive(t.db.db, event.eventId);
    return event;
  }

  it(
    'accepts a pending live bet once its delay is over',
    async () => {
      const event = await liveEvent();
      const userId = await fundedUser(t.db.db);
      const { bet } = await place(t.db.db, userId, {
        stake: 1_000n,
        legs: [{ selectionId: event.home, oddsMilli: 2000 }],
        settings,
        now: t.clock.now,
      });
      expect(bet.status).toBe('pending_acceptance');
      expect(bet.acceptAfter).toEqual(new Date(t.clock.now.getTime() + LIVE_DELAY_MS));

      await dispatcher.run();
      // The job's real-time delay passes, but the bet is not due by the clock yet.
      await new Promise((resolve) => setTimeout(resolve, LIVE_DELAY_MS * 2));
      expect(await status(bet.id)).toBe('pending_acceptance');

      t.clock.advance(LIVE_DELAY_MS);
      await waitForStatus(bet.id, 'open');
      const row = await betRow(t.db.db, bet.id);
      expect(row.acceptedAt).toEqual(t.clock.now);
      expect((await balances(t.db.db, userId)).cash).toBe(100_000n - 1_000n);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects and refunds a pending live bet whose odds moved (policy none)',
    async () => {
      const event = await liveEvent();
      const userId = await fundedUser(t.db.db);
      const { bet } = await place(t.db.db, userId, {
        stake: 1_000n,
        legs: [{ selectionId: event.home, oddsMilli: 2000 }],
        settings,
        now: t.clock.now,
        policy: 'none',
      });
      expect((await balances(t.db.db, userId)).cash).toBe(99_000n);
      await reprice(t.db.db, event.home, 1800);
      t.clock.advance(LIVE_DELAY_MS);
      await dispatcher.run();
      await waitForStatus(bet.id, 'rejected');
      expect((await betRow(t.db.db, bet.id)).rejectReason).toBe('odds_changed');
      expect((await balances(t.db.db, userId)).cash).toBe(100_000n);
      // Deciding it again changes nothing.
      expect((await decidePendingBet(t.ctx, bet.id)).outcome).toBe('unchanged');
      expect((await balances(t.db.db, userId)).cash).toBe(100_000n);
    },
    TEST_TIMEOUT,
  );

  it(
    'the sweep decides a pending bet whose job never ran',
    async () => {
      const event = await liveEvent();
      const userId = await fundedUser(t.db.db);
      const { bet } = await place(t.db.db, userId, {
        stake: 1_000n,
        legs: [{ selectionId: event.draw, oddsMilli: 3200 }],
        settings,
        now: t.clock.now,
      });
      // The job is lost: its bet.placed row is marked published without being queued.
      await t.db.db
        .update(schema.outboxEvents)
        .set({ publishedAt: new Date() })
        .where(
          and(
            eq(schema.outboxEvents.type, BET_PLACED),
            eq(schema.outboxEvents.aggregateId, bet.id),
            isNull(schema.outboxEvents.publishedAt),
          ),
        );

      // Due, but within the sweep's grace period: left to the (missing) job.
      t.clock.advance(LIVE_DELAY_MS);
      expect(await runAcceptanceSweep(t.ctx, { graceMs: 1000 })).toMatchObject({ due: 0 });
      t.clock.advance(1000);
      expect(await runAcceptanceSweep(t.ctx, { graceMs: 1000 })).toMatchObject({
        due: 1,
        accepted: 1,
      });
      expect(await status(bet.id)).toBe('open');
      expect(await runAcceptanceSweep(t.ctx, { graceMs: 1000 })).toMatchObject({ due: 0 });
      // No job was ever queued for it.
      const acceptance = new Queue(QUEUE_NAMES.betAcceptance, {
        connection: { url: REDIS_URL },
        prefix: t.queuePrefix,
      });
      try {
        const [row] = await t.db.db
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(
            and(
              eq(schema.outboxEvents.type, BET_PLACED),
              eq(schema.outboxEvents.aggregateId, bet.id),
            ),
          );
        expect(await acceptance.getJob(outboxJobId(row!.id))).toBeUndefined();
      } finally {
        await acceptance.close();
      }
    },
    TEST_TIMEOUT,
  );
});
