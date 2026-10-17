import { randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyLiveState,
  CatalogNotFoundError,
  CatalogStateError,
  getBetById,
  getCashOutOffer,
  listBetIdsForMarket,
  listBetsToSettle,
  MARKET_RESULTED,
  resultEvent,
  resultMarket,
  settleEventBets,
  settleMarketBets,
  settlePlacedBet,
  upsertFixture,
  type CatalogIds,
  type GameSettings,
  type ResultMarketInput,
  type UserBet,
} from '../src/index';
import { markets, outboxEvents, selections } from '../src/schema/index';
import {
  balances,
  createBettingDatabase,
  createEvent,
  finish,
  goLive,
  place,
  type TestDb,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';

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

/** Writes the live score of a live event (as the simulator does each tick). */
async function setScore(
  eventId: string,
  home: number,
  away: number,
  ht: [number, number] | null = null,
): Promise<void> {
  await handle.db.transaction((tx) =>
    applyLiveState(tx, eventId, {
      status: 'live',
      minute: ht === null ? 30 : 60,
      period: ht === null ? '1H' : '2H',
      home,
      away,
      htHome: ht?.[0] ?? null,
      htAway: ht?.[1] ?? null,
    }),
  );
}

const resultOne = (marketId: string, input: ResultMarketInput) =>
  handle.db.transaction((tx) => resultMarket(tx, marketId, input));

async function selectionRows(marketId: string) {
  return handle.db
    .select({ code: selections.code, status: selections.status, result: selections.result })
    .from(selections)
    .where(eq(selections.marketId, marketId))
    .orderBy(asc(selections.code));
}

async function marketRow(marketId: string) {
  const [row] = await handle.db.select().from(markets).where(eq(markets.id, marketId));
  if (row === undefined) throw new Error(`no market ${marketId}`);
  return row;
}

async function marketOutbox(marketId: string) {
  return handle.db
    .select({ type: outboxEvents.type, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.aggregateType, 'market'), eq(outboxEvents.aggregateId, marketId)))
    .orderBy(outboxEvents.id);
}

async function bet(id: string): Promise<UserBet> {
  const row = await getBetById(handle.db, id);
  if (row === null) throw new Error(`no bet ${id}`);
  return row;
}

/** A live football event with half-time result and both-teams-to-score markets. */
async function liveEventWithHalfTime() {
  const competitionId = ids.competitions.get('football/premier-league');
  const home = ids.teams.get('football/Arsenal');
  const away = ids.teams.get('football/Chelsea');
  if (competitionId === undefined || home === undefined || away === undefined) {
    throw new Error('seeded catalogue missing');
  }
  const { eventId } = await handle.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'test-feed',
        feedRef: `early:${randomUUID()}`,
        sport: 'football',
        competitionId,
        homeTeamId: home,
        awayTeamId: away,
        startTime: new Date(Date.now() + 3600_000),
      },
      [
        {
          type: 'ht_1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: 2500 },
            { code: 'X', oddsMilli: 2100 },
            { code: '2', oddsMilli: 4000 },
          ],
        },
        {
          type: 'btts',
          line: null,
          selections: [
            { code: 'yes', oddsMilli: 1800 },
            { code: 'no', oddsMilli: 1950 },
          ],
        },
      ],
    ),
  );
  await goLive(handle.db, eventId);
  const rows = await handle.db
    .select({ id: markets.id, type: markets.type })
    .from(markets)
    .where(eq(markets.eventId, eventId));
  const marketId = (type: string) => rows.find((row) => row.type === type)!.id;
  return { eventId, ht: marketId('ht_1x2'), btts: marketId('btts') };
}

