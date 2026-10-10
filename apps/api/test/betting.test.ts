import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  BetView,
  BookingCodeResponse,
  MyBetsResponse,
  QuoteResponse,
  WalletResponse,
} from '@vamos/contracts';
import {
  BOOKING_CODE_LENGTH,
  DEFAULT_BET_RULES,
  DEFAULT_MULTI_BONUS,
  DEFAULT_TAX,
  birr,
  quoteBet,
  toWire,
  type SlipLeg,
} from '@vamos/core';
import { BOOKING_CODE_TTL_MS, type Database } from '@vamos/db';
import {
  bets,
  bookingCodes,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
} from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/lib/idempotency';
import { BETTING_RATE_LIMITS } from '../src/modules/betting/routes';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });
const newKey = () => randomUUID();

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

let ctx: TestContext;
let db: Database;

/** Selection ids by fixture name. */
const sel = {} as Record<
  | 'aHome'
  | 'aDraw'
  | 'aOver'
  | 'bHome'
  | 'bAway'
  | 'cHome'
  | 'cAwaySuspended'
  | 'finishedHome'
  | 'liveHome',
  string
>;
const eventIds = {} as Record<'a' | 'b' | 'c', { id: string; gameId: number }>;

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.clock.now = NOW;
  db = ctx.db.db;

  await insertSport(db, 'football', { en: 'Football', am: 'እግር ኳስ' }, 10);
  const ethiopia = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  const league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: ethiopia,
    slug: 'ethiopian-premier-league',
    name: { en: 'Ethiopian Premier League' },
  });
  const team = (short: string, en: string, am?: string) =>
    insertTeam(db, 'football', short, am === undefined ? { en } : { en, am });
  const stGeorge = await team('STG', 'St. George', 'ቅዱስ ጊዮርጊስ');
  const fasil = await team('FAS', 'Fasil Kenema');
  const bunna = await team('BUN', 'Ethiopia Bunna');
  const sidama = await team('SID', 'Sidama Coffee');
  const base = { sportId: 'football', competitionId: league };

  eventIds.a = await insertEvent(db, {
    ...base,
    homeTeamId: stGeorge,
    awayTeamId: fasil,
    startTime: minutes(120),
  });
  const aMain = await insertMarket(db, eventIds.a.id, '1x2', null, ONE_X_TWO);
  sel.aHome = aMain.selectionIds['1']!;
  sel.aDraw = aMain.selectionIds['X']!;
  const aTotals = await insertMarket(db, eventIds.a.id, 'ou', '2.5', [
    ['over', 1950],
    ['under', 1800],
  ]);
  sel.aOver = aTotals.selectionIds['over']!;

  eventIds.b = await insertEvent(db, {
    ...base,
    homeTeamId: bunna,
    awayTeamId: sidama,
    startTime: minutes(180),
  });
  const bMain = await insertMarket(db, eventIds.b.id, '1x2', null, [
    ['1', 2100],
    ['X', 3200],
    ['2', 3300],
  ]);
  sel.bHome = bMain.selectionIds['1']!;
  sel.bAway = bMain.selectionIds['2']!;

  eventIds.c = await insertEvent(db, {
    ...base,
    homeTeamId: fasil,
    awayTeamId: bunna,
    startTime: minutes(240),
  });
  const cMain = await insertMarket(db, eventIds.c.id, '1x2', null, [
    ['1', 1500],
    ['X', 3600],
    ['2', 5000, 'suspended'],
  ]);
  sel.cHome = cMain.selectionIds['1']!;
  sel.cAwaySuspended = cMain.selectionIds['2']!;

  const finished = await insertEvent(db, {
    ...base,
    homeTeamId: sidama,
    awayTeamId: stGeorge,
    startTime: minutes(-180),
    status: 'finished',
    score: [1, 0],
  });
  sel.finishedHome = (await insertMarket(db, finished.id, '1x2', null, ONE_X_TWO)).selectionIds[
    '1'
  ]!;

  const live = await insertEvent(db, {
    ...base,
    homeTeamId: bunna,
    awayTeamId: stGeorge,
    startTime: minutes(-30),
    status: 'live',
    liveMinute: 30,
    score: [0, 0],
  });
  sel.liveHome = (await insertMarket(db, live.id, '1x2', null, ONE_X_TWO)).selectionIds['1']!;
});

