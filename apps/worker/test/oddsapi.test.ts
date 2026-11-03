import { loadConfig } from '@vamos/config';
import { upsertFixture } from '@vamos/db';
import { events, feedLeagues, feedResults, markets, selections } from '@vamos/db/schema';
import {
  OddsApiError,
  type OddsApiBookmaker,
  type OddsApiEvent,
  type OddsApiResult,
  type OddsApiScore,
  type OddsApiSport,
  type OddsQuery,
} from '@vamos/feed';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTasks } from '../src/tasks/index';
import {
  ODDS_API_PROVIDER,
  readScore,
  retireSimulatedEvents,
  reviewReasonFor,
  runOddsApiCatalogSync,
  runOddsApiOddsPoll,
  runOddsApiScoresPoll,
  runOddsApiSweeps,
  type OddsApiSource,
  type OddsApiTaskDeps,
} from '../src/tasks/oddsapi/index';
import {
  HOUR_MS,
  MINUTE_MS,
  nextOddsPollAt,
  nextScoresPollAt,
  planBudget,
  staleBuckets,
} from '../src/tasks/oddsapi/schedule';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

const sport = (key: string, group: string, title: string, hasOutrights = false): OddsApiSport => ({
  key,
  group,
  title,
  description: '',
  active: true,
  hasOutrights,
});

class FakeOddsApi implements OddsApiSource {
  sportsData: OddsApiSport[] = [];
  eventsData = new Map<string, OddsApiEvent[]>();
  oddsData = new Map<string, OddsApiEvent[]>();
  scoresData = new Map<string, OddsApiScore[]>();
  calls: string[] = [];
  fail: OddsApiError | null = null;

  private reply<T>(endpoint: string, data: T, cost: number): Promise<OddsApiResult<T>> {
    this.calls.push(endpoint);
    if (this.fail !== null) return Promise.reject(this.fail);
    return Promise.resolve({
      data,
      quota: { remaining: 50_000, used: 100, last: cost },
      dropped: 0,
    });
  }
  sports(): Promise<OddsApiResult<OddsApiSport[]>> {
    return this.reply('sports', this.sportsData, 0);
  }
  events(sportKey: string): Promise<OddsApiResult<OddsApiEvent[]>> {
    return this.reply(`events:${sportKey}`, this.eventsData.get(sportKey) ?? [], 0);
  }
  odds(sportKey: string, query: OddsQuery): Promise<OddsApiResult<OddsApiEvent[]>> {
    return this.reply(`odds:${sportKey}`, this.oddsData.get(sportKey) ?? [], query.markets.length);
  }
  scores(
    sportKey: string,
    options: { daysFrom?: 1 | 2 | 3 } = {},
  ): Promise<OddsApiResult<OddsApiScore[]>> {
    return this.reply(
      `scores:${sportKey}`,
      this.scoresData.get(sportKey) ?? [],
      options.daysFrom ? 2 : 1,
    );
  }
}

/** A bookmaker quoting 1X2 (and optionally the 2.5 total) at `at`. */
function book(
  key: string,
  at: Date,
  h2h: [number, number, number],
  total?: [number, number],
): OddsApiBookmaker {
  const outcome = (name: string, price: number, point: number | null = null) => ({
    name,
    price,
    point,
    description: null,
  });
  return {
    key,
    title: key,
    lastUpdate: at,
    markets: [
      {
        key: 'h2h',
        lastUpdate: at,
        outcomes: [outcome('Arsenal', h2h[0]), outcome('Chelsea', h2h[2]), outcome('Draw', h2h[1])],
      },
      ...(total === undefined
        ? []
        : [
            {
              key: 'totals',
              lastUpdate: at,
              outcomes: [outcome('Over', total[0], 2.5), outcome('Under', total[1], 2.5)],
            },
          ]),
    ],
  };
}

const match = (
  id: string,
  start: Date,
  bookmakers: OddsApiBookmaker[],
  home = 'Arsenal',
  away = 'Chelsea',
): OddsApiEvent => ({
  id,
  sportKey: 'soccer_epl',
  sportTitle: 'EPL',
  commenceTime: start,
  homeTeam: home,
  awayTeam: away,
  bookmakers,
});

