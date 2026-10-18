import { randomUUID } from 'node:crypto';
import { UserMessage } from '@vamos/contracts';
import { birr, DEFAULT_TAX, type JackpotTemplate } from '@vamos/core';
import {
  createJackpotRound,
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  getBalance,
  getJackpotRound,
  MARKET_RESULTED,
  placeJackpotEntry,
  resultEvent,
  schema,
  updateJackpotTemplate,
  upsertFixture,
  type JackpotRound,
} from '@vamos/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOutboxDispatcher, type OutboxDispatcher } from '../src/tasks/outbox-dispatch';
import {
  jackpotSettlementTask,
  processJackpotSettlementJob,
  runJackpotRounds,
  runJackpotSettlementSweep,
  settleJackpotRounds,
} from '../src/tasks/jackpots';
import { userNotifyTask } from '../src/tasks/user-notify';
import type { WorkerTask } from '../src/worker';
import { cash, eventually, fundedUser } from './betting';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

const NOW = new Date('2026-10-17T08:00:00.000Z');
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
const LEAD_MS = 30 * MINUTE;

let t: WorkerTestContext;

/**
 * A small template for tests (3 games, 10 ETB a combination, at most 8):
 * 3 correct share 1,000 ETB, 2 correct win a fixed 20 ETB per combination.
 */
function smallTemplate(overrides: Partial<JackpotTemplate> = {}): JackpotTemplate {
  return {
    code: 'daily9',
    enabled: true,
    gameCount: 3,
    costPerCombination: birr(10),
    maxCombinations: 8,
    cancelledRule: 'all_win',
    prizeTiers: [
      { correct: 3, kind: 'shared', amount: birr(1_000) },
      { correct: 2, kind: 'fixed', amount: birr(20) },
    ],
    ...overrides,
  };
}

/** A prematch football fixture with a 1X2 market kicking off at `startTime`; returns its id. */
async function createGame(startTime: Date): Promise<string> {
  const lookup = (map: Map<string, string>, key: string) => {
    const value = map.get(key);
    if (value === undefined) throw new Error(`not seeded: ${key}`);
    return value;
  };
  const result = await t.db.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'test-feed',
        feedRef: `jackpot:${randomUUID()}`,
        sport: 'football',
        competitionId: lookup(t.ids.competitions, 'football/premier-league'),
        homeTeamId: lookup(t.ids.teams, 'football/Arsenal'),
        awayTeamId: lookup(t.ids.teams, 'football/Chelsea'),
        startTime,
      },
      [
        {
          type: '1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: 2000 },
            { code: 'X', oddsMilli: 3200 },
            { code: '2', oddsMilli: 3500 },
          ],
        },
      ],
    ),
  );
  return result.eventId;
}

async function createGames(count: number, firstStart: Date, spacingMs = 10 * MINUTE) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await createGame(new Date(firstStart.getTime() + i * spacingMs)));
  }
  return ids;
}

/** Takes every scheduled event out of the candidates (each test starts from a clean schedule). */
async function retireScheduledEvents(): Promise<void> {
  await t.db.db
    .update(schema.events)
    .set({ status: 'cancelled', bettingOpen: false })
    .where(eq(schema.events.status, 'scheduled'));
}

async function setTemplate(template: JackpotTemplate): Promise<void> {
  await t.db.db.transaction((tx) =>
    updateJackpotTemplate(tx, {
      code: template.code,
      value: template,
      actor: { type: 'system' },
    }),
  );
}

async function openRound(firstStart = at(60)): Promise<JackpotRound> {
  const eventIds = await createGames(3, firstStart);
  return t.db.db.transaction((tx) =>
    createJackpotRound(tx, { template: smallTemplate(), tax: DEFAULT_TAX, eventIds, now: NOW }),
  );
}

