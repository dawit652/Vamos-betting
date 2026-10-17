import { birr, DEFAULT_JACKPOTS, DEFAULT_TAX } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDueJackpotRounds,
  createJackpotRound,
  DomainError,
  ensureJackpotRound,
  getJackpotRound,
  listJackpotCandidateEvents,
  listOpenJackpotRounds,
  listRecentJackpotRounds,
  openJackpotRound,
  setMarketStatus,
  shrinkJackpotTemplate,
  type CatalogIds,
} from '../src/index';
import { auditLog, jackpotGames, jackpotRounds, outboxEvents } from '../src/schema/index';
import {
  cancel,
  createBettingDatabase,
  createEvent,
  goLive,
  type TestDb,
} from './betting-fixtures';
import { createGames, enter, HOUR, MINUTE, openRound, smallTemplate } from './jackpot-fixtures';
import { createUser, dropTestDatabase, errorText, fund, pgCode } from './helpers';

let handle: TestDb;
let ids: CatalogIds;

beforeAll(async () => {
  ({ handle, ids } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const DAY = 24 * HOUR;

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

async function dbError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a database error');
}

describe('createJackpotRound', () => {
  it('opens a round with frozen terms, closing at the earliest kick-off', async () => {
    const now = new Date();
    const first = new Date(now.getTime() + 2 * HOUR);
    const games = [
      await createEvent(handle.db, ids, { startTime: new Date(first.getTime() + 30 * MINUTE) }),
      await createEvent(handle.db, ids, { startTime: first }),
      await createEvent(handle.db, ids, { startTime: new Date(first.getTime() + HOUR) }),
    ];
    const template = smallTemplate();
    const round = await openRound(handle.db, games, { template, now });
    expect(round).toMatchObject({
      templateCode: 'daily9',
      status: 'open',
      template,
      tax: DEFAULT_TAX,
      gameCount: 3,
      costPerCombination: birr(10),
      maxCombinations: 8,
      pool: birr(1_000),
      closesAt: first,
      createdAt: now,
      closedAt: null,
      settledAt: null,
      settlement: null,
      resultsFlaggedAt: null,
    });
    // Games in the order given, with names, kick-off and the 1X2 odds for information.
    expect(round.games.map((g) => g.eventId)).toEqual(games.map((g) => g.eventId));
    expect(round.games[0]).toMatchObject({
      position: 0,
      marketId: games[0]!.marketIds['1x2'],
      selectionIds: { '1': games[0]!.home, X: games[0]!.draw, '2': games[0]!.away },
      sportId: 'football',
      homeTeam: { en: 'Arsenal' },
      awayTeam: { en: 'Chelsea' },
      competitionName: { en: 'Premier League' },
      eventStatus: 'scheduled',
      odds: { '1': 2000, X: 3200, '2': 3500 },
      result: null,
    });
    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, round.id));
    expect(outbox.map((row) => row.type)).toEqual(['jackpot.round_opened']);
    expect(outbox[0]?.payload).toMatchObject({
      roundId: round.id,
      templateCode: 'daily9',
      gameCount: 3,
      costPerCombination: '1000',
      pool: '100000',
      eventIds: games.map((g) => g.eventId),
    });
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, round.id));
    expect(audit).toMatchObject([{ action: 'jackpot.round_created', actorType: 'system' }]);
  });

  it('refuses events that cannot be games (422 jackpot_event_unavailable)', async () => {
    const now = new Date();
    const start = new Date(now.getTime() + HOUR);
    const [live, suspended, ok] = await createGames(handle.db, ids, 3, start);
    await goLive(handle.db, live!.eventId);
    await handle.db.transaction((tx) =>
      setMarketStatus(tx, suspended!.marketIds['1x2'], 'suspended'),
    );
    const error = await domainError(openRound(handle.db, [live!, suspended!, ok!], { now }));
    expect(error).toMatchObject({ status: 422, code: 'jackpot_event_unavailable' });
    expect(error.details).toEqual({
      events: [
        { eventId: live!.eventId, reason: 'not_scheduled' },
        { eventId: suspended!.eventId, reason: 'market_not_open' },
      ],
    });
    const missing = '00000000-0000-4000-8000-000000000000';
    const late = await domainError(
      handle.db.transaction((tx) =>
        createJackpotRound(tx, {
          template: smallTemplate(),
          tax: DEFAULT_TAX,
          eventIds: [ok!.eventId, missing, suspended!.eventId],
          // After the first game's kick-off.
          now: new Date(start.getTime() + 40 * MINUTE),
        }),
      ),
    );
    expect(late.details).toEqual({
      events: [
        { eventId: ok!.eventId, reason: 'started' },
        { eventId: missing, reason: 'not_found' },
        { eventId: suspended!.eventId, reason: 'started' },
      ],
    });
  });

  it('refuses a template that does not fit the events (422 jackpot_template_invalid)', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const cases = [
      { games: games.slice(0, 2), template: smallTemplate() },
      { games: [games[0]!, games[0]!, games[1]!], template: smallTemplate() },
      { games, template: smallTemplate({ prizeTiers: [] }) },
      {
        games,
        template: smallTemplate({ prizeTiers: [{ correct: 0, kind: 'fixed', amount: birr(1) }] }),
      },
      { games, template: smallTemplate({ costPerCombination: 0n }) },
    ];
    for (const { games: events, template } of cases) {
      const error = await domainError(openRound(handle.db, events, { template }));
      expect(error).toMatchObject({ status: 422, code: 'jackpot_template_invalid' });
    }
  });
});

