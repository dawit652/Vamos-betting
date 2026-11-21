import { BOARD_KEY_MARKER, isBoardPricedKey } from '@vamos/core';
import { latestBoardOdds, setBoardPricing, setNarobetEvents, upsertBoardOdds } from '@vamos/db';
import { priceBoardMarket } from '@vamos/feed';
import {
  apiFootballFixturesByIdsUrl,
  MRZ_MATCHES_PATH,
  narobetPricesMaxAgeMs,
} from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { sweepNarobetEvents } from '../src/pipeline/board-events';
import { runNarobetResults } from '../src/tasks/board-results';
import { readNarobetBoard } from '../src/tasks/narobet';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
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
 * Narobet's odds through the owner's mr-z service (docs/plans/narobet-feed.md): mr-z's upcoming
 * football matches are read and linked to our events by their teams, as board `narobet`. A match
 * without markets yet, or listed past its kickoff, is not stored; one whose names do not resolve is
 * stored unlinked. Everything is SYNTHETIC.
 */

const MRZ = 'http://mrz.test:3200';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

async function createdEvent(): Promise<string> {
  h = await createHarness({ narobetUrl: MRZ });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string }>(
    `SELECT id FROM events WHERE feed_provider = 'scraped'`,
  );
  return event!.id;
}

/** One match as mr-z serves it. */
function mrzMatch(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cm-ars-che',
    api_id: 1001,
    league_api_id: 39,
    sport: 'football',
    country: 'England',
    league: 'Premier League',
    hom: 'Arsenal',
    awy: 'Chelsea',
    schedule: KICKOFF.toISOString(),
    status: 'SCHEDULED',
    detail_at: new Date(h.now().getTime() - 2 * MINUTE).toISOString(),
    past_kickoff: false,
    markets: {
      '1X2': { HOME: 1.9, DRAW: 3.5, AWAY: 4.1 },
      OVER_UNDER: { 'OVER_2.5': 1.85, 'UNDER_2.5': 1.95 },
      BTTS: { YES: 1.72, NO: 2.02 },
    },
    ...overrides,
  };
}