async function enter(userId: string, roundId: string, picks: string[][]) {
  const result = await t.db.db.transaction((tx) =>
    placeJackpotEntry(tx, {
      userId,
      roundId,
      picks,
      idempotencyKey: `jp-${randomUUID()}`,
      now: NOW,
    }),
  );
  return result.entry;
}

const SCORES = { '1': [2, 1], X: [1, 1], '2': [0, 1] } as const;

async function resultGame(eventId: string, result: '1' | 'X' | '2' | 'cancelled') {
  await t.db.db.transaction((tx) =>
    result === 'cancelled'
      ? resultEvent(tx, eventId, { status: 'cancelled' })
      : resultEvent(tx, eventId, {
          status: 'finished',
          score: { home: SCORES[result][0], away: SCORES[result][1] },
        }),
  );
}

async function roundOf(id: string): Promise<JackpotRound> {
  const round = await getJackpotRound(t.db.db, id);
  if (round === null) throw new Error(`no round ${id}`);
  return round;
}

async function entryRow(id: string) {
  const [row] = await t.db.db
    .select()
    .from(schema.jackpotEntries)
    .where(eq(schema.jackpotEntries.id, id));
  if (row === undefined) throw new Error(`no entry ${id}`);
  return row;
}

/** Marks every pending outbox row published (as if its jobs were lost). */
async function dropOutbox(): Promise<void> {
  await t.db.db
    .update(schema.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(schema.outboxEvents.publishedAt));
}