describe('shrinkJackpotTemplate', () => {
  it('keeps the price and prizes on fewer games, each tier as far from all correct', () => {
    const daily = DEFAULT_JACKPOTS.daily9;
    expect(shrinkJackpotTemplate(daily, 3)).toEqual({
      ...daily,
      gameCount: 3,
      maxCombinations: 27,
      prizeTiers: [
        { correct: 3, kind: 'shared', amount: birr(100_000) },
        { correct: 2, kind: 'fixed', amount: birr(200) },
      ],
    });
    // 13 → 2 games: only the tiers for 13 and 12 correct still need a correct prediction.
    expect(shrinkJackpotTemplate(DEFAULT_JACKPOTS.weekly13, 2).prizeTiers).toEqual([
      { correct: 2, kind: 'shared', amount: birr(1_000_000) },
      { correct: 1, kind: 'shared', amount: birr(100_000) },
    ]);
    expect(shrinkJackpotTemplate(daily, 9)).toEqual(daily);
    for (const bad of [0, 10, 2.5]) {
      expect(() => shrinkJackpotTemplate(daily, bad)).toThrow(RangeError);
    }
  });

  it('opens a quick round from the next events', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const round = await openRound(handle.db, games, {
      template: shrinkJackpotTemplate(DEFAULT_JACKPOTS.daily9, 3),
    });
    expect(round).toMatchObject({ gameCount: 3, maxCombinations: 27, pool: birr(100_000) });
  });
});

describe('listJackpotCandidateEvents and ensureJackpotRound', () => {
  it('picks upcoming open 1X2 events, soonest first, not used by the same template', async () => {
    // A window far ahead so other tests' events do not get in the way.
    const now = new Date(Date.now() + 30 * DAY);
    const events = await createGames(
      handle.db,
      ids,
      6,
      new Date(now.getTime() + HOUR),
      10 * MINUTE,
    );
    const tooSoon = await createEvent(handle.db, ids, {
      startTime: new Date(now.getTime() + 10 * MINUTE),
    });
    const suspended = await createEvent(handle.db, ids, {
      startTime: new Date(now.getTime() + 2 * HOUR),
    });
    await handle.db.transaction((tx) =>
      setMarketStatus(tx, suspended.marketIds['1x2'], 'suspended'),
    );
    const window = { now, leadMs: 30 * MINUTE, horizonMs: 3 * HOUR, limit: 20 };

    const all = await listJackpotCandidateEvents(handle.db, { ...window, templateCode: 'daily9' });
    expect(all.map((c) => c.eventId)).toEqual(events.map((e) => e.eventId));
    expect(all[0]).toMatchObject({ marketId: events[0]!.marketIds['1x2'] });
    expect(all.map((c) => c.eventId)).not.toContain(tooSoon.eventId);

    // A weekly round on the first three takes them from weekly candidates only.
    await openRound(handle.db, events.slice(0, 3), {
      template: smallTemplate({ code: 'weekly13' }),
      now,
    });
    const weekly = await listJackpotCandidateEvents(handle.db, {
      ...window,
      templateCode: 'weekly13',
    });
    expect(weekly.map((c) => c.eventId)).toEqual(events.slice(3).map((e) => e.eventId));
    const daily = await listJackpotCandidateEvents(handle.db, {
      ...window,
      templateCode: 'daily9',
    });
    expect(daily).toHaveLength(6);
  });

  it('keeps one round per template open and needs enough events', async () => {
    const now = new Date(Date.now() + 60 * DAY);
    const template = smallTemplate({ code: 'daily9' });
    const window = { tax: DEFAULT_TAX, now, leadMs: 0, horizonMs: 3 * HOUR };
    const notEnough = await handle.db.transaction((tx) =>
      ensureJackpotRound(tx, { ...window, template }),
    );
    expect(notEnough).toEqual({ outcome: 'not_enough_events', available: 0, needed: 3 });

    const events = await createGames(handle.db, ids, 4, new Date(now.getTime() + HOUR));
    const disabled = await handle.db.transaction((tx) =>
      ensureJackpotRound(tx, { ...window, template: { ...template, enabled: false } }),
    );
    expect(disabled).toEqual({ outcome: 'disabled' });

    // Concurrent workers open exactly one round.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        handle.db.transaction((tx) => ensureJackpotRound(tx, { ...window, template })),
      ),
    );
    const created = results.filter((r) => r.outcome === 'created');
    expect(created).toHaveLength(1);
    const round = created[0]?.outcome === 'created' ? created[0].round : null;
    expect(round?.games.map((g) => g.eventId)).toEqual(events.slice(0, 3).map((e) => e.eventId));
    expect(round?.closesAt).toEqual(new Date(now.getTime() + HOUR));
    for (const other of results.filter((r) => r.outcome !== 'created')) {
      expect(other).toEqual({ outcome: 'exists', roundId: round?.id });
    }
    // The weekly template is separate: it may use the same events.
    const weekly = await handle.db.transaction((tx) =>
      ensureJackpotRound(tx, { ...window, template: { ...template, code: 'weekly13' } }),
    );
    expect(weekly).toMatchObject({ outcome: 'created' });
  });

  it('opens the configured templates from the settings with their own size', async () => {
    const now = new Date(Date.now() + 90 * DAY);
    await createGames(handle.db, ids, 9, new Date(now.getTime() + HOUR), 5 * MINUTE);
    const result = await handle.db.transaction((tx) =>
      ensureJackpotRound(tx, {
        template: DEFAULT_JACKPOTS.daily9,
        tax: DEFAULT_TAX,
        now,
        leadMs: 0,
        horizonMs: 2 * HOUR,
      }),
    );
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    expect(result.round).toMatchObject({
      gameCount: 9,
      maxCombinations: 1_024,
      pool: birr(100_000),
      template: DEFAULT_JACKPOTS.daily9,
    });
    expect(result.round.games).toHaveLength(9);
  });
});

