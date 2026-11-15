import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEFAULT_MARKET_FAMILIES, FACTORY_MARKETS, type FactoryMarket } from '@vamos/core';
import {
  finishRun,
  saveFamilyHistory,
  setCompetitionPolicy,
  setSetting,
  setSourceEnabled,
  startRun,
  upsertMarketOdds,
  upsertSource,
} from '@vamos/db';
import { betLegs, bets, users } from '@vamos/db/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScraperContext } from '../src/context';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { runMarketFamilyJob } from '../src/tasks/market-families';
import { runWeeklyReport, weeklyReportPaths } from '../src/tasks/weekly-report';
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

/** Plan task 2.5: margins per family from the settings, and the weekly family job. */
describe('market families', () => {
  const htftOdds = async (eventId: string) =>
    rows<{ code: string; odds_milli: number }>(
      `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 AND m.key = 'htft' ORDER BY s.code`,
      [eventId],
    );

  it(
    "a family's margin from the settings re-prices once, under a new key; today's prices unchanged",
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      await repriceScheduledEvents(h.ctx);
      expect(await stampKey(eventId)).toMatch(/\|fm1$/);
      const before = await htftOdds(eventId);
      const todays = await oddsOf(eventId, '1x2');

      await setSetting(h.ctx.db, 'market_families', {
        ...DEFAULT_MARKET_FAMILIES,
        typeMarginBps: { htft: 1500 },
      });
      h.advance(60_000);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, held: 0 });
      const key = await stampKey(eventId);
      expect(key).toMatch(/\|fm1\.[0-9a-f]{8}$/);
      const after = await htftOdds(eventId);
      expect(after.map((r) => r.code)).toEqual(before.map((r) => r.code));
      after.forEach((r, i) => expect(r.odds_milli).toBeLessThanOrEqual(before[i]!.odds_milli));
      expect(after.some((r, i) => r.odds_milli < before[i]!.odds_milli)).toBe(true);
      expect(await oddsOf(eventId, '1x2')).toBe(todays);

      // Once only: the next pass finds the prices current.
      h.advance(60_000);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 0 });
      expect(await stampKey(eventId)).toBe(key);
    },
    TEST_TIMEOUT,
  );

  it(
    "the first-half share (task A11) re-prices the families once; today's prices are unchanged",
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      await repriceScheduledEvents(h.ctx);
      const h2 = async () =>
        rows<{ code: string; odds_milli: number }>(
          `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
            WHERE m.event_id = $1 AND m.key = 'h2_ou:2.5' ORDER BY s.code`,
          [eventId],
        );
      const before = await h2();
      expect(before.map((r) => r.code)).toEqual(['over', 'under']);
      const todays = await oddsOf(eventId, '1x2');

      await setSetting(h.ctx.db, 'market_families', {
        ...DEFAULT_MARKET_FAMILIES,
        firstHalfShare: 0.447,
      });
      h.advance(60_000);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, held: 0 });
      expect(await stampKey(eventId)).toMatch(/\|fm1\.[0-9a-f]{8}$/);
      const after = await h2();
      // More goals in the second half: its over is shorter, its under longer.
      expect(after[0]!.odds_milli).toBeLessThan(before[0]!.odds_milli);
      expect(after[1]!.odds_milli).toBeGreaterThan(before[1]!.odds_milli);
      expect(await oddsOf(eventId, '1x2')).toBe(todays);
    },
    TEST_TIMEOUT,
  );

  it(
    'the weekly job suspends a family that kept too little for three weeks; the feed suspends its markets; the report lists it; a passed history test lets it return',
    async () => {
      const eventId = await marketPricedEvent({ factoryMarkets: true });
      await repriceScheduledEvents(h.ctx);
      await setSetting(h.ctx.db, 'market_families', {
        ...DEFAULT_MARKET_FAMILIES,
        minWeeklyStake: '1000',
      });
      // A lost week for the house in each of weeks 41 to 43 on htft singles (and one on a 1x2).
      const [selection] = await rows<{ id: string; market_id: string }>(
        `SELECT s.id, s.market_id FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = 'htft' AND s.code = '1/1'`,
        [eventId],
      );
      const [user] = await h.ctx.db
        .insert(users)
        .values({
          phone: '+251911000077',
          passwordHash: 'x',
          dateOfBirth: '1990-01-01',
          status: 'active',
          termsAcceptedAt: h.now(),
        })
        .returning({ id: users.id });
      const settledAt = ['2026-10-07', '2026-10-14', '2026-10-21'];
      for (const [i, day] of settledAt.entries()) {
        const at = new Date(`${day}T12:00:00Z`);
        const [bet] = await h.ctx.db
          .insert(bets)
          .values({
            userId: user!.id,
            shortId: `FAM00${i}`,
            betType: 'single',
            stake: 100_000n,
            totalOddsMilli: 3000n,
            potentialGrossPayout: 300_000n,
            potentialBonus: 0n,
            potentialTax: 0n,
            potentialNetPayout: 300_000n,
            status: 'won',
            oddsChangePolicy: 'none',
            idempotencyKey: randomUUID(),
            terms: { betRules: {}, multiBonus: {}, tax: {} },
            settledGrossPayout: 300_000n,
            settledTax: 0n,
            settledNetPayout: 300_000n,
            placedAt: at,
            settledAt: at,
          })
          .returning({ id: bets.id });
        await h.ctx.db.insert(betLegs).values({
          betId: bet!.id,
          position: 0,
          eventId,
          marketId: selection!.market_id,
          selectionId: selection!.id,
          oddsMilli: 3000,
          requestedOddsMilli: 3000,
          isLive: false,
          state: 'won',
        });
      }

      // 2026-10-29: week 43 ended on 26 October, more than 24 hours ago.
      const run = await runMarketFamilyJob(h.ctx);
      expect(run).toMatchObject({ ran: true, week: '2026-W43' });
      expect(run.moves.map((m) => [m.family, m.move])).toEqual([['htft', 'suspend']]);
      expect(run.moves[0]!.next).toEqual({
        status: 'suspended',
        sinceWeek: '2026-W43',
        raisedMarginBps: 1400,
      });
      expect((await runMarketFamilyJob(h.ctx)).ran).toBe(false);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.market_family.moved' AND target_id = 'htft'`,
        ),
      ).toBe(1);

      h.advance(60_000);
      await repriceScheduledEvents(h.ctx);
      expect(await stampKey(eventId)).toMatch(/\|fm1\.[0-9a-f]{8}$/);
      const stored = await storedMarkets(eventId);
      expect(stored.find((m) => m.key === 'htft')).toMatchObject({
        status: 'suspended',
        suspended_by: 'feed',
      });
      expect(stored.find((m) => m.key === 'multigoals:1-3')?.status).toBe('open');
      expect(stored.find((m) => m.key === '1x2')?.status).toBe('open');

      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: true, week: '2026-W43' });
      const paths = weeklyReportPaths(h.ctx.config.scraper.archiveDir, '2026-W43');
      const md = readFileSync(paths.md, 'utf8');
      expect(md).toContain('## Market family moves');
      expect(md).toMatch(/\| htft \| suspended \| 1200 bps \| 1400 bps \|/);
      const json = JSON.parse(readFileSync(paths.json, 'utf8')) as {
        familyMoves: Array<{ family: string; move: string }>;
      };
      expect(json.familyMoves).toEqual([
        expect.objectContaining({ family: 'htft', move: 'suspend' }),
      ]);

      // Task A2: it returns at 1400 bps only once a stored history test passes at that margin.
      const verdict = (suggestedMarginBps: number) => ({
        family: 'htft',
        matches: 1000,
        selections: 5000,
        marginBps: 1200,
        holdBps: 500,
        suggestedMarginBps,
        worst: null,
        passed: suggestedMarginBps <= 1200,
      });
      const store = (suggested: number) =>
        h.ctx.db.transaction((tx) =>
          saveFamilyHistory(
            tx,
            { testedAt: h.now(), matches: 1000, files: ['E0.csv'], families: [verdict(suggested)] },
            { system: 'test' },
          ),
        );
      await store(1600);
      h.at(new Date('2026-11-03T00:00:00Z'));
      expect(await runMarketFamilyJob(h.ctx)).toEqual({ ran: true, week: '2026-W44', moves: [] });
      expect(
        (
          await rows<{ status: string }>(
            `SELECT status FROM market_family_state WHERE family = 'htft'`,
          )
        )[0]?.status,
      ).toBe('suspended');

      await store(1400);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.market_family_history.written'`,
        ),
      ).toBe(2);
      h.at(new Date('2026-11-10T00:00:00Z'));
      const returned = await runMarketFamilyJob(h.ctx);
      expect(returned.moves.map((m) => [m.family, m.move])).toEqual([['htft', 'return']]);
      expect(returned.moves[0]!.next).toEqual({
        status: 'active',
        sinceWeek: '2026-W45',
        raisedMarginBps: 1400,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'the job waits 24 hours after the week, and moves nothing without stakes',
    async () => {
      h = await createHarness({});
      h.at(new Date('2026-11-09T12:00:00Z'));
      expect(await runMarketFamilyJob(h.ctx)).toEqual({ ran: false, week: '2026-W45', moves: [] });
      h.at(new Date('2026-11-10T00:00:00Z'));
      expect(await runMarketFamilyJob(h.ctx)).toEqual({ ran: true, week: '2026-W45', moves: [] });
      expect(await h.count(`SELECT count(*) AS n FROM market_family_state`)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
