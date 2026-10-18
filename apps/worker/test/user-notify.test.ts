import { randomUUID } from 'node:crypto';
import { UserMessage } from '@vamos/contracts';
import {
  BET_ACCEPTED,
  BET_CASHED_OUT,
  BET_PLACED,
  BET_REJECTED,
  BET_REOPENED,
  BET_SETTLED,
  cashOutBet,
  DEPOSIT_SUCCEEDED,
  EVENT_RESULTED,
  getCashOutOffer,
  getPlayerBalances,
  WITHDRAWAL_APPROVED,
  WITHDRAWAL_REQUESTED,
  type GameSettings,
  type OutboxEvent,
} from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/lib/queues';
import {
  createOutboxDispatcher,
  OUTBOX_ROUTES,
  USER_NOTIFY_TYPES,
  type OutboxDispatcher,
  type UserNotifyJobData,
} from '../src/tasks/outbox-dispatch';
import { processUserNotifyJob, userNotifyTask } from '../src/tasks/user-notify';
import type { WorkerTask } from '../src/worker';
import { createEvent, eventually, fundedUser, place, reprice, testSettings } from './betting';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function row(type: string, payload: unknown): OutboxEvent {
  return {
    id: 42n,
    jobKey: 'key',
    type,
    aggregateType: 'bet',
    aggregateId: randomUUID(),
    payload,
    createdAt: NOW,
    publishedAt: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
  };
}

/** The user-notify job an outbox row routes to (null when none). */
function notifyJob(type: string, payload: unknown): UserNotifyJobData | null {
  const jobs = (OUTBOX_ROUTES[type] ?? [])
    .map((route) => route(row(type, payload), NOW))
    .filter((job) => job !== null && job.queue === QUEUE_NAMES.userNotify);
  expect(jobs.length).toBeLessThanOrEqual(1);
  return (jobs[0]?.data as UserNotifyJobData | undefined) ?? null;
}

describe('user-notify routes', () => {
  const userId = randomUUID();
  const betId = randomUUID();
  const ref = { betId, userId, shortId: 'K7Q2M9XA' };

  it('builds the push of each bet event from its outbox payload', () => {
    expect(notifyJob(BET_ACCEPTED, { ...ref, oddsChanged: [] })).toMatchObject({
      userId,
      wallet: false,
      messages: [
        { type: 'bet.accepted', data: { betId, shortId: 'K7Q2M9XA', oddsChanged: false } },
      ],
    });
    expect(
      notifyJob(BET_ACCEPTED, { ...ref, oddsChanged: [{ selectionId: 'x', from: 1, to: 2 }] })
        ?.messages,
    ).toEqual([{ type: 'bet.accepted', data: { betId, shortId: 'K7Q2M9XA', oddsChanged: true } }]);
    expect(
      notifyJob(BET_REJECTED, { ...ref, reason: 'odds_changed', refund: '1000' }),
    ).toMatchObject({
      wallet: true,
      messages: [
        {
          type: 'bet.rejected',
          data: { betId, shortId: 'K7Q2M9XA', reason: 'odds_changed', refund: '1000' },
        },
      ],
    });
    expect(
      notifyJob(BET_SETTLED, {
        ...ref,
        status: 'won',
        version: 1,
        stake: '1000',
        grossPayout: '20000',
        taxAmount: '1800',
        netPayout: '18200',
        corrected: true,
        previous: null,
      }),
    ).toMatchObject({
      wallet: true,
      messages: [
        {
          type: 'bet.settled',
          data: {
            betId,
            shortId: 'K7Q2M9XA',
            status: 'won',
            gross: '20000',
            tax: '1800',
            net: '18200',
            corrected: true,
          },
        },
      ],
    });
    expect(
      notifyJob(BET_CASHED_OUT, {
        ...ref,
        stake: '1000',
        quotedGross: '900',
        gross: '950',
        tax: '0',
        net: '950',
        cashedOutAt: NOW.toISOString(),
      })?.messages,
    ).toEqual([
      {
        type: 'bet.cashed_out',
        data: { betId, shortId: 'K7Q2M9XA', gross: '950', tax: '0', net: '950' },
      },
    ]);
    expect(notifyJob(BET_REOPENED, { ...ref, version: 1, previous: null })?.messages).toEqual([
      { type: 'bet.reopened', data: { betId, shortId: 'K7Q2M9XA' } },
    ]);
    // Every type has a route, and every message built is a valid UserMessage.
    for (const type of [BET_ACCEPTED, BET_REJECTED, BET_SETTLED, BET_CASHED_OUT, BET_REOPENED]) {
      expect(USER_NOTIFY_TYPES).toContain(type);
    }
    const built = notifyJob(BET_REOPENED, { ...ref })!.messages;
    for (const message of built) expect(UserMessage.parse(message)).toEqual(message);
  });

  it('pushes only a wallet change for placements and payments', () => {
    for (const type of [BET_PLACED, DEPOSIT_SUCCEEDED, WITHDRAWAL_REQUESTED]) {
      expect(notifyJob(type, { ...ref, status: 'open', amount: '500' })).toEqual({
        outboxId: '42',
        type,
        userId,
        messages: [],
        wallet: true,
      });
    }
    // Not player-facing: no push.
    expect(notifyJob(EVENT_RESULTED, { eventId: randomUUID() })).toBeNull();
    expect(
      notifyJob(WITHDRAWAL_APPROVED, { payoutId: randomUUID(), userId, amount: '5' }),
    ).toBeNull();
  });

  it('routes no push for a payload without what it needs, without blocking the other jobs', () => {
    expect(notifyJob(BET_SETTLED, { ...ref, status: 'cashed_out' })).toBeNull();
    expect(notifyJob(BET_REJECTED, { betId, shortId: 'X' })).toBeNull();
    expect(notifyJob(WITHDRAWAL_REQUESTED, { userId: 'not-a-uuid', amount: '1' })).toBeNull();
    // A pending live bet still gets its acceptance job.
    const pending = row(BET_PLACED, {
      betId,
      status: 'pending_acceptance',
      acceptAfter: NOW.toISOString(),
    });
    const jobs = (OUTBOX_ROUTES[BET_PLACED] ?? [])
      .map((route) => route(pending, NOW))
      .filter((job) => job !== null);
    expect(jobs.map((job) => job.queue)).toEqual([QUEUE_NAMES.betAcceptance, QUEUE_NAMES.els]);
  });
});