afterAll(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------

function quote(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/betslip/quote', payload });
}

function placeBet(
  user: LoggedInUser,
  payload: Record<string, unknown>,
  key: string | null = newKey(),
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/bets',
    payload,
    headers: { ...bearer(user), ...(key === null ? {} : { 'idempotency-key': key }) },
  });
}

async function topUp(user: LoggedInUser, amount = birr(1_000)) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/wallet/demo-topup',
    payload: { amount: toWire(amount) },
    headers: { ...bearer(user), 'idempotency-key': newKey() },
  });
  expect(response.statusCode).toBe(200);
}

async function cash(user: LoggedInUser): Promise<bigint> {
  const response = await ctx.app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
  expect(response.statusCode).toBe(200);
  return BigInt(WalletResponse.parse(response.json()).cash);
}

/** A logged-in player with 1,000 ETB of play money. */
async function fundedPlayer(): Promise<LoggedInUser> {
  const user = await registerAndLogin(ctx);
  await topUp(user);
  return user;
}

/** quoteBet with the default settings (what the API should price a slip at). */
function expectedQuote(stake: bigint, legs: SlipLeg[]) {
  return quoteBet({
    stake,
    legs,
    rules: DEFAULT_BET_RULES,
    multiBonus: DEFAULT_MULTI_BONUS,
    tax: DEFAULT_TAX,
  });
}

// ---------------------------------------------------------------------------

