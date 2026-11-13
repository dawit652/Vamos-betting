import { FACTORY_MARKETS, type FactoryMarket } from '@vamos/core';
import {
  finishRun,
  setCompetitionPolicy,
  setSourceEnabled,
  startRun,
  upsertMarketOdds,
  upsertSource,
} from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScraperContext } from '../src/context';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  KICKOFF,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
  type HarnessOptions,
} from './helpers';

/**
 * Plan task 2.3 (SCRAPER_FACTORY_MARKETS): market-priced events carry the market factory's football
 * markets, priced from the same fitted goals; rule O6 leaves out the half-time ones; a stored factory
 * market that is no longer priced is suspended by the feed and reopened when priced again.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const actor = { system: 'test' };
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

const keyOf = (m: FactoryMarket) => (m.line === null ? m.type : `${m.type}:${m.line}`);
const TODAYS_TYPES = new Set(['1x2', 'dc', 'ou', 'ah', 'eh', 'btts', 'dnb', 'cs', 'ht_1x2']);
const FACTORY = FACTORY_MARKETS.filter((m) => !TODAYS_TYPES.has(m.type));

/** The context with the switch set (the harness config is fixed at creation). */
const withFlag = (on: boolean): ScraperContext => ({
  ...h.ctx,
  config: {
    ...h.ctx.config,
    scraper: { ...h.ctx.config.scraper, factoryMarkets: on },
  },
});

async function marketPricedEvent(
  options: HarnessOptions = {},
  setup?: () => Promise<void>,
  /** The competition's own factoryMarkets flag (task 2.3 (e)). */
  competitionFlag = true,
): Promise<string> {
  h = await createHarness({ calibrated: true, ...options });
  await setup?.();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string }>(
    `SELECT id FROM events WHERE feed_provider = 'scraped'`,
  );
  const eventId = event!.id;
  await h.ctx.db.transaction((tx) =>
    setCompetitionPolicy(
      tx,
      h.premier,
      { pricingSource: 'market', factoryMarkets: competitionFlag },
      actor,
    ),
  );
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'feed-a',
        name: 'feed a',
        adapter: 'generic-json',
        upstream: 'feed-a',
        config: { allowedHosts: ['example.test'] },
      },
      actor,
    );
    await setSourceEnabled(tx, 'feed-a', true, actor);
  });
  await listEvent(eventId, 1);
  return eventId;
}

/** Two bookmakers' 1X2 and 2.5 line around the event's stored model prices, home scaled by `home`. */
async function listEvent(eventId: string, home: number): Promise<void> {
  const stored = async (key: string) => {
    const found = await rows<{ code: string; odds_milli: number }>(
      `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 AND m.key = $2`,
      [eventId, key],
    );
    return Object.fromEntries(found.map((r) => [r.code, r.odds_milli])) as Record<string, number>;
  };
  // The model's prices are the first stored ones; keep them as the books' base.
  const base = baseOf.get(eventId) ?? {
    x: await stored('1x2'),
    ou: await stored('ou:2.5'),
  };
  baseOf.set(eventId, base);
  const at = h.now();
  const run = await startRun(h.ctx.db, { sourceId: 'feed-a', startedAt: at });
  await finishRun(h.ctx.db, run.id, { status: 'ok', finishedAt: at });
  const common = {
    sourceKey: `match-${eventId}`,
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    priceUpdatedAt: at,
    observedAt: at,
    competitionId: h.premier,
    homeTeamId: h.team('Arsenal'),
    awayTeamId: h.team('Chelsea'),
    eventId,
  };
  const out = ['19', '23'].flatMap((bookmaker, i) => {
    const scale = i === 0 ? 1 : 1.03;
    const price = (n: number, f = 1) => Math.floor(n * scale * f);
    return [
      ...(['1', 'X', '2'] as const).map((selection) => ({
        ...common,
        market: '1x2' as const,
        line: null,
        selection,
        bookmaker,
        priceMilli: price(base.x[selection]!, selection === '1' ? home : 1),
      })),
      ...(['over', 'under'] as const).map((selection) => ({
        ...common,
        market: 'ou' as never,
        line: '2.5' as never,
        selection: selection as never,
        bookmaker,
        priceMilli: price(base.ou[selection]!),
      })),
    ];
  });
  await h.ctx.db.transaction((tx) =>
    upsertMarketOdds(tx, { sourceId: 'feed-a', runId: run.id, rawId: null, rows: out }),
  );
}
const baseOf = new Map<string, { x: Record<string, number>; ou: Record<string, number> }>();

