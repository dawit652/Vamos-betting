import { SPORT_MARKETS, isValidOddsMilli } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_HORIZON_HOURS,
  MockFeedProvider,
  type MockFeedProviderConfig,
  defaultSchedule,
  mockFeedRef,
} from './mock-provider';
import type { FeedFixture, FeedTeam, OddsFeedProvider } from './types';

const HOUR = 3_600_000;
/** Saturday 10 October 2026, 00:00 in Addis Ababa (UTC+3). */
const SATURDAY = new Date('2026-10-09T21:00:00Z');

const EPL = [
  'ARS',
  'AVL',
  'BOU',
  'BRE',
  'BHA',
  'BUR',
  'CHE',
  'CRY',
  'EVE',
  'FUL',
  'LEE',
  'LIV',
  'MCI',
  'MUN',
  'NEW',
  'NFO',
  'SUN',
  'TOT',
  'WHU',
  'WOL',
];
const ETH = [
  'SGE',
  'FAS',
  'BDR',
  'HAW',
  'MEK',
  'ADA',
  'WOL',
  'SID',
  'DIR',
  'ETB',
  'BAH',
  'HAD',
  'SHA',
  'ARB',
  'WEL',
  'KDC',
];
const CAF = [
  'SGE',
  'AHL',
  'ZAM',
  'ESP',
  'WAC',
  'RSB',
  'MSD',
  'SUN',
  'PYR',
  'YNG',
  'TPM',
  'ASF',
  'SIM',
  'CRB',
  'ORL',
  'PET',
];

function pool(names: readonly string[], seed = 0): FeedTeam[] {
  return names.map((shortName, i) => ({
    shortName,
    ratings: {
      attack: 0.7 + ((i * 7 + seed) % 10) / 15,
      defence: 0.7 + ((i * 3 + seed) % 10) / 15,
    },
  }));
}

function players(prefix: string, count: number): FeedTeam[] {
  return Array.from({ length: count }, (_, i) => ({
    shortName: `${prefix}${i + 1}`,
    ratings: { rating: 1500 + i * 40 },
  }));
}

function config(overrides: Partial<MockFeedProviderConfig> = {}): MockFeedProviderConfig {
  return {
    competitions: [
      { slug: 'premier-league', sport: 'football', featured: true },
      { slug: 'ethiopian-premier-league', sport: 'football', featured: true },
      { slug: 'caf-champions-league', sport: 'football', featured: true },
      { slug: 'la-liga', sport: 'football', featured: false },
      { slug: 'nba', sport: 'basketball', featured: true },
      { slug: 'atp-tour', sport: 'tennis', featured: true },
      { slug: 'cev-champions-league', sport: 'volleyball', featured: false },
    ],
    teams: {
      'premier-league': pool(EPL),
      'ethiopian-premier-league': pool(ETH, 3),
      'caf-champions-league': pool(CAF, 5),
      'la-liga': pool(['RMA', 'BAR', 'ATM', 'SEV', 'VAL', 'BET', 'RSO', 'VIL']),
      nba: pool(['BOS', 'LAL', 'GSW', 'MIA', 'DEN', 'MIL', 'PHX', 'NYK', 'DAL', 'OKC']),
      'atp-tour': players('P', 16),
      'cev-champions-league': players('V', 8),
    },
    seed: 'test-seed',
    ...overrides,
  };
}

