import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyLiveState,
  deactivateMissingLeagues,
  dueFeedResults,
  ensureLeagueCompetition,
  feedCreditsSpent,
  feedEventsByRef,
  feedResultsForReview,
  latestFeedQuota,
  listDueLeagues,
  listFeedLeagues,
  loadCatalogIds,
  markFeedResultApplied,
  overdueFeedEvents,
  pruneFeedCalls,
  recordFeedCall,
  recordFeedResult,
  resolveFeedTeam,
  setMarketStatus,
  staleFeedEvents,
  updateFeedLeaguePoll,
  updateFeedLeagueSettings,
  upsertFeedLeague,
  upsertFixture,
  type FixtureMarketInput,
} from '../src/index';
import { competitions, events, markets, teams } from '../src/schema';
import { seedCatalog } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
const PROVIDER = 'theoddsapi';
const T0 = new Date('2026-11-07T10:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

beforeAll(async () => {
  handle = await createTestDatabase();
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.drop();
});

const league = (sportKey: string, enabled = true) => ({
  provider: PROVIDER,
  sportKey,
  sport: 'football' as const,
  group: 'Soccer',
  title: sportKey,
  description: '',
  active: true,
  cup: false,
  tier: 1 as const,
  enabled,
});

describe('feed leagues', () => {
  it('keeps the staff settings when the provider data is refreshed', async () => {
    await upsertFeedLeague(handle.db, league('soccer_epl'));
    expect(
      await updateFeedLeagueSettings(handle.db, PROVIDER, 'soccer_epl', {
        enabled: false,
        marginBps: 450,
      }),
    ).toBe(true);
    await upsertFeedLeague(handle.db, { ...league('soccer_epl'), title: 'EPL' });
    const [row] = await listFeedLeagues(handle.db, PROVIDER);
    expect(row).toMatchObject({
      sportKey: 'soccer_epl',
      title: 'EPL',
      enabled: false,
      marginBps: 450,
    });
    await expect(
      updateFeedLeagueSettings(handle.db, PROVIDER, 'soccer_epl', { marginBps: 5000 }),
    ).rejects.toThrow(RangeError);
    await updateFeedLeagueSettings(handle.db, PROVIDER, 'soccer_epl', {
      enabled: true,
      marginBps: null,
    });
  });

  it('lists the leagues due for a poll', async () => {
    await upsertFeedLeague(handle.db, league('soccer_spain_la_liga'));
    await upsertFeedLeague(handle.db, league('soccer_italy_serie_a', false));
    await updateFeedLeaguePoll(handle.db, PROVIDER, 'soccer_spain_la_liga', { nextOddsAt: at(30) });
    const due = await listDueLeagues(handle.db, PROVIDER, 'odds', at(0));
    expect(due.map((row) => row.sportKey)).toEqual(['soccer_epl']);
    expect(
      (await listDueLeagues(handle.db, PROVIDER, 'odds', at(30))).map((row) => row.sportKey),
    ).toEqual(['soccer_epl', 'soccer_spain_la_liga']);
    // A league the provider dropped is no longer polled for odds, but its scores still are.
    expect(
      await deactivateMissingLeagues(handle.db, PROVIDER, ['soccer_epl', 'soccer_italy_serie_a']),
    ).toBe(1);
    expect(
      (await listDueLeagues(handle.db, PROVIDER, 'odds', at(30))).map((row) => row.sportKey),
    ).toEqual(['soccer_epl']);
    expect(
      (await listDueLeagues(handle.db, PROVIDER, 'scores', at(30))).map((row) => row.sportKey),
    ).toContain('soccer_spain_la_liga');
  });

  it('places a league on the seeded competition, or creates its category and competition once', async () => {
    const seeded = await handle.db.transaction((tx) =>
      ensureLeagueCompetition(tx, PROVIDER, 'soccer_epl', 'football', {
        category: {
          slug: 'england',
          name: { en: 'England' },
          countryCode: 'GB-ENG',
          sortOrder: 10,
        },
        competition: {
          slug: 'premier-league',
          name: { en: 'Renamed' },
          featured: false,
          sortOrder: 10,
        },
      }),
    );
    const [epl] = await handle.db.select().from(competitions).where(eq(competitions.id, seeded));
    expect(epl?.slug).toBe('premier-league');
    expect(epl?.name.en).toBe('Premier League');
    expect(epl?.featured).toBe(true);

    await upsertFeedLeague(handle.db, league('soccer_sweden_allsvenskan'));
    const placement = {
      category: { slug: 'sweden', name: { en: 'Sweden' }, countryCode: 'SE', sortOrder: 500 },
      competition: {
        slug: 'sweden-allsvenskan',
        name: { en: 'Allsvenskan' },
        featured: false,
        sortOrder: 500,
      },
    };
    const created = await handle.db.transaction((tx) =>
      ensureLeagueCompetition(tx, PROVIDER, 'soccer_sweden_allsvenskan', 'football', placement),
    );
    const again = await handle.db.transaction((tx) =>
      ensureLeagueCompetition(tx, PROVIDER, 'soccer_sweden_allsvenskan', 'football', placement),
    );
    expect(again).toBe(created);
    const [row] = await handle.db.select().from(competitions).where(eq(competitions.id, created));
    expect(row).toMatchObject({ slug: 'sweden-allsvenskan', featured: false });
  });

  it('resolves team names to seeded teams, new teams and remembered aliases', async () => {
    const city = await handle.db.transaction((tx) =>
      resolveFeedTeam(tx, PROVIDER, 'football', 'Manchester City'),
    );
    const [seeded] = await handle.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.sportId, 'football'), eq(teams.shortName, 'Man City')));
    expect(city).toBe(seeded?.id);
    const malmo = await handle.db.transaction((tx) =>
      resolveFeedTeam(tx, PROVIDER, 'football', ' Malmö FF '),
    );
    const sameAgain = await handle.db.transaction((tx) =>
      resolveFeedTeam(tx, PROVIDER, 'football', 'Malmö FF'),
    );
    expect(sameAgain).toBe(malmo);
    const [team] = await handle.db.select().from(teams).where(eq(teams.id, malmo));
    expect(team).toMatchObject({ shortName: 'Malmö FF', name: { en: 'Malmö FF' }, ratings: null });
  });
});

