import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  BetView,
  CashOutOfferChangedDetails,
  CashOutOffersResponse,
  CashOutOfferView,
  CashOutResponse,
  CashOutUnavailableDetails,
  MAX_CASH_OUT_OFFERS,
  MyBetsResponse,
  WalletResponse,
} from '@vamos/contracts';
import {
  birr,
  cashOutOffer,
  cashOutPayout,
  DEFAULT_BET_RULES,
  DEFAULT_CASH_OUT,
  DEFAULT_TAX,
  toWire,
} from '@vamos/core';
import {
  getSetting,
  setMarketStatus,
  setSelectionOdds,
  setSetting,
  type Database,
} from '@vamos/db';
import { bets, ledgerTransactions, outboxEvents, rgExclusions } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/lib/idempotency';
import { clearGameSettingsCache } from '../src/modules/betting/service';
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
  type LoggedInUser,
  type TestContext,
} from './helpers';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });
const newKey = () => randomUUID();
const trader = { adminId: '00000000-0000-4000-8000-00000000bbbb', reason: 'test' };

let ctx: TestContext;
let db: Database;

/** One prematch event per test (so odds moves do not leak between tests). */
async function freshEvent() {
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.league,
    homeTeamId: ids.home,
    awayTeamId: ids.away,
    startTime: minutes(120),
  });
  const market = await insertMarket(db, event.id, '1x2', null, [
    ['1', 1850],
    ['X', 3400],
    ['2', 4200],
  ]);
  return { eventId: event.id, marketId: market.id, home: market.selectionIds['1']! };
}

const ids = {} as { league: string; home: string; away: string };

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
    name: { en: 'Ethiopian Premier League' },
  });
  ids.home = await insertTeam(db, 'football', 'STG', { en: 'St. George' });
  ids.away = await insertTeam(db, 'football', 'FAS', { en: 'Fasil Kenema' });
});

afterAll(async () => {
  await ctx?.close();
});

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

async function player(): Promise<LoggedInUser> {
  const user = await registerAndLogin(ctx);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/wallet/demo-topup',
    payload: { amount: toWire(birr(5_000)) },
    headers: { ...bearer(user), 'idempotency-key': newKey() },
  });
  expect(response.statusCode).toBe(200);
  return user;
}

async function cash(user: LoggedInUser): Promise<bigint> {
  const response = await ctx.app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
  return BigInt(WalletResponse.parse(response.json()).cash);
}

async function placeSingle(user: LoggedInUser, selectionId: string, stake: bigint, odds = 1850) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/bets',
    payload: { stake: toWire(stake), legs: [{ selectionId, oddsMilli: odds }] },
    headers: { ...bearer(user), 'idempotency-key': newKey() },
  });
  expect(response.statusCode).toBe(201);
  return BetView.parse(response.json());
}

async function setOdds(selectionId: string, oddsMilli: number) {
  await db.transaction((tx) => setSelectionOdds(tx, [{ selectionId, oddsMilli, source: 'test' }]));
}

function getOffer(user: LoggedInUser, betId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/me/bets/${betId}/cash-out`,
    headers: bearer(user),
  });
}

function cashOut(
  user: LoggedInUser,
  betId: string,
  gross: string,
  key: string | null = newKey(),
  headers: Record<string, string> = bearer(user),
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/me/bets/${betId}/cash-out`,
    payload: { gross },
    headers: { ...headers, ...(key === null ? {} : { 'idempotency-key': key }) },
  });
}

/** The offer for a single at `placed` odds now priced at `current` (default settings), from core. */
function expectedOffer(stake: bigint, placed: number, current: number) {
  const offer = cashOutOffer({
    stake,
    legs: [{ placedOddsMilli: placed, state: 'open', currentOddsMilli: current }],
    config: DEFAULT_CASH_OUT,
    maxPayout: DEFAULT_BET_RULES.maxPayout,
  });
  return { ...cashOutPayout({ stake, gross: offer.amount, tax: DEFAULT_TAX }), offer };
}

