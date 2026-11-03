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
  activeShares,
  reviewReasonFor,
  runOddsApiCatalogSync,
  scoresDaysFrom,
  shareOf,
  runOddsApiOddsPoll,
  runOddsApiScoresPoll,
  runOddsApiSweeps,
  type OddsApiSource,
  type OddsApiTaskDeps,
} from '../src/tasks/oddsapi/index';
import {
  effectiveMonthlyCredits,
  freshnessFactor,
  HOUR_MS,
  MINUTE_MS,
  nextOddsPollAt,
  nextScoresPollAt,
  nothingToPrice,
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
    // In-play is off by default (its credits); these tests cover it too.
    config: loadConfig({
      FEED_PROVIDER: 'theoddsapi',
      ODDS_API_KEY: 'test-key',
      ODDS_API_INPLAY: 'true',
    }).feed.oddsApi,
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
  it('paces each sport on its share over a week, and drops to reserve and critical', () => {
    // The 20 000-credit plan, football's 90%: 600 a day, 4 200 a week.
    const plan = { monthlyCredits: 20_000, reservePercent: 10, remaining: null, share: 0.9 };
    const factor = (spentLast24h: number, spentLast7d: number, share = 0.9) =>
      planBudget({ ...plan, spentLast24h, spentLast7d, share }).factor;
    // A match day may spend up to three days' worth while the week is on plan.
    expect(factor(1500, 4200)).toBe(1);
    expect(factor(1800, 4200)).toBe(1);
    // A week at twice the pace, or a single day of six days' worth: polls twice as far apart.
    expect(factor(600, 8400)).toBeCloseTo(2);
    expect(factor(3600, 4200)).toBeCloseTo(2);
    // Basketball's 5% (about 233 a week) is paced on its own.
    expect(factor(0, 466, 0.05)).toBeCloseTo(2);
    // No share: the slowest schedule.
    expect(factor(0, 0, 0)).toBe(24);
    expect(planBudget({ ...plan, spentLast24h: 0, spentLast7d: 0 })).toEqual({
      factor: 1,
      mode: 'normal',
    });
    const left = (remaining: number) =>
      planBudget({ ...plan, spentLast24h: 0, spentLast7d: 0, remaining }).mode;
    expect(left(2500)).toBe('normal');
    expect(left(2000)).toBe('reserve');
    expect(left(200)).toBe('critical');
  });

  it('caps the monthly target by the plan the API reports (used + remaining)', () => {
    // The real free plan: x-requests-used 63, x-requests-remaining 437 (fixtures/real/quota.json).
    expect(effectiveMonthlyCredits(20_000, 63, 437)).toBe(500);
    expect(effectiveMonthlyCredits(300, 63, 437)).toBe(300);
    expect(effectiveMonthlyCredits(20_000, null, 437)).toBe(20_000);
    expect(effectiveMonthlyCredits(20_000, undefined, null)).toBe(20_000);
    const free = { monthlyCredits: 20_000, reservePercent: 10, spentLast7d: 0 };
    // Without the cap, 437 left of a 20 000 target is inside the 2 000 reserve: no prematch odds.
    expect(planBudget({ ...free, spentLast24h: 0, remaining: 437 }).mode).toBe('reserve');
    expect(planBudget({ ...free, spentLast24h: 0, remaining: 437, used: 63 })).toEqual({
      factor: 1,
      mode: 'normal',
    });
    // 500 a month is about 117 a week: 350 spent in the last 7 days stretches polls threefold.
    expect(
      planBudget({ ...free, spentLast24h: 0, spentLast7d: 350, remaining: 437, used: 63 }).factor,
    ).toBeCloseTo(3);
    expect(planBudget({ ...free, spentLast24h: 0, remaining: 40, used: 460 }).mode).toBe('reserve');
    expect(planBudget({ ...free, spentLast24h: 0, remaining: 4, used: 496 }).mode).toBe('critical');
    // A plan reported as empty: the longest stretch and only scores, never NaN.
    expect(planBudget({ ...free, spentLast24h: 0, remaining: 0, used: 0 })).toEqual({
      factor: 24,
      mode: 'critical',
    });
  });

  it('reads scores less often without live markets, and stretches freshness only so far', () => {
    const at = (input: Partial<Parameters<typeof nextScoresPollAt>[0]>) =>
      nextScoresPollAt({
        now: T0,
        live: false,
        awaitingResults: false,
        budget: { factor: 1, mode: 'normal' },
        ...input,
      }).getTime() - T0.getTime();
    expect(at({ live: true })).toBe(2 * MINUTE_MS);
    expect(at({ live: true, inPlay: false })).toBe(10 * MINUTE_MS);
    expect(at({ awaitingResults: true })).toBe(10 * MINUTE_MS);
    expect(at({})).toBe(30 * MINUTE_MS);
    const tight = { factor: 10, mode: 'normal' as const };
    expect(at({ live: true, budget: tight })).toBe(4 * MINUTE_MS);
    expect(at({ live: true, inPlay: false, budget: tight })).toBe(60 * MINUTE_MS);
    expect(at({ awaitingResults: true, budget: tight })).toBe(60 * MINUTE_MS);

    expect(freshnessFactor(24, true)).toBe(2);
    expect(freshnessFactor(24, false)).toBe(6);
    expect(freshnessFactor(1.5, true)).toBe(1.5);
    expect(freshnessFactor(0.5, false)).toBe(1);
    // Licensed: a match within the hour is suspended after 30 minutes without a fresh price.
    expect(staleBuckets(freshnessFactor(24, true))[0]?.maxAgeMs).toBe(30 * MINUTE_MS);
  });

  it('takes credits from polls days ahead before the last hours, and skips idle leagues', () => {
    const tight = { factor: 4, mode: 'normal' as const };
    const next = (startsIn: number) =>
      nextOddsPollAt({
        now: T0,
        nextStartAt: new Date(T0.getTime() + startsIn),
        liveCount: 0,
        inPlay: false,
        budget: tight,
      }).getTime() - T0.getTime();
    // Within 6 hours of the start: stretched by √4 = 2. Further out: by 4.
    expect(next(30 * MINUTE_MS)).toBe(10 * MINUTE_MS);
    expect(next(5 * HOUR_MS)).toBe(30 * MINUTE_MS);
    expect(next(20 * HOUR_MS)).toBe(4 * HOUR_MS);
    expect(next(48 * HOUR_MS)).toBe(12 * HOUR_MS);

    const idle = (startsIn: number | null, live = 0, inPlay = false) =>
      nothingToPrice({
        now: T0,
        nextStartAt: startsIn === null ? null : new Date(T0.getTime() + startsIn),
        liveCount: live,
        inPlay,
      });
    expect(idle(null)).toBe(true);
    expect(idle(80 * HOUR_MS)).toBe(true);
    expect(idle(70 * HOUR_MS)).toBe(false);
    expect(idle(-HOUR_MS)).toBe(false);
    expect(idle(null, 1, true)).toBe(false);
    expect(idle(null, 1, false)).toBe(true);
  });

  it('reads live scores without daysFrom until a match should be over', () => {
    const start = T0;
    const after = (minutes: number, sport: 'football' | 'basketball' = 'football') =>
      scoresDaysFrom(new Date(start.getTime() + minutes * MINUTE_MS), start, sport);
    expect(after(60)).toBeUndefined();
    expect(after(114)).toBeUndefined();
    expect(after(115)).toBe(1);
    expect(after(130, 'basketball')).toBeUndefined();
    expect(after(150, 'basketball')).toBe(1);
    expect(after(30 * 60)).toBe(2);
    expect(after(5 * 24 * 60)).toBe(3);
  });

  it('gives each sport its share of the credits', () => {
    const config = loadConfig({}).feed.oddsApi;
    expect(shareOf(config, 'football')).toBe(0.9);
    expect(shareOf(config, 'basketball')).toBe(0.05);
    expect(shareOf(config, 'tennis')).toBe(0.05);
    expect(shareOf(config, 'volleyball')).toBe(0);
    // No tennis tournament running: its 5% goes to football and basketball.
    const share = activeShares(config, new Set(['football', 'basketball'] as const));
    expect(share('football')).toBeCloseTo(0.9 / 0.95);
    expect(share('basketball')).toBeCloseTo(0.05 / 0.95);
    expect(activeShares(config, new Set(['football'] as const))('football')).toBe(1);
    expect(activeShares(config, new Set())('football')).toBe(0.9);
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
          book('pinnacle', now, [1.3, 5, 11], [1.6, 2.3]),
          book('betfair_ex_eu', now, [1.31, 5.1, 10.5], [1.62, 2.35]),
          book('williamhill', now, [1.28, 4.8, 10], [1.58, 2.25]),
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
      // The bookmakers' in-play total re-opens; the model's markets stay off in play.
      const rows = await marketRows(ev1.id);
      expect(rows.find((row) => row.key === 'ou:2.5')?.status).toBe('open');
      for (const key of ['btts', 'cs', 'ou:3.5']) {
        expect(rows.find((row) => row.key === key)?.status).toBe('suspended');
      }
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

  it(
    'never reads tennis scores (the API has none) and sends a match to staff once it should be over',
    async () => {
      const key = 'tennis_atp_paris_masters';
      const start = new Date(t.clock.now.getTime() + 2 * HOUR_MS);
      const players = { homeTeam: 'Brandon Nakashima', awayTeam: 'Matteo Berrettini' };
      const twoWay = (bookmaker: string, home: number, away: number): OddsApiBookmaker => ({
        key: bookmaker,
        title: bookmaker,
        lastUpdate: t.clock.now,
        markets: [
          {
            key: 'h2h',
            lastUpdate: t.clock.now,
            outcomes: [
              { name: players.homeTeam, price: home, point: null, description: null },
              { name: players.awayTeam, price: away, point: null, description: null },
            ],
          },
        ],
      });
      const tennisMatch: OddsApiEvent = {
        id: 'tn1',
        sportKey: key,
        sportTitle: 'ATP Paris Masters',
        commenceTime: start,
        ...players,
        bookmakers: [twoWay('pinnacle', 1.91, 1.95), twoWay('onexbet', 1.9, 1.96)],
      };
      fake.sportsData = [...fake.sportsData, sport(key, 'Tennis', 'ATP Paris Masters')];
      fake.eventsData.set(key, [{ ...tennisMatch, bookmakers: [] }]);
      fake.oddsData.set(key, [tennisMatch]);
      await runOddsApiCatalogSync(t.ctx, deps);
      // Off by default (only grand slams are on): staff switch it on, the next sync plans it.
      await t.db.db.update(feedLeagues).set({ enabled: true }).where(eq(feedLeagues.sportKey, key));
      await runOddsApiCatalogSync(t.ctx, deps);
      await runOddsApiOddsPoll(t.ctx, deps);
      const tn1 = await eventByRef('tn1');

      t.clock.set(new Date(start.getTime() + 3 * HOUR_MS));
      await t.db.db
        .update(feedLeagues)
        .set({ nextScoresAt: null })
        .where(eq(feedLeagues.sportKey, key));
      const calls = fake.calls.length;
      await runOddsApiScoresPoll(t.ctx, deps);
      expect(fake.calls.slice(calls)).not.toContain(`scores:${key}`);
      expect((await runOddsApiSweeps(t.ctx, deps)).toStaff).toBe(0);

      t.clock.set(new Date(start.getTime() + 6 * HOUR_MS + MINUTE_MS));
      expect((await runOddsApiSweeps(t.ctx, deps)).toStaff).toBe(1);
      const [review] = await t.db.db
        .select()
        .from(feedResults)
        .where(eq(feedResults.eventId, tn1.id));
      expect(review).toMatchObject({ reviewReason: 'tennis', scoreHome: null, appliedAt: null });
      expect((await marketRows(tn1.id)).every((row) => row.status !== 'open')).toBe(true);
      // Sent once: the next sweep leaves it with staff.
      expect((await runOddsApiSweeps(t.ctx, deps)).toStaff).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not call the API for a league with nothing inside the horizon',
    async () => {
      const now = t.clock.now;
      await t.db.db
        .update(feedLeagues)
        .set({
          nextStartAt: new Date(now.getTime() + 5 * 24 * HOUR_MS),
          liveCount: 0,
          nextOddsAt: null,
        })
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      const calls = fake.calls.length;
      const summary = await runOddsApiOddsPoll(t.ctx, deps);
      expect(summary.skipped).toBeGreaterThanOrEqual(1);
      expect(fake.calls.slice(calls)).not.toContain('odds:soccer_epl');
      const [league] = await t.db.db
        .select()
        .from(feedLeagues)
        .where(eq(feedLeagues.sportKey, 'soccer_epl'));
      // Looked at again within 6 hours; the free /events read keeps the next start current.
      expect(league?.nextOddsAt).toEqual(new Date(now.getTime() + 6 * HOUR_MS));
    },
    TEST_TIMEOUT,
  );
});