describe('resultMarket', () => {
  it('results one market once its outcome is certain, with an outbox event and a market delta', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 2, 1);
    const outcome = await resultOne(event.marketIds.ou, { score: { home: 2, away: 1 } });
    expect(outcome).toEqual({
      outcome: 'resulted',
      eventId: event.eventId,
      marketId: event.marketIds.ou,
      status: 'settled',
      messages: [
        { type: 'market', eventId: event.eventId, data: { k: event.marketIds.ou, st: 'settled' } },
      ],
    });
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'won' },
      { code: 'under', status: 'settled', result: 'lost' },
    ]);
    const market = await marketRow(event.marketIds.ou);
    expect(market).toMatchObject({ status: 'settled', suspendedBy: null });
    expect(market.settledAt).toBeInstanceOf(Date);
    expect(await marketOutbox(event.marketIds.ou)).toEqual([
      {
        type: MARKET_RESULTED,
        payload: {
          eventId: event.eventId,
          marketId: event.marketIds.ou,
          status: 'settled',
          score: { home: 2, away: 1, htHome: null, htAway: null },
        },
      },
    ]);
    // The other markets of the event are untouched.
    expect((await marketRow(event.marketIds['1x2'])).status).toBe('open');
    expect((await selectionRows(event.marketIds['1x2'])).every((row) => row.result === null)).toBe(
      true,
    );
  });

  it('is idempotent: the same call again changes nothing', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 3, 0);
    await resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } });
    const before = {
      selections: await selectionRows(event.marketIds.ou),
      market: await marketRow(event.marketIds.ou),
    };
    const again = await resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } });
    expect(again).toEqual({
      outcome: 'unchanged',
      eventId: event.eventId,
      marketId: event.marketIds.ou,
      status: 'settled',
      messages: [],
    });
    // A later score that keeps the outcome is still the same result.
    await setScore(event.eventId, 4, 1);
    expect((await resultOne(event.marketIds.ou, { score: { home: 4, away: 1 } })).outcome).toBe(
      'unchanged',
    );
    expect({
      selections: await selectionRows(event.marketIds.ou),
      market: await marketRow(event.marketIds.ou),
    }).toEqual(before);
    expect(await marketOutbox(event.marketIds.ou)).toHaveLength(1);
  });

  it('refuses, writing nothing, while the outcome can still change', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 1, 1);
    for (const marketId of [event.marketIds.ou, event.marketIds['1x2'], event.marketIds.dnb]) {
      await expect(resultOne(marketId, { score: { home: 1, away: 1 } })).rejects.toThrow(
        CatalogStateError,
      );
      expect((await marketRow(marketId)).status).toBe('open');
      expect((await selectionRows(marketId)).every((row) => row.result === null)).toBe(true);
      expect(await marketOutbox(marketId)).toEqual([]);
    }
  });

  it('decides only on the event’s live score, and only while the event is live', async () => {
    const event = await createEvent(handle.db, ids);
    // Not kicked off yet.
    await expect(resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } })).rejects.toThrow(
      CatalogStateError,
    );
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 1, 0);
    // A score the event does not have (stale or made up) is refused.
    await expect(resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } })).rejects.toThrow(
      /live score/,
    );
    await expect(
      resultOne(event.marketIds.ou, { score: { home: 1, away: 0, htHome: 1, htAway: 0 } }),
    ).rejects.toThrow(CatalogStateError);
    expect((await marketRow(event.marketIds.ou)).status).toBe('open');
    // Invalid input and unknown markets.
    await expect(resultOne(event.marketIds.ou, { score: { home: -1, away: 0 } })).rejects.toThrow(
      RangeError,
    );
    await expect(resultOne(randomUUID(), { score: { home: 3, away: 0 } })).rejects.toThrow(
      CatalogNotFoundError,
    );
  });

  it('refuses a market already final with another result (corrections go through resultEvent)', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await finish(handle.db, event.eventId, 0, 0); // under 2.5 won
    await expect(resultOne(event.marketIds.ou, { score: { home: 2, away: 1 } })).rejects.toThrow(
      /already settled/,
    );
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'lost' },
      { code: 'under', status: 'settled', result: 'won' },
    ]);
  });

  it('results the half-time market after half time and both teams to score once both scored', async () => {
    const event = await liveEventWithHalfTime();
    await setScore(event.eventId, 1, 0);
    await expect(resultOne(event.ht, { score: { home: 1, away: 0 } })).rejects.toThrow(
      CatalogStateError,
    );
    await setScore(event.eventId, 1, 1, [1, 0]);
    expect(
      (await resultOne(event.ht, { score: { home: 1, away: 1, htHome: 1, htAway: 0 } })).status,
    ).toBe('settled');
    expect(await selectionRows(event.ht)).toEqual([
      { code: '1', status: 'settled', result: 'won' },
      { code: '2', status: 'settled', result: 'lost' },
      { code: 'X', status: 'settled', result: 'lost' },
    ]);
    expect(
      (await resultOne(event.btts, { score: { home: 1, away: 1, htHome: 1, htAway: 0 } })).status,
    ).toBe('settled');
    expect(await selectionRows(event.btts)).toEqual([
      { code: 'no', status: 'settled', result: 'lost' },
      { code: 'yes', status: 'settled', result: 'won' },
    ]);
  });

  it('full time leaves the early result as it is and results the rest; a correction re-resolves it', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 2, 1);
    await resultOne(event.marketIds.ou, { score: { home: 2, away: 1 } });
    const early = await marketRow(event.marketIds.ou);

    const fullTime = await handle.db.transaction((tx) =>
      resultEvent(tx, event.eventId, { status: 'finished', score: { home: 2, away: 1 } }),
    );
    expect(fullTime).toMatchObject({ outcome: 'resulted', marketsSettled: 2, marketsVoided: 0 });
    expect(fullTime.messages.filter((m) => m.type === 'market').map((m) => m.data)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ k: event.marketIds.ou })]),
    );
    expect(await marketRow(event.marketIds.ou)).toEqual(early);
    expect((await marketRow(event.marketIds['1x2'])).status).toBe('settled');
    expect((await selectionRows(event.marketIds['1x2'])).map((row) => row.result)).toEqual([
      'won',
      'lost',
      'lost',
    ]);

    // A correction to 1-1 re-resolves every market, the early one too.
    await finish(handle.db, event.eventId, 1, 1);
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'lost' },
      { code: 'under', status: 'settled', result: 'won' },
    ]);
    expect((await marketRow(event.marketIds.dnb)).status).toBe('void');
  });
});