describe('POST /betslip/quote', () => {
  it('prices an accumulator at the current odds and labels each leg', async () => {
    const stake = birr(100);
    const response = await quote({
      stake: toWire(stake),
      legs: [
        { selectionId: sel.aHome, oddsMilli: 1850 },
        { selectionId: sel.bAway, oddsMilli: 3000 },
        { selectionId: sel.cHome },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = QuoteResponse.parse(response.json());

    const expected = expectedQuote(stake, [
      { selectionId: sel.aHome, eventId: eventIds.a.id, oddsMilli: 1850 },
      { selectionId: sel.bAway, eventId: eventIds.b.id, oddsMilli: 3300 },
      { selectionId: sel.cHome, eventId: eventIds.c.id, oddsMilli: 1500 },
    ]);
    expect(expected.bonusPercentBps).toBe(300);
    expect(body).toEqual({
      betType: 'multi',
      stake: toWire(stake),
      totalOddsMilli: expected.totalOddsMilli.toString(),
      grossReturn: toWire(expected.grossReturn),
      bonusPercentBps: 300,
      bonusAmount: toWire(expected.bonusAmount),
      grossPayout: toWire(expected.grossPayout),
      cappedByMaxPayout: false,
      taxAmount: toWire(expected.taxAmount),
      netPayout: toWire(expected.netPayout),
      errors: [],
      legs: [
        {
          selectionId: sel.aHome,
          eventId: eventIds.a.id,
          gameId: String(eventIds.a.gameId).padStart(4, '0'),
          eventName: 'St. George vs Fasil Kenema',
          marketName: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
          selectionName: { en: 'St. George', am: 'ቅዱስ ጊዮርጊስ' },
          oddsMilli: 1850,
          requestedOddsMilli: 1850,
          oddsChanged: false,
          available: true,
          reason: null,
          live: false,
        },
        expect.objectContaining({
          selectionId: sel.bAway,
          selectionName: { en: 'Sidama Coffee', am: 'Sidama Coffee' },
          oddsMilli: 3300,
          requestedOddsMilli: 3000,
          oddsChanged: true,
          available: true,
        }),
        expect.objectContaining({
          selectionId: sel.cHome,
          oddsMilli: 1500,
          requestedOddsMilli: null,
          oddsChanged: false,
        }),
      ],
    });
  });

  it('reports unavailable legs and prices only the others', async () => {
    const unknown = randomUUID();
    const response = await quote({
      stake: toWire(birr(50)),
      legs: [
        { selectionId: sel.aOver },
        { selectionId: unknown },
        { selectionId: sel.cAwaySuspended },
        { selectionId: sel.finishedHome },
        { selectionId: sel.liveHome },
      ],
    });
    expect(response.statusCode).toBe(200);
    const body = QuoteResponse.parse(response.json());
    expect(body.legs.map((leg) => [leg.available, leg.reason, leg.live])).toEqual([
      [true, null, false],
      [false, 'not_found', false],
      [false, 'suspended', false],
      [false, 'event_closed', false],
      [true, null, true],
    ]);
    expect(body.legs[0]?.selectionName).toEqual({ en: 'Over 2.5', am: 'ከ2.5 በላይ' });
    expect(body.legs[1]).toMatchObject({
      selectionId: unknown,
      eventId: null,
      gameId: null,
      eventName: null,
      oddsMilli: null,
    });
    // Over 2.5 (1.950) × live home (1.850) = 3.6075, rounded down.
    expect(body.betType).toBe('multi');
    expect(body.totalOddsMilli).toBe('3607');
  });

  it('returns slip errors for a stake below the minimum', async () => {
    const response = await quote({ stake: '100', legs: [{ selectionId: sel.aHome }] });
    expect(response.statusCode).toBe(200);
    const body = QuoteResponse.parse(response.json());
    expect(body.errors.map((error) => error.code)).toContain('stake_below_minimum');
  });

  it('rejects a malformed request', async () => {
    const response = await quote({ stake: '-5', legs: [] });
    expect(response.statusCode).toBe(400);
    expect(apiError(response).code).toBe('validation_error');
  });
});

describe('POST /bets', () => {
  it('places a single, debits the stake and returns the bet', async () => {
    const user = await fundedPlayer();
    const stake = birr(100);
    const response = await placeBet(user, {
      stake: toWire(stake),
      legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }],
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    const bet = BetView.parse(response.json());
    const expected = expectedQuote(stake, [
      { selectionId: sel.aHome, eventId: eventIds.a.id, oddsMilli: 1850 },
    ]);
    expect(bet).toMatchObject({
      betType: 'single',
      status: 'open',
      channel: 'web',
      oddsChangePolicy: 'none',
      stake: toWire(stake),
      totalOddsMilli: '1850',
      potentialGross: toWire(expected.grossPayout),
      potentialBonus: '0',
      potentialTax: toWire(expected.taxAmount),
      potentialNet: toWire(expected.netPayout),
      settledGross: null,
      settledNet: null,
      placedAt: NOW.toISOString(),
      acceptAfter: null,
      acceptedAt: NOW.toISOString(),
      settledAt: null,
      legs: [
        {
          selectionId: sel.aHome,
          eventId: eventIds.a.id,
          gameId: String(eventIds.a.gameId).padStart(4, '0'),
          sport: 'football',
          eventName: 'St. George vs Fasil Kenema',
          // Team names in every language they have, so My Bets can show them localised.
          homeTeam: { en: 'St. George', am: 'ቅዱስ ጊዮርጊስ' },
          awayTeam: { en: 'Fasil Kenema' },
          startTime: minutes(120).toISOString(),
          marketName: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
          selectionName: { en: 'St. George', am: 'ቅዱስ ጊዮርጊስ' },
          oddsMilli: 1850,
          live: false,
          state: 'open',
        },
      ],
    });
    expect(bet.shortId).toMatch(/^[0-9A-Z]{8}$/);
    expect(await cash(user)).toBe(birr(1_000) - stake);

    const [stakePosting] = await db
      .select({ type: ledgerTransactions.type })
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.refType, 'bet'), eq(ledgerTransactions.refId, bet.id)));
    expect(stakePosting?.type).toBe('bet_stake');
    const placed = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, bet.id), eq(outboxEvents.type, 'bet.placed')));
    expect(placed).toHaveLength(1);
  });

  it('places an accumulator with the multi bonus', async () => {
    const user = await fundedPlayer();
    const stake = birr(200);
    const response = await placeBet(user, {
      stake: toWire(stake),
      legs: [
        { selectionId: sel.aOver, oddsMilli: 1950 },
        { selectionId: sel.bHome, oddsMilli: 2100 },
        { selectionId: sel.cHome, oddsMilli: 1500 },
      ],
    });
    expect(response.statusCode).toBe(201);
    const bet = BetView.parse(response.json());
    const expected = expectedQuote(stake, [
      { selectionId: sel.aOver, eventId: eventIds.a.id, oddsMilli: 1950 },
      { selectionId: sel.bHome, eventId: eventIds.b.id, oddsMilli: 2100 },
      { selectionId: sel.cHome, eventId: eventIds.c.id, oddsMilli: 1500 },
    ]);
    expect(bet).toMatchObject({
      betType: 'multi',
      status: 'open',
      totalOddsMilli: expected.totalOddsMilli.toString(),
      bonusPercentBps: 300,
      potentialBonus: toWire(expected.bonusAmount),
      potentialGross: toWire(expected.grossPayout),
      potentialTax: toWire(expected.taxAmount),
      potentialNet: toWire(expected.netPayout),
    });
    expect(bet.legs.map((leg) => [leg.selectionId, leg.oddsMilli])).toEqual([
      [sel.aOver, 1950],
      [sel.bHome, 2100],
      [sel.cHome, 1500],
    ]);
    expect(await cash(user)).toBe(birr(1_000) - stake);
  });

  it('holds a bet with a live leg for acceptance', async () => {
    const user = await fundedPlayer();
    const response = await placeBet(user, {
      stake: toWire(birr(20)),
      legs: [{ selectionId: sel.liveHome, oddsMilli: 1850 }],
    });
    expect(response.statusCode).toBe(201);
    const bet = BetView.parse(response.json());
    expect(bet.status).toBe('pending_acceptance');
    expect(bet.acceptedAt).toBeNull();
    expect(bet.acceptAfter).not.toBeNull();
    expect(new Date(bet.acceptAfter!).getTime()).toBeGreaterThan(NOW.getTime());
    expect(bet.legs[0]?.live).toBe(true);
  });

  it('replays the same request with the same key without a second stake', async () => {
    const user = await fundedPlayer();
    const key = newKey();
    const payload = {
      stake: toWire(birr(50)),
      legs: [{ selectionId: sel.bHome, oddsMilli: 2100 }],
    };
    const first = await placeBet(user, payload, key);
    expect(first.statusCode).toBe(201);
    const replay = await placeBet(user, payload, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(BetView.parse(replay.json())).toEqual(BetView.parse(first.json()));
    expect(await cash(user)).toBe(birr(950));
    const rows = await db.select({ id: bets.id }).from(bets).where(eq(bets.userId, user.userId));
    expect(rows).toHaveLength(1);

    // A key is scoped to its player: another player may use it.
    const other = await fundedPlayer();
    const otherBet = await placeBet(other, payload, key);
    expect(otherBet.statusCode).toBe(201);
    expect(BetView.parse(otherBet.json()).id).not.toBe(BetView.parse(first.json()).id);
  });

  it('refuses a reused key with a different payload (422)', async () => {
    const user = await fundedPlayer();
    const key = newKey();
    const legs = [{ selectionId: sel.bHome, oddsMilli: 2100 }];
    expect((await placeBet(user, { stake: toWire(birr(50)), legs }, key)).statusCode).toBe(201);
    const reused = await placeBet(user, { stake: toWire(birr(60)), legs }, key);
    expect(reused.statusCode).toBe(422);
    expect(apiError(reused).code).toBe('idempotency_key_reused');
    expect(await cash(user)).toBe(birr(950));
  });

  it('requires an idempotency key (400)', async () => {
    const user = await fundedPlayer();
    const legs = [{ selectionId: sel.aHome, oddsMilli: 1850 }];
    const missing = await placeBet(user, { stake: toWire(birr(10)), legs }, null);
    expect(missing.statusCode).toBe(400);
    expect(apiError(missing).code).toBe('idempotency_key_required');
    const short = await placeBet(user, { stake: toWire(birr(10)), legs }, 'short');
    expect(short.statusCode).toBe(400);
    expect(await cash(user)).toBe(birr(1_000));
  });

  it('refuses changed odds under policy none (409) and takes a rise under policy higher', async () => {
    const user = await fundedPlayer();
    const legs = [
      { selectionId: sel.aHome, oddsMilli: 1700 },
      { selectionId: sel.bHome, oddsMilli: 2100 },
    ];
    const refused = await placeBet(user, { stake: toWire(birr(10)), legs });
    expect(refused.statusCode).toBe(409);
    const error = apiError(refused);
    expect(error.code).toBe('odds_changed');
    expect(error.details).toEqual({
      policy: 'none',
      changes: [
        {
          selectionId: sel.aHome,
          requestedOddsMilli: 1700,
          currentOddsMilli: 1850,
          direction: 'up',
        },
      ],
    });
    expect(await cash(user)).toBe(birr(1_000));

    const accepted = await placeBet(user, {
      stake: toWire(birr(10)),
      legs,
      oddsChangePolicy: 'higher',
    });
    expect(accepted.statusCode).toBe(201);
    const bet = BetView.parse(accepted.json());
    expect(bet.oddsChangePolicy).toBe('higher');
    expect(bet.legs[0]?.oddsMilli).toBe(1850);

    const drop = await placeBet(user, {
      stake: toWire(birr(10)),
      legs: [{ selectionId: sel.aHome, oddsMilli: 1900 }],
      oddsChangePolicy: 'higher',
    });
    expect(drop.statusCode).toBe(409);
    expect(apiError(drop).details).toMatchObject({
      policy: 'higher',
      changes: [{ direction: 'down' }],
    });
  });

  it('refuses a suspended selection (409)', async () => {
    const user = await fundedPlayer();
    const response = await placeBet(user, {
      stake: toWire(birr(10)),
      legs: [{ selectionId: sel.cAwaySuspended, oddsMilli: 5000 }],
    });
    expect(response.statusCode).toBe(409);
    const error = apiError(response);
    expect(error.code).toBe('selection_unavailable');
    expect(error.details).toEqual({
      selections: [{ selectionId: sel.cAwaySuspended, reason: 'suspended' }],
    });
    expect(await cash(user)).toBe(birr(1_000));
  });

  it('refuses a stake above the balance (422)', async () => {
    const user = await registerAndLogin(ctx);
    await topUp(user, birr(10));
    const response = await placeBet(user, {
      stake: toWire(birr(20)),
      legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }],
    });
    expect(response.statusCode).toBe(422);
    const error = apiError(response);
    expect(error.code).toBe('insufficient_funds');
    expect(error.details).toEqual({ balance: toWire(birr(10)), stake: toWire(birr(20)) });
    expect(await cash(user)).toBe(birr(10));
  });

  it('refuses an invalid slip (422)', async () => {
    const user = await fundedPlayer();
    const response = await placeBet(user, {
      stake: toWire(birr(10)),
      legs: [
        { selectionId: sel.aHome, oddsMilli: 1850 },
        { selectionId: sel.aOver, oddsMilli: 1950 },
      ],
    });
    expect(response.statusCode).toBe(422);
    const error = apiError(response);
    expect(error.code).toBe('slip_invalid');
    expect(error.details).toMatchObject({ errors: [{ code: 'duplicate_event' }] });
  });

  it('refuses a self-excluded player (403)', async () => {
    const user = await fundedPlayer();
    await db
      .insert(rgExclusions)
      .values({ userId: user.userId, kind: 'self_exclusion', startsAt: NOW, endsAt: null });
    const response = await placeBet(user, {
      stake: toWire(birr(10)),
      legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }],
    });
    expect(response.statusCode).toBe(403);
    expect(apiError(response).code).toBe('self_excluded');
    expect(await cash(user)).toBe(birr(1_000));
  });

  it('requires authentication (401)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/bets',
      payload: {
        stake: toWire(birr(10)),
        legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }],
      },
      headers: { 'idempotency-key': newKey() },
    });
    expect(response.statusCode).toBe(401);
    expect(apiError(response).code).toBe('unauthorized');
  });

  it('requires the CSRF header with cookie authentication (403)', async () => {
    const user = await fundedPlayer();
    const payload = {
      stake: toWire(birr(10)),
      legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }],
    };
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/bets',
      payload,
      headers: { cookie: user.cookie, 'idempotency-key': newKey() },
    });
    expect(forged.statusCode).toBe(403);
    expect(apiError(forged).code).toBe('csrf_invalid');
    expect(await cash(user)).toBe(birr(1_000));

    const genuine = await ctx.app.inject({
      method: 'POST',
      url: '/bets',
      payload,
      headers: { cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'idempotency-key': newKey() },
    });
    expect(genuine.statusCode).toBe(201);
  });

  it('limits each player to BETTING_RATE_LIMITS.placeBet placements a minute (429), per player', async () => {
    const a = await fundedPlayer();
    const b = await fundedPlayer();
    // Both players share one address (a carrier NAT); only A uses up their budget.
    const from = { remoteAddress: '198.51.100.7' };
    const send = (user: LoggedInUser, stake: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/bets',
        payload: { stake, legs: [{ selectionId: sel.aHome, oddsMilli: 1850 }] },
        headers: { ...bearer(user), 'idempotency-key': newKey() },
        ...from,
      });
    for (let i = 0; i < BETTING_RATE_LIMITS.placeBet; i += 1) {
      // Refused requests count too (a zero stake is a 400).
      expect((await send(a, '0')).statusCode).toBe(400);
    }
    const limited = await send(a, toWire(birr(10)));
    expect(limited.statusCode).toBe(429);
    expect(apiError(limited).code).toBe('rate_limited');
    expect((await send(b, toWire(birr(10)))).statusCode).toBe(201);
  });
});

