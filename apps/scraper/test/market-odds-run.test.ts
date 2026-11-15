import { readFileSync } from 'node:fs';
import { latestMarketOdds, setSourceEnabled, upsertSource } from '@vamos/db';
import { therundownUrls, TheRundownConfigSchema } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { reresolveMarketOdds } from '../src/pipeline/run-source';
import { pruneOldMarketOdds } from '../src/tasks/prune';
import { createHarness, HOUR, MINUTE, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * A run of a TheRundown source (docs/scraper.md 3.1) against the synthetic golden file stores the
 * bookmaker prices next to the fixtures: one row per bookmaker and selection, resolved to the
 * catalogue, linked to the event once there is one, kept current by a 304.
 */

const GOLDEN = readFileSync(
  new URL(
    '../../../packages/scraper/src/adapters/__fixtures__/therundown-epl.json',
    import.meta.url,
  ),
  'utf8',
);
const SECRET_NAME = 'SCRAPER_SECRET_THERUNDOWN';
const NOW = new Date('2026-11-06T12:00:00Z');
const SOURCE_CONFIG = {
  allowedHosts: ['therundown.io'],
  secret: SECRET_NAME,
  sports: [{ sportId: 11, competition: 'Premier League' }],
};
const URLS = therundownUrls(TheRundownConfigSchema.parse(SOURCE_CONFIG), NOW);
/** The day the Arsenal v Chelsea match of the golden file is on. */
const GOLDEN_URL = URLS.find((url) => url.includes('/2026-11-07?'))!;
const ETAG = '"golden-1"';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ secrets: { [SECRET_NAME]: 'test-key-not-real' } });
  h.at(NOW);
  const actor = { system: 'test' };
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'src-rundown',
        name: 'therundown test',
        adapter: 'therundown',
        upstream: 'therundown',
        config: SOURCE_CONFIG,
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-rundown', true, actor);
  });
  for (const url of URLS) h.serve(url, { status: 200, body: '{"events":[]}' });
  h.serve(GOLDEN_URL, { status: 200, body: GOLDEN, headers: { etag: ETAG } });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async () =>
  (
    await h.pool.query<{
      source_key: string;
      bookmaker: string;
      market: string;
      line: string | null;
      selection: string;
      price_milli: number;
      competition_id: string | null;
      home_team_id: string | null;
      away_team_id: string | null;
      event_id: string | null;
      observed_at: Date;
      run_id: string;
      raw_id: string | null;
    }>(`SELECT * FROM scrape_market_odds ORDER BY source_key, bookmaker, market, line, selection`)
  ).rows;