describe('closing and opening', () => {
  it('closes an open round at its first kick-off, or as soon as a game cannot be played', async () => {
    const start = new Date(Date.now() + HOUR);
    const games = await createGames(handle.db, ids, 3, start);
    const round = await openRound(handle.db, games);
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(100));
    await enter(handle.db, userId, round.id, [['1', 'X'], ['1'], ['1']]);

    const early = await handle.db.transaction((tx) =>
      closeDueJackpotRounds(tx, new Date(start.getTime() - MINUTE)),
    );
    expect(early.closed).not.toContain(round.id);
    const due = await handle.db.transaction((tx) => closeDueJackpotRounds(tx, start));
    expect(due.closed).toContain(round.id);
    const closed = await getJackpotRound(handle.db, round.id);
    expect(closed).toMatchObject({ status: 'closed', closedAt: start });
    const [event] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'jackpot.round_closed'))
      .then((rows) => rows.filter((row) => row.aggregateId === round.id));
    expect(event?.payload).toMatchObject({ roundId: round.id, entries: 1, stakes: '2000' });
    // Closing twice does nothing.
    const again = await handle.db.transaction((tx) => closeDueJackpotRounds(tx, start));
    expect(again.closed).not.toContain(round.id);

    // A game cancelled before the kick-off closes the round at once.
    const others = await createGames(handle.db, ids, 3, new Date(Date.now() + 2 * HOUR));
    const second = await openRound(handle.db, others);
    await cancel(handle.db, others[2]!.eventId);
    const result = await handle.db.transaction((tx) => closeDueJackpotRounds(tx, new Date()));
    expect(result.closed).toContain(second.id);
  });

  it('cancels a scheduled round that never opened, and opens one on request', async () => {
    const start = new Date(Date.now() + HOUR);
    const games = await createGames(handle.db, ids, 3, start);
    const never = await openRound(handle.db, games, { status: 'scheduled' });
    expect(never.status).toBe('scheduled');
    expect(await listOpenJackpotRounds(handle.db, { now: new Date() })).not.toContainEqual(
      expect.objectContaining({ id: never.id }),
    );
    const result = await handle.db.transaction((tx) => closeDueJackpotRounds(tx, start));
    expect(result.cancelled).toContain(never.id);
    expect(await getJackpotRound(handle.db, never.id)).toMatchObject({
      status: 'cancelled',
      settlement: { void: true, voidReason: 'not_opened', entries: 0, refunds: 0n },
    });

    const later = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const scheduled = await openRound(handle.db, later, { status: 'scheduled' });
    const opened = await handle.db.transaction((tx) =>
      openJackpotRound(tx, { roundId: scheduled.id, now: new Date() }),
    );
    expect(opened.status).toBe('open');
    expect(
      (await listOpenJackpotRounds(handle.db, { now: new Date() })).map((r) => r.id),
    ).toContain(scheduled.id);
    const twice = await domainError(
      handle.db.transaction((tx) =>
        openJackpotRound(tx, { roundId: scheduled.id, now: new Date() }),
      ),
    );
    expect(twice).toMatchObject({ status: 409, code: 'jackpot_closed' });

    const started = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const stuck = await openRound(handle.db, started, { status: 'scheduled' });
    await goLive(handle.db, started[1]!.eventId);
    const refused = await domainError(
      handle.db.transaction((tx) => openJackpotRound(tx, { roundId: stuck.id, now: new Date() })),
    );
    expect(refused.details).toEqual({ reason: 'game_started', status: 'scheduled' });
  });
});