describe('GET /me/bets', () => {
  let owner: LoggedInUser;
  const placed: string[] = [];

  beforeAll(async () => {
    owner = await fundedPlayer();
    const legs = [
      [{ selectionId: sel.aHome, oddsMilli: 1850 }],
      [{ selectionId: sel.bHome, oddsMilli: 2100 }],
      [{ selectionId: sel.cHome, oddsMilli: 1500 }],
    ];
    try {
      for (const slip of legs) {
        ctx.clock.advance(1_000);
        const response = await placeBet(owner, { stake: toWire(birr(10)), legs: slip });
        expect(response.statusCode).toBe(201);
        placed.push(BetView.parse(response.json()).id);
      }
    } finally {
      ctx.clock.now = NOW;
    }
  });

  function myBets(user: LoggedInUser, query = '') {
    return ctx.app.inject({ method: 'GET', url: `/me/bets${query}`, headers: bearer(user) });
  }

  it('lists open bets newest first with cursor pagination', async () => {
    const first = await myBets(owner, '?status=open&limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = MyBetsResponse.parse(first.json());
    expect(page1.items.map((bet) => bet.id)).toEqual([placed[2], placed[1]]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await myBets(
      owner,
      `?status=open&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(second.statusCode).toBe(200);
    const page2 = MyBetsResponse.parse(second.json());
    expect(page2.items.map((bet) => bet.id)).toEqual([placed[0]]);
    expect(page2.nextCursor).toBeNull();

    // status defaults to open.
    const all = MyBetsResponse.parse((await myBets(owner)).json());
    expect(all.items).toHaveLength(3);
  });

  it('has no settled bets yet', async () => {
    const response = await myBets(owner, '?status=settled');
    expect(response.statusCode).toBe(200);
    expect(MyBetsResponse.parse(response.json())).toEqual({ items: [], nextCursor: null });
  });

  it('rejects a bad cursor or status (400)', async () => {
    const cursor = await myBets(owner, '?cursor=nonsense');
    expect(cursor.statusCode).toBe(400);
    expect(apiError(cursor).code).toBe('invalid_cursor');
    const status = await myBets(owner, '?status=won');
    expect(status.statusCode).toBe(400);
    expect(apiError(status).code).toBe('validation_error');
  });

  it("shows only the player's own bets", async () => {
    const stranger = await registerAndLogin(ctx);
    const list = MyBetsResponse.parse((await myBets(stranger)).json());
    expect(list.items).toEqual([]);

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/me/bets/${placed[0]}`,
      headers: bearer(owner),
    });
    expect(own.statusCode).toBe(200);
    expect(BetView.parse(own.json()).id).toBe(placed[0]);

    for (const id of [placed[0], randomUUID(), 'not-a-uuid']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/me/bets/${id}`,
        headers: bearer(stranger),
      });
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('not_found');
    }
  });

  it('requires authentication (401)', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/me/bets' });
    expect(list.statusCode).toBe(401);
    const one = await ctx.app.inject({ method: 'GET', url: `/me/bets/${placed[0]}` });
    expect(one.statusCode).toBe(401);
  });
});

describe('booking codes', () => {
  function createCode(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
    return ctx.app.inject({ method: 'POST', url: '/booking-codes', payload, headers });
  }

  function loadCode(code: string) {
    return ctx.app.inject({ method: 'GET', url: `/booking-codes/${encodeURIComponent(code)}` });
  }

  it('creates a code anonymously and loads it with current odds', async () => {
    const created = await createCode({
      legs: [{ selectionId: sel.aHome }, { selectionId: sel.bAway }],
    });
    expect(created.statusCode).toBe(201);
    const body = BookingCodeResponse.parse(created.json());
    expect(body.code).toHaveLength(BOOKING_CODE_LENGTH);
    expect(body.createdAt).toBe(NOW.toISOString());
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + BOOKING_CODE_TTL_MS).toISOString());
    expect(body.legs.map((leg) => [leg.selectionId, leg.oddsMilli, leg.available])).toEqual([
      [sel.aHome, 1850, true],
      [sel.bAway, 3300, true],
    ]);
    const [row] = await db
      .select({ createdBy: bookingCodes.createdByUserId })
      .from(bookingCodes)
      .where(eq(bookingCodes.code, body.code));
    expect(row?.createdBy).toBeNull();

    const loaded = await loadCode(body.code);
    expect(loaded.statusCode).toBe(200);
    expect(BookingCodeResponse.parse(loaded.json())).toEqual(body);

    // Typed codes are normalised (case, spaces and dashes).
    const typed = `${body.code.slice(0, 3).toLowerCase()}-${body.code.slice(3).toLowerCase()} `;
    const normalised = await loadCode(typed);
    expect(normalised.statusCode).toBe(200);
    expect(BookingCodeResponse.parse(normalised.json()).code).toBe(body.code);
  });

  it('records the creator when logged in', async () => {
    const user = await registerAndLogin(ctx);
    const created = await createCode({ legs: [{ selectionId: sel.cHome }] }, bearer(user));
    expect(created.statusCode).toBe(201);
    const { code } = BookingCodeResponse.parse(created.json());
    const [row] = await db
      .select({ createdBy: bookingCodes.createdByUserId })
      .from(bookingCodes)
      .where(eq(bookingCodes.code, code));
    expect(row?.createdBy).toBe(user.userId);
  });

  it('refuses unavailable selections (409)', async () => {
    const response = await createCode({
      legs: [{ selectionId: sel.aHome }, { selectionId: sel.cAwaySuspended }],
    });
    expect(response.statusCode).toBe(409);
    expect(apiError(response).code).toBe('selection_unavailable');
  });

  it('answers 404 for an unknown or malformed code and 410 once expired', async () => {
    for (const code of ['ZZZZZZ', 'nope', '0000000000']) {
      const response = await loadCode(code);
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('booking_code_not_found');
    }

    const created = await createCode({ legs: [{ selectionId: sel.bHome }] });
    const { code } = BookingCodeResponse.parse(created.json());
    ctx.clock.advance(BOOKING_CODE_TTL_MS);
    try {
      const expired = await loadCode(code);
      expect(expired.statusCode).toBe(410);
      expect(apiError(expired).code).toBe('booking_code_expired');
    } finally {
      ctx.clock.now = NOW;
    }
  });

  it('keeps the legs of a code whose selection is no longer bettable', async () => {
    const created = await createCode({ legs: [{ selectionId: sel.aDraw }] });
    const { code } = BookingCodeResponse.parse(created.json());
    // Two hours later the match has started: prematch betting is closed.
    ctx.clock.advance(121 * 60_000);
    try {
      const loaded = BookingCodeResponse.parse((await loadCode(code)).json());
      expect(loaded.legs).toEqual([
        expect.objectContaining({
          selectionId: sel.aDraw,
          available: false,
          reason: 'event_started',
        }),
      ]);
    } finally {
      ctx.clock.now = NOW;
    }
  });
});