function local(date: Date): { day: string; time: string; weekday: number } {
  const shifted = new Date(date.getTime() + 3 * HOUR);
  const weekday = shifted.getUTCDay();
  return {
    day: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
    weekday: weekday === 0 ? 7 : weekday,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

describe('MockFeedProvider.fixtures', () => {
  const provider = new MockFeedProvider(config());
  const twoWeeks = provider.fixtures(SATURDAY, 24 * 14);

  it('implements the provider contract', () => {
    const contract: OddsFeedProvider = provider;
    expect(contract.name).toBe('mock');
    expect(twoWeeks.length).toBeGreaterThan(100);
  });

  it('is deterministic across instances and overlapping windows', () => {
    const again = new MockFeedProvider(config()).fixtures(SATURDAY, 24 * 14);
    expect(again).toEqual(twoWeeks);
    const later = new Date(SATURDAY.getTime() + 37.5 * HOUR);
    const window = provider.fixtures(later, 50);
    const expected = twoWeeks.filter(
      (f) => f.startTime >= later && f.startTime.getTime() <= later.getTime() + 50 * HOUR,
    );
    expect(window).toEqual(expected);
    const otherSeed = new MockFeedProvider(config({ seed: 'other' })).fixtures(SATURDAY, 24 * 14);
    expect(otherSeed).not.toEqual(twoWeeks);
  });

  it('returns only fixtures in [now, now + horizon], sorted by start time', () => {
    const now = new Date('2026-10-11T14:23:00Z');
    const fixtures = provider.fixtures(now, 30);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.startTime.getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect(f.startTime.getTime()).toBeLessThanOrEqual(now.getTime() + 30 * HOUR);
    }
    const starts = fixtures.map((f) => f.startTime.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(provider.fixtures(now, 0).every((f) => f.startTime.getTime() === now.getTime())).toBe(
      true,
    );
  });

  it('gives every fixture a stable, unique feedRef', () => {
    const refs = twoWeeks.map((f) => f.feedRef);
    expect(new Set(refs).size).toBe(refs.length);
    for (const f of twoWeeks) {
      expect(f.feedRef).toBe(
        mockFeedRef(f.competitionSlug, f.startTime, f.homeShortName, f.awayShortName),
      );
      expect(f.feedRef).toMatch(
        /^mock:[a-z-]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z:[A-Z0-9]+-[A-Z0-9]+$/,
      );
    }
    expect(mockFeedRef('nba', new Date('2026-10-10T00:00:30Z'), 'BOS', 'LAL')).toBe(
      'mock:nba:2026-10-10T00:00Z:BOS-LAL',
    );
  });

  it('never schedules a team twice on one Addis Ababa day, even across competitions', () => {
    const bySportDay = groupBy(twoWeeks, (f) => `${f.sport}|${local(f.startTime).day}`);
    for (const fixtures of bySportDay.values()) {
      const teams = fixtures.flatMap((f) => [f.homeShortName, f.awayShortName]);
      expect(new Set(teams).size).toBe(teams.length);
    }
    for (const f of twoWeeks) expect(f.homeShortName).not.toBe(f.awayShortName);
    // SGE is in both the Ethiopian league and the CAF pool; both play on Tuesdays.
    const tuesday = twoWeeks.filter(
      (f) => local(f.startTime).weekday === 2 && f.sport === 'football',
    );
    expect(new Set(tuesday.map((f) => f.competitionSlug)).size).toBeGreaterThanOrEqual(2);
  });

  it('uses each pool only for its own competition and sport', () => {
    const cfg = config();
    for (const f of twoWeeks) {
      const names = cfg.teams[f.competitionSlug]!.map((t) => t.shortName);
      expect(names).toContain(f.homeShortName);
      expect(names).toContain(f.awayShortName);
      expect(cfg.competitions.find((c) => c.slug === f.competitionSlug)?.sport).toBe(f.sport);
    }
  });

  it('kicks off at realistic Addis Ababa times on the competition matchdays', () => {
    const expected: Record<string, { times: string[]; days: number[] }> = {
      'premier-league': { times: ['16:00', '19:00', '22:00'], days: [1, 5, 6, 7] },
      'la-liga': { times: ['16:00', '19:00', '22:00'], days: [1, 5, 6, 7] },
      'ethiopian-premier-league': { times: ['15:00', '18:00'], days: [2, 4, 6, 7] },
      'caf-champions-league': { times: ['16:00', '19:00', '22:00'], days: [2, 3] },
      nba: { times: ['03:00', '20:00', '21:45'], days: [1, 2, 3, 4, 5, 6, 7] },
    };
    for (const f of twoWeeks) {
      const rule = expected[f.competitionSlug];
      if (rule === undefined) continue;
      const { time, weekday } = local(f.startTime);
      expect(rule.times).toContain(time);
      expect(rule.days).toContain(weekday);
    }
    // 16:00 in Addis Ababa is 13:00 UTC.
    const epl = twoWeeks.filter((f) => f.competitionSlug === 'premier-league');
    expect(new Set(epl.map((f) => f.startTime.getUTCHours()))).toEqual(new Set([13, 16, 19]));
  });

  it('plays 4–8 fixtures per matchday in featured football competitions', () => {
    const byCompetitionDay = groupBy(
      twoWeeks.filter((f) => f.sport === 'football'),
      (f) => `${f.competitionSlug}|${local(f.startTime).day}`,
    );
    for (const [key, fixtures] of byCompetitionDay) {
      const featured = !key.startsWith('la-liga');
      expect(fixtures.length).toBeGreaterThanOrEqual(featured ? 4 : 2);
      expect(fixtures.length).toBeLessThanOrEqual(featured ? 8 : 4);
    }
    // Two weeks of Fri–Mon in the Premier League: eight matchdays.
    const eplDays = new Set(
      twoWeeks
        .filter((f) => f.competitionSlug === 'premier-league')
        .map((f) => local(f.startTime).day),
    );
    expect(eplDays.size).toBe(8);
  });

  it('schedules a few basketball, tennis and volleyball fixtures every day', () => {
    for (const [slug, [min, max]] of [
      ['nba', [2, 4]],
      ['atp-tour', [2, 4]],
      ['cev-champions-league', [1, 3]],
    ] as const) {
      const byDay = groupBy(
        twoWeeks.filter((f) => f.competitionSlug === slug),
        (f) => local(f.startTime).day,
      );
      expect(byDay.size).toBe(14);
      for (const fixtures of byDay.values()) {
        expect(fixtures.length).toBeGreaterThanOrEqual(min);
        expect(fixtures.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('honours configured matchdays and kick-off times', () => {
    const custom = new MockFeedProvider(
      config({
        competitions: [
          {
            slug: 'premier-league',
            sport: 'football',
            featured: true,
            matchdays: [3],
            kickoffs: ['20:30'],
          },
        ],
      }),
    );
    const fixtures = custom.fixtures(SATURDAY, 24 * 14);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures)
      expect(local(f.startTime)).toMatchObject({ weekday: 3, time: '20:30' });
  });

  it('caps the fixture count by the size of the pool', () => {
    const small = new MockFeedProvider(
      config({
        competitions: [{ slug: 'tiny', sport: 'football', featured: true, matchdays: [6] }],
        teams: { tiny: pool(['AAA', 'BBB', 'CCC']) },
      }),
    );
    const fixtures = small.fixtures(SATURDAY, 24);
    expect(fixtures).toHaveLength(1);
    const empty = new MockFeedProvider(
      config({ competitions: [{ slug: 'none', sport: 'football', featured: true }], teams: {} }),
    );
    expect(empty.fixtures(SATURDAY, 24 * 7)).toEqual([]);
  });

  it('rejects invalid configuration and arguments', () => {
    const bad = (overrides: Partial<MockFeedProviderConfig>) => () =>
      new MockFeedProvider(config(overrides));
    const football = { slug: 'x', sport: 'football', featured: true } as const;
    expect(bad({ competitions: [football, football] })).toThrow(RangeError);
    expect(bad({ competitions: [{ ...football, matchdays: [0] }] })).toThrow(RangeError);
    expect(bad({ competitions: [{ ...football, kickoffs: ['25:00'] }] })).toThrow(RangeError);
    expect(bad({ competitions: [{ ...football, kickoffs: [] }] })).toThrow(RangeError);
    expect(
      bad({ rolling: { everyMinutes: 0, horizonMinutes: 60, competitionSlugs: ['nba'] } }),
    ).toThrow(RangeError);
    expect(
      bad({ rolling: { everyMinutes: 10, horizonMinutes: 60, competitionSlugs: ['unknown'] } }),
    ).toThrow(RangeError);
    expect(() => provider.fixtures(new Date('invalid'), 24)).toThrow(RangeError);
    expect(() => provider.fixtures(SATURDAY, -1)).toThrow(RangeError);
    expect(() => provider.fixtures(SATURDAY, MAX_HORIZON_HOURS + 1)).toThrow(RangeError);
  });
});

describe('rolling demo fixtures', () => {
  const rolling = {
    everyMinutes: 10,
    horizonMinutes: 200,
    competitionSlugs: ['premier-league', 'ethiopian-premier-league'],
  };
  const provider = new MockFeedProvider(config({ rolling }));
  const plain = new MockFeedProvider(config());

  function rollingOnly(now: Date, hours: number): FeedFixture[] {
    const regular = new Set(plain.fixtures(now, hours).map((f) => f.feedRef));
    return provider.fixtures(now, hours).filter((f) => !regular.has(f.feedRef));
  }

  it('starts one fixture every N minutes on a fixed grid within the rolling horizon', () => {
    const fixtures = rollingOnly(SATURDAY, 48);
    expect(fixtures).toHaveLength(21); // 00:00, 00:10 … 03:20
    const firstSlot = SATURDAY.getTime() / (10 * 60_000);
    fixtures.forEach((f, i) => {
      expect(f.startTime.getTime()).toBe(SATURDAY.getTime() + i * 10 * 60_000);
      // Slot k of the epoch-aligned grid belongs to competition k mod 2.
      expect(f.competitionSlug).toBe(rolling.competitionSlugs[(firstSlot + i) % 2]);
    });
    // The slots alternate between the two competitions.
    const slugs = fixtures.map((f) => f.competitionSlug);
    for (let i = 1; i < slugs.length; i++) expect(slugs[i]).not.toBe(slugs[i - 1]);
  });

  it('is stable as time moves on, so the worker can poll and upsert', () => {
    const first = rollingOnly(SATURDAY, 48);
    const later = new Date(SATURDAY.getTime() + 35 * 60_000);
    const second = rollingOnly(later, 48);
    const overlap = first.filter((f) => f.startTime >= later);
    expect(second.slice(0, overlap.length)).toEqual(overlap);
    expect(second.at(-1)!.startTime.getTime()).toBe(later.getTime() + 195 * 60_000);
  });

  it('cycles through the whole pool before a team plays again', () => {
    const fixtures = rollingOnly(SATURDAY, 48);
    const epl = fixtures.filter((f) => f.competitionSlug === 'premier-league');
    expect(epl.length).toBeGreaterThanOrEqual(10);
    const firstCycle = epl.slice(0, 10).flatMap((f) => [f.homeShortName, f.awayShortName]);
    expect(new Set(firstCycle).size).toBe(20);
    const eth = fixtures.filter((f) => f.competitionSlug === 'ethiopian-premier-league');
    const ethCycle = eth.slice(0, 8).flatMap((f) => [f.homeShortName, f.awayShortName]);
    expect(new Set(ethCycle).size).toBe(16);
  });

  it('respects the shorter of the two horizons', () => {
    expect(rollingOnly(SATURDAY, 1)).toHaveLength(7);
  });

  it('is off without rolling competitions', () => {
    const none = new MockFeedProvider(
      config({ rolling: { everyMinutes: 5, horizonMinutes: 600, competitionSlugs: [] } }),
    );
    expect(none.fixtures(SATURDAY, 48)).toEqual(plain.fixtures(SATURDAY, 48));
  });
});

describe('MockFeedProvider.price', () => {
  const provider = new MockFeedProvider(config());
  const at = new Date('2026-10-10T13:00:00Z');
  const fixture = (slug: string, sport: FeedFixture['sport'], home: string, away: string) => ({
    feedRef: mockFeedRef(slug, at, home, away),
    sport,
    competitionSlug: slug,
    homeShortName: home,
    awayShortName: away,
    startTime: at,
  });

  it('prices every generated fixture with valid odds for its sport', () => {
    for (const f of provider.fixtures(SATURDAY, 48)) {
      const markets = provider.price(f);
      expect([...new Set(markets.map((m) => m.type))]).toEqual([...SPORT_MARKETS[f.sport]]);
      for (const m of markets)
        for (const s of m.selections) expect(isValidOddsMilli(s.oddsMilli)).toBe(true);
    }
  });

  it('uses the team ratings', () => {
    const strong = new MockFeedProvider(
      config({
        competitions: [{ slug: 'premier-league', sport: 'football', featured: true }],
        teams: {
          'premier-league': [
            { shortName: 'MCI', ratings: { attack: 1.7, defence: 0.6 } },
            { shortName: 'SUN', ratings: { attack: 0.7, defence: 1.5 } },
          ],
        },
      }),
    );
    const home = strong.price(fixture('premier-league', 'football', 'MCI', 'SUN'));
    const odds1x2 = home.find((m) => m.type === '1x2')!.selections;
    expect(odds1x2[0]!.oddsMilli).toBeLessThan(odds1x2[2]!.oddsMilli);
    expect(
      strong.strengths(fixture('premier-league', 'football', 'MCI', 'SUN')).home,
    ).toBeGreaterThan(strong.strengths(fixture('premier-league', 'football', 'SUN', 'MCI')).home);
  });

  it('prices in play from a live state', () => {
    const f = fixture('premier-league', 'football', 'ARS', 'CHE');
    const live = provider.price(f, { minute: 80, home: 2, away: 0, htHome: 1, htAway: 0 });
    expect(live.find((m) => m.type === '1x2')!.selections[0]!.oddsMilli).toBeLessThan(1100);
    expect(live.some((m) => m.type === 'ht_1x2')).toBe(false);
    const tennis = provider.price(fixture('atp-tour', 'tennis', 'P1', 'P16'), {
      minute: 50,
      home: 1,
      away: 0,
    });
    expect(tennis).toHaveLength(1);
  });

  it('finds teams in other competitions of the sport, else uses neutral ratings', () => {
    // FAS is only rated in the Ethiopian pool; a fixture in another competition still finds it.
    const friendly = fixture('caf-champions-league', 'football', 'FAS', 'BDR');
    const ethiopian = fixture('ethiopian-premier-league', 'football', 'FAS', 'BDR');
    expect(provider.strengths(friendly)).toEqual(provider.strengths(ethiopian));
    const unknown = fixture('premier-league', 'football', 'ZZZ', 'YYY');
    expect(provider.strengths(unknown)).toEqual(
      provider.strengths({ ...unknown, homeShortName: 'QQQ', awayShortName: 'WWW' }),
    );
  });
});

describe('defaultSchedule', () => {
  it('picks the profile from the sport and the competition slug', () => {
    expect(
      defaultSchedule({ slug: 'ethiopian-premier-league', sport: 'football', featured: true }),
    ).toMatchObject({ kickoffs: ['15:00', '18:00'], fixtures: [4, 8] });
    expect(
      defaultSchedule({ slug: 'caf-confederation-cup', sport: 'football', featured: false }),
    ).toMatchObject({ matchdays: [2, 3], fixtures: [2, 4] });
    expect(
      defaultSchedule({ slug: 'uefa-champions-league', sport: 'football', featured: true }),
    ).toMatchObject({ matchdays: [2, 3, 4], kickoffs: ['19:45', '22:00'] });
    expect(defaultSchedule({ slug: 'serie-a', sport: 'football', featured: true })).toMatchObject({
      kickoffs: ['16:00', '19:00', '22:00'],
    });
    expect(
      defaultSchedule({ slug: 'bal', sport: 'basketball', featured: false }).matchdays,
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