describe('upsertFixture for a real feed', () => {
  const market1x2 = (home: number, draw: number, away: number): FixtureMarketInput => ({
    type: '1x2',
    line: null,
    selections: [
      { code: '1', oddsMilli: home },
      { code: 'X', oddsMilli: draw },
      { code: '2', oddsMilli: away },
    ],
  });
  const total = (over: number, under: number): FixtureMarketInput => ({
    type: 'ou',
    line: '2.5',
    selections: [
      { code: 'over', oddsMilli: over },
      { code: 'under', oddsMilli: under },
    ],
  });
  const lengthenAfterOnePercent = (reference: number, next: number): boolean =>
    next !== reference && (next < reference || (next - reference) / reference >= 0.01);

  let fixture: Parameters<typeof upsertFixture>[1];

  beforeAll(async () => {
    const ids = await loadCatalogIds(handle.db);
    const id = (map: Map<string, string>, key: string): string => {
      const value = map.get(key);
      if (value === undefined) throw new Error(`no ${key}`);
      return value;
    };
    fixture = {
      feedProvider: PROVIDER,
      feedRef: 'evt-1',
      sport: 'football',
      competitionId: id(ids.competitions, 'football/premier-league'),
      homeTeamId: id(ids.teams, 'football/Arsenal'),
      awayTeamId: id(ids.teams, 'football/Chelsea'),
      startTime: at(24 * 60),
    };
  });

  const sync = (markets: FixtureMarketInput[], minutes: number, extra = {}) =>
    handle.db.transaction((tx) =>
      upsertFixture(tx, fixture, markets, {
        now: at(minutes),
        pricedAt: at(minutes),
        suspendMissing: true,
        shouldWrite: lengthenAfterOnePercent,
        ...extra,
      }),
    );

  const marketStatus = async (eventId: string, key: string) => {
    const [row] = await handle.db
      .select({ status: markets.status, suspendedBy: markets.suspendedBy })
      .from(markets)
      .where(and(eq(markets.eventId, eventId), eq(markets.key, key)));
    return row;
  };

  it('stamps the freshness, suspends what is no longer priced and re-opens it when it is back', async () => {
    const created = await sync([market1x2(1780, 3950, 4720), total(1880, 2000)], 0);
    expect(created.created).toBe(true);
    const [event] = await handle.db.select().from(events).where(eq(events.id, created.eventId));
    expect(event?.oddsUpdatedAt).toEqual(at(0));
    await expect(
      handle.db.transaction((tx) =>
        upsertFixture(tx, { ...fixture, feedRef: 'empty' }, [], { suspendMissing: true }),
      ),
    ).rejects.toThrow(RangeError);

    const withoutTotal = await sync([market1x2(1780, 3950, 4720)], 5);
    expect(withoutTotal.marketsSuspended).toBe(1);
    expect(await marketStatus(created.eventId, 'ou:2.5')).toEqual({
      status: 'suspended',
      suspendedBy: 'feed',
    });
    expect(withoutTotal.messages.some((m) => m.type === 'market')).toBe(true);
    const refs = await feedEventsByRef(handle.db, PROVIDER, ['evt-1']);
    expect(refs.get('evt-1')?.oddsUpdatedAt).toEqual(at(5));

    const back = await sync([market1x2(1780, 3950, 4720), total(1880, 2000)], 10);
    expect(back.marketsReopened).toBe(1);
    expect((await marketStatus(created.eventId, 'ou:2.5'))?.status).toBe('open');

    // A trader's suspension is never lifted by the feed.
    const [ou] = await handle.db
      .select({ id: markets.id })
      .from(markets)
      .where(and(eq(markets.eventId, created.eventId), eq(markets.key, 'ou:2.5')));
    await handle.db.transaction((tx) =>
      setMarketStatus(tx, ou?.id ?? '', 'suspended', { adminId: 'trader-1' }),
    );
    const kept = await sync([market1x2(1780, 3950, 4720), total(1880, 2000)], 15);
    expect(kept.marketsReopened).toBe(0);
    expect((await marketStatus(created.eventId, 'ou:2.5'))?.suspendedBy).toBe('trader');
  });

  it('shortens at once but lengthens only after 1%', async () => {
    const shorter = await sync([market1x2(1760, 3950, 4720)], 20);
    expect(shorter.oddsChanged).toBe(1);
    const slightlyLonger = await sync([market1x2(1770, 3950, 4720)], 25);
    expect(slightlyLonger.oddsChanged).toBe(0);
    const longer = await sync([market1x2(1790, 3950, 4720)], 30);
    expect(longer.oddsChanged).toBe(1);
  });

  it('reprices a live event only when allowed', async () => {
    const { eventId } = await sync([market1x2(1790, 3950, 4720)], 35);
    await handle.db.transaction((tx) =>
      applyLiveState(tx, eventId, { status: 'live', minute: null, period: null, home: 0, away: 0 }),
    );
    const refused = await sync([market1x2(1500, 4200, 6000)], 40);
    expect(refused.oddsChanged).toBe(0);
    const live = await sync([market1x2(1500, 4200, 6000)], 41, { allowLive: true });
    expect(live.oddsChanged).toBe(3);
    expect(live.status).toBe('live');
  });

  it('finds stale and overdue events', async () => {
    const { eventId } = await sync([market1x2(1500, 4200, 6000)], 45, { allowLive: true });
    expect(
      await staleFeedEvents(handle.db, PROVIDER, {
        now: at(46),
        prematchBefore: at(0),
        liveBefore: at(44),
      }),
    ).toEqual([]);
    expect(
      await staleFeedEvents(handle.db, PROVIDER, {
        now: at(50),
        prematchBefore: at(0),
        liveBefore: at(48),
      }),
    ).toEqual([eventId]);
    expect(
      (await overdueFeedEvents(handle.db, PROVIDER, at(24 * 60 + 1))).map((e) => e.id),
    ).toEqual([eventId]);
    expect(await overdueFeedEvents(handle.db, PROVIDER, at(24 * 60 - 1))).toEqual([]);
    // Only the given competitions (the sports without feed scores), none for an empty list.
    const late = at(24 * 60 + 1);
    expect(
      await overdueFeedEvents(handle.db, PROVIDER, late, {
        competitionIds: [fixture.competitionId],
      }),
    ).toEqual([
      { id: eventId, startTime: fixture.startTime, competitionId: fixture.competitionId },
    ]);
    expect(
      await overdueFeedEvents(handle.db, PROVIDER, late, {
        competitionIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).toEqual([]);
    expect(await overdueFeedEvents(handle.db, PROVIDER, late, { competitionIds: [] })).toEqual([]);
  });
});

describe('feed calls and results', () => {
  it('logs credits and the latest quota, and prunes old records', async () => {
    await recordFeedCall(handle.db, {
      provider: PROVIDER,
      endpoint: 'odds',
      cost: 2,
      remaining: 98,
      used: 2,
      calledAt: at(0),
    });
    await recordFeedCall(handle.db, {
      provider: PROVIDER,
      endpoint: 'scores',
      cost: 2,
      remaining: 96,
      used: 4,
      calledAt: at(10),
    });
    await recordFeedCall(handle.db, {
      provider: PROVIDER,
      endpoint: 'sports',
      status: 401,
      cost: 0,
      errorKind: 'auth',
      calledAt: at(20),
    });
    expect(await feedCreditsSpent(handle.db, PROVIDER, at(-1))).toBe(4);
    expect(await feedCreditsSpent(handle.db, PROVIDER, at(5))).toBe(2);
    expect(await latestFeedQuota(handle.db, PROVIDER)).toEqual({
      remaining: 96,
      used: 4,
      at: at(10),
    });
    expect(await pruneFeedCalls(handle.db, PROVIDER, at(5))).toBe(1);
  });

  it('applies a final score only after it stood, and holds the ones staff must confirm', async () => {
    const [event] = await handle.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.feedRef, 'evt-1'));
    const eventId = event?.id ?? '';
    await recordFeedResult(handle.db, {
      eventId,
      provider: PROVIDER,
      score: { home: 2, away: 1 },
      seenAt: at(100),
      reviewReason: null,
    });
    expect(await dueFeedResults(handle.db, PROVIDER, at(110))).toEqual([]);
    await recordFeedResult(handle.db, {
      eventId,
      provider: PROVIDER,
      score: { home: 2, away: 2 },
      seenAt: at(105),
      reviewReason: null,
    });
    await recordFeedResult(handle.db, {
      eventId,
      provider: PROVIDER,
      score: { home: 2, away: 2 },
      seenAt: at(112),
      reviewReason: null,
    });
    // The changed score restarted the wait at 105.
    expect(await dueFeedResults(handle.db, PROVIDER, at(104))).toEqual([]);
    const [due] = await dueFeedResults(handle.db, PROVIDER, at(110));
    expect(due).toMatchObject({
      eventId,
      scoreHome: 2,
      scoreAway: 2,
      firstSeenAt: at(105),
      lastSeenAt: at(112),
    });

    await recordFeedResult(handle.db, {
      eventId,
      provider: PROVIDER,
      score: { home: 2, away: 2 },
      seenAt: at(115),
      reviewReason: 'cup',
    });
    expect(await dueFeedResults(handle.db, PROVIDER, at(110))).toEqual([]);
    expect(
      (await feedResultsForReview(handle.db, PROVIDER)).map((row) => row.reviewReason),
    ).toEqual(['cup']);
    await markFeedResultApplied(handle.db, eventId, at(120));
    expect(await feedResultsForReview(handle.db, PROVIDER)).toEqual([]);
    const after = await recordFeedResult(handle.db, {
      eventId,
      provider: PROVIDER,
      score: { home: 3, away: 2 },
      seenAt: at(130),
      reviewReason: null,
    });
    expect(after).toMatchObject({ scoreHome: 2, scoreAway: 2, appliedAt: at(120) });
    await expect(
      recordFeedResult(handle.db, {
        eventId,
        provider: PROVIDER,
        score: { home: -1, away: 0 },
        seenAt: at(1),
        reviewReason: null,
      }),
    ).rejects.toThrow(RangeError);
  });
});