const storedMarkets = (eventId: string) =>
  rows<{ key: string; type: string; status: string; suspended_by: string | null }>(
    `SELECT key, type, status, suspended_by FROM markets WHERE event_id = $1 ORDER BY key`,
    [eventId],
  );
const oddsOf = async (eventId: string, key: string) =>
  JSON.stringify(
    await rows(
      `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 AND m.key = $2 ORDER BY s.code`,
      [eventId, key],
    ),
  );
const stampKey = async (eventId: string) =>
  (
    await rows<{ ratings_key: string }>(
      `SELECT ratings_key FROM scrape_event_pricing WHERE event_id = $1`,
      [eventId],
    )
  )[0]!.ratings_key;
const factoryKeys = new Set(FACTORY.map(keyOf));

describe('factory markets on market-priced events', () => {
  it(
    "switch off (default): only today's markets and a pricing key without the suffix",
    async () => {
      const eventId = await marketPricedEvent();
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 1, failed: 0 });
      const stored = await storedMarkets(eventId);
      expect(stored.some((m) => factoryKeys.has(m.key))).toBe(false);
      expect(stored.length).toBeLessThan(100);
      const key = await stampKey(eventId);
      expect(key.startsWith('mkt1|')).toBe(true);
      expect(key).not.toContain('|fm1');
    },
    TEST_TIMEOUT,
  );

  it(
    'both are needed: global on with the competition flag off, or global off with the flag on, prices no factory market',
    async () => {
      // Global on, competition flag off.
      let eventId = await marketPricedEvent({ factoryMarkets: true }, undefined, false);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, failed: 0 });
      expect((await storedMarkets(eventId)).some((m) => factoryKeys.has(m.key))).toBe(false);
      expect(await stampKey(eventId)).not.toContain('|fm1');
      // The flag switched on prices them.
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { factoryMarkets: true }, actor),
      );
      await repriceScheduledEvents(h.ctx);
      expect((await storedMarkets(eventId)).some((m) => factoryKeys.has(m.key))).toBe(true);
      expect(await stampKey(eventId)).toMatch(/\|fm1$/);
      await h.close();

      // Global off, competition flag on.
      eventId = await marketPricedEvent({}, undefined, true);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, failed: 0 });
      expect((await storedMarkets(eventId)).some((m) => factoryKeys.has(m.key))).toBe(false);
      expect(await stampKey(eventId)).not.toContain('|fm1');
    },
    TEST_TIMEOUT,
  );

  it(
    "switch on: today's markets plus every factory market with all selections; today's prices unchanged",
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      // The same pass with the switch off, for the comparison.
      await repriceScheduledEvents(withFlag(false));
      const offOdds = [await oddsOf(eventId, '1x2'), await oddsOf(eventId, 'ou:2.5')];
      expect(await stampKey(eventId)).not.toContain('|fm1');

      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 1, failed: 0, held: 0 });
      expect(await stampKey(eventId)).toMatch(/\|fm1$/);
      const stored = await storedMarkets(eventId);
      expect(stored.length).toBeGreaterThan(100);
      const keys = new Set(stored.map((m) => m.key));
      for (const key of ['htft', 'multigoals:1-3', 'ft_1x2_btts']) expect(keys.has(key)).toBe(true);
      expect(await oddsOf(eventId, '1x2')).toBe(offOdds[0]);
      expect(await oddsOf(eventId, 'ou:2.5')).toBe(offOdds[1]);

      // Every stored factory market lists all its factory selections (no long-shot pruning).
      const selections = await rows<{ key: string; code: string }>(
        `SELECT m.key, s.code FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.event_id = $1`,
        [eventId],
      );
      const byKey = new Map<string, Set<string>>();
      for (const s of selections) byKey.set(s.key, (byKey.get(s.key) ?? new Set()).add(s.code));
      const present = FACTORY.filter((m) => keys.has(keyOf(m)));
      expect(present.length).toBeGreaterThan(100);
      for (const m of present) {
        expect([...byKey.get(keyOf(m))!].sort(), keyOf(m)).toEqual([...m.selections].sort());
      }
      expect(stored.filter((m) => factoryKeys.has(m.key)).every((m) => m.status === 'open')).toBe(
        true,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'O6: without a half-time source no half-time factory market is stored, full-time ones are',
    async () => {
      const eventId = await marketPricedEvent(
        { factoryMarkets: true, halfTimeMarkets: 'covered' },
        async () => {
          // No half-time source: src-a (openfootball, with half time) off, src-b full time only.
          await h.ctx.db.transaction(async (tx) => {
            await setSourceEnabled(tx, 'src-a', false, actor);
            await upsertSource(
              tx,
              {
                id: 'src-b',
                name: 'json api test',
                adapter: 'generic-json',
                upstream: 'example-api',
                config: {
                  allowedHosts: ['api.example.com'],
                  requests: [{ url: URL_B, purpose: 'both' }],
                  sport: 'football',
                  recordsPath: 'data.events[*]',
                  fields: {
                    home: 'h',
                    away: 'a',
                    competition: { path: 'league' },
                    kickoff: { path: 'kick', format: 'iso' },
                    externalRef: 'id',
                    status: {
                      path: 'st',
                      map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' },
                    },
                    score: { homePath: 'hs', awayPath: 'as' },
                  },
                  scoreBasis: 'regular_time',
                },
              },
              actor,
            );
            await setSourceEnabled(tx, 'src-b', true, actor);
            // A second full-time upstream so the fixture is confirmed (R2).
            await upsertSource(
              tx,
              {
                id: 'src-c',
                name: 'second json api',
                adapter: 'generic-json',
                upstream: 'other-api',
                config: {
                  allowedHosts: ['api.other.example'],
                  requests: [{ url: 'https://api.other.example/events', purpose: 'both' }],
                  sport: 'football',
                  recordsPath: 'data.events[*]',
                  fields: {
                    home: 'h',
                    away: 'a',
                    competition: { path: 'league' },
                    kickoff: { path: 'kick', format: 'iso' },
                    externalRef: 'id',
                    status: {
                      path: 'st',
                      map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' },
                    },
                    score: { homePath: 'hs', awayPath: 'as' },
                  },
                  scoreBasis: 'regular_time',
                },
              },
              actor,
            );
            await setSourceEnabled(tx, 'src-c', true, actor);
          });
          h.serve('https://api.other.example/events', jsonDoc([ARSENAL_CHELSEA_JSON]));
          await h.run('src-c');
        },
      );
      await repriceScheduledEvents(h.ctx);
      const stored = await storedMarkets(eventId);
      const halfBases = new Set(FACTORY.filter((m) => m.basis !== 'ft').map(keyOf));
      expect(stored.some((m) => halfBases.has(m.key) || m.type === 'ht_1x2')).toBe(false);
      const keys = new Set(stored.map((m) => m.key));
      expect(keys.has('htft')).toBe(false);
      expect(keys.has('h2_1x2')).toBe(false);
      expect(keys.has('multigoals:1-3')).toBe(true);
      expect(keys.has('ft_1x2_btts')).toBe(true);
      expect(stored.length).toBeGreaterThan(50);
    },
    TEST_TIMEOUT,
  );

  it(
    'switched off again the factory markets are suspended by the feed, and reopened when switched on',
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      await repriceScheduledEvents(h.ctx);
      const open = (await storedMarkets(eventId)).filter((m) => factoryKeys.has(m.key));
      expect(open.length).toBeGreaterThan(100);

      await repriceScheduledEvents(withFlag(false));
      const off = await storedMarkets(eventId);
      for (const m of off.filter((x) => factoryKeys.has(x.key))) {
        expect(m).toMatchObject({ status: 'suspended', suspended_by: 'feed' });
      }
      expect(off.filter((m) => !factoryKeys.has(m.key)).every((m) => m.status === 'open')).toBe(
        true,
      );
      expect(off.filter((m) => factoryKeys.has(m.key))).toHaveLength(open.length);

      await repriceScheduledEvents(h.ctx);
      const again = await storedMarkets(eventId);
      expect(again.every((m) => m.status === 'open' && m.suspended_by === null)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a consensus that moves within the bounds updates the factory prices without holding',
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      await repriceScheduledEvents(h.ctx);
      const before = await oddsOf(eventId, 'ft_1x2_btts');
      const beforeOpen = await oddsOf(eventId, '1x2');
      h.advance(60_000);
      await listEvent(eventId, 0.96);
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 1, repriced: 1, held: 0, failed: 0 });
      expect(await oddsOf(eventId, '1x2')).not.toBe(beforeOpen);
      expect(await oddsOf(eventId, 'ft_1x2_btts')).not.toBe(before);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE kind = 'odds_approval' AND subject_key LIKE '%|reprice'`,
        ),
      ).toBe(0);
      expect((await storedMarkets(eventId)).filter((m) => factoryKeys.has(m.key))).not.toHaveLength(
        0,
      );
    },
    TEST_TIMEOUT,
  );
});