function serveMrz(list: unknown) {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

describe('Narobet odds from mr-z', () => {
  it(
    'stores the upcoming matches with markets as board narobet, linked to our event by its teams',
    async () => {
      const eventId = await createdEvent();
      const { fetchImpl, seen } = serveMrz([
        mrzMatch({}),
        mrzMatch({ id: 'cm-unknown', hom: 'Nobody United', awy: 'Nowhere Town' }),
        mrzMatch({ id: 'cm-past', past_kickoff: true }),
        mrzMatch({ id: 'cm-undetailed', detail_at: null }),
        { id: 'broken' },
      ]);

      const summary = await readNarobetBoard(h.ctx, fetchImpl);
      expect(seen).toEqual([`${MRZ}${MRZ_MATCHES_PATH}`]);
      expect(summary).toEqual({
        matches: 2,
        linked: 1,
        unresolved: 1,
        skipped: 2,
        rejected: 1,
        boardEvents: { created: 0, updated: 0, skipped: 0, unchanged: 0, deferred: 0 },
      });

      const narobet = await latestBoardOdds(h.ctx.db, {
        eventId,
        now: h.now(),
        maxAgeMs: 30 * MINUTE,
        board: 'narobet',
      });
      expect(narobet?.sourceKey).toBe('narobet:cm-ars-che');
      expect(narobet?.markets.map((m) => `${m.type}:${m.line ?? ''}`)).toEqual([
        '1x2:',
        'btts:',
        'ou:2.5',
      ]);
      // Not a Hulusport row: the Hulusport board of the event stays empty.
      expect(
        await latestBoardOdds(h.ctx.db, { eventId, now: h.now(), maxAgeMs: 30 * MINUTE }),
      ).toBeNull();
      const stored = await rows<{ source_key: string; board: string; event_id: string | null }>(
        `SELECT source_key, board, event_id FROM scrape_board_odds ORDER BY source_key`,
      );
      expect(stored).toEqual([
        { source_key: 'narobet:cm-ars-che', board: 'narobet', event_id: eventId },
        { source_key: 'narobet:cm-unknown', board: 'narobet', event_id: null },
      ]);
      // Reading creates no event while the switch narobet_events is off (the default).
      expect(await h.count(`SELECT count(*) AS n FROM events`)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a failed read throws and stores nothing',
    async () => {
      await createdEvent();
      await expect(
        readNarobetBoard(h.ctx, async () => new Response('boom', { status: 503 })),
      ).rejects.toThrow('mr-z matches: HTTP 503');
      await expect(
        readNarobetBoard(h.ctx, async () => new Response(JSON.stringify({ error: 'x' }))),
      ).rejects.toThrow('not a list of matches');
      expect(await h.count(`SELECT count(*) AS n FROM scrape_board_odds`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'prices: Narobet over the markets we price while its switch is on and its prices fresh; Hulusport first',
    async () => {
      const eventId = await createdEvent();
      const { fetchImpl } = serveMrz([mrzMatch({})]);
      await readNarobetBoard(h.ctx, fetchImpl);
      const narobet = await latestBoardOdds(h.ctx.db, {
        eventId,
        now: h.now(),
        maxAgeMs: 30 * MINUTE,
        board: 'narobet',
      });
      const calibrated = { attack: 1.1, defence: 0.95, matches: 12 };
      const input = {
        competitionPricingSource: 'model' as const,
        eventId,
        homeRatings: calibrated,
        awayRatings: { ...calibrated, attack: 0.9 },
        minRatingMatches: 1,
        now: h.now(),
      };
      const switchTo = (board: 'hulusport' | 'narobet', enabled: boolean) =>
        h.ctx.db.transaction((tx) => setBoardPricing(tx, board, enabled, actor));

      // Off (the default): our own prices.
      const off = await priceEvent(h.ctx.db, input);
      expect(off.board).toBeUndefined();

      // On: the 1X2 and the 2.5 line take Narobet's prices with our margin; BTTS too where we price
      // it; nothing is added.
      await switchTo('narobet', true);
      const on = await priceEvent(h.ctx.db, input);
      expect(on.board?.name).toBe('narobet');
      expect(on.key.startsWith(off.key)).toBe(true);
      expect(on.key).toContain(BOARD_KEY_MARKER);
      expect(isBoardPricedKey(on.key)).toBe(false);
      expect(on.markets.map((m) => `${m.type}:${m.line ?? ''}`)).toEqual(
        off.markets.map((m) => `${m.type}:${m.line ?? ''}`),
      );
      const expected = priceBoardMarket(narobet!.markets.find((m) => m.type === '1x2') as never)!;
      expect(on.markets.find((m) => m.type === '1x2')!.selections).toEqual(expected.selections);

      // Teams not calibrated: Narobet never prices a whole match (rule O1h is Hulusport's only).
      const uncalibrated = await priceEvent(h.ctx.db, {
        ...input,
        homeRatings: null,
        awayRatings: null,
      });
      expect(isBoardPricedKey(uncalibrated.key)).toBe(false);
      expect(uncalibrated).toMatchObject({ source: 'model', backsOpening: false });

      // Hulusport first: with both switches on and a fresh Hulusport row, Hulusport's prices win.
      await h.ctx.db.transaction((tx) =>
        upsertBoardOdds(tx, [
          {
            sourceKey: 'hulusport:77',
            board: 'hulusport',
            competitionRaw: 'England - Premier League',
            homeRaw: 'Arsenal',
            awayRaw: 'Chelsea',
            kickoff: KICKOFF,
            homeTeamId: null,
            awayTeamId: null,
            eventId,
            markets: [
              {
                type: '1x2',
                line: null,
                prices: [
                  { code: '1', priceMilli: 2100 },
                  { code: 'X', priceMilli: 3300 },
                  { code: '2', priceMilli: 3700 },
                ],
              },
            ],
            pricesAt: h.now(),
            observedAt: h.now(),
          },
        ]),
      );
      await switchTo('hulusport', true);
      expect((await priceEvent(h.ctx.db, input)).board?.name).toBe('hulusport');
      await switchTo('hulusport', false);
      expect((await priceEvent(h.ctx.db, input)).board?.name).toBe('narobet');

      // Too old for the time left to the kickoff (mr-z's re-read pace): our own prices again.
      const limit = narobetPricesMaxAgeMs(KICKOFF, h.now());
      await h.pool.query(`UPDATE scrape_board_odds SET prices_at = $1 WHERE board = 'narobet'`, [
        new Date(h.now().getTime() - limit - MINUTE),
      ]);
      const stale = await priceEvent(h.ctx.db, input);
      expect(stale.board).toBeUndefined();
      expect(stale.key).toBe(off.key);
    },
    TEST_TIMEOUT,
  );
});

/**
 * Narobet-only matches (docs/plans/narobet-events.md): while the switch `narobet_events` is on, a
 * Narobet match in a league Nahubet does not list becomes an event of its own (feed provider
 * `narobet`), never in our league or with our team, never a club friendly, never without
 * API-Football's ids, never twice. Everything is SYNTHETIC.
 */
describe('Narobet-only matches', () => {
  const on = (change: { enabled?: boolean; horizonDays?: number } = { enabled: true }) =>
    h.ctx.db.transaction((tx) => setNarobetEvents(tx, change, actor));

  /** A match of a league Nahubet does not list, between two clubs it does not know. */
  const foreign = (overrides: Record<string, unknown> = {}) =>
    mrzMatch({
      id: 'cm-nb-1',
      api_id: 5001,
      league_api_id: 363,
      country: 'Ethiopia',
      league: 'Premier League',
      hom: 'Testland Rovers',
      awy: 'Mockville Athletic',
      ...overrides,
    });

  const narobetEvents = () =>
    rows<{ feed_ref: string; competition: string; category: string; home: string; away: string }>(
      `SELECT e.feed_ref, c.name->>'en' AS competition, cat.name->>'en' AS category,
              th.name->>'en' AS home, ta.name->>'en' AS away
         FROM events e JOIN competitions c ON c.id = e.competition_id
         JOIN categories cat ON cat.id = c.category_id
         JOIN teams th ON th.id = e.home_team_id JOIN teams ta ON ta.id = e.away_team_id
        WHERE e.feed_provider = 'narobet' ORDER BY e.feed_ref`,
    );

  it(
    'lists a match of a league we do not list, and only such matches',
    async () => {
      await createdEvent();
      await on();
      const { fetchImpl } = serveMrz([
        mrzMatch({}), // ours: links to our event, so league 39 is ours
        mrzMatch({ id: 'cm-39-other', api_id: 1002, hom: 'Nobody United', awy: 'Nowhere Town' }),
        foreign(),
        foreign({
          id: 'cm-friendly',
          api_id: 5002,
          league_api_id: 667,
          league: 'Friendlies Clubs',
        }),
        foreign({ id: 'cm-no-ids', api_id: null, hom: 'Fakeburg United', awy: 'Dummyton City' }),
        foreign({ id: 'cm-twice-a', api_id: 5003, hom: 'Sampleton FC', awy: 'Placeholder Town' }),
        foreign({ id: 'cm-twice-b', api_id: 5003, hom: 'Sampleton FC', awy: 'Placeholder Town' }),
      ]);

      const summary = await readNarobetBoard(h.ctx, fetchImpl);
      expect(summary.boardEvents).toEqual({
        created: 1,
        updated: 0,
        skipped: 5,
        unchanged: 0,
        deferred: 0,
      });
      expect(await narobetEvents()).toEqual([
        {
          feed_ref: 'cm-nb-1',
          // Our catalogue already has a "Premier League": the country is added.
          competition: 'Premier League (Ethiopia)',
          category: 'Ethiopia',
          home: 'Testland Rovers',
          away: 'Mockville Athletic',
        },
      ]);
      const [event] = await rows<{ id: string; betting_open: boolean }>(
        `SELECT id, betting_open FROM events WHERE feed_provider = 'narobet'`,
      );
      const open = await h.count(
        `SELECT count(*) AS n FROM markets WHERE event_id = '${event!.id}' AND status = 'open'`,
      );
      expect(open).toBeGreaterThan(0);
      // The fixture id is kept with the board row (results are looked up by it).
      const [row] = await rows<{ fixture_id: number }>(
        `SELECT fixture_id FROM scrape_board_odds WHERE source_key = 'narobet:cm-nb-1'`,
      );
      expect(row?.fixture_id).toBe(5001);
    },
    TEST_TIMEOUT,
  );

  it(
    're-prices only what mr-z re-read, never lists one match twice, and keeps to the horizon',
    async () => {
      await createdEvent();
      await on();
      const first = serveMrz([foreign()]);
      expect((await readNarobetBoard(h.ctx, first.fetchImpl)).boardEvents.created).toBe(1);

      // The same read again: mr-z has not re-read the match, so its event is left alone.
      h.advance(5 * MINUTE);
      const again = await readNarobetBoard(h.ctx, first.fetchImpl);
      expect(again.boardEvents).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

      // mr-z re-read it: re-priced. A second listing of the same two clubs is not listed.
      const reread = serveMrz([
        foreign({ detail_at: new Date(h.now().getTime() - MINUTE).toISOString() }),
        foreign({ id: 'cm-nb-copy', api_id: 5009 }),
      ]);
      const third = await readNarobetBoard(h.ctx, reread.fetchImpl);
      expect(third.boardEvents).toMatchObject({ created: 0, updated: 1, skipped: 1 });
      expect((await narobetEvents()).map((e) => e.feed_ref)).toEqual(['cm-nb-1']);

      // A horizon of one day: a match four days out is not listed.
      await on({ horizonDays: 1 });
      const far = serveMrz([foreign({ id: 'cm-nb-far', api_id: 5010, hom: 'Faraway Wanderers' })]);
      expect((await readNarobetBoard(h.ctx, far.fetchImpl)).boardEvents.created).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'switched off: nothing new, and the sweep suspends what was listed',
    async () => {
      await createdEvent();
      await on();
      const { fetchImpl } = serveMrz([foreign()]);
      await readNarobetBoard(h.ctx, fetchImpl);
      await on({ enabled: false });
      expect(await sweepNarobetEvents(h.ctx, h.now())).toBe(1);
      const open = await h.count(
        `SELECT count(*) AS n FROM markets m JOIN events e ON e.id = m.event_id
          WHERE e.feed_provider = 'narobet' AND m.status = 'open'`,
      );
      expect(open).toBe(0);
      const later = serveMrz([foreign({ id: 'cm-nb-2', api_id: 5020, hom: 'Lateville Rangers' })]);
      expect((await readNarobetBoard(h.ctx, later.fetchImpl)).boardEvents.created).toBe(0);

      // Back on: the suspended event re-opens on the next read, although mr-z did not re-read it.
      await on({ enabled: true });
      const back = await readNarobetBoard(h.ctx, fetchImpl);
      expect(back.boardEvents).toMatchObject({ updated: 1 });
    },
    TEST_TIMEOUT,
  );
});

/**
 * Results of Narobet-only matches (docs/plans/narobet-events.md): looked up at API-Football by the
 * fixture id mr-z gave, settled once the score has stood for 15 minutes; left to a person when mr-z
 * confirmed another 90-minute score, or when the match started before our betting closed.
 */
describe('Narobet-only results', () => {
  const KEY = 'test-api-football-key';
  const fixture = (id: number, date: Date, status = 'FT') => ({
    fixture: { id, date: date.toISOString(), status: { short: status } },
    league: { name: 'Premier League', country: 'Ethiopia' },
    teams: { home: { name: 'Testland Rovers' }, away: { name: 'Mockville Athletic' } },
    goals: { home: 2, away: 1 },
    score: { halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 1 } },
  });

  async function listed(matches: Array<Record<string, unknown>>) {
    h = await createHarness({ narobetUrl: MRZ, secrets: { SCRAPER_SECRET_API_FOOTBALL: KEY } });
    await h.ctx.db.transaction((tx) => setNarobetEvents(tx, { enabled: true }, actor));
    const { fetchImpl } = serveMrz(matches);
    expect((await readNarobetBoard(h.ctx, fetchImpl)).boardEvents.created).toBe(matches.length);
  }

  const match = (id: string, apiId: number, home: string, away: string) =>
    mrzMatch({ id, api_id: apiId, league_api_id: 363, country: 'Ethiopia', hom: home, awy: away });

  it(
    'settles by fixture id after 15 minutes; holds a score mr-z confirmed differently',
    async () => {
      await listed([
        match('cm-r1', 7001, 'Testland Rovers', 'Mockville Athletic'),
        match('cm-r2', 7002, 'Fakeburg United', 'Dummyton City'),
      ]);
      h.serve(
        apiFootballFixturesByIdsUrl([7001, 7002]),
        JSON.stringify({ errors: [], response: [fixture(7001, KICKOFF), fixture(7002, KICKOFF)] }),
      );
      // mr-z agrees on the first match and confirmed 1-1 for the second.
      const mrz = async () =>
        new Map([
          [7001, { status: 'FT', home: 2, away: 1, confirmed: true }],
          [7002, { status: 'FT', home: 1, away: 1, confirmed: true }],
        ]);
      h.at(new Date(KICKOFF.getTime() + 2 * 3_600_000 + MINUTE));
      expect(await runNarobetResults(h.ctx, mrz)).toMatchObject({
        pending: 2,
        matched: 2,
        confirming: 1,
        applied: 0,
        held: 1,
      });
      expect(h.requests.at(-1)?.headers['x-apisports-key']).toBe(KEY);

      h.advance(16 * MINUTE);
      expect(await runNarobetResults(h.ctx, mrz)).toMatchObject({ applied: 1, held: 1 });
      const settled = await rows<{ feed_ref: string; status: string }>(
        `SELECT feed_ref, status FROM events WHERE feed_provider = 'narobet' ORDER BY feed_ref`,
      );
      expect(settled).toEqual([
        { feed_ref: 'cm-r1', status: 'finished' },
        { feed_ref: 'cm-r2', status: 'scheduled' },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves a match that started before our betting closed to a person',
    async () => {
      await listed([match('cm-r3', 7003, 'Sampleton FC', 'Placeholder Town')]);
      // API-Football: it kicked off an hour before the time we showed.
      h.serve(
        apiFootballFixturesByIdsUrl([7003]),
        JSON.stringify({
          errors: [],
          response: [fixture(7003, new Date(KICKOFF.getTime() - 3_600_000))],
        }),
      );
      h.at(new Date(KICKOFF.getTime() + 2 * 3_600_000 + MINUTE));
      expect(await runNarobetResults(h.ctx, async () => null)).toMatchObject({
        matched: 1,
        held: 1,
        confirming: 0,
      });
      h.advance(16 * MINUTE);
      expect((await runNarobetResults(h.ctx, async () => null)).applied).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