describe('settling market.resulted', () => {
  it('settles the bets with a leg on the market, and only those', async () => {
    const userId = await player();
    const a = await createEvent(handle.db, ids);
    const b = await createEvent(handle.db, ids);
    const leg = (selectionId: string, oddsMilli: number) => ({ selectionId, oddsMilli });
    const stake = birr(100);
    const [over, under, home, acca] = await Promise.all(
      [
        [leg(a.over, 1900)],
        [leg(a.under, 1850)],
        [leg(a.home, 2000)],
        [leg(a.over, 1900), leg(b.home, 2000)],
      ].map((legs) => place(handle.db, userId, { stake, legs, settings }).then((r) => r.bet.id)),
    );
    await goLive(handle.db, a.eventId);
    await setScore(a.eventId, 2, 1);
    await resultOne(a.marketIds.ou, { score: { home: 2, away: 1 } });

    expect(await listBetIdsForMarket(handle.db, a.marketIds.ou)).toEqual(
      [over!, under!, acca!].sort(),
    );
    const before = await balances(handle.db, userId);
    const summary = await handle.db.transaction((tx) =>
      settleMarketBets(tx, a.marketIds.ou, new Date()),
    );
    expect(summary).toEqual({
      marketId: a.marketIds.ou,
      bets: 3,
      outcomes: {
        settled: 2,
        resettled: 0,
        reopened: 0,
        unchanged: 1,
        skipped: 0,
        correction_blocked: 0,
      },
    });
    // over 2.5 won at 1.90: 190 ETB (90 ETB of winnings, under the tax exemption).
    expect(await bet(over!)).toMatchObject({ status: 'won', settledNetPayout: birr(190) });
    expect(await bet(under!)).toMatchObject({ status: 'lost', settledNetPayout: 0n });
    // The accumulator's decided leg is up to date; the bet waits for its other leg.
    const accumulator = await bet(acca!);
    expect(accumulator.status).toBe('open');
    expect(accumulator.legs.map((l) => l.state)).toEqual(['won', 'open']);
    // A bet on another market of the same event is not touched.
    const other = await bet(home!);
    expect(other.status).toBe('open');
    expect(other.legs.map((l) => l.state)).toEqual(['open']);
    expect((await balances(handle.db, userId)).cash - before.cash).toBe(birr(190));

    // Replaying the job changes nothing (settled bets are looked at again, as for corrections).
    const replay = await handle.db.transaction((tx) =>
      settleMarketBets(tx, a.marketIds.ou, new Date()),
    );
    expect(replay).toMatchObject({ bets: 3, outcomes: { settled: 0, unchanged: 3 } });

    // The accumulator cashes out with its decided leg at the odds it was placed at:
    // 100 × 1.90 × 2.00 / 2.00 × 0.95 = 180.50 ETB.
    const offer = await getCashOutOffer(handle.db, {
      userId,
      betId: acca!,
      config: settings.cashOut,
      now: new Date(),
    });
    expect(offer).toMatchObject({ available: true, gross: birr(180.5) });

    // Full time settles the rest; the early-settled bets are unchanged.
    await finish(handle.db, a.eventId, 2, 1);
    const fullTime = await handle.db.transaction((tx) =>
      settleEventBets(tx, a.eventId, new Date()),
    );
    expect(fullTime.outcomes).toMatchObject({ settled: 1, unchanged: 3 });
    expect((await bet(home!)).status).toBe('won');
    expect((await bet(over!)).settlementVersion).toBe(0);
    const [settledTwice] = await handle.db
      .select({ n: count() })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, over!), eq(outboxEvents.type, 'bet.settled')));
    expect(settledTwice?.n).toBe(1);
  });
});

