import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  apiFootballFixturesUrl,
  matchApiFootballFixture,
  parseApiFootballFixtures,
  sameTeamName,
  type ApiFootballFixture,
} from './apifootball-results';

/** A SYNTHETIC `/fixtures?date=` response in API-Football v3's shape. */
const row = (over: {
  id?: number;
  date?: string;
  home?: string;
  away?: string;
  status?: string;
  ft?: [number, number] | null;
  ht?: [number, number] | null;
}) => ({
  fixture: {
    id: over.id ?? 1,
    date: over.date ?? '2026-11-14T16:00:00+00:00',
    status: { short: over.status ?? 'FT' },
  },
  league: { name: 'Czech Liga', country: 'Czech-Republic' },
  teams: { home: { name: over.home ?? 'Mlada Boleslav' }, away: { name: over.away ?? 'Plzen' } },
  goals: { home: 3, away: 2 },
  score: {
    halftime:
      over.ht === null
        ? { home: null, away: null }
        : { home: (over.ht ?? [1, 0])[0], away: (over.ht ?? [1, 0])[1] },
    fulltime:
      over.ft === null
        ? { home: null, away: null }
        : { home: (over.ft ?? [2, 2])[0], away: (over.ft ?? [2, 2])[1] },
    extratime: { home: 1, away: 0 },
    penalty: { home: null, away: null },
  },
});
const doc = (rows: unknown[], errors: unknown = []) =>
  JSON.stringify({ get: 'fixtures', errors, results: rows.length, response: rows });

describe('parseApiFootballFixtures', () => {
  it('reads each fixture with its 90-minute and half-time scores', () => {
    const parsed = parseApiFootballFixtures(doc([row({ status: 'AET' })]))!;
    expect(parsed.errors).toEqual([]);
    expect(parsed.fixtures).toEqual([
      {
        id: 1,
        kickoff: new Date('2026-11-14T16:00:00Z'),
        home: 'Mlada Boleslav',
        away: 'Plzen',
        league: 'Czech Liga',
        country: 'Czech-Republic',
        status: 'AET',
        // The score after 90 minutes, not the final score with extra time (goals 3-2).
        fullTime: { home: 2, away: 2 },
        halfTime: { home: 1, away: 0 },
      },
    ]);
  });

  it('reports the errors API-Football returns, and has no score while a match is not played', () => {
    const refused = parseApiFootballFixtures(doc([], { token: 'Error/Missing application key' }))!;
    expect(refused).toEqual({ fixtures: [], errors: ['token: Error/Missing application key'] });
    const upcoming = parseApiFootballFixtures(doc([row({ status: 'NS', ft: null, ht: null })]))!;
    expect(upcoming.fixtures[0]).toMatchObject({ status: 'NS', fullTime: null, halfTime: null });
  });

  it('skips broken rows, returns null for anything else, and never throws', () => {
    expect(
      parseApiFootballFixtures(doc([{ fixture: { id: 'x' } }, row({})]))!.fixtures,
    ).toHaveLength(1);
    expect(parseApiFootballFixtures('not json')).toBeNull();
    expect(parseApiFootballFixtures('{"response":{}}')).toBeNull();
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        parseApiFootballFixtures(JSON.stringify(value));
      }),
    );
  });

  it('builds the day URL', () => {
    expect(apiFootballFixturesUrl('2026-11-14')).toBe(
      'https://v3.football.api-sports.io/fixtures?date=2026-11-14',
    );
  });
});

describe('sameTeamName', () => {
  it('accepts the spellings of one club and refuses different clubs', () => {
    expect(sameTeamName('FK Mlada Boleslav', 'Mlada Boleslav')).toBe(true);
    expect(sameTeamName('FC Viktoria Plzen', 'Viktoria Plzeň')).toBe(true);
    expect(sameTeamName('Amazulu', 'AmaZulu FC')).toBe(true);
    expect(sameTeamName('Manchester United', 'Manchester Utd')).toBe(true);
    expect(sameTeamName('Manchester United', 'Manchester City')).toBe(false);
    expect(sameTeamName('Mamelodi Sundowns', 'Mamelodi Sundowns FC')).toBe(true);
    expect(sameTeamName('Sparta Prague', 'Slavia Prague')).toBe(false);
    expect(sameTeamName('Dinamo Tbilisi', 'Dinamo Batumi')).toBe(false);
    expect(sameTeamName('Real Madrid', 'Atletico Madrid')).toBe(false);
  });

  it('property: symmetric, and every name is its own spelling', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (a, b) => {
          expect(sameTeamName(a, b)).toBe(sameTeamName(b, a));
        },
      ),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{3,12}( [A-Za-z]{3,12}){0,2}$/), (name) => {
        expect(sameTeamName(name, name)).toBe(true);
      }),
    );
  });
});

describe('matchApiFootballFixture', () => {
  const fixtures = parseApiFootballFixtures(
    doc([
      row({ id: 1 }),
      row({ id: 2, home: 'Sparta Prague', away: 'Slavia Prague' }),
      row({ id: 3, date: '2026-11-14T19:00:00+00:00', home: 'Mlada Boleslav', away: 'Plzen' }),
    ]),
  )!.fixtures;
  const match = (over: Partial<{ home: string; away: string; kickoff: Date }> = {}) => ({
    home: 'FK Mlada Boleslav',
    away: 'FC Viktoria Plzen',
    kickoff: new Date('2026-11-14T16:00:00Z'),
    ...over,
  });

  it('finds the one fixture with both teams near the kickoff', () => {
    expect(matchApiFootballFixture(match(), fixtures)?.id).toBe(1);
    expect(
      matchApiFootballFixture(match({ kickoff: new Date('2026-11-14T16:10:00Z') }), fixtures)?.id,
    ).toBe(1);
  });

  it('finds nothing for a swapped, distant, unknown or doubled match', () => {
    expect(
      matchApiFootballFixture(
        match({ home: 'FC Viktoria Plzen', away: 'FK Mlada Boleslav' }),
        fixtures,
      ),
    ).toBeNull();
    expect(
      matchApiFootballFixture(match({ kickoff: new Date('2026-11-14T17:00:00Z') }), fixtures),
    ).toBeNull();
    expect(matchApiFootballFixture(match({ home: 'Banik Ostrava' }), fixtures)).toBeNull();
    const doubled: ApiFootballFixture[] = [...fixtures, { ...fixtures[0]!, id: 9 }];
    expect(matchApiFootballFixture(match(), doubled)).toBeNull();
  });
});
