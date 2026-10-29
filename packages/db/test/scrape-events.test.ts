import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getEventExposure,
  listScrapedEvents,
  loadGameSettings,
  resultEvent,
  upsertObservation,
  setSourceEnabled,
  type GameSettings,
} from '../src/index';
import { birr } from '@vamos/core';
import { markets, selections } from '../src/schema/index';
import { place } from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';
import {
  addRun,
  addSource,
  createScrapeDatabase,
  createScrapedEvent,
  fixtureObs,
  KICKOFF,
  SYSTEM,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
let settings: GameSettings;
const H = 3_600_000;
const FROM = new Date(KICKOFF.getTime() - 30 * 24 * H);
const TO = new Date(KICKOFF.getTime() + 30 * 24 * H);

beforeAll(async () => {
  ctx = await createScrapeDatabase();
  settings = await loadGameSettings(ctx.handle.db);
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

async function oneXTwo(eventId: string, code: string): Promise<{ id: string; odds: number }> {
  const rows = await ctx.handle.db
    .select({
      id: selections.id,
      code: selections.code,
      odds: selections.oddsMilli,
      type: markets.type,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, eventId));
  const row = rows.find((r) => r.type === '1x2' && r.code === code);
  return { id: row!.id, odds: row!.odds };
}

async function bet(eventIds: string[], stake: bigint): Promise<void> {
  const userId = await createUser(ctx.handle.db);
  await fund(ctx.handle.db, userId, birr(10_000));
  const legs = await Promise.all(
    eventIds.map(async (id) => {
      const s = await oneXTwo(id, '1');
      return { selectionId: s.id, oddsMilli: s.odds };
    }),
  );
  await place(ctx.handle.db, userId, { stake, legs, settings });
}

describe('listScrapedEvents', () => {
  it('only lists scraped events in range with hasBets, needsHalfTimeScore and score', async () => {
    const plain = await createScrapedEvent(ctx, { home: 'Arsenal', away: 'Chelsea' });
    const withHt = await createScrapedEvent(ctx, {
      home: 'Chelsea',
      away: 'Arsenal',
      halfTime: true,
    });
    const outside = await createScrapedEvent(ctx, { startTime: new Date(TO.getTime() + 24 * H) });
    // A catalogue event of another provider is never listed.
    const { createEvent } = await import('./betting-fixtures');
    const foreign = await createEvent(ctx.handle.db, ctx.ids, { startTime: KICKOFF });

    await bet([plain.eventId], birr(50));

    const listed = await listScrapedEvents(ctx.handle.db, { from: FROM, to: TO });
    const ids = listed.map((e) => e.eventId);
    expect(ids).toContain(plain.eventId);
    expect(ids).toContain(withHt.eventId);
    expect(ids).not.toContain(outside.eventId);
    expect(ids).not.toContain(foreign.eventId);

    const a = listed.find((e) => e.eventId === plain.eventId)!;
    expect(a).toMatchObject({
      feedRef: plain.feedRef,
      competitionId: ctx.competitionId,
      homeTeamId: plain.homeTeamId,
      awayTeamId: plain.awayTeamId,
      startTime: KICKOFF,
      status: 'scheduled',
      bettingOpen: true,
      hasBets: true,
      needsHalfTimeScore: false,
      resultedAt: null,
      score: null,
      lastListedAt: null,
    });
    expect(typeof a.gameId).toBe('number');
    const b = listed.find((e) => e.eventId === withHt.eventId)!;
    expect(b).toMatchObject({ hasBets: false, needsHalfTimeScore: true });
  });

  it('includes finished events with their score only when asked', async () => {
    const ev = await createScrapedEvent(ctx, { halfTime: true });
    await ctx.handle.db.transaction((tx) =>
      resultEvent(tx, ev.eventId, {
        status: 'finished',
        score: { home: 3, away: 1, htHome: 1, htAway: 0 },
      }),
    );
    const cancelled = await createScrapedEvent(ctx);
    await ctx.handle.db.transaction((tx) =>
      resultEvent(tx, cancelled.eventId, { status: 'cancelled' }),
    );

    const open = await listScrapedEvents(ctx.handle.db, { from: FROM, to: TO });
    expect(open.map((e) => e.eventId)).not.toContain(ev.eventId);
    const all = await listScrapedEvents(ctx.handle.db, {
      from: FROM,
      to: TO,
      includeFinished: true,
    });
    const done = all.find((e) => e.eventId === ev.eventId)!;
    expect(done).toMatchObject({
      status: 'finished',
      score: { home: 3, away: 1, htHome: 1, htAway: 0 },
      needsHalfTimeScore: true,
    });
    expect(done.resultedAt).toBeInstanceOf(Date);
    expect(all.find((e) => e.eventId === cancelled.eventId)).toMatchObject({
      status: 'cancelled',
      score: null,
    });
  });

  it('lastListedAt follows enabled sources whose last run was ok (rule F5)', async () => {
    const db = ctx.handle.db;
    const ev = await createScrapedEvent(ctx, { home: 'Liverpool', away: 'Arsenal' });
    await addSource(db, 'll-ok', { upstream: 'u1' });
    await addSource(db, 'll-failed', { upstream: 'u2' });
    await addSource(db, 'll-off', { upstream: 'u3', enabled: false });
    const names = {
      competitionId: ctx.competitionId,
      homeTeamId: ev.homeTeamId,
      awayTeamId: ev.awayTeamId,
    };
    const seen = (sourceId: string, runId: string, hours: number, extra = {}) =>
      db.transaction((tx) =>
        upsertObservation(
          tx,
          fixtureObs({
            sourceId,
            runId,
            sourceKey: 'k',
            observedAt: new Date(T0.getTime() + hours * H),
            kickoff: new Date(KICKOFF.getTime() + H), // an hour of drift is still the same match
            ...names,
            ...extra,
          }),
        ),
      );
    const okRun = await addRun(db, 'll-ok', 'ok', new Date(T0.getTime() + 5 * H));
    const failedRunOld = await addRun(db, 'll-failed', 'ok', new Date(T0.getTime() + 1 * H));
    const offRun = await addRun(db, 'll-off', 'ok', new Date(T0.getTime() + 20 * H));
    await seen('ll-ok', okRun.id, 5);
    await seen('ll-failed', failedRunOld.id, 9);
    await seen('ll-off', offRun.id, 20);
    await addRun(db, 'll-failed', 'failed', new Date(T0.getTime() + 10 * H));
    // a different match of the same source does not count
    await db.transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          sourceId: 'll-ok',
          runId: okRun.id,
          sourceKey: 'other',
          kickoff: new Date(KICKOFF.getTime() + 400 * H),
          observedAt: new Date(T0.getTime() + 30 * H),
          ...names,
        }),
      ),
    );
    const find = async () =>
      (await listScrapedEvents(db, { from: FROM, to: TO })).find((e) => e.eventId === ev.eventId)!;
    // ll-failed's last run failed and ll-off is disabled: only ll-ok counts.
    expect((await find()).lastListedAt).toEqual(new Date(T0.getTime() + 5 * H));
    // ll-failed recovers: its newer sighting counts.
    await addRun(db, 'll-failed', 'ok', new Date(T0.getTime() + 11 * H));
    expect((await find()).lastListedAt).toEqual(new Date(T0.getTime() + 9 * H));
    // The kill switch removes a source at once.
    await db.transaction((tx) => setSourceEnabled(tx, 'll-failed', false, SYSTEM));
    expect((await find()).lastListedAt).toEqual(new Date(T0.getTime() + 5 * H));
    // A narrower window than the drift ignores the sighting.
    const narrow = (
      await listScrapedEvents(db, { from: FROM, to: TO, listedWindowMs: H / 2 })
    ).find((e) => e.eventId === ev.eventId)!;
    expect(narrow.lastListedAt).toBeNull();
  });
});

describe('getEventExposure', () => {
  it('counts unsettled bets once (a multi counts on each of its events) with the stake as a decimal string', async () => {
    const a = await createScrapedEvent(ctx, { home: 'Arsenal', away: 'Liverpool' });
    const b = await createScrapedEvent(ctx, { home: 'Liverpool', away: 'Chelsea' });
    const none = await createScrapedEvent(ctx, { home: 'Chelsea', away: 'Liverpool' });
    expect(await getEventExposure(ctx.handle.db, none.eventId)).toEqual({
      openBets: 0,
      totalStake: '0',
    });
    await bet([a.eventId], birr(100));
    await bet([a.eventId, b.eventId], birr(25));
    await bet([b.eventId], birr(10));
    expect(await getEventExposure(ctx.handle.db, a.eventId)).toEqual({
      openBets: 2,
      totalStake: '12500',
    });
    expect(await getEventExposure(ctx.handle.db, b.eventId)).toEqual({
      openBets: 2,
      totalStake: '3500',
    });
    expect(await getEventExposure(ctx.handle.db, none.eventId)).toEqual({
      openBets: 0,
      totalStake: '0',
    });
  });
});
