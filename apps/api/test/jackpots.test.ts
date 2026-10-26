import { randomBytes, randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  JackpotClosedDetails,
  JackpotEntryInvalidDetails,
  JackpotEntryView,
  JackpotListResponse,
  JackpotRoundView,
  MyJackpotEntriesResponse,
  PromotionsResponse,
  WalletResponse,
} from '@vamos/contracts';
import {
  birr,
  DEFAULT_JACKPOTS,
  DEFAULT_MULTI_BONUS,
  DEFAULT_TAX,
  toWire,
  type JackpotTemplate,
} from '@vamos/core';
import {
  createJackpotRound,
  resultEvent,
  settleJackpotRound,
  shrinkJackpotTemplate,
  updateJackpotTemplate,
  type Database,
} from '@vamos/db';
import { events, jackpotEntries, ledgerTransactions } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/lib/idempotency';
import { devJackpotsEnabled } from '../src/modules/jackpots/dev-routes';
import { JACKPOT_RATE_LIMITS } from '../src/modules/jackpots/routes';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
} from './fixtures';
import {
  createTestContext,
  registerAndLogin,
  relogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const NOW = new Date('2026-10-17T09:00:00.000Z');
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });
const newKey = () => randomUUID();

let ctx: TestContext;
let db: Database;
const ids = {} as { league: string; home: string; away: string };

/**
 * A small template (3 games, 10 ETB a combination, at most 8): 3 correct
 * share 1,000 ETB, 2 correct win a fixed 20 ETB per combination.
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

/** `count` football events with an open 1X2 market, the first at `firstStart`, then every 15 minutes. */
async function createGames(count: number, firstStart = at(60)): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const event = await insertEvent(db, {
      sportId: 'football',
      competitionId: ids.league,
      homeTeamId: ids.home,
      awayTeamId: ids.away,
      startTime: new Date(firstStart.getTime() + i * 15 * MINUTE),
    });
    await insertMarket(db, event.id, '1x2', null, [
      ['1', 1850],
      ['X', 3400],
      ['2', 4200],
    ]);
    eventIds.push(event.id);
  }
  return eventIds;
}

/** A fresh open round on fresh games (the small template unless given). */
async function openRound(template = smallTemplate(), firstStart = at(60)) {
  const eventIds = await createGames(template.gameCount, firstStart);
  const round = await db.transaction((tx) =>
    createJackpotRound(tx, { template, tax: DEFAULT_TAX, eventIds, now: ctx.clock.now }),
  );
  return { roundId: round.id, eventIds };
}

const SCORES = { '1': [2, 1], X: [1, 1], '2': [0, 1] } as const;

async function resultGame(eventId: string, result: '1' | 'X' | '2' | 'cancelled') {
  await db.transaction((tx) =>
    result === 'cancelled'
      ? resultEvent(tx, eventId, { status: 'cancelled' })
      : resultEvent(tx, eventId, {
          status: 'finished',
          score: { home: SCORES[result][0], away: SCORES[result][1] },
        }),
  );
}

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

async function player(amount = birr(1_000)): Promise<LoggedInUser> {
  const user = await registerAndLogin(ctx);
  if (amount > 0n) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/wallet/demo-topup',
      payload: { amount: toWire(amount) },
      headers: { ...bearer(user), 'idempotency-key': newKey() },
    });
    expect(response.statusCode).toBe(200);
  }
  return user;
}

async function cash(user: LoggedInUser): Promise<bigint> {
  const response = await ctx.app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
  expect(response.statusCode).toBe(200);
  return BigInt(WalletResponse.parse(response.json()).cash);
}