describe('a therundown source run', () => {
  it(
    'stores the prices of the golden file with the run, the snapshot and the resolved names',
    async () => {
      const run = await h.run('src-rundown');
      expect(run.status).toBe('ok');
      const stored = await rows();
      expect(stored).toHaveLength(16);
      expect(new Set(stored.map((r) => r.source_key))).toEqual(
        new Set(['ev-ars-che-0001', 'ev-new-bha-0004', 'ev-whu-ful-0005']),
      );
      const arsenal = stored.filter((r) => r.source_key === 'ev-ars-che-0001');
      expect(arsenal).toHaveLength(10);
      expect(arsenal.find((r) => r.bookmaker === '19' && r.selection === '1')?.price_milli).toBe(
        2500,
      );
      expect(arsenal.every((r) => r.run_id === run.runId)).toBe(true);
      expect(arsenal.every((r) => r.raw_id !== null)).toBe(true);
      expect(arsenal.every((r) => r.observed_at.getTime() === NOW.getTime())).toBe(true);
      expect(arsenal.every((r) => r.competition_id === h.premier)).toBe(true);
      expect(arsenal.every((r) => r.home_team_id === h.team('Arsenal'))).toBe(true);
      expect(arsenal.every((r) => r.away_team_id === h.team('Chelsea'))).toBe(true);
      // No event exists yet: the prices wait unlinked, and pricing never reads them.
      expect(stored.every((r) => r.event_id === null)).toBe(true);
      // Fixtures were stored too (the same document).
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_observations WHERE source_id = 'src-rundown' AND kind = 'fixture'`,
        ),
      ).toBe(5);
    },
    TEST_TIMEOUT,
  );

  it(
    'links the prices to the event once it exists, and pricing may read them',
    async () => {
      expect((await promoteFixtures(h.ctx)).created).toBeGreaterThanOrEqual(1);
      const { rows: events } = await h.pool.query<{ id: string }>(
        `SELECT id FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1 AND away_team_id = $2`,
        [h.team('Arsenal'), h.team('Chelsea')],
      );
      expect(events).toHaveLength(1);
      const eventId = events[0]!.id;

      // Every listed match got its event from the promotion (16 rows, 3 matches).
      expect(await reresolveMarketOdds(h.ctx)).toBe(16);
      expect((await rows()).filter((r) => r.event_id === eventId).map((r) => r.source_key)).toEqual(
        Array(10).fill('ev-ars-che-0001'),
      );
      // Idempotent.
      expect(await reresolveMarketOdds(h.ctx)).toBe(0);

      const latest = await latestMarketOdds(h.ctx.db, {
        eventIds: [eventId],
        now: h.now(),
        maxAgeMs: 3 * HOUR,
      });
      expect(new Set(latest.map((r) => r.bookmaker))).toEqual(new Set(['19', '23']));
      expect(latest.every((r) => r.upstream === 'therundown')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a 304 lists the prices again: observed_at, run and snapshot move',
    async () => {
      h.advance(20 * MINUTE);
      const run = await h.run('src-rundown');
      expect(run.status).toBe('ok');
      const stored = await rows();
      expect(stored).toHaveLength(16);
      expect(stored.every((r) => r.observed_at.getTime() === h.now().getTime())).toBe(true);
      expect(stored.every((r) => r.run_id === run.runId)).toBe(true);
      const { rows: raws } = await h.pool.query<{ id: string; status: number }>(
        `SELECT id, status FROM scrape_raw WHERE run_id = $1 AND status = 304`,
        [run.runId],
      );
      expect(raws).toHaveLength(1);
      expect(stored.every((r) => r.raw_id === raws[0]!.id)).toBe(true);
      // The event link stays.
      expect(stored.filter((r) => r.event_id !== null)).toHaveLength(16);
    },
    TEST_TIMEOUT,
  );

  it(
    'a changed page rewrites the price, and a new run that no longer lists a bookmaker drops it from pricing',
    async () => {
      h.advance(20 * MINUTE);
      const changed = JSON.parse(GOLDEN) as { events: Array<Record<string, unknown>> };
      const arsenal = changed.events.find((e) => e.event_id === 'ev-ars-che-0001') as {
        markets: Array<{
          market_id: number;
          participants: Array<{
            lines: Array<{ prices: Record<string, { price: number | string }> }>;
          }>;
        }>;
      };
      // Affiliate 23 goes: remove its prices from every line.
      for (const market of arsenal.markets) {
        for (const participant of market.participants) {
          for (const line of participant.lines) delete line.prices['23'];
        }
      }
      h.serve(GOLDEN_URL, {
        status: 200,
        body: JSON.stringify(changed),
        headers: { etag: '"golden-2"' },
      });
      expect((await h.run('src-rundown')).status).toBe('ok');
      await reresolveMarketOdds(h.ctx);
      const { rows: events } = await h.pool.query<{ id: string }>(
        `SELECT id FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
        [h.team('Arsenal')],
      );
      const latest = await latestMarketOdds(h.ctx.db, {
        eventIds: [events[0]!.id],
        now: h.now(),
        maxAgeMs: 3 * HOUR,
      });
      expect(new Set(latest.map((r) => r.bookmaker))).toEqual(new Set(['19']));
    },
    TEST_TIMEOUT,
  );

  it(
    'old price rows are pruned after the retention period',
    async () => {
      expect(await pruneOldMarketOdds(h.ctx)).toBe(0);
      h.advance(8 * 24 * HOUR);
      expect(await pruneOldMarketOdds(h.ctx)).toBeGreaterThan(0);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_market_odds`)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
