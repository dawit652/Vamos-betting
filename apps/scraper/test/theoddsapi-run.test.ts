import { latestMarketOdds, setCompetitionPolicy, setSourceEnabled, upsertSource } from '@vamos/db';
import { theOddsApiUrl, TheOddsApiConfigSchema } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { reresolveMarketOdds } from '../src/pipeline/run-source';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  jsonDoc,
  KICKOFF,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * A run of a The Odds API source (docs/theoddsapi-plan/README.md, task P2) end to end: the key
 * travels only in the x-api-key header, the prices are stored and linked to the event the
 * fixture sources made, and a market-priced competition then prices the match from them.
 */

const SECRET_NAME = 'SCRAPER_SECRET_THEODDSAPI';
const KEY = 'odds-key-for-tests-only';
const SOURCE_CONFIG = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET_NAME,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  bookmakers: ['pinnacle', 'williamhill', 'betsson'],
};
const ODDS_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(SOURCE_CONFIG));
const actor = { system: 'test' };

let h: Harness;

/** The Odds API's answer for Arsenal v Chelsea: three books, 1X2 and the 2.5 line. */
function answer(lastUpdate: Date, books = ['pinnacle', 'williamhill', 'betsson']) {
  const at = lastUpdate.toISOString();
  return JSON.stringify([
    {
      id: 'odds-ars-che',
      sport_key: 'soccer_epl',
      sport_title: 'EPL',
      commence_time: KICKOFF.toISOString(),
      home_team: 'Arsenal',
      away_team: 'Chelsea',
      bookmakers: books.map((key, i) => ({
        key,
        title: key,
        last_update: at,
        markets: [
          {
            key: 'h2h',
            last_update: at,
            outcomes: [
              { name: 'Arsenal', price: 2.1 + i * 0.02 },
              { name: 'Draw', price: 3.4 },
              { name: 'Chelsea', price: 3.5 - i * 0.05 },
            ],
          },
          {
            key: 'totals',
            last_update: at,
            outcomes: [
              { name: 'Over', price: 1.9, point: 2.5 },
              { name: 'Under', price: 1.95, point: 2.5 },
            ],
          },
        ],
      })),
    },
  ]);
}

beforeAll(async () => {
  h = await createHarness({ secrets: { [SECRET_NAME]: KEY } });
  // The match exists first, from the fixture sources (this source never makes fixtures).
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'src-odds',
        name: 'the odds api test',
        adapter: 'theoddsapi',
        upstream: 'TheOddsAPI',
        config: SOURCE_CONFIG,
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-odds', true, actor);
  });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const eventId = async () =>
  (
    await h.pool.query<{ id: string }>(
      `SELECT id FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1 AND away_team_id = $2`,
      [h.team('Arsenal'), h.team('Chelsea')],
    )
  ).rows[0]!.id;

describe('a The Odds API source run', () => {
  it(
    'sends the key only in the x-api-key header and stores the prices, never the key',
    async () => {
      h.serve(ODDS_URL, { status: 200, body: answer(new Date(h.now().getTime() - 2 * MINUTE)) });
      const run = await h.run('src-odds');
      expect(run.status).toBe('ok');

      const sent = h.requests.filter((r) => r.url.startsWith('https://api.the-odds-api.com/'));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(ODDS_URL);
      expect(sent[0]!.url).not.toContain(KEY);
      expect(Object.entries(sent[0]!.headers).filter(([, v]) => v === KEY)).toEqual([
        ['x-api-key', KEY],
      ]);

      const { rows } = await h.pool.query<{ bookmaker: string; market: string; url: string }>(
        `SELECT o.bookmaker, o.market, r.url FROM scrape_market_odds o JOIN scrape_raw r ON r.id = o.raw_id
          WHERE o.source_id = 'src-odds'`,
      );
      // 3 books × (1X2 + both sides of 2.5) = 15 rows.
      expect(rows).toHaveLength(15);
      expect(new Set(rows.map((r) => r.bookmaker))).toEqual(
        new Set(['pinnacle', 'williamhill', 'betsson']),
      );
      expect(rows.every((r) => !r.url.includes(KEY))).toBe(true);
      const leaked = await h.count(
        `SELECT count(*) AS n FROM scrape_runs WHERE issues::text LIKE '%${KEY}%'`,
      );
      expect(leaked).toBe(0);
      // No fixtures or results come from this source.
      expect(
        await h.count(`SELECT count(*) AS n FROM scrape_observations WHERE source_id = 'src-odds'`),
      ).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'links the prices to the match, and a market-priced competition prices it from them',
    async () => {
      await reresolveMarketOdds(h.ctx);
      const id = await eventId();
      const latest = await latestMarketOdds(h.ctx.db, {
        eventIds: [id],
        now: h.now(),
        maxAgeMs: 3 * HOUR,
      });
      expect(latest).toHaveLength(15);
      expect(latest.every((r) => r.upstream === 'TheOddsAPI')).toBe(true);

      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { pricingSource: 'market' }, actor),
      );
      const priced = await priceEvent(h.ctx.db, {
        competitionPricingSource: 'market',
        eventId: id,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: 8,
        now: h.now(),
      });
      expect(priced).toMatchObject({
        source: 'market',
        books: 3,
        booksOu25: 3,
        totalsLine: '2.5',
        pricesSane: true,
      });
      expect(priced.residual!).toBeLessThanOrEqual(0.03);
    },
    TEST_TIMEOUT,
  );

  it(
    'an error answer stores nothing new and keeps what was stored',
    async () => {
      h.advance(20 * MINUTE);
      h.serve(ODDS_URL, {
        status: 200,
        body: JSON.stringify({
          message: 'Usage quota has been reached',
          error_code: 'OUT_OF_USAGE_CREDITS',
        }),
      });
      const run = await h.run('src-odds');
      expect(run.status).not.toBe('ok');
      expect(
        await h.count(`SELECT count(*) AS n FROM scrape_market_odds WHERE source_id = 'src-odds'`),
      ).toBe(15);
    },
    TEST_TIMEOUT,
  );
});
