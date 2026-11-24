import { describe, expect, it } from 'vitest';
import type { RawDocument, SourceAdapter } from '../types';
import { apiFootballBookmakerKey, apiFootballSeason } from './apifootball-odds';
import { ApiFootballConfigSchema, createAdapter, safeParse } from './index';

/**
 * The odds mode of the apifootball adapter (docs/plans/feed-gaps-2026-11-23.md, E2). The bodies
 * follow the shape of a real answer read on the server on 23 Nov 2026 (Premier League, page 1 of
 * 3: league, fixture without team names, update, bookmakers with bets 1 and 5), with made-up
 * matches.
 */

const HOST = 'v3.football.api-sports.io';
const NOW = new Date('2026-11-23T12:00:00Z');
const config = {
  allowedHosts: [HOST],
  secret: 'SCRAPER_SECRET_API_FOOTBALL',
  mode: 'odds',
  league: 39,
};

function build(cfg: unknown = config): SourceAdapter {
  const r = createAdapter({
    id: 'apifootball-odds-en1',
    adapter: 'apifootball',
    upstream: 'api-sports',
    config: cfg,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.adapter;
}

const doc = (url: string, body: unknown): RawDocument => ({
  sourceId: 'apifootball-odds-en1',
  url,
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
  fetchedAt: NOW,
  contentHash: 'h',
});

const FIXTURES_URL = `https://${HOST}/fixtures?league=39&season=2026&from=2026-11-23&to=2026-12-07&timezone=UTC`;
const oddsUrl = (page: number) => `https://${HOST}/odds?league=39&season=2026&page=${page}`;
const LEAGUE = { id: 39, name: 'Premier League', country: 'England', season: 2026 };

const at = (iso: string) => ({
  date: iso.replace('Z', '+00:00'),
  timestamp: Date.parse(iso) / 1000,
});

const fixtureItem = (id: number, home: string, away: string, kickoff: string) => ({
  fixture: { id, timezone: 'UTC', ...at(kickoff), status: { short: 'NS' } },
  league: LEAGUE,
  teams: { home: { id: id * 10 + 1, name: home }, away: { id: id * 10 + 2, name: away } },
});

const FIXTURES = {
  get: 'fixtures',
  parameters: {
    league: '39',
    season: '2026',
    from: '2026-11-23',
    to: '2026-12-07',
    timezone: 'UTC',
  },
  errors: [],
  results: 3,
  paging: { current: 1, total: 1 },
  response: [
    fixtureItem(5001, 'Arsenal', 'Chelsea', '2026-11-28T15:00:00Z'),
    fixtureItem(5002, 'Everton', 'Fulham', '2026-11-23T11:00:00Z'),
    fixtureItem(5003, 'Leeds', 'Wolves', '2026-11-29T15:00:00Z'),
  ],
};

const winner = (home: string, draw: string, away: string) => ({
  id: 1,
  name: 'Match Winner',
  values: [
    { value: 'Home', odd: home },
    { value: 'Draw', odd: draw },
    { value: 'Away', odd: away },
  ],
});
const goals = {
  id: 5,
  name: 'Goals Over/Under',
  values: [
    { value: 'Over 1.5', odd: '1.25' },
    { value: 'Under 1.5', odd: '4.00' },
    { value: 'Over 2.5', odd: '1.80' },
    { value: 'Under 2.5', odd: '2.00' },
    { value: 'Over 7.5', odd: '51.00' },
    { value: 'Under 7.5', odd: '1.00' },
  ],
};

const oddsItem = (fixtureId: number, kickoff: string, update: string, bookmakers: unknown[]) => ({
  league: LEAGUE,
  fixture: { id: fixtureId, timezone: 'UTC', ...at(kickoff) },
  update: update.replace('Z', '+00:00'),
  bookmakers,
});

const ODDS = {
  get: 'odds',
  parameters: { league: '39', season: '2026', page: '1' },
  errors: [],
  results: 4,
  paging: { current: 1, total: 1 },
  response: [
    // Played last week: not on the fixtures page.
    oddsItem(4999, '2026-11-21T15:00:00Z', '2026-11-21T13:02:20Z', [
      { id: 8, name: 'Bet365', bets: [winner('1.75', '3.75', '4.50')] },
    ]),
    oddsItem(5001, '2026-11-28T15:00:00Z', '2026-11-23T10:00:00Z', [
      { id: 4, name: 'Pinnacle', bets: [winner('1.80', '3.90', '4.60'), goals] },
      { id: 8, name: 'Bet365', bets: [winner('1.75', '3.75', '4.50'), goals] },
      { id: 7, name: 'William Hill', bets: [winner('1.75', '3.75', '4.40')] },
      // An incomplete 1X2 is left out whole.
      {
        id: 11,
        name: '1xBet',
        bets: [{ id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.8' }] }],
      },
    ]),
    // Kicked off an hour ago.
    oddsItem(5002, '2026-11-23T11:00:00Z', '2026-11-23T09:00:00Z', [
      { id: 4, name: 'Pinnacle', bets: [winner('2.00', '3.40', '3.80')] },
    ]),
    // Its odds were refreshed 6 hours ago: older than 4 hours.
    oddsItem(5003, '2026-11-29T15:00:00Z', '2026-11-23T06:00:00Z', [
      { id: 4, name: 'Pinnacle', bets: [winner('2.10', '3.30', '3.60')] },
    ]),
  ],
};

describe('apifootball odds mode', () => {
  it('plans the fixtures page then the odds pages, in full, on the odds schedule', () => {
    const plan = build().plan(NOW);
    expect(plan.map((p) => p.url)).toEqual([FIXTURES_URL, oddsUrl(1), oddsUrl(2), oddsUrl(3)]);
    expect(plan.every((p) => p.purpose === 'odds' && p.revalidate === false)).toBe(true);
    expect(plan[0]?.auth).toEqual({
      header: 'x-apisports-key',
      secret: 'SCRAPER_SECRET_API_FOOTBALL',
    });
    expect(
      build({ ...config, season: 2025, pages: 1 })
        .plan(NOW)
        .map((p) => p.url)[1],
    ).toBe(`https://${HOST}/odds?league=39&season=2025&page=1`);
  });

  it('works out the season: August to May leagues turn in July, calendar-year leagues in January', () => {
    expect(apiFootballSeason(new Date('2026-11-23T00:00:00Z'), false)).toBe(2026);
    expect(apiFootballSeason(new Date('2027-03-01T00:00:00Z'), false)).toBe(2026);
    expect(apiFootballSeason(new Date('2027-07-01T00:00:00Z'), false)).toBe(2027);
    expect(apiFootballSeason(new Date('2027-03-01T00:00:00Z'), true)).toBe(2027);
  });

  it('names books like The Odds API where it is the same book', () => {
    expect(apiFootballBookmakerKey('Pinnacle')).toBe('pinnacle');
    expect(apiFootballBookmakerKey('William Hill')).toBe('williamhill');
    expect(apiFootballBookmakerKey('1xBet')).toBe('onexbet');
    expect(apiFootballBookmakerKey('Bet365')).toBe('bet365');
    expect(apiFootballBookmakerKey('  ')).toBeNull();
  });

  it('turns the odds of upcoming matches into whole books of 1X2 and half-line over/under prices', () => {
    const adapter = build();
    const fixtures = safeParse(adapter, doc(FIXTURES_URL, FIXTURES));
    expect(fixtures.issues.filter((i) => i.fatal)).toEqual([]);
    expect(fixtures.marketOdds).toEqual([]);
    const odds = safeParse(adapter, doc(oddsUrl(1), ODDS));
    expect(odds.issues.filter((i) => i.fatal)).toEqual([]);
    const rows = odds.marketOdds;
    // Only the Arsenal match: the past, started and stale ones give nothing.
    expect(new Set(rows.map((r) => r.externalRef))).toEqual(new Set(['5001']));
    expect(rows[0]).toMatchObject({
      sourceId: 'apifootball-odds-en1',
      sport: 'football',
      competition: 'England - Premier League [39]',
      home: 'Arsenal',
      away: 'Chelsea',
      kickoff: new Date('2026-11-28T15:00:00Z'),
      priceUpdatedAt: new Date('2026-11-23T10:00:00Z'),
      observedAt: NOW,
    });
    const books = (market: string, line: string | null = null) =>
      rows
        .filter((r) => r.market === market && r.line === line)
        .map((r) => `${r.bookmaker}:${r.selection}:${r.priceMilli}`)
        .sort();
    expect(books('1x2')).toEqual(
      [
        'bet365:1:1750',
        'bet365:2:4500',
        'bet365:X:3750',
        'pinnacle:1:1800',
        'pinnacle:2:4600',
        'pinnacle:X:3900',
        'williamhill:1:1750',
        'williamhill:2:4400',
        'williamhill:X:3750',
      ].sort(),
    );
    expect(books('ou', '2.5')).toEqual(
      ['bet365:over:1800', 'bet365:under:2000', 'pinnacle:over:1800', 'pinnacle:under:2000'].sort(),
    );
    // 7.5 (Under at 1.00) is beyond the lines read; 1xBet's broken 1X2 is left out whole.
    expect(rows.some((r) => r.line === '7.5' || r.bookmaker === 'onexbet')).toBe(false);
  });

  it('uses no odds when the fixtures page did not come first in the run', () => {
    const odds = safeParse(build(), doc(oddsUrl(1), ODDS));
    expect(odds.marketOdds).toEqual([]);
    expect(odds.issues.map((i) => i.code)).toContain('no_fixtures');
  });

  it('refuses an answer with errors, for another league, or with unreadable prices', () => {
    const adapter = build();
    safeParse(adapter, doc(FIXTURES_URL, FIXTURES));
    const refused = (body: unknown) =>
      safeParse(adapter, doc(oddsUrl(1), body)).issues.find((i) => i.fatal)?.code;
    expect(refused({ ...ODDS, errors: { token: 'Missing application key' }, response: [] })).toBe(
      'api_error',
    );
    expect(refused({ ...ODDS, parameters: { league: '140', season: '2026', page: '1' } })).toBe(
      'bad_shape',
    );
    const garbled = {
      ...ODDS,
      response: [
        oddsItem(5001, '2026-11-28T15:00:00Z', '2026-11-23T10:00:00Z', [
          { id: 4, name: 'Pinnacle', bets: [winner('one', 'two', 'three')] },
        ]),
      ],
    };
    expect(refused(garbled)).toBe('wrong_price_format');
    expect(
      safeParse(adapter, doc(`https://${HOST}/odds?league=140&season=2026&page=1`, ODDS)).issues[0]
        ?.code,
    ).toBe('unknown_request');
  });

  it('warns when the league has more odds pages than are read', () => {
    const adapter = build({ ...config, pages: 2 });
    safeParse(adapter, doc(FIXTURES_URL, FIXTURES));
    const last = safeParse(
      adapter,
      doc(oddsUrl(2), {
        ...ODDS,
        parameters: { league: '39', season: '2026', page: '2' },
        paging: { current: 2, total: 3 },
      }),
    );
    expect(last.issues.find((i) => i.code === 'pages_missing')?.context).toMatchObject({
      total: 3,
      pages: 2,
    });
  });

  it('needs a league in odds mode, and reads one league only', () => {
    expect(ApiFootballConfigSchema.safeParse({ ...config, league: undefined }).success).toBe(false);
    expect(ApiFootballConfigSchema.safeParse({ ...config, leagueIds: [39] }).success).toBe(false);
    expect(ApiFootballConfigSchema.safeParse(config).success).toBe(true);
  });
});