describe('early results: the sweep and abandoned matches', () => {
  const leg = (selectionId: string, oddsMilli: number) => ({ selectionId, oddsMilli });

  it('the settlement sweep settles bets on a market resulted early whose job was lost', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids);
    const [over, home] = await Promise.all(
      [[leg(event.over, 1900)], [leg(event.home, 2000)]].map((legs) =>
        place(handle.db, userId, { stake: birr(100), legs, settings }).then((r) => r.bet.id),
      ),
    );
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 2, 1);
    await resultOne(event.marketIds.ou, { score: { home: 2, away: 1 } });

    // The market.resulted job never ran; the event is still live (not resulted).
    const sweep = { graceMs: 0, lookbackMs: 3600_000, limit: 1000 };
    const later = new Date(Date.now() + 60_000);
    const due = await listBetsToSettle(handle.db, later, sweep);
    expect(due).toContain(over);
    expect(due).not.toContain(home);
    // Not while the grace period lets the job go first.
    expect(
      await listBetsToSettle(handle.db, new Date(), { ...sweep, graceMs: 10 * 60_000 }),
    ).not.toContain(over);

    expect(
      await handle.db.transaction((tx) => settlePlacedBet(tx, over!, new Date())),
    ).toMatchObject({ outcome: 'settled', status: 'won' });
    expect(await listBetsToSettle(handle.db, later, sweep)).not.toContain(over);
    expect((await bet(home!)).status).toBe('open');
  });

  it('an abandoned match keeps the markets already decided; the rest is void', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids);
    const [over, home] = await Promise.all(
      [[leg(event.over, 1900)], [leg(event.home, 2000)]].map((legs) =>
        place(handle.db, userId, { stake: birr(100), legs, settings }).then((r) => r.bet.id),
      ),
    );
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 3, 0);
    await resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } });

    const abandoned = await handle.db.transaction((tx) =>
      resultEvent(tx, event.eventId, { status: 'abandoned' }),
    );
    expect(abandoned).toMatchObject({ outcome: 'resulted', marketsSettled: 0, marketsVoided: 2 });
    // Bets on a market already decided stand (the usual sportsbook rule).
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'won' },
      { code: 'under', status: 'settled', result: 'lost' },
    ]);
    expect((await marketRow(event.marketIds['1x2'])).status).toBe('void');
    expect((await marketRow(event.marketIds.dnb)).status).toBe('void');

    const before = await balances(handle.db, userId);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    // over 2.5 won at 1.90: 190 ETB (90 ETB of winnings, under the tax exemption).
    expect(await bet(over!)).toMatchObject({ status: 'won', settledNetPayout: birr(190) });
    expect(await bet(home!)).toMatchObject({ status: 'void', settledNetPayout: birr(100) });
    expect((await balances(handle.db, userId)).cash - before.cash).toBe(birr(290));
  });

  it('a correction from finished to abandoned keeps the markets decided in play; their bets stay won', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids);
    const [over, home] = await Promise.all(
      [[leg(event.over, 1900)], [leg(event.home, 2000)]].map((legs) =>
        place(handle.db, userId, { stake: birr(100), legs, settings }).then((r) => r.bet.id),
      ),
    );
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 3, 0);
    await resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } });
    await handle.db.transaction((tx) => settleMarketBets(tx, event.marketIds.ou, new Date()));
    expect(await bet(over!)).toMatchObject({ status: 'won', settledNetPayout: birr(190) });

    await finish(handle.db, event.eventId, 3, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect((await bet(home!)).status).toBe('won');
    const early = await marketRow(event.marketIds.ou);
    const before = await balances(handle.db, userId);

    // The match is then reported abandoned: the same facts as resulting it abandoned first.
    const corrected = await handle.db.transaction((tx) =>
      resultEvent(tx, event.eventId, { status: 'abandoned' }),
    );
    expect(corrected).toMatchObject({ outcome: 'corrected', marketsSettled: 0, marketsVoided: 2 });
    expect(corrected.messages.filter((m) => m.type === 'market').map((m) => m.data)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ k: event.marketIds.ou })]),
    );
    expect(await marketRow(event.marketIds.ou)).toEqual(early);
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'won' },
      { code: 'under', status: 'settled', result: 'lost' },
    ]);
    expect((await marketRow(event.marketIds['1x2'])).status).toBe('void');

    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    // over 2.5 was decided at 3-0 in play: the bet stands (won, 190 ETB, never re-settled).
    expect(await bet(over!)).toMatchObject({
      status: 'won',
      settledNetPayout: birr(190),
      settlementVersion: 0,
    });
    // The 1x2 bet is void now: its 180 ETB payout is reversed and the 100 ETB stake returned.
    expect(await bet(home!)).toMatchObject({ status: 'void', settledNetPayout: birr(100) });
    expect((await balances(handle.db, userId)).cash - before.cash).toBe(birr(100) - birr(180));

    // A correction back to a final score re-resolves the early market from that score.
    await finish(handle.db, event.eventId, 1, 1);
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'lost' },
      { code: 'under', status: 'settled', result: 'won' },
    ]);
  });

  it('a market decided in play that a final-score correction overturned is void when the match is then abandoned', async () => {
    const event = await createEvent(handle.db, ids);
    await goLive(handle.db, event.eventId);
    await setScore(event.eventId, 3, 0);
    await resultOne(event.marketIds.ou, { score: { home: 3, away: 0 } });
    await finish(handle.db, event.eventId, 3, 0);
    // The goals are corrected away: the early result was wrong, so it is no longer an in-play decision.
    await finish(handle.db, event.eventId, 1, 0);
    expect(await selectionRows(event.marketIds.ou)).toEqual([
      { code: 'over', status: 'settled', result: 'lost' },
      { code: 'under', status: 'settled', result: 'won' },
    ]);
    await handle.db.transaction((tx) => resultEvent(tx, event.eventId, { status: 'abandoned' }));
    expect((await marketRow(event.marketIds.ou)).status).toBe('void');
  });
});
