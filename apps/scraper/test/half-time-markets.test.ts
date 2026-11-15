import { listScrapedEvents, setSourceEnabled, setTeamRatings, upsertSource } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { coveredCompetitions, halfTimeCheck } from '../src/pipeline/half-time';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
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
  type JsonEvent,
} from './helpers';

/**
 * Rule O6 (S-2 of docs/feed-quality-plan.md): with SCRAPER_HALF_TIME_MARKETS=covered, a
 * competition without a half-time source gets no half-time market, so two full-time upstreams
 * apply its results (R2); a competition with one keeps them and its results still need the half
 * time; an event that already has a half-time market keeps it.
 *
 * Sources: src-a openfootball (full time and half time, Premier League by its config), and two
 * generic-json sources of two upstreams that give the full time only (src-b, src-c).
 */

const URL_C = 'https://api.other.example/events';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const ftOnly = (url: string) => ({
  allowedHosts: [new URL(url).host],
  requests: [{ url, purpose: 'both' }],
  sport: 'football',
  recordsPath: 'data.events[*]',
  fields: {
    home: 'h',
    away: 'a',
    competition: { path: 'league' },
    kickoff: { path: 'kick', format: 'iso' },
    externalRef: 'id',
    status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
    // No htHomePath / htAwayPath: a full-time-only upstream.
    score: { homePath: 'hs', awayPath: 'as' },
  },
  scoreBasis: 'regular_time',
});

/** The harness with src-b made full-time only and src-c added (both enabled); src-a as asked. */
async function harness(options: { htSource: boolean }): Promise<Harness> {
  const made = await createHarness({ halfTimeMarkets: 'covered' });
  await made.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'src-b',
        name: 'json api test',
        adapter: 'generic-json',
        upstream: 'example-api',
        config: ftOnly(URL_B),
      },
      actor,
    );
    await upsertSource(
      tx,
      {
        id: 'src-c',
        name: 'second json api',
        adapter: 'generic-json',
        upstream: 'other-api',
        config: ftOnly(URL_C),
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-c', true, actor);
    if (!options.htSource) await setSourceEnabled(tx, 'src-a', false, actor);
  });
  return made;
}