beforeAll(async () => {
  t = await createWorkerTestContext();
  await dropOutbox();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

beforeEach(() => {
  t.clock.set(NOW);
});

describe('jackpot-rounds task', () => {
  it(
    'keeps one round per enabled template open on valid events, never reusing an event within a template',
    async () => {
      await retireScheduledEvents();
      await setTemplate(smallTemplate());
      await setTemplate(
        smallTemplate({
          code: 'weekly13',
          gameCount: 2,
          maxCombinations: 9,
          prizeTiers: [{ correct: 2, kind: 'shared', amount: birr(5_000) }],
        }),
      );

      // Not eligible: kicks off within the lead time; its 1X2 market suspended.
      const tooSoon = await createGame(at(20));
      const suspended = await createGame(at(35));
      await t.db.db
        .update(schema.markets)
        .set({ status: 'suspended' })
        .where(eq(schema.markets.eventId, suspended));
      const valid = await createGames(7, at(40));

      const first = await runJackpotRounds(t.ctx, { leadMs: LEAD_MS, preferWithinMs: 0 });
      expect(first.templates).toEqual({ daily9: 'created', weekly13: 'created' });
      expect(first.created).toHaveLength(2);
      const rounds = await Promise.all(first.created.map(roundOf));
      const daily = rounds.find((round) => round.templateCode === 'daily9')!;
      const weekly = rounds.find((round) => round.templateCode === 'weekly13')!;
      expect(daily.games.map((game) => game.eventId)).toEqual(valid.slice(0, 3));
      expect(daily).toMatchObject({ status: 'open', gameCount: 3, closesAt: at(40) });
      expect(daily.tax).toEqual(DEFAULT_TAX);
      // Another template may use the same events.
      expect(weekly.games.map((game) => game.eventId)).toEqual(valid.slice(0, 2));
      for (const round of rounds) {
        const used = round.games.map((game) => game.eventId);
        expect(used).not.toContain(tooSoon);
        expect(used).not.toContain(suspended);
      }

      // Nothing more while they take entries.
      const again = await runJackpotRounds(t.ctx, { leadMs: LEAD_MS, preferWithinMs: 0 });
      expect(again).toMatchObject({
        closed: [],
        created: [],
        templates: { daily9: 'exists', weekly13: 'exists' },
      });

      // At the first kick-off both close, and new rounds open on events the
      // closed (still unsettled) rounds of the same template do not use.
      t.clock.set(at(40));
      const next = await runJackpotRounds(t.ctx, { leadMs: 0, preferWithinMs: 0 });
      expect([...next.closed].sort()).toEqual([daily.id, weekly.id].sort());
      expect(next.templates).toEqual({ daily9: 'created', weekly13: 'created' });
      expect((await roundOf(daily.id)).status).toBe('closed');
      const reopened = await Promise.all(next.created.map(roundOf));
      const daily2 = reopened.find((round) => round.templateCode === 'daily9')!;
      const weekly2 = reopened.find((round) => round.templateCode === 'weekly13')!;
      expect(daily2.games.map((game) => game.eventId)).toEqual(valid.slice(3, 6));
      expect(weekly2.games.map((game) => game.eventId)).toEqual(valid.slice(2, 4));

      // Every unsettled round of a template has its own events.
      const games = await t.db.db
        .select({
          eventId: schema.jackpotGames.eventId,
          templateCode: schema.jackpotRounds.templateCode,
        })
        .from(schema.jackpotGames)
        .innerJoin(schema.jackpotRounds, eq(schema.jackpotRounds.id, schema.jackpotGames.roundId))
        .where(inArray(schema.jackpotRounds.status, ['scheduled', 'open', 'closed']));
      for (const code of ['daily9', 'weekly13']) {
        const used = games.filter((g) => g.templateCode === code).map((g) => g.eventId);
        expect(new Set(used).size).toBe(used.length);
      }

      // Too few events left for daily9 (1 unused valid event); weekly13 disabled.
      await setTemplate(
        smallTemplate({
          code: 'weekly13',
          enabled: false,
          gameCount: 2,
          maxCombinations: 9,
          prizeTiers: [{ correct: 2, kind: 'shared', amount: birr(5_000) }],
        }),
      );
      t.clock.set(at(70));
      const last = await runJackpotRounds(t.ctx, { leadMs: 0, preferWithinMs: 0 });
      expect([...last.closed].sort()).toEqual([daily2.id, weekly2.id].sort());
      expect(last.templates).toEqual({ daily9: 'not_enough_events', weekly13: 'disabled' });
      expect(last.created).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'opens rounds on games toward each template’s horizon, so they take entries for hours',
    async () => {
      await retireScheduledEvents();
      await setTemplate(smallTemplate());
      await setTemplate(
        smallTemplate({
          code: 'weekly13',
          gameCount: 2,
          maxCombinations: 9,
          prizeTiers: [{ correct: 2, kind: 'shared', amount: birr(5_000) }],
        }),
      );
      const hours = [2, 6, 12, 20, 23, 30];
      const events = [];
      for (const hour of hours) events.push(await createGame(at(hour * 60)));
      const run = await runJackpotRounds(t.ctx);
      expect(run.templates).toEqual({ daily9: 'created', weekly13: 'created' });
      const rounds = await Promise.all(run.created.map(roundOf));
      const daily = rounds.find((round) => round.templateCode === 'daily9')!;
      const weekly = rounds.find((round) => round.templateCode === 'weekly13')!;
      // daily9: the latest three within a day; weekly13: the latest two within a week.
      expect(daily.games.map((game) => game.eventId)).toEqual(events.slice(2, 5));
      expect(daily.closesAt).toEqual(at(12 * 60));
      expect(weekly.games.map((game) => game.eventId)).toEqual(events.slice(4, 6));
      expect(weekly.closesAt).toEqual(at(23 * 60));
    },
    TEST_TIMEOUT,
  );

  it(
    'closes an open round exactly at its first kick-off',
    async () => {
      await retireScheduledEvents();
      const round = await openRound(at(90));
      t.clock.set(new Date(at(90).getTime() - 1));
      expect((await runJackpotRounds(t.ctx, { leadMs: LEAD_MS })).closed).not.toContain(round.id);
      expect((await roundOf(round.id)).status).toBe('open');

      t.clock.set(at(90));
      expect((await runJackpotRounds(t.ctx, { leadMs: LEAD_MS })).closed).toContain(round.id);
      const closed = await roundOf(round.id);
      expect(closed.status).toBe('closed');
      expect(closed.closedAt).toEqual(at(90));
      const [outbox] = await t.db.db
        .select()
        .from(schema.outboxEvents)
        .where(
          and(
            eq(schema.outboxEvents.type, 'jackpot.round_closed'),
            eq(schema.outboxEvents.aggregateId, round.id),
          ),
        );
      expect(outbox).toBeDefined();
    },
    TEST_TIMEOUT,
  );
});

describe('jackpot settlement', () => {
  let dispatcher: OutboxDispatcher;
  let consumers: WorkerTask[];

  beforeAll(async () => {
    await dropOutbox();
    dispatcher = createOutboxDispatcher(t.ctx);
    consumers = [jackpotSettlementTask(t.ctx), userNotifyTask(t.ctx)];
    for (const task of consumers) await task.start();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const task of [...(consumers ?? [])].reverse()) await task.stop();
    await dispatcher?.close();
  }, SETUP_TIMEOUT);

  const pushesOf = (userId: string) =>
    t.userMessages.filter((m) => m.userId === userId).map((m) => m.message);

  it(
    'settles a round through the outbox once every game has a result and pushes jackpot.settled',
    async () => {
      const round = await openRound();
      const winner = await fundedUser(t.db.db, birr(100));
      const loser = await fundedUser(t.db.db, birr(100));
      const won = await enter(winner, round.id, [['1'], ['X'], ['2']]);
      const lost = await enter(loser, round.id, [['2'], ['2'], ['1']]);
      await dispatcher.run(); // jackpot.entered → wallet pushes
      await eventually(
        async () => pushesOf(winner).length >= 1 && pushesOf(loser).length >= 1,
        10_000,
        'the entry pushes',
      );
      expect(pushesOf(winner)).toEqual([
        { type: 'wallet.changed', data: { cash: birr(90).toString(), bonus: '0' } },
      ]);

      const [first, second, third] = round.games.map((game) => game.eventId);
      await resultGame(first!, '1');
      await resultGame(second!, 'X');
      await dispatcher.run();
      // Closed (its games left the schedule), waiting for the last result.
      await eventually(
        async () => (await roundOf(round.id)).games.filter((g) => g.result !== null).length === 2,
        10_000,
        'the first results recorded',
      );
      expect((await roundOf(round.id)).status).toBe('closed');
      expect((await entryRow(won.id)).status).toBe('open');

      await resultGame(third!, '2');
      await dispatcher.run();
      await eventually(
        async () => (await roundOf(round.id)).status === 'settled',
        10_000,
        'the round settled',
      );
      const winning = await entryRow(won.id);
      expect(winning).toMatchObject({ status: 'won', bestCorrect: 3, prizeGross: birr(1_000) });
      expect((await entryRow(lost.id)).status).toBe('lost');
      expect(await getBalance(t.db.db, cash(winner))).toBe(birr(90) + winning.prizeNet!);

      await dispatcher.run(); // jackpot.settled → pushes
      await eventually(
        async () => pushesOf(winner).length >= 3 && pushesOf(loser).length >= 3,
        10_000,
        'the settlement pushes',
      );
      expect(pushesOf(winner).slice(1)).toEqual([
        {
          type: 'jackpot.settled',
          data: {
            entryId: won.id,
            roundId: round.id,
            templateCode: 'daily9',
            status: 'won',
            gross: birr(1_000).toString(),
            tax: winning.prizeTax!.toString(),
            net: winning.prizeNet!.toString(),
            refund: '0',
            bestCorrect: 3,
          },
        },
        {
          type: 'wallet.changed',
          data: { cash: (birr(90) + winning.prizeNet!).toString(), bonus: '0' },
        },
      ]);
      expect(pushesOf(loser)[1]).toMatchObject({
        type: 'jackpot.settled',
        data: { entryId: lost.id, status: 'lost', gross: '0', net: '0', refund: '0' },
      });
      for (const { message } of t.userMessages) expect(UserMessage.parse(message)).toEqual(message);
    },
    TEST_TIMEOUT,
  );

  it(
    'the sweep settles rounds whose jobs were lost, and voids a round with most games cancelled',
    async () => {
      const round = await openRound();
      const player = await fundedUser(t.db.db, birr(100));
      const entry = await enter(player, round.id, [['1', 'X'], ['X'], ['2']]);
      const [first, second, third] = round.games.map((game) => game.eventId);
      await resultGame(first!, 'cancelled');
      await resultGame(second!, 'cancelled');
      await resultGame(third!, '1');
      await dropOutbox();

      const run = await runJackpotSettlementSweep(t.ctx);
      expect(run.outcomes.voided).toBe(1);
      expect(run.failed).toEqual([]);
      expect((await roundOf(round.id)).status).toBe('cancelled');
      expect(await entryRow(entry.id)).toMatchObject({ status: 'void' });
      expect(await getBalance(t.db.db, cash(player))).toBe(birr(100));

      // Final rounds are not swept again.
      const again = await runJackpotSettlementSweep(t.ctx);
      expect(again.outcomes.voided).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'pays each prize once when jobs and the sweep settle the same round concurrently',
    async () => {
      const round = await openRound();
      const player = await fundedUser(t.db.db, birr(100));
      const entry = await enter(player, round.id, [['1'], ['X'], ['2']]);
      const [first, second, third] = round.games.map((game) => game.eventId);
      await resultGame(first!, '1');
      await resultGame(second!, 'X');
      await resultGame(third!, '2');
      await dropOutbox();

      const runs = await Promise.all([
        settleJackpotRounds(t.ctx, [round.id]),
        settleJackpotRounds(t.ctx, [round.id]),
        processJackpotSettlementJob(t.ctx, {
          outboxId: '1',
          type: EVENT_RESULTED,
          eventId: third!,
        }),
      ]);
      const settled = runs.reduce((sum, run) => sum + run.outcomes.settled, 0);
      const unchanged = runs.reduce((sum, run) => sum + run.outcomes.unchanged, 0);
      expect({ settled, unchanged }).toEqual({ settled: 1, unchanged: 2 });
      const prizes = await t.db.db
        .select()
        .from(schema.ledgerTransactions)
        .where(
          and(
            eq(schema.ledgerTransactions.refId, entry.id),
            eq(schema.ledgerTransactions.type, 'jackpot_prize'),
          ),
        );
      expect(prizes).toHaveLength(1);
      const row = await entryRow(entry.id);
      expect(await getBalance(t.db.db, cash(player))).toBe(birr(90) + row.prizeNet!);

      // A correction after settlement only flags the round: nothing is paid again.
      await resultGame(third!, '1');
      const corrected = await processJackpotSettlementJob(t.ctx, {
        outboxId: '2',
        type: EVENT_RESULT_CORRECTED,
        eventId: third!,
      });
      expect(corrected.outcomes.flagged).toBe(1);
      expect((await roundOf(round.id)).resultsFlaggedAt).not.toBeNull();
      expect(await getBalance(t.db.db, cash(player))).toBe(birr(90) + row.prizeNet!);
      await dropOutbox();
    },
    TEST_TIMEOUT,
  );

  it(
    'a market.resulted job looks at the rounds with a game on that 1X2 market only',
    async () => {
      const round = await openRound();
      const other = await openRound(at(70));
      const game = round.games[0]!;
      const run = await processJackpotSettlementJob(t.ctx, {
        outboxId: '3',
        type: MARKET_RESULTED,
        eventId: game.eventId,
        marketId: game.marketId,
      });
      expect(run.rounds).toBe(1);
      expect(run.outcomes.open).toBe(1);
      expect((await roundOf(other.id)).status).toBe('open');
    },
    TEST_TIMEOUT,
  );
});