const score = (
  id: string,
  start: Date,
  completed: boolean,
  home: number | null,
  away: number | null,
): OddsApiScore => ({
  id,
  sportKey: 'soccer_epl',
  commenceTime: start,
  completed,
  homeTeam: 'Arsenal',
  awayTeam: 'Chelsea',
  scores:
    home === null || away === null
      ? null
      : [
          { name: 'Arsenal', score: String(home) },
          { name: 'Chelsea', score: String(away) },
        ],
  lastUpdate: null,
});

let t: WorkerTestContext;
const fake = new FakeOddsApi();
let deps: OddsApiTaskDeps;
// Ahead of the database clock, so rows stamped with now() are always "before" the test clock.
const T0 = new Date(Math.ceil(Date.now() / HOUR_MS) * HOUR_MS + 24 * HOUR_MS);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * MINUTE_MS);
const KICKOFF = at(120);

beforeAll(async () => {
  t = await createWorkerTestContext();
  t.clock.set(T0);
  deps = {
    client: fake,
    config: loadConfig({ FEED_PROVIDER: 'theoddsapi', ODDS_API_KEY: 'test-key' }).feed.oddsApi,
    mode: 'demo',
  };
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

const eventByRef = async (ref: string) => {
  const [row] = await t.db.db
    .select()
    .from(events)
    .where(and(eq(events.feedProvider, ODDS_API_PROVIDER), eq(events.feedRef, ref)));
  if (row === undefined) throw new Error(`no event ${ref}`);
  return row;
};
const marketRows = (eventId: string) =>
  t.db.db.select().from(markets).where(eq(markets.eventId, eventId));
const homePrice = async (eventId: string): Promise<number> => {
  const [row] = await t.db.db
    .select({ oddsMilli: selections.oddsMilli })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(and(eq(markets.eventId, eventId), eq(markets.key, '1x2'), eq(selections.code, '1')));
  return row?.oddsMilli ?? 0;
};

describe('schedule', () => {
  it('stretches intervals with the spend and drops to reserve and critical', () => {
    expect(
      planBudget({
        spentLast24h: 100,
        monthlyCredits: 30_000,
        reservePercent: 10,
        remaining: null,
      }),
    ).toEqual({
      factor: 1,
      mode: 'normal',
    });
    expect(
      planBudget({
        spentLast24h: 3000,
        monthlyCredits: 30_000,
        reservePercent: 10,
        remaining: 20_000,
      }).factor,
    ).toBe(3);
    expect(
      planBudget({ spentLast24h: 0, monthlyCredits: 30_000, reservePercent: 10, remaining: 2500 })
        .mode,
    ).toBe('reserve');
    expect(
      planBudget({ spentLast24h: 0, monthlyCredits: 30_000, reservePercent: 10, remaining: 200 })
        .mode,
    ).toBe('critical');
  });

  it('polls more often near kick-off and every minute in play', () => {
    const budget = { factor: 1, mode: 'normal' as const };
    const next = (startsIn: number | null, live = 0, inPlay = true) =>
      nextOddsPollAt({
        now: T0,
        nextStartAt: startsIn === null ? null : new Date(T0.getTime() + startsIn),
        liveCount: live,
        inPlay,
        budget,
      }).getTime() - T0.getTime();
    expect(next(30 * MINUTE_MS)).toBe(5 * MINUTE_MS);
    expect(next(5 * HOUR_MS)).toBe(15 * MINUTE_MS);
    expect(next(20 * HOUR_MS)).toBe(HOUR_MS);
    expect(next(48 * HOUR_MS)).toBe(3 * HOUR_MS);
    expect(next(74 * HOUR_MS)).toBe(2 * HOUR_MS);
    expect(next(null)).toBe(6 * HOUR_MS);
    expect(next(5 * HOUR_MS, 1)).toBe(MINUTE_MS);
    expect(next(5 * HOUR_MS, 1, false)).toBe(15 * MINUTE_MS);
    expect(
      nextScoresPollAt({
        now: T0,
        live: true,
        awaitingResults: true,
        budget: { factor: 5, mode: 'normal' },
      }).getTime() - T0.getTime(),
    ).toBe(4 * MINUTE_MS);
    expect(staleBuckets(2)[0]).toEqual({ startsWithinMs: HOUR_MS, maxAgeMs: 30 * MINUTE_MS });
  });

  it('reads scores and decides which results staff confirm', () => {
    expect(readScore(score('x', T0, true, 2, 1))).toEqual({ home: 2, away: 1 });
    expect(
      readScore({ ...score('x', T0, true, 2, 1), scores: [{ name: 'Arsenal', score: '2.5' }] }),
    ).toBeNull();
    expect(readScore(score('x', T0, false, null, null))).toBeNull();
    expect(reviewReasonFor({ cup: true }, 'football', 'demo')).toBeNull();
    expect(reviewReasonFor({ cup: true }, 'football', 'licensed')).toBe('cup');
    expect(reviewReasonFor({ cup: false }, 'tennis', 'licensed')).toBe('tennis');
    expect(reviewReasonFor({ cup: false }, 'football', 'licensed')).toBeNull();
  });
});

describe('the real feed, end to end', () => {
  it(
    'syncs the supported leagues and plans their first poll',
    async () => {
      fake.sportsData = [
        sport('soccer_epl', 'Soccer', 'EPL'),
        sport('soccer_sweden_allsvenskan', 'Soccer', 'Allsvenskan - Sweden'),
        sport('icehockey_nhl', 'Ice Hockey', 'NHL'),
        sport('soccer_epl_winner', 'Soccer', 'EPL Winner', true),
      ];
      fake.eventsData.set('soccer_epl', [match('ev1', KICKOFF, []), match('ev2', at(30 * 60), [])]);
      const summary = await runOddsApiCatalogSync(t.ctx, deps);
      expect(summary).toMatchObject({ leagues: 4, supported: 2, eventsRead: 1, failed: 0 });
      const rows = await t.db.db.select().from(feedLeagues);
      const epl = rows.find((row) => row.sportKey === 'soccer_epl');
      expect(epl).toMatchObject({
        enabled: true,
        eventCount: 2,
        nextStartAt: KICKOFF,
        nextOddsAt: null,
      });
      expect(rows.find((row) => row.sportKey === 'soccer_sweden_allsvenskan')?.enabled).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'creates only events with a priced consensus, below the sharp price',
    async () => {
      const now = t.clock.now;
      fake.oddsData.set('soccer_epl', [
        match('ev1', KICKOFF, [
          book('pinnacle', now, [1.78, 3.95, 4.72], [1.88, 2.0]),
          book('betfair_ex_eu', now, [1.8, 3.9, 4.6], [1.9, 2.04]),
          book('williamhill', now, [1.75, 3.8, 4.5], [1.83, 1.95]),
          book('onexbet', now, [1.77, 3.85, 4.65], [1.87, 1.97]),
        ]),
        match('ev2', at(30 * 60), [book('williamhill', now, [2.1, 3.4, 3.5])]),
        match('ev3', at(100 * 60), [
          book('pinnacle', now, [2, 3.5, 4]),
          book('onexbet', now, [2, 3.5, 4]),
        ]),
      ]);
      const summary = await runOddsApiOddsPoll(t.ctx, deps);
      expect(summary).toMatchObject({ leagues: 1, created: 1, unpriced: 1, failed: 0 });
      const ev1 = await eventByRef('ev1');
      expect(ev1.oddsUpdatedAt).toEqual(now);
      expect(ev1.competitionId).toBe(t.ids.competitions.get('football/premier-league'));
      expect(ev1.homeTeamId).toBe(t.ids.teams.get('football/Arsenal'));
      const keys = (await marketRows(ev1.id)).map((row) => row.key).sort();
      expect(keys).toEqual(expect.arrayContaining(['1x2', 'dc', 'dnb', 'ou:2.5', 'btts', 'cs']));
      expect(keys).not.toContain('ht_1x2');
      const home = await homePrice(ev1.id);
      expect(home).toBeGreaterThan(1500);
      expect(home).toBeLessThan(1780);
      const [league] = await t.db.db
        .select()
        .from(feedLeagues)
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      expect(league?.nextOddsAt).toEqual(at(15));
      expect(fake.calls).toContain('odds:soccer_epl');
    },
    TEST_TIMEOUT,
  );

  it(
    'follows the market and suspends what loses its consensus',
    async () => {
      t.clock.set(at(20));
      const now = t.clock.now;
      const ev1 = await eventByRef('ev1');
      const before = await homePrice(ev1.id);
      fake.oddsData.set('soccer_epl', [
        match('ev1', KICKOFF, [
          book('pinnacle', now, [1.7, 4.1, 5]),
          book('betfair_ex_eu', now, [1.72, 4.05, 4.9]),
          book('williamhill', now, [1.68, 4, 4.8]),
        ]),
      ]);
      const summary = await runOddsApiOddsPoll(t.ctx, deps);
      expect(summary.updated).toBe(1);
      expect(await homePrice(ev1.id)).toBeLessThan(before);
      const rows = await marketRows(ev1.id);
      const status = (key: string) => rows.find((row) => row.key === key);
      expect(status('1x2')?.status).toBe('open');
      for (const key of ['ou:2.5', 'btts', 'cs']) {
        expect(status(key)).toMatchObject({ status: 'suspended', suspendedBy: 'feed' });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'suspends the board at kick-off and on every score',
    async () => {
      t.clock.set(new Date(KICKOFF.getTime() + 5 * MINUTE_MS));
      fake.scoresData.set('soccer_epl', [score('ev1', KICKOFF, false, 1, 0)]);
      const summary = await runOddsApiScoresPoll(t.ctx, deps);
      expect(summary).toMatchObject({ leagues: 1, live: 1, failed: 0 });
      const ev1 = await eventByRef('ev1');
      expect(ev1).toMatchObject({ status: 'live', scoreHome: 1, scoreAway: 0, liveMinute: null });
      expect((await marketRows(ev1.id)).every((row) => row.status !== 'open')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    're-opens in play on a fresh consensus',
    async () => {
      t.clock.advance(MINUTE_MS);
      const now = t.clock.now;
      fake.oddsData.set('soccer_epl', [
        match('ev1', KICKOFF, [
          book('pinnacle', now, [1.3, 5, 11]),
          book('betfair_ex_eu', now, [1.31, 5.1, 10.5]),
          book('williamhill', now, [1.28, 4.8, 10]),
        ]),
      ]);
      await t.db.db
        .update(feedLeagues)
        .set({ nextOddsAt: null })
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      const summary = await runOddsApiOddsPoll(t.ctx, deps);
      expect(summary.updated).toBe(1);
      const ev1 = await eventByRef('ev1');
      expect((await marketRows(ev1.id)).find((row) => row.key === '1x2')?.status).toBe('open');
      expect(await homePrice(ev1.id)).toBeLessThan(1300);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes betting on the final score and results it after the wait',
    async () => {
      t.clock.advance(100 * MINUTE_MS);
      fake.scoresData.set('soccer_epl', [score('ev1', KICKOFF, true, 2, 1)]);
      const first = await runOddsApiScoresPoll(t.ctx, deps);
      expect(first).toMatchObject({ finals: 1, resulted: 0 });
      let ev1 = await eventByRef('ev1');
      expect(ev1.bettingOpen).toBe(false);
      const [pending] = await t.db.db
        .select()
        .from(feedResults)
        .where(eq(feedResults.eventId, ev1.id));
      expect(pending).toMatchObject({
        scoreHome: 2,
        scoreAway: 1,
        appliedAt: null,
        reviewReason: null,
      });

      t.clock.advance(11 * MINUTE_MS);
      await t.db.db
        .update(feedLeagues)
        .set({ nextScoresAt: null })
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      const second = await runOddsApiScoresPoll(t.ctx, deps);
      expect(second.resulted).toBe(1);
      ev1 = await eventByRef('ev1');
      expect(ev1).toMatchObject({ status: 'finished', scoreHome: 2, scoreAway: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'suspends stale prices, then reviews and finally voids an event without a result',
    async () => {
      const start = new Date(t.clock.now.getTime() + 5 * HOUR_MS);
      const now = t.clock.now;
      fake.oddsData.set('soccer_epl', [
        match('ev4', start, [
          book('pinnacle', now, [2.2, 3.3, 3.4]),
          book('onexbet', now, [2.25, 3.2, 3.3]),
        ]),
      ]);
      await t.db.db
        .update(feedLeagues)
        .set({ nextOddsAt: null })
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      expect((await runOddsApiOddsPoll(t.ctx, deps)).created).toBe(1);
      const ev4 = await eventByRef('ev4');

      t.clock.advance(45 * MINUTE_MS);
      expect((await runOddsApiSweeps(t.ctx, deps)).stale).toBe(1);
      expect((await marketRows(ev4.id)).every((row) => row.status === 'suspended')).toBe(true);

      t.clock.set(new Date(start.getTime() + 49 * HOUR_MS));
      expect((await runOddsApiSweeps(t.ctx, deps)).overdue).toBe(1);
      const [review] = await t.db.db
        .select()
        .from(feedResults)
        .where(eq(feedResults.eventId, ev4.id));
      expect(review).toMatchObject({ reviewReason: 'overdue', scoreHome: null });

      t.clock.set(new Date(start.getTime() + 73 * HOUR_MS));
      expect((await runOddsApiSweeps(t.ctx, deps)).voided).toBe(1);
      expect((await eventByRef('ev4')).status).toBe('cancelled');
    },
    TEST_TIMEOUT,
  );

  it(
    'pauses every call after a key or quota error',
    async () => {
      fake.fail = new OddsApiError({
        kind: 'quota',
        message: 'out of credits',
        path: '/sports',
        status: 401,
      });
      expect((await runOddsApiCatalogSync(t.ctx, deps)).failed).toBe(1);
      fake.fail = null;
      const calls = fake.calls.length;
      await runOddsApiCatalogSync(t.ctx, deps);
      await runOddsApiOddsPoll(t.ctx, deps);
      expect(fake.calls.length).toBe(calls);
      await t.redis.del('vamos:oddsapi:paused');
    },
    TEST_TIMEOUT,
  );

  it(
    'retires simulated events and runs only the real feed tasks',
    async () => {
      const lookup = (map: Map<string, string>, key: string): string => {
        const value = map.get(key);
        if (value === undefined) throw new Error(`not seeded: ${key}`);
        return value;
      };
      const mock = await t.db.db.transaction((tx) =>
        upsertFixture(
          tx,
          {
            feedProvider: 'mock',
            feedRef: 'mock-1',
            sport: 'football',
            competitionId: lookup(t.ids.competitions, 'football/premier-league'),
            homeTeamId: lookup(t.ids.teams, 'football/Arsenal'),
            awayTeamId: lookup(t.ids.teams, 'football/Chelsea'),
            startTime: new Date(t.clock.now.getTime() + HOUR_MS),
          },
          [
            {
              type: '1x2',
              line: null,
              selections: [
                { code: '1', oddsMilli: 2000 },
                { code: 'X', oddsMilli: 3400 },
                { code: '2', oddsMilli: 3600 },
              ],
            },
          ],
        ),
      );
      expect(await retireSimulatedEvents(t.ctx)).toBe(1);
      const [row] = await t.db.db
        .select({ status: events.status })
        .from(events)
        .where(eq(events.id, mock.eventId));
      expect(row?.status).toBe('cancelled');

      const config = loadConfig({ FEED_PROVIDER: 'theoddsapi', ODDS_API_KEY: 'test-key' });
      const names = createTasks(config, t.ctx, { oddsApi: { client: fake } }).map(
        (task) => task.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'oddsapi-catalog',
          'oddsapi-odds',
          'oddsapi-scores',
          'oddsapi-sweeps',
        ]),
      );
      expect(names).not.toContain('feed-ingest');
      expect(names).not.toContain('live-sim');
    },
    TEST_TIMEOUT,
  );
});