describe('round lists', () => {
  it('lists open rounds by closing time and past rounds newest first with a cursor', async () => {
    const now = new Date(Date.now() + 120 * DAY);
    const rounds = [];
    for (let i = 0; i < 3; i += 1) {
      const games = await createGames(handle.db, ids, 3, new Date(now.getTime() + (i + 1) * HOUR));
      rounds.push(
        await openRound(handle.db, games, {
          template: smallTemplate({ code: 'weekly13' }),
          now,
        }),
      );
    }
    const open = await listOpenJackpotRounds(handle.db, { now, templateCode: 'weekly13' });
    expect(open.map((r) => r.id)).toEqual(rounds.map((r) => r.id));

    // Close all three (their closing times have come) and page through the history.
    await handle.db.transaction((tx) =>
      closeDueJackpotRounds(tx, new Date(now.getTime() + 4 * HOUR)),
    );
    const page = await listRecentJackpotRounds(handle.db, { limit: 2, templateCode: 'weekly13' });
    expect(page.items.map((r) => r.id)).toEqual([rounds[2]!.id, rounds[1]!.id]);
    const next = await listRecentJackpotRounds(handle.db, {
      limit: 2,
      templateCode: 'weekly13',
      cursor: page.nextCursor ?? '',
    });
    expect(next.items[0]?.id).toBe(rounds[0]!.id);
    expect(await listOpenJackpotRounds(handle.db, { now, templateCode: 'weekly13' })).toEqual([]);
  });
});

describe('database guards', () => {
  it('keeps a round’s terms frozen and its status moving forward only', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const round = await openRound(handle.db, games);
    const frozen = await dbError(() =>
      handle.db
        .update(jackpotRounds)
        .set({ closesAt: new Date(Date.now() + DAY) })
        .where(eq(jackpotRounds.id, round.id)),
    );
    expect(pgCode(frozen)).toBe('23001');
    const skip = await dbError(() =>
      handle.db
        .update(jackpotRounds)
        .set({ status: 'scheduled' })
        .where(eq(jackpotRounds.id, round.id)),
    );
    expect(errorText(skip)).toContain('is not allowed');
    const settledInsert = await dbError(() =>
      handle.db.insert(jackpotRounds).values({
        templateCode: 'daily9',
        status: 'settled',
        gameCount: 3,
        costPerCombination: birr(10),
        maxCombinations: 8,
        pool: birr(1_000),
        terms: { template: {}, tax: {} },
        closesAt: new Date(),
        createdAt: new Date(),
        closedAt: new Date(),
        settledAt: new Date(),
        settlement: {
          void: true,
          voidReason: 'not_opened',
          results: [],
          cancelledGames: 0,
          entries: 0,
          winners: 0,
          stakes: '0',
          gross: '0',
          tax: '0',
          net: '0',
          refunds: '0',
          undistributed: '0',
          payouts: [],
        },
      }),
    );
    expect(errorText(settledInsert)).toContain('inserted scheduled or open');

    // No game can be added once a round has entries.
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(100));
    await enter(handle.db, userId, round.id, [['1'], ['1'], ['1']]);
    const extra = await createEvent(handle.db, ids);
    const added = await dbError(() =>
      handle.db.insert(jackpotGames).values({
        roundId: round.id,
        position: 3,
        eventId: extra.eventId,
        marketId: extra.marketIds['1x2'],
        homeSelectionId: extra.home,
        drawSelectionId: extra.draw,
        awaySelectionId: extra.away,
      }),
    );
    expect(errorText(added)).toContain('cannot be added');
    const moved = await dbError(() =>
      handle.db
        .update(jackpotGames)
        .set({ eventId: extra.eventId })
        .where(eq(jackpotGames.roundId, round.id)),
    );
    expect(pgCode(moved)).toBe('23001');
  });
});