const finishedFt = (ft: [number, number]): JsonEvent => ({
  ...ARSENAL_CHELSEA_JSON,
  st: 'FT',
  hs: String(ft[0]),
  as: String(ft[1]),
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

async function theEvent(): Promise<{ id: string; feedRef: string }> {
  const [event] = await rows<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped'`,
  );
  return { id: event!.id, feedRef: event!.feed_ref };
}

const marketTypes = async (eventId: string): Promise<string[]> =>
  (await rows<{ type: string }>(`SELECT DISTINCT type FROM markets WHERE event_id = $1`, [eventId]))
    .map((r) => r.type)
    .sort();

const needsHalfTime = async (eventId: string): Promise<boolean> => {
  const listed = await listScrapedEvents(h.ctx.db, {
    from: new Date(KICKOFF.getTime() - HOUR),
    to: new Date(KICKOFF.getTime() + HOUR),
    includeFinished: true,
  });
  return listed.find((e) => e.eventId === eventId)!.needsHalfTimeScore;
};

const runAll = async (ids: string[]) => {
  for (const id of ids) expect((await h.run(id)).status).toBe('ok');
};

describe('O6: a competition without a half-time source', () => {
  it(
    'creates its events without half-time markets, and two full-time upstreams apply the result (R2)',
    async () => {
      h = await harness({ htSource: false });
      expect((await halfTimeCheck(h.ctx))(h.premier)).toBe(false);

      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      h.serve(URL_C, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await runAll(['src-b', 'src-c']);
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      const event = await theEvent();
      const types = await marketTypes(event.id);
      expect(types).not.toContain('ht_1x2');
      // Every other market is there.
      for (const type of ['1x2', 'dc', 'ou', 'ah', 'eh', 'btts', 'dnb', 'cs']) {
        expect(types).toContain(type);
      }
      expect(await needsHalfTime(event.id)).toBe(false);
      const [created] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.created'`,
      );
      expect(created!.metadata).toMatchObject({ halfTimeMarkets: 'omitted (O6)' });
      // The trader's item shows the same prices (no half-time market).
      const [item] = await rows<{ payload: { markets: { market: string }[] } }>(
        `SELECT payload FROM scrape_review_items WHERE kind = 'odds_approval'`,
      );
      const shown = item!.payload.markets.map((m) => m.market);
      expect(shown).toContain('1x2');
      expect(shown).not.toContain('ht_1x2');

      // A re-price keeps the market set: nothing added, nothing held.
      await h.ctx.db.transaction((tx) =>
        setTeamRatings(tx, h.team('Arsenal'), { attack: 1.26, defence: 0.9, matches: 11 }, actor),
      );
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, held: 0 });
      expect(await marketTypes(event.id)).toEqual(types);

      // Two full-time upstreams, no half time anywhere: applied after the confirmation time.
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_B, jsonDoc([finishedFt([2, 1])]));
      h.serve(URL_C, jsonDoc([finishedFt([2, 1])]));
      await runAll(['src-b', 'src-c']);
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      h.advance(16 * MINUTE);
      await runAll(['src-b', 'src-c']);
      expect((await promoteResults(h.ctx)).applied).toBe(1);

      const [resulted] = await rows<Record<string, unknown>>(
        `SELECT status, score_home, score_away, ht_score_home, ht_score_away FROM events WHERE id = $1`,
        [event.id],
      );
      expect(resulted).toMatchObject({
        status: 'finished',
        score_home: 2,
        score_away: 1,
        ht_score_home: null,
        ht_score_away: null,
      });
      expect(
        await h.count(
          `SELECT count(*) AS n FROM markets WHERE event_id = $1 AND status NOT IN ('settled', 'void')`,
          [event.id],
        ),
      ).toBe(0);
      const [applied] = await rows<{ metadata: { upstreams: string[] } }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.applied' AND actor_id = 'system:scraper'`,
      );
      expect(applied!.metadata.upstreams).toEqual(['example-api', 'other-api']);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE kind LIKE 'result_%' AND status = 'open'`,
        ),
      ).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'the setting `all` (the default) keeps every market, as before',
    async () => {
      h = await harness({ htSource: false });
      const all = {
        ...h.ctx,
        config: { ...h.ctx.config, scraper: { ...h.ctx.config.scraper, halfTimeMarkets: 'all' } },
      } as typeof h.ctx;
      expect((await halfTimeCheck(all))(h.premier)).toBe(true);
      expect((await coveredCompetitions(h.ctx.db))(h.premier)).toBe(false);

      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      h.serve(URL_C, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await runAll(['src-b', 'src-c']);
      expect((await promoteFixtures(all)).created).toBe(1);
      const event = await theEvent();
      expect(await marketTypes(event.id)).toContain('ht_1x2');
      expect(await needsHalfTime(event.id)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('O6: a competition with a half-time source', () => {
  it(
    'still gets the half-time markets, and its result still waits for the half time',
    async () => {
      h = await harness({ htSource: true });
      expect((await halfTimeCheck(h.ctx))(h.premier)).toBe(true);

      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      h.serve(URL_C, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await runAll(['src-a', 'src-b', 'src-c']);
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      const event = await theEvent();
      expect(await marketTypes(event.id)).toContain('ht_1x2');
      expect(await needsHalfTime(event.id)).toBe(true);
      const [created] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.created'`,
      );
      expect(created!.metadata).not.toHaveProperty('halfTimeMarkets');

      // Three full-time upstreams agree, none gives the half time: not applied.
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, score: { ft: [2, 1] } }]));
      h.serve(URL_B, jsonDoc([finishedFt([2, 1])]));
      h.serve(URL_C, jsonDoc([finishedFt([2, 1])]));
      await runAll(['src-a', 'src-b', 'src-c']);
      h.advance(16 * MINUTE);
      await runAll(['src-a', 'src-b', 'src-c']);
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE id = $1 AND resulted_at IS NULL`, [
          event.id,
        ]),
      ).toBe(1);

      // The half-time source gives it: applied once stable, with the half time.
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, score: { ht: [1, 0], ft: [2, 1] } }]));
      await runAll(['src-a', 'src-b', 'src-c']);
      h.advance(16 * MINUTE);
      await runAll(['src-a', 'src-b', 'src-c']);
      expect((await promoteResults(h.ctx)).applied).toBe(1);
      const [resulted] = await rows<Record<string, unknown>>(
        `SELECT score_home, score_away, ht_score_home, ht_score_away FROM events WHERE id = $1`,
        [event.id],
      );
      expect(resulted).toMatchObject({
        score_home: 2,
        score_away: 1,
        ht_score_home: 1,
        ht_score_away: 0,
      });
    },
    TEST_TIMEOUT,
  );
});

describe('O6: an event that already has half-time markets', () => {
  it(
    'keeps them when its competition loses its half-time source: re-priced, never removed, still needs the half time',
    async () => {
      h = await harness({ htSource: true });
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await runAll(['src-a', 'src-b']);
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      const event = await theEvent();
      const types = await marketTypes(event.id);
      expect(types).toContain('ht_1x2');
      const htOdds = async () =>
        (
          await rows<{ code: string; odds_milli: number }>(
            `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
              WHERE m.event_id = $1 AND m.type = 'ht_1x2' ORDER BY s.code`,
            [event.id],
          )
        ).map((r) => `${r.code}:${r.odds_milli}`);
      const before = await htOdds();

      // The half-time source is switched off: the competition is no longer covered.
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-a', false, actor));
      expect((await halfTimeCheck(h.ctx))(h.premier)).toBe(false);

      // priceEvent keeps the half-time market of this event, and leaves it out of a new one's.
      const input = {
        competitionPricingSource: 'model' as const,
        homeRatings: { attack: 1.2, defence: 0.9, matches: 10 },
        awayRatings: { attack: 1.2, defence: 0.9, matches: 10 },
        minRatingMatches: 8,
        now: h.now(),
        halfTimeMarkets: false,
      };
      const existing = await priceEvent(h.ctx.db, { ...input, eventId: event.id });
      expect(existing.markets.map((m) => m.type)).toContain('ht_1x2');
      expect(existing.halfTimeOmitted).toBeUndefined();
      const fresh = await priceEvent(h.ctx.db, { ...input, eventId: null });
      expect(fresh.markets.map((m) => m.type)).not.toContain('ht_1x2');
      expect(fresh).toMatchObject({ halfTimeOmitted: true, pricesSane: true });
      expect(fresh.markets).toEqual(existing.markets.filter((m) => m.type !== 'ht_1x2'));

      // A re-price applies inside the bounds, half-time market included; nothing is held.
      await h.ctx.db.transaction((tx) =>
        setTeamRatings(tx, h.team('Arsenal'), { attack: 1.26, defence: 0.9, matches: 11 }, actor),
      );
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        repriced: 1,
        held: 0,
        suspended: 0,
      });
      expect(await marketTypes(event.id)).toEqual(types);
      expect(await htOdds()).not.toEqual(before);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM markets WHERE event_id = $1 AND type = 'ht_1x2' AND status = 'open'`,
          [event.id],
        ),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE subject_key LIKE '%|reprice'`,
        ),
      ).toBe(0);
      expect(await needsHalfTime(event.id)).toBe(true);

      // Two full-time upstreams do not apply its result without a half time (a person settles it).
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_B, jsonDoc([finishedFt([2, 1])]));
      h.serve(URL_C, jsonDoc([finishedFt([2, 1])]));
      await runAll(['src-b', 'src-c']);
      h.advance(16 * MINUTE);
      await runAll(['src-b', 'src-c']);
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE id = $1 AND resulted_at IS NULL`, [
          event.id,
        ]),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );
});