describe('user-notify consumer', () => {
  let t: WorkerTestContext;
  let settings: GameSettings;
  let dispatcher: OutboxDispatcher;
  let consumers: WorkerTask[];

  beforeAll(async () => {
    t = await createWorkerTestContext();
    settings = await testSettings(t.db.db);
    dispatcher = createOutboxDispatcher(t.ctx);
    consumers = [userNotifyTask(t.ctx)];
    for (const task of consumers) await task.start();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const task of [...(consumers ?? [])].reverse()) await task.stop();
    await dispatcher?.close();
    await t?.close();
  }, SETUP_TIMEOUT);

  const pushesOf = (userId: string) =>
    t.userMessages.filter((m) => m.userId === userId).map((m) => m.message);

  it(
    "publishes a cash-out and the new balance on the player's own channel after commit",
    async () => {
      const event = await createEvent(t);
      const player = await fundedUser(t.db.db);
      const bystander = await fundedUser(t.db.db);
      const { bet } = await place(t.db.db, player, {
        stake: 10_000n,
        legs: [{ selectionId: event.home, oddsMilli: 2000 }],
        settings,
        now: t.clock.now,
      });
      await place(t.db.db, bystander, {
        stake: 1_000n,
        legs: [{ selectionId: event.away, oddsMilli: 3500 }],
        settings,
        now: t.clock.now,
      });

      // bet.placed → wallet.changed (the stake left the balance).
      await dispatcher.run();
      await eventually(
        async () => pushesOf(player).length >= 1 && pushesOf(bystander).length >= 1,
        10_000,
        'the placement pushes',
      );
      expect(pushesOf(player)).toEqual([
        { type: 'wallet.changed', data: { cash: '90000', bonus: '0' } },
      ]);

      await reprice(t.db.db, event.home, 1600);
      const offer = await getCashOutOffer(t.db.db, {
        userId: player,
        betId: bet.id,
        config: settings.cashOut,
        now: t.clock.now,
      });
      expect(offer?.available).toBe(true);
      const result = await t.db.db.transaction((tx) =>
        cashOutBet(tx, {
          userId: player,
          betId: bet.id,
          quotedGross: offer!.gross,
          idempotencyKey: `cash-out-${randomUUID()}`,
          now: t.clock.now,
          config: settings.cashOut,
        }),
      );
      expect(result.replayed).toBe(false);

      await dispatcher.run();
      await eventually(async () => pushesOf(player).length >= 3, 10_000, 'the cash-out pushes');
      const balances = await getPlayerBalances(t.db.db, player);
      expect(pushesOf(player).slice(1)).toEqual([
        {
          type: 'bet.cashed_out',
          data: {
            betId: bet.id,
            shortId: bet.shortId,
            gross: result.cashOut.gross.toString(),
            tax: result.cashOut.tax.toString(),
            net: result.cashOut.net.toString(),
          },
        },
        {
          type: 'wallet.changed',
          data: { cash: balances.cash.toString(), bonus: balances.bonus.toString() },
        },
      ]);
      expect(balances.cash).toBe(90_000n + result.cashOut.net);
      for (const { message } of t.userMessages) expect(UserMessage.parse(message)).toEqual(message);
      // The bystander only ever heard about their own stake.
      expect(pushesOf(bystander)).toEqual([
        { type: 'wallet.changed', data: { cash: '99000', bonus: '0' } },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'publishes the messages of a job directly (processUserNotifyJob)',
    async () => {
      const userId = await fundedUser(t.db.db, 12_345n);
      const result = await processUserNotifyJob(t.ctx, {
        outboxId: '1',
        type: BET_REOPENED,
        userId,
        messages: [{ type: 'bet.reopened', data: { betId: randomUUID(), shortId: 'ABCDEFGH' } }],
        wallet: true,
      });
      expect(result.published).toBe(2);
      await eventually(async () => pushesOf(userId).length === 2, 5_000, 'two pushes');
      expect(pushesOf(userId)[1]).toEqual({
        type: 'wallet.changed',
        data: { cash: '12345', bonus: '0' },
      });
      expect(
        (
          await processUserNotifyJob(t.ctx, {
            ...{ outboxId: '2', type: BET_ACCEPTED, userId },
            messages: [],
            wallet: false,
          })
        ).published,
      ).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