function enter(
  user: LoggedInUser,
  roundId: string,
  picks: unknown,
  key: string | null = newKey(),
  headers: Record<string, string> = bearer(user),
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/jackpots/${roundId}/entries`,
    payload: { picks },
    headers: { ...headers, ...(key === null ? {} : { 'idempotency-key': key }) },
  });
}

function get(url: string, user?: LoggedInUser) {
  return ctx.app.inject({ method: 'GET', url, headers: user === undefined ? {} : bearer(user) });
}

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.clock.now = NOW;
  db = ctx.db.db;
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  ids.league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'ethiopian-premier-league',
    name: { en: 'Ethiopian Premier League', am: 'የኢትዮጵያ ፕሪሚየር ሊግ' },
  });
  ids.home = await insertTeam(db, 'football', 'STG', { en: 'St. George', am: 'ቅዱስ ጊዮርጊስ' });
  ids.away = await insertTeam(db, 'football', 'FAS', { en: 'Fasil Kenema' });
});

beforeEach(() => {
  ctx.clock.now = NOW;
});

afterAll(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------

describe('GET /jackpots and /jackpots/:id', () => {
  it('shows an open round with its games, prices and prize tiers', async () => {
    const { roundId, eventIds } = await openRound();
    const response = await get(`/jackpots/${roundId}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=5');
    const view = JackpotRoundView.parse(response.json());
    expect(view).toMatchObject({
      id: roundId,
      templateCode: 'daily9',
      status: 'open',
      gameCount: 3,
      closesAt: at(60).toISOString(),
      costPerCombination: toWire(birr(10)),
      maxCombinations: 8,
      pool: toWire(birr(1_000)),
      cancelledRule: 'all_win',
      prizeTiers: [
        { correct: 3, kind: 'shared', amount: toWire(birr(1_000)) },
        { correct: 2, kind: 'fixed', amount: toWire(birr(20)) },
      ],
      settledAt: null,
      settlement: null,
    });
    expect(view.games.map((game) => game.eventId)).toEqual(eventIds);
    expect(view.games[0]).toMatchObject({
      position: 0,
      sport: 'football',
      eventName: 'St. George vs Fasil Kenema',
      homeTeam: { en: 'St. George', am: 'ቅዱስ ጊዮርጊስ' },
      awayTeam: { en: 'Fasil Kenema' },
      competition: { en: 'Ethiopian Premier League' },
      startTime: at(60).toISOString(),
      status: 'scheduled',
      score: null,
      odds: { '1': 1850, X: 3400, '2': 4200 },
      result: null,
    });
    expect(view.games[0]!.gameId).toMatch(/^\d+$/);
  });

  it('lists open rounds soonest closing first and past rounds with a cursor, per template', async () => {
    const soon = await openRound(smallTemplate(), at(30));
    const weekly = await openRound(smallTemplate({ code: 'weekly13' }), at(45));
    const past = [await openRound(), await openRound()];
    for (const round of past) {
      for (const eventId of round.eventIds) await resultGame(eventId, '1');
      await db.transaction((tx) => settleJackpotRound(tx, round.roundId, at(500)));
    }

    const all = JackpotListResponse.parse((await get('/jackpots')).json());
    const openIds = all.open.map((round) => round.id);
    expect(openIds.indexOf(soon.roundId)).toBeLessThan(openIds.indexOf(weekly.roundId));
    expect(all.open.every((round) => round.status === 'open')).toBe(true);
    expect(all.recent.map((round) => round.id)).toEqual(
      expect.arrayContaining(past.map((round) => round.roundId)),
    );
    const settled = all.recent.find((round) => round.id === past[0]!.roundId)!;
    expect(settled.status).toBe('settled');
    expect(settled.games.every((game) => game.result === '1')).toBe(true);
    expect(settled.settlement).toMatchObject({ void: false, winners: 0, cancelledGames: 0 });

    const weeklyOnly = JackpotListResponse.parse((await get('/jackpots?template=weekly13')).json());
    expect(weeklyOnly.open.map((round) => round.id)).toEqual([weekly.roundId]);
    expect(weeklyOnly.recent).toEqual([]);

    const first = JackpotListResponse.parse((await get('/jackpots?limit=1')).json());
    expect(first.recent).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = JackpotListResponse.parse(
      (await get(`/jackpots?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json(),
    );
    expect(second.recent).toHaveLength(1);
    expect(second.recent[0]!.id).not.toBe(first.recent[0]!.id);

    expect((await get('/jackpots?template=nope')).statusCode).toBe(400);
    expect((await get('/jackpots?cursor=garbage')).statusCode).toBe(400);
  });

  it('answers 404 for an unknown or malformed round id', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const response = await get(`/jackpots/${id}`);
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('not_found');
    }
  });
});

describe('POST /jackpots/:id/entries', () => {
  it('places an entry, charges combinations × cost and replays the same key', async () => {
    const { roundId } = await openRound();
    const user = await player();
    const key = newKey();
    const picks = [['X', '1'], ['1'], ['2', '1']];
    const response = await enter(user, roundId, picks, key);
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const entry = JackpotEntryView.parse(response.json());
    expect(entry).toMatchObject({
      roundId,
      templateCode: 'daily9',
      status: 'open',
      roundStatus: 'open',
      // Stored in 1, X, 2 order.
      picks: [['1', 'X'], ['1'], ['1', '2']],
      combinations: 4,
      cost: toWire(birr(40)),
      correct: null,
      bestCorrect: null,
      prizeGross: null,
      prizeTax: null,
      prizeNet: null,
      refund: null,
      placedAt: NOW.toISOString(),
      settledAt: null,
    });
    expect(entry.games.map((game) => [game.picks, game.hit])).toEqual([
      [['1', 'X'], null],
      [['1'], null],
      [['1', '2'], null],
    ]);
    expect(await cash(user)).toBe(birr(960));

    const replay = await enter(user, roundId, picks, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(JackpotEntryView.parse(replay.json()).id).toBe(entry.id);
    expect(await cash(user)).toBe(birr(960));
    const rows = await db.select().from(jackpotEntries).where(eq(jackpotEntries.roundId, roundId));
    expect(rows).toHaveLength(1);
    const payments = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.refId, entry.id));
    expect(payments.map((row) => row.type)).toEqual(['jackpot_entry']);

    const reused = await enter(user, roundId, [['1'], ['1'], ['1']], key);
    expect(reused.statusCode).toBe(422);
    expect(apiError(reused).code).toBe('idempotency_key_reused');
  });

  it('refuses picks that do not fit the round (422 jackpot_entry_invalid) or the contract (400)', async () => {
    const { roundId } = await openRound();
    const user = await player();

    const tooFew = await enter(user, roundId, [['1'], ['X']]);
    expect(tooFew.statusCode).toBe(422);
    expect(apiError(tooFew).code).toBe('jackpot_entry_invalid');
    expect(JackpotEntryInvalidDetails.parse(apiError(tooFew).details)).toMatchObject({
      gameCount: 3,
      maxCombinations: 8,
    });

    // 3 × 3 × 1 = 9 combinations > 8.
    const tooMany = await enter(user, roundId, [['1', 'X', '2'], ['1', 'X', '2'], ['1']]);
    expect(tooMany.statusCode).toBe(422);
    expect(JackpotEntryInvalidDetails.parse(apiError(tooMany).details)).toMatchObject({
      combinations: 9,
      maxCombinations: 8,
    });

    for (const picks of [
      [['1', '1'], ['X'], ['2']],
      [[], ['X'], ['2']],
      [['3'], ['X'], ['2']],
    ]) {
      const malformed = await enter(user, roundId, picks);
      expect(malformed.statusCode).toBe(400);
      expect(apiError(malformed).code).toBe('validation_error');
    }
    // Thousands of bad games (about 40 KB): one short error, not one issue per game.
    const flood = await enter(
      user,
      roundId,
      Array.from({ length: 5_000 }, () => ['1', '1']),
    );
    expect(flood.statusCode).toBe(400);
    expect(apiError(flood).code).toBe('validation_error');
    expect(flood.body.length).toBeLessThan(2_000);

    const noKey = await enter(user, roundId, [['1'], ['X'], ['2']], null);
    expect(noKey.statusCode).toBe(400);
    expect(apiError(noKey).code).toBe('idempotency_key_required');
    expect(await cash(user)).toBe(birr(1_000));
  });

  it('refuses entries once the round closed, before it opens or after a game left the schedule (409)', async () => {
    const user = await player();

    const closing = await openRound();
    ctx.clock.now = at(60);
    // An hour without a request ends the session (30 minutes idle): sign in again.
    await relogin(ctx, user);
    const late = await enter(user, closing.roundId, [['1'], ['X'], ['2']]);
    expect(late.statusCode).toBe(409);
    expect(apiError(late).code).toBe('jackpot_closed');
    expect(JackpotClosedDetails.parse(apiError(late).details)).toEqual({
      reason: 'closed',
      status: 'open',
    });
    ctx.clock.now = NOW;

    const eventIds = await createGames(3);
    const scheduled = await db.transaction((tx) =>
      createJackpotRound(tx, {
        template: smallTemplate(),
        tax: DEFAULT_TAX,
        eventIds,
        now: NOW,
        status: 'scheduled',
      }),
    );
    const early = await enter(user, scheduled.id, [['1'], ['X'], ['2']]);
    expect(early.statusCode).toBe(409);
    expect(JackpotClosedDetails.parse(apiError(early).details)).toEqual({
      reason: 'not_open',
      status: 'scheduled',
    });

    const postponed = await openRound();
    await db
      .update(events)
      .set({ status: 'postponed' })
      .where(eq(events.id, postponed.eventIds[2]!));
    const started = await enter(user, postponed.roundId, [['1'], ['X'], ['2']]);
    expect(started.statusCode).toBe(409);
    expect(JackpotClosedDetails.parse(apiError(started).details)).toEqual({
      reason: 'game_started',
      status: 'open',
    });

    const unknown = await enter(user, randomUUID(), [['1'], ['X'], ['2']]);
    expect(unknown.statusCode).toBe(404);
    expect(await cash(user)).toBe(birr(1_000));
  });

  it('refuses an entry the balance cannot pay (422 insufficient_funds)', async () => {
    const { roundId } = await openRound();
    const user = await player(birr(15));
    const response = await enter(user, roundId, [['1', 'X'], ['X'], ['2']]);
    expect(response.statusCode).toBe(422);
    expect(apiError(response).code).toBe('insufficient_funds');
    expect(apiError(response).details).toEqual({
      balance: toWire(birr(15)),
      cost: toWire(birr(20)),
    });
    expect(await cash(user)).toBe(birr(15));
  });

  it('requires a session (401) and the CSRF header with cookie authentication (403)', async () => {
    const { roundId } = await openRound();
    const user = await player();
    const anonymous = await enter(user, roundId, [['1'], ['X'], ['2']], newKey(), {});
    expect(anonymous.statusCode).toBe(401);

    const forged = await enter(user, roundId, [['1'], ['X'], ['2']], newKey(), {
      cookie: user.cookie,
    });
    expect(forged.statusCode).toBe(403);
    expect(apiError(forged).code).toBe('csrf_invalid');
    expect(await cash(user)).toBe(birr(1_000));

    const genuine = await enter(user, roundId, [['1'], ['X'], ['2']], newKey(), {
      cookie: user.cookie,
      'x-csrf-token': user.csrfToken,
    });
    expect(genuine.statusCode).toBe(201);
    expect(await cash(user)).toBe(birr(990));
  });

  it('limits each player to JACKPOT_RATE_LIMITS.placeEntry entries a minute (429), per player', async () => {
    const { roundId } = await openRound();
    const a = await player();
    const b = await player();
    const from = { remoteAddress: '198.51.100.9' };
    const send = (user: LoggedInUser, picks: unknown) =>
      ctx.app.inject({
        method: 'POST',
        url: `/jackpots/${roundId}/entries`,
        payload: { picks },
        headers: { ...bearer(user), 'idempotency-key': newKey() },
        ...from,
      });
    for (let i = 0; i < JACKPOT_RATE_LIMITS.placeEntry; i += 1) {
      expect((await send(a, [])).statusCode).toBe(400);
    }
    const limited = await send(a, [['1'], ['X'], ['2']]);
    expect(limited.statusCode).toBe(429);
    expect(apiError(limited).code).toBe('rate_limited');
    expect((await send(b, [['1'], ['X'], ['2']])).statusCode).toBe(201);
  });
});

describe('GET /me/jackpot-entries', () => {
  it('lists the player’s entries newest first with a cursor and a status filter', async () => {
    const first = await openRound();
    const second = await openRound();
    const owner = await player();
    const other = await player();
    const a = JackpotEntryView.parse(
      (await enter(owner, first.roundId, [['1'], ['X'], ['2']])).json(),
    );
    ctx.clock.advance(1_000);
    const b = JackpotEntryView.parse(
      (await enter(owner, second.roundId, [['1'], ['1'], ['1']])).json(),
    );
    ctx.clock.advance(1_000);
    const c = JackpotEntryView.parse(
      (await enter(owner, second.roundId, [['2'], ['2'], ['2']])).json(),
    );
    const foreign = JackpotEntryView.parse(
      (await enter(other, first.roundId, [['1'], ['X'], ['2']])).json(),
    );

    const list = await get('/me/jackpot-entries', owner);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const page = MyJackpotEntriesResponse.parse(list.json());
    expect(page.items.map((entry) => entry.id)).toEqual([c.id, b.id, a.id]);
    expect(page.nextCursor).toBeNull();

    const one = MyJackpotEntriesResponse.parse(
      (await get('/me/jackpot-entries?limit=2', owner)).json(),
    );
    expect(one.items.map((entry) => entry.id)).toEqual([c.id, b.id]);
    const rest = MyJackpotEntriesResponse.parse(
      (
        await get(
          `/me/jackpot-entries?limit=2&cursor=${encodeURIComponent(one.nextCursor!)}`,
          owner,
        )
      ).json(),
    );
    expect(rest.items.map((entry) => entry.id)).toEqual([a.id]);
    expect(rest.nextCursor).toBeNull();

    // Settle the first round: results 1, X, 2.
    for (const [i, result] of (['1', 'X', '2'] as const).entries()) {
      await resultGame(first.eventIds[i]!, result);
    }
    const before = await cash(owner);
    const settledRun = await db.transaction((tx) => settleJackpotRound(tx, first.roundId, at(400)));
    expect(settledRun.outcome).toBe('settled');

    const open = MyJackpotEntriesResponse.parse(
      (await get('/me/jackpot-entries?status=open', owner)).json(),
    );
    expect(open.items.map((entry) => entry.id)).toEqual([c.id, b.id]);
    const settled = MyJackpotEntriesResponse.parse(
      (await get('/me/jackpot-entries?status=settled', owner)).json(),
    );
    expect(settled.items.map((entry) => entry.id)).toEqual([a.id]);

    const detail = await get(`/me/jackpot-entries/${a.id}`, owner);
    expect(detail.statusCode).toBe(200);
    const won = JackpotEntryView.parse(detail.json());
    // Two combinations (owner and other) with 3 correct share the 1,000 ETB pool.
    expect(won).toMatchObject({
      status: 'won',
      roundStatus: 'settled',
      correct: ['0', '0', '0', '1'],
      bestCorrect: 3,
      prizeGross: toWire(birr(500)),
      refund: null,
    });
    expect(BigInt(won.prizeTax!) + BigInt(won.prizeNet!)).toBe(birr(500));
    expect(BigInt(won.prizeTax!)).toBeGreaterThan(0n);
    expect(won.games.map((game) => [game.result, game.hit])).toEqual([
      ['1', true],
      ['X', true],
      ['2', true],
    ]);
    expect(await cash(owner)).toBe(before + BigInt(won.prizeNet!));

    const round = JackpotRoundView.parse((await get(`/jackpots/${first.roundId}`)).json());
    expect(round.status).toBe('settled');
    expect(round.settlement).toEqual({
      void: false,
      voidReason: null,
      cancelledGames: 0,
      winners: 2,
      payouts: [
        {
          correct: 3,
          kind: 'shared',
          winningCombinations: '2',
          prizePerCombination: toWire(birr(500)),
          total: toWire(birr(1_000)),
        },
        {
          correct: 2,
          kind: 'fixed',
          winningCombinations: '0',
          prizePerCombination: toWire(birr(20)),
          total: '0',
        },
      ],
    });

    for (const id of [foreign.id, randomUUID(), 'nope']) {
      const response = await get(`/me/jackpot-entries/${id}`, owner);
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('not_found');
    }
    expect((await get('/me/jackpot-entries')).statusCode).toBe(401);
    expect((await get('/me/jackpot-entries?status=won', owner)).statusCode).toBe(400);
  });
});

describe('GET /promotions', () => {
  it('lists the multi-bonus ladder in force and the open jackpots', async () => {
    const { roundId } = await openRound();
    const response = await get('/promotions');
    expect(response.statusCode).toBe(200);
    const body = PromotionsResponse.parse(response.json());
    expect(body.multiBonus).toEqual({
      enabled: DEFAULT_MULTI_BONUS.enabled,
      minLegOddsMilli: DEFAULT_MULTI_BONUS.minLegOddsMilli,
      maxBonus: toWire(DEFAULT_MULTI_BONUS.maxBonus),
      tiers: DEFAULT_MULTI_BONUS.tiers.map((tier) => ({
        minLegs: tier.minLegs,
        percentBps: tier.percentBps,
      })),
    });
    expect(body.jackpots.map((round) => round.id)).toContain(roundId);
    expect(body.jackpots.every((round) => round.status === 'open')).toBe(true);
  });
});

describe('POST /dev/jackpots/rounds (demo only)', () => {
  it('opens a small round on the next scheduled events, shrunk from the template', async () => {
    // Sooner than every other test's games, so these are the next candidates.
    const eventIds = await createGames(3, at(2));
    const user = await player();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/dev/jackpots/rounds',
      payload: { games: 3, leadSeconds: 60 },
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(201);
    const round = JackpotRoundView.parse(response.json());
    const expected = shrinkJackpotTemplate(DEFAULT_JACKPOTS.daily9, 3);
    expect(round).toMatchObject({
      templateCode: 'daily9',
      status: 'open',
      gameCount: 3,
      closesAt: at(2).toISOString(),
      costPerCombination: toWire(DEFAULT_JACKPOTS.daily9.costPerCombination),
      maxCombinations: expected.maxCombinations,
      prizeTiers: expected.prizeTiers.map((tier) => ({ ...tier, amount: toWire(tier.amount) })),
    });
    expect(round.games.map((game) => game.eventId)).toEqual(eventIds);

    // A player can enter it right away.
    const entry = await enter(user, round.id, [['1'], ['X'], ['2']]);
    expect(entry.statusCode).toBe(201);

    const tooMany = await ctx.app.inject({
      method: 'POST',
      url: '/dev/jackpots/rounds',
      // Nothing kicks off more than a day from now.
      payload: { template: 'weekly13', games: 13, leadSeconds: 24 * 3600 },
      headers: bearer(user),
    });
    expect(tooMany.statusCode).toBe(409);
    expect(apiError(tooMany).code).toBe('not_enough_events');
  });

  it('needs a signed-in player and refuses a disabled template', async () => {
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/dev/jackpots/rounds' });
    expect(anonymous.statusCode).toBe(401);

    const user = await player(0n);
    const setWeekly = (enabled: boolean) =>
      db.transaction((tx) =>
        updateJackpotTemplate(tx, {
          code: 'weekly13',
          value: { ...DEFAULT_JACKPOTS.weekly13, enabled },
          actor: { type: 'system' },
        }),
      );
    await setWeekly(false);
    try {
      const disabled = await ctx.app.inject({
        method: 'POST',
        url: '/dev/jackpots/rounds',
        payload: { template: 'weekly13', games: 1 },
        headers: bearer(user),
      });
      expect(disabled.statusCode).toBe(409);
      expect(apiError(disabled).code).toBe('jackpot_disabled');
    } finally {
      await setWeekly(true);
    }
  });

  it('is enabled only in demo mode outside production, and absent in licensed mode', async () => {
    const { config } = ctx.deps;
    expect(devJackpotsEnabled({ config })).toBe(true);
    expect(devJackpotsEnabled({ config: { ...config, mode: 'licensed' } })).toBe(false);
    expect(devJackpotsEnabled({ config: { ...config, nodeEnv: 'production' } })).toBe(false);

    const app = buildApp(
      { ...ctx.deps, config: { ...config, mode: 'licensed' } },
      { logger: false, rateLimitNameSpace: `licensed-jp-${randomBytes(4).toString('hex')}:` },
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/dev/jackpots/rounds',
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('not_found');
    } finally {
      await app.close();
    }
  });
});