describe('cash-out offers', () => {
  it('shows the offer of an open bet in its view, on its own and in a batch', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(100));
    const unchanged = expectedOffer(birr(100), 1850, 1850);
    expect(bet.cashOutOffer).toMatchObject({
      betId: bet.id,
      available: true,
      reason: null,
      gross: toWire(unchanged.gross),
      tax: '0',
      net: toWire(unchanged.gross),
    });
    expect(bet.cashedOut).toBeNull();

    // The odds shorten: the offer rises above the stake and carries the winnings tax.
    const big = await placeSingle(user, event.home, birr(1_000));
    await setOdds(event.home, 1010);
    const response = await getOffer(user, big.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const offer = CashOutOfferView.parse(response.json());
    const expected = expectedOffer(birr(1_000), 1850, 1010);
    expect(expected.gross).toBeGreaterThan(birr(1_000));
    expect(offer).toMatchObject({
      available: true,
      gross: toWire(expected.gross),
      tax: toWire(expected.tax),
      net: toWire(expected.net),
      potentialReturn: toWire(expected.offer.potentialReturn),
      quotedAt: NOW.toISOString(),
    });
    expect(BigInt(offer.tax)).toBeGreaterThan(0n);
    expect(BigInt(offer.net)).toBe(BigInt(offer.gross) - BigInt(offer.tax));

    const view = await ctx.app.inject({
      method: 'GET',
      url: `/me/bets/${big.id}`,
      headers: bearer(user),
    });
    expect(BetView.parse(view.json()).cashOutOffer).toEqual(offer);

    // The batch: in request order, someone else's and unknown bets left out.
    const other = await player();
    const theirs = await placeSingle(other, event.home, birr(10), 1010);
    const batch = await ctx.app.inject({
      method: 'GET',
      url: `/me/cash-out-offers?betIds=${big.id},${theirs.id},${randomUUID()},${bet.id}`,
      headers: bearer(user),
    });
    expect(batch.statusCode).toBe(200);
    const items = CashOutOffersResponse.parse(batch.json()).items;
    expect(items.map((item) => item.betId)).toEqual([big.id, bet.id]);
    expect(items[0]).toEqual(offer);

    // The parameter may also be repeated.
    const repeated = await ctx.app.inject({
      method: 'GET',
      url: `/me/cash-out-offers?betIds=${bet.id}&betIds=${big.id}`,
      headers: bearer(user),
    });
    expect(CashOutOffersResponse.parse(repeated.json()).items.map((i) => i.betId)).toEqual([
      bet.id,
      big.id,
    ]);
  });

  it('reports a suspended leg as unavailable and refuses to cash it out (409)', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(50));
    await db.transaction((tx) => setMarketStatus(tx, event.marketId, 'suspended', trader));

    const offer = CashOutOfferView.parse((await getOffer(user, bet.id)).json());
    expect(offer).toMatchObject({ available: false, reason: 'leg_suspended', gross: '0' });
    const before = await cash(user);
    const response = await cashOut(user, bet.id, bet.cashOutOffer!.gross);
    expect(response.statusCode).toBe(409);
    const error = apiError(response);
    expect(error.code).toBe('cashout_unavailable');
    expect(CashOutUnavailableDetails.parse(error.details)).toEqual({ reason: 'leg_suspended' });
    expect(await cash(user)).toBe(before);

    await db.transaction((tx) => setMarketStatus(tx, event.marketId, 'open', trader));
    expect((await cashOut(user, bet.id, bet.cashOutOffer!.gross)).statusCode).toBe(200);
  });

  it("is 404 for someone else's bet or an unknown id, and needs a session (401)", async () => {
    const event = await freshEvent();
    const owner = await player();
    const intruder = await player();
    const bet = await placeSingle(owner, event.home, birr(20));

    for (const id of [bet.id, randomUUID(), 'not-a-uuid']) {
      const offer = await getOffer(intruder, id);
      expect(offer.statusCode).toBe(404);
      expect(apiError(offer).code).toBe('not_found');
      const execute = await cashOut(intruder, id, '100');
      expect(execute.statusCode).toBe(404);
      expect(apiError(execute).code).toBe('not_found');
    }
    expect((await getOffer(owner, bet.id)).statusCode).toBe(200);

    const anonymous = await ctx.app.inject({ method: 'GET', url: `/me/bets/${bet.id}/cash-out` });
    expect(anonymous.statusCode).toBe(401);
    const anonymousPost = await cashOut(owner, bet.id, '100', newKey(), {});
    expect(anonymousPost.statusCode).toBe(401);
    const batch = await ctx.app.inject({
      method: 'GET',
      url: `/me/cash-out-offers?betIds=${bet.id}`,
    });
    expect(batch.statusCode).toBe(401);
  });

  it('validates the batch query (1 to MAX_CASH_OUT_OFFERS ids)', async () => {
    const user = await player();
    const tooMany = Array.from({ length: MAX_CASH_OUT_OFFERS + 1 }, () => randomUUID()).join(',');
    for (const query of [
      '',
      'betIds=',
      'betIds=,,',
      `betIds=${tooMany}`,
      `betIds=${'x'.repeat(65)}`,
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/me/cash-out-offers?${query}`,
        headers: bearer(user),
      });
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('validation_error');
    }
    const exactly = Array.from({ length: MAX_CASH_OUT_OFFERS }, () => randomUUID()).join(',');
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/me/cash-out-offers?betIds=${exactly}`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);
    expect(CashOutOffersResponse.parse(response.json()).items).toEqual([]);
  });
});

