import { setSourceEnabled, upsertSource } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * A run of an API-Football odds source (docs/plans/feed-gaps-2026-11-23.md, E2): the fixtures page
 * names the matches, the odds page that follows gives their prices, stored like The Odds API's,
 * resolved to the catalogue.
 */

const HOST = 'v3.football.api-sports.io';
const SECRET = 'SCRAPER_SECRET_API_FOOTBALL';
const NOW = new Date('2026-11-23T12:00:00Z');
const FIXTURES_URL = `https://${HOST}/fixtures?league=39&season=2026&from=2026-11-23&to=2026-12-07&timezone=UTC`;
const ODDS_URL = `https://${HOST}/odds?league=39&season=2026&page=1`;
const LEAGUE = { id: 39, name: 'Premier League', country: 'England', season: 2026 };
const KICKOFF = '2026-11-28T15:00:00+00:00';
const TIMESTAMP = Date.parse(KICKOFF) / 1000;

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
  results: 1,
  paging: { current: 1, total: 1 },
  response: [
    {
      fixture: {
        id: 5001,
        timezone: 'UTC',
        date: KICKOFF,
        timestamp: TIMESTAMP,
        status: { short: 'NS' },
      },
      league: LEAGUE,
      teams: { home: { id: 42, name: 'Arsenal' }, away: { id: 49, name: 'Chelsea' } },
    },
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

const ODDS = {
  get: 'odds',
  parameters: { league: '39', season: '2026', page: '1' },
  errors: [],
  results: 1,
  paging: { current: 1, total: 1 },
  response: [
    {
      league: LEAGUE,
      fixture: { id: 5001, timezone: 'UTC', date: KICKOFF, timestamp: TIMESTAMP },
      update: '2026-11-23T10:00:00+00:00',
      bookmakers: [
        {
          id: 4,
          name: 'Pinnacle',
          bets: [
            winner('1.80', '3.90', '4.60'),
            {
              id: 5,
              name: 'Goals Over/Under',
              values: [
                { value: 'Over 2.5', odd: '1.80' },
                { value: 'Under 2.5', odd: '2.00' },
              ],
            },
          ],
        },
        { id: 8, name: 'Bet365', bets: [winner('1.75', '3.75', '4.50')] },
        { id: 7, name: 'William Hill', bets: [winner('1.75', '3.75', '4.40')] },
      ],
    },
  ],
};

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ secrets: { [SECRET]: 'test-key-not-real' } });
  h.at(NOW);
  const actor = { system: 'test' };
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'apifootball-odds-en1',
        name: 'API-Football odds test',
        adapter: 'apifootball',
        upstream: 'api-sports',
        config: { allowedHosts: [HOST], secret: SECRET, mode: 'odds', league: 39, pages: 1 },
      },
      actor,
    );
    await setSourceEnabled(tx, 'apifootball-odds-en1', true, actor);
  });
  h.serve(FIXTURES_URL, { status: 200, body: JSON.stringify(FIXTURES) });
  h.serve(ODDS_URL, { status: 200, body: JSON.stringify(ODDS) });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('an API-Football odds source run', () => {
  it(
    'stores whole books of the match the fixtures page named, resolved to the catalogue',
    async () => {
      const run = await h.run('apifootball-odds-en1');
      expect(run.status).toBe('ok');
      const { rows } = await h.pool.query<{
        source_key: string;
        bookmaker: string;
        market: string;
        line: string | null;
        selection: string;
        price_milli: number;
        home_team_id: string | null;
        away_team_id: string | null;
      }>(
        `SELECT source_key, bookmaker, market, line, selection, price_milli, home_team_id, away_team_id
           FROM scrape_market_odds WHERE source_id = 'apifootball-odds-en1'`,
      );
      // Three 1X2 books (9 rows) and Pinnacle's 2.5 line (2 rows).
      expect(rows).toHaveLength(11);
      expect(new Set(rows.map((r) => r.bookmaker))).toEqual(
        new Set(['pinnacle', 'bet365', 'williamhill']),
      );
      expect(rows.find((r) => r.bookmaker === 'pinnacle' && r.selection === '1')?.price_milli).toBe(
        1800,
      );
      expect(rows.every((r) => r.home_team_id === h.team('Arsenal'))).toBe(true);
      expect(rows.every((r) => r.away_team_id === h.team('Chelsea'))).toBe(true);
      // Both pages were asked for in full (no conditional request).
      const asked = h.requests.filter((r) => r.url.startsWith(`https://${HOST}/`));
      expect(asked.map((r) => r.url)).toEqual([FIXTURES_URL, ODDS_URL]);
      expect(asked.every((r) => r.headers['if-none-match'] === undefined)).toBe(true);
      expect(asked.every((r) => r.headers['x-apisports-key'] === 'test-key-not-real')).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