describe('POST /me/bets/:id/cash-out', () => {
  it('pays the offer, records the bet as cashed out and replays by Idempotency-Key', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(1_000));
    await setOdds(event.home, 1200);
    const offer = CashOutOfferView.parse((await getOffer(user, bet.id)).json());
    const expected = expectedOffer(birr(1_000), 1850, 1200);
    expect(offer.gross).toBe(toWire(expected.gross));
    const before = await cash(user);

    const key = newKey();
    ctx.clock.advance(1_000);
    const response = await cashOut(user, bet.id, offer.gross, key);
    expect(response.statusCode).toBe(200);
    expect(response.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    const body = CashOutResponse.parse(response.json());
    const at = ctx.clock.now.toISOString();
    expect(body.cashOut).toEqual({
      gross: toWire(expected.gross),
      tax: toWire(expected.tax),
      net: toWire(expected.net),
      cashedOutAt: at,
    });
    expect(body.bet).toMatchObject({
      id: bet.id,
      status: 'cashed_out',
      settledGross: toWire(expected.gross),
      settledTax: toWire(expected.tax),
      settledNet: toWire(expected.net),
      settledAt: at,
      cashOutOffer: null,
      cashedOut: body.cashOut,
    });
    expect(await cash(user)).toBe(before + expected.net);

    // One bet_cashout posting, one outbox event.
    const postings = await db
      .select()
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.refId, bet.id), eq(ledgerTransactions.type, 'bet_cashout')));
    expect(postings).toHaveLength(1);
    const events = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, bet.id), eq(outboxEvents.type, 'bet.cashed_out')));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ betId: bet.id, userId: user.userId });

    // The same key again: the same answer, marked as a replay, nothing paid twice.
    ctx.clock.advance(1_000);
    const replay = await cashOut(user, bet.id, offer.gross, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(CashOutResponse.parse(replay.json())).toEqual(body);
    expect(await cash(user)).toBe(before + expected.net);

    // The same key for another amount is refused (422); a new key finds the bet closed (409).
    const reused = await cashOut(user, bet.id, '100', key);
    expect(reused.statusCode).toBe(422);
    expect(apiError(reused).code).toBe('idempotency_key_reused');
    const again = await cashOut(user, bet.id, offer.gross);
    expect(again.statusCode).toBe(409);
    expect(apiError(again)).toMatchObject({
      code: 'cashout_unavailable',
      details: { reason: 'bet_not_open' },
    });
    expect(await cash(user)).toBe(before + expected.net);

    // My Bets shows it as settled with what the cash-out paid.
    const settled = await ctx.app.inject({
      method: 'GET',
      url: '/me/bets?status=settled',
      headers: bearer(user),
    });
    const mine = MyBetsResponse.parse(settled.json()).items;
    expect(mine.find((item) => item.id === bet.id)?.cashedOut).toEqual(body.cashOut);
    const offerNow = CashOutOfferView.parse((await getOffer(user, bet.id)).json());
    expect(offerNow).toMatchObject({ available: false, reason: 'bet_not_open' });
  });

  it('refuses a lower fresh offer with the new one (409), and pays a higher one', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(200));
    const seen = bet.cashOutOffer!;

    // The price drifts out: the offer falls below what the player saw.
    await setOdds(event.home, 2600);
    const lower = expectedOffer(birr(200), 1850, 2600);
    const before = await cash(user);
    const refused = await cashOut(user, bet.id, seen.gross);
    expect(refused.statusCode).toBe(409);
    const error = apiError(refused);
    expect(error.code).toBe('cashout_offer_changed');
    const { offer } = CashOutOfferChangedDetails.parse(error.details);
    expect(offer).toMatchObject({ available: true, gross: toWire(lower.gross) });
    expect(await cash(user)).toBe(before);
    expect((await db.select().from(bets).where(eq(bets.id, bet.id)))[0]!.status).toBe('open');

    // The player accepts the new offer; the price shortens meanwhile: the fresh, higher offer is paid.
    await setOdds(event.home, 1500);
    const higher = expectedOffer(birr(200), 1850, 1500);
    const paid = await cashOut(user, bet.id, offer.gross);
    expect(paid.statusCode).toBe(200);
    const body = CashOutResponse.parse(paid.json());
    expect(body.cashOut.gross).toBe(toWire(higher.gross));
    expect(BigInt(body.cashOut.gross)).toBeGreaterThan(BigInt(offer.gross));
    expect(await cash(user)).toBe(before + higher.net);
  });

  it('lets a self-excluded player cash out (it is not a stake)', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(30));
    await db
      .insert(rgExclusions)
      .values({ userId: user.userId, kind: 'self_exclusion', startsAt: NOW, endsAt: null });
    const response = await cashOut(user, bet.id, bet.cashOutOffer!.gross);
    expect(response.statusCode).toBe(200);
    expect(CashOutResponse.parse(response.json()).bet.status).toBe('cashed_out');
  });

  it('refuses a bet waiting for live acceptance (409 bet_not_open)', async () => {
    const live = await insertEvent(db, {
      sportId: 'football',
      competitionId: ids.league,
      homeTeamId: ids.away,
      awayTeamId: ids.home,
      startTime: minutes(-20),
      status: 'live',
      liveMinute: 20,
      score: [0, 0],
    });
    const market = await insertMarket(db, live.id, '1x2', null, [
      ['1', 2000],
      ['X', 3000],
      ['2', 3500],
    ]);
    const user = await player();
    const bet = await placeSingle(user, market.selectionIds['1']!, birr(10), 2000);
    expect(bet.status).toBe('pending_acceptance');
    expect(bet.cashOutOffer).toBeNull();
    const response = await cashOut(user, bet.id, '900');
    expect(response.statusCode).toBe(409);
    expect(apiError(response)).toMatchObject({
      code: 'cashout_unavailable',
      details: { reason: 'bet_not_open' },
    });
  });

  it('validates the request: Idempotency-Key, a positive amount, CSRF with cookies', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(40));
    const gross = bet.cashOutOffer!.gross;

    const noKey = await cashOut(user, bet.id, gross, null);
    expect(noKey.statusCode).toBe(400);
    expect(apiError(noKey).code).toBe('idempotency_key_required');
    for (const amount of ['0', '-5', 'abc', '1.5', '']) {
      const response = await cashOut(user, bet.id, amount);
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('validation_error');
    }

    const forged = await cashOut(user, bet.id, gross, newKey(), { cookie: user.cookie });
    expect(forged.statusCode).toBe(403);
    expect(apiError(forged).code).toBe('csrf_invalid');
    expect((await db.select().from(bets).where(eq(bets.id, bet.id)))[0]!.status).toBe('open');

    const genuine = await cashOut(user, bet.id, gross, newKey(), {
      cookie: user.cookie,
      'x-csrf-token': user.csrfToken,
    });
    expect(genuine.statusCode).toBe(200);
  });

  it('uses the cash-out settings in force when executing, not a cached copy', async () => {
    const event = await freshEvent();
    const user = await player();
    const bet = await placeSingle(user, event.home, birr(60));
    // Warm the read cache, then switch cash-out off.
    expect((await getOffer(user, bet.id)).statusCode).toBe(200);
    const previous = await getSetting<unknown>(db, 'cash_out');
    await setSetting(db, 'cash_out', { ...DEFAULT_CASH_OUT, enabled: false });
    try {
      const response = await cashOut(user, bet.id, bet.cashOutOffer!.gross);
      expect(response.statusCode).toBe(409);
      expect(apiError(response)).toMatchObject({
        code: 'cashout_unavailable',
        details: { reason: 'disabled' },
      });
    } finally {
      await setSetting(db, 'cash_out', previous ?? DEFAULT_CASH_OUT);
      clearGameSettingsCache(db);
    }
  });
});
