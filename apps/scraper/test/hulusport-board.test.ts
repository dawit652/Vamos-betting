import { BOARD_KEY_MARKER, hasBoardPrices, isBoardPricedKey } from '@vamos/core';
import { getHulusportPricing, latestBoardOdds, setHulusportPricing } from '@vamos/db';
import { priceBoardMarket } from '@vamos/feed';
import { apiFootballFixturesUrl } from '@vamos/scraper';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { sweepBoardEvents } from '../src/pipeline/board-events';
import { cancelStuckBoardEvents, runBoardResults } from '../src/tasks/board-results';
import { runTeamLogos, teamLogoUrl } from '../src/tasks/team-logos';
import { HULUSPORT_BOARD_PATH, readHulusportBoard } from '../src/tasks/hulusport';
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
 * Hulusport prices through the owner's mr-x service (docs/plans/hulusport-feed.md): the board is
 * read and linked to our event by its teams; with the back office switch on, the markets the board
 * quotes take its prices with our margin; off, stale or without the board's 1X2, our own prices.
 */

const MRX = 'http://mrx.test:3100';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

async function createdEvent(): Promise<string> {
  h = await createHarness({ hulusportUrl: MRX });
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

async function storedBook(eventId: string): Promise<Map<string, number>> {
  const found = await rows<{ key: string; code: string; odds_milli: number }>(
    `SELECT m.key, s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1`,
    [eventId],
  );
  return new Map(found.map((r) => [`${r.key}|${r.code}`, r.odds_milli]));
}

const decimal = (milli: number) => Math.round(milli / 10) / 100;
const item = (name: string, specifier: Record<string, string>, odds: Array<[string, number]>) => ({
  bet_group: { name },
  specifier,
  odds: odds.map(([outcome, odd]) => ({ bet_type: { name: outcome }, odd, is_available: true })),
});

/**
 * Hulusport's board for Arsenal v Chelsea, built around our own stored prices (so a re-price stays
 * within the bounds of O3): each price is ours with 2% more margin, the home win 3% longer.
 */
function boardAround(book: Map<string, number>, pricesAt: Date) {
  const at = (key: string, factor = 0.98) => decimal(Math.floor(book.get(key)! * factor));
  return {
    generated_at: pricesAt.toISOString(),
    worker: { last_success_at: pricesAt.toISOString(), backoff_until: null },
    matches: [
      {
        id: 2281709,
        hom: 'Arsenal',
        awy: 'Chelsea',
        schedule: KICKOFF.toISOString(),
        odds_checked_at: pricesAt.toISOString(),
        expired: false,
        league: { id: 17, name: 'Premier League', sport_type: 79, group: 'England' },
        items: [
          item('3 Way', {}, [
            ['{$competitor1}', at('1x2|1', 1.01)],
            ['draw', at('1x2|X')],
            ['{$competitor2}', at('1x2|2')],
          ]),
          item('Over/Under', { total: '2.5' }, [
            ['over {total}', at('ou:2.5|over')],
            ['under {total}', at('ou:2.5|under')],
          ]),
          // A line we do not price: never added.
          item('Over/Under', { total: '7.5' }, [
            ['over {total}', 60],
            ['under {total}', 1.01],
          ]),
          // Correct score is never taken from the board.
          item('Correct score', { variant: 'sr:correct_score:max:6' }, [['1:0', 7]]),
        ],
      },
      {
        id: 2281710,
        hom: 'Nobody United',
        awy: 'Nowhere Town',
        schedule: KICKOFF.toISOString(),
        odds_checked_at: pricesAt.toISOString(),
        expired: false,
        league: { id: 99, name: 'Somewhere League', sport_type: 79, group: null },
        items: [
          item('3 Way', {}, [
            ['{$competitor1}', 2],
            ['draw', 3.2],
            ['{$competitor2}', 3.6],
          ]),
        ],
      },
    ],
  };
}

function serveBoard(board: unknown) {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(board), { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

const switchTo = (enabled: boolean) =>
  h.ctx.db.transaction((tx) => setHulusportPricing(tx, enabled, actor));

describe('Hulusport prices from the mr-x board', () => {
  it(
    'links the board to our event, and uses it only while the switch is on and the prices are fresh',
    async () => {
      const eventId = await createdEvent();
      const ours = await storedBook(eventId);
      const board = boardAround(ours, new Date(h.now().getTime() - 2 * MINUTE));
      const { fetchImpl, seen } = serveBoard(board);

      const summary = await readHulusportBoard(h.ctx, fetchImpl);
      expect(seen).toEqual([`${MRX}${HULUSPORT_BOARD_PATH}?hours=336`]);
      expect(summary).toMatchObject({ matches: 2, linked: 1, unresolved: 1, skipped: 0 });
      const linked = await latestBoardOdds(h.ctx.db, {
        eventId,
        now: h.now(),
        maxAgeMs: 30 * MINUTE,
      });
      expect(linked?.sourceKey).toBe('hulusport:2281709');

      // Calibrated teams (O1): the model, with the board over the markets it quotes.
      const calibrated = { attack: 1.1, defence: 0.95, matches: 12 };
      const input = {
        competitionPricingSource: 'model' as const,
        eventId,
        homeRatings: calibrated,
        awayRatings: { ...calibrated, attack: 0.9 },
        minRatingMatches: 1,
        now: h.now(),
      };
      // Off (the default): our own prices, untouched.
      expect((await getHulusportPricing(h.ctx.db)).enabled).toBe(false);
      const off = await priceEvent(h.ctx.db, input);
      expect(off.board).toBeUndefined();
      expect(hasBoardPrices(off.key)).toBe(false);

      // On: the 1X2 and the 2.5 line take the board's prices with our margin; nothing else changes.
      await switchTo(true);
      const on = await priceEvent(h.ctx.db, input);
      expect(on.board).toMatchObject({ name: 'hulusport', markets: 2 });
      expect(on.key.startsWith(off.key)).toBe(true);
      expect(on.key).toContain(BOARD_KEY_MARKER);
      expect(on.markets.map((m) => `${m.type}:${m.line ?? ''}`)).toEqual(
        off.markets.map((m) => `${m.type}:${m.line ?? ''}`),
      );
      const x12 = on.markets.find((m) => m.type === '1x2')!;
      const expected = priceBoardMarket(linked!.markets.find((m) => m.type === '1x2') as never)!;
      expect(x12.selections).toEqual(expected.selections);
      for (const market of on.markets) {
        if (market.type === '1x2' || (market.type === 'ou' && market.line === '2.5')) continue;
        expect(market).toEqual(
          off.markets.find((m) => m.type === market.type && m.line === market.line),
        );
      }

      // Rule O1h: teams NOT calibrated: the whole book from the board's expected goals (no market
      // priced from empty ratings), backing opening, with the board's own 1X2 over it.
      const uncalibrated = { ...input, homeRatings: null, awayRatings: null };
      const o1h = await priceEvent(h.ctx.db, uncalibrated);
      expect(isBoardPricedKey(o1h.key)).toBe(true);
      expect(o1h).toMatchObject({ source: 'market', backsOpening: true, calibrated: true });
      expect(o1h.key).toContain(BOARD_KEY_MARKER);
      expect(o1h.markets.find((m) => m.type === '1x2')!.selections).toEqual(expected.selections);
      expect(o1h.markets.length).toBeGreaterThan(5);

      // Stale: back to our own prices (and for uncalibrated teams, the model's, which cannot open).
      h.advance(31 * MINUTE);
      const stale = await priceEvent(h.ctx.db, { ...input, now: h.now() });
      expect(stale.board).toBeUndefined();
      expect(stale.key).toBe(off.key);
      const staleO1h = await priceEvent(h.ctx.db, { ...uncalibrated, now: h.now() });
      expect(isBoardPricedKey(staleO1h.key)).toBe(false);
      expect(staleO1h).toMatchObject({ source: 'model', calibrated: false, backsOpening: false });
    },
    TEST_TIMEOUT,
  );

  it(
    're-prices the event to the board and back to our prices when switched off, audited',
    async () => {
      const eventId = await createdEvent();
      const ours = await storedBook(eventId);
      const { fetchImpl } = serveBoard(boardAround(ours, h.now()));
      await readHulusportBoard(h.ctx, fetchImpl);
      await switchTo(true);

      await repriceScheduledEvents(h.ctx);
      const withBoard = await storedBook(eventId);
      expect(withBoard.get('1x2|1')).not.toBe(ours.get('1x2|1'));
      const [stamp] = await rows<{ ratings_key: string }>(
        `SELECT ratings_key FROM scrape_event_pricing WHERE event_id = $1`,
        [eventId],
      );
      expect(hasBoardPrices(stamp!.ratings_key)).toBe(true);
      const audits = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.repriced' AND target_id = $1`,
        [eventId],
      );
      expect(audits.at(-1)?.metadata).toMatchObject({ board: 'hulusport', boardMarkets: 2 });
      // Markets the board does not quote keep our prices.
      expect(withBoard.get('btts|yes')).toBe(ours.get('btts|yes'));

      await switchTo(false);
      await repriceScheduledEvents(h.ctx);
      expect(await storedBook(eventId)).toEqual(ours);
      const switched = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.hulusport_pricing.updated' ORDER BY created_at`,
      );
      expect(switched.map((r) => r.metadata)).toEqual([
        { before: { enabled: false }, after: { enabled: true } },
        { before: { enabled: true }, after: { enabled: false } },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'skips matches mr-x has not read yet, and refuses a response that is not a board',
    async () => {
      await createdEvent();
      const board = boardAround(
        await storedBook((await rows<{ id: string }>(`SELECT id FROM events`))[0]!.id),
        h.now(),
      );
      board.matches[0]!.odds_checked_at = null as never;
      const { fetchImpl } = serveBoard(board);
      expect(await readHulusportBoard(h.ctx, fetchImpl)).toMatchObject({ skipped: 1, matches: 1 });
      const broken = serveBoard({ detail: 'not found' });
      await expect(readHulusportBoard(h.ctx, broken.fetchImpl)).rejects.toThrow(/not a board/);
    },
    TEST_TIMEOUT,
  );
});

describe('Hulusport matches Nahubet does not list', () => {
  /** A complete board match in a league of its own (no team of our catalogue). */
  const ownMatch = (
    pricesAt: Date,
    over: {
      id?: number;
      home?: string;
      league?: number;
      leagueName?: string;
      group?: string;
      homeWin?: number;
      btts?: boolean;
    } = {},
  ) => ({
    id: over.id ?? 2281710,
    hom: over.home ?? 'Nobody United',
    awy: 'Nowhere Town',
    schedule: KICKOFF.toISOString(),
    odds_checked_at: pricesAt.toISOString(),
    expired: false,
    league: {
      id: over.league ?? 99,
      name: over.leagueName ?? 'Somewhere League',
      sport_type: 79,
      group: over.group ?? 'Somewhereland',
    },
    items: [
      item('3 Way', {}, [
        ['{$competitor1}', over.homeWin ?? 2.1],
        ['draw', 3.3],
        ['{$competitor2}', 3.4],
      ]),
      item('Over/Under', { total: '2.5' }, [
        ['over {total}', 1.95],
        ['under {total}', 1.85],
      ]),
      ...(over.btts === false
        ? []
        : [
            item('Both teams to score', {}, [
              ['yes', 1.8],
              ['no', 1.95],
            ]),
          ]),
    ],
  });
  const boardOf = (pricesAt: Date, matches: unknown[]) => ({
    generated_at: pricesAt.toISOString(),
    worker: { last_success_at: pricesAt.toISOString() },
    matches,
  });
  const boardEvents = () =>
    rows<{
      id: string;
      feed_ref: string;
      betting_open: boolean;
      close_lead_ms: number;
      competition: string;
      category: string;
      home: string;
    }>(
      `SELECT e.id, e.feed_ref, e.betting_open, e.close_lead_ms, c.name->>'en' AS competition,
              cat.name->>'en' AS category, t.name->>'en' AS home
         FROM events e JOIN competitions c ON c.id = e.competition_id
         JOIN categories cat ON cat.id = c.category_id JOIN teams t ON t.id = e.home_team_id
        WHERE e.feed_provider = 'hulusport' ORDER BY e.feed_ref`,
    );
  const marketStatus = async (eventId: string) =>
    new Map(
      (
        await rows<{ key: string; status: string }>(
          `SELECT key, status FROM markets WHERE event_id = $1`,
          [eventId],
        )
      ).map((r) => [r.key, r.status]),
    );

  it(
    'gives the category of a board league its country, and fills those made without one',
    async () => {
      await createdEvent();
      await switchTo(true);
      const board = serveBoard(
        boardOf(h.now(), [
          ownMatch(h.now(), { id: 1, league: 71, group: 'England Amateur' }),
          ownMatch(h.now(), { id: 2, league: 72, group: 'International' }),
        ]),
      );
      await readHulusportBoard(h.ctx, board.fetchImpl);
      const codes = () =>
        rows<{ slug: string; country_code: string | null }>(
          `SELECT slug, country_code FROM categories WHERE slug LIKE 'hl-%' ORDER BY slug`,
        );
      expect(await codes()).toEqual([
        { slug: 'hl-england-amateur', country_code: 'GB-ENG' },
        { slug: 'hl-international', country_code: null },
      ]);
      // A category made before the code existed is filled on the next read.
      await h.pool.query(
        `UPDATE categories SET country_code = NULL WHERE slug = 'hl-england-amateur'`,
      );
      await readHulusportBoard(h.ctx, board.fetchImpl);
      expect((await codes())[0]).toEqual({ slug: 'hl-england-amateur', country_code: 'GB-ENG' });
    },
    TEST_TIMEOUT,
  );

  it(
    'lists the match in a league and with teams of its own, priced from the board, and follows the board',
    async () => {
      await createdEvent();
      await switchTo(true);
      const first = serveBoard(boardOf(h.now(), [ownMatch(h.now())]));
      const summary = await readHulusportBoard(h.ctx, first.fetchImpl);
      expect(summary.boardEvents).toEqual({ created: 1, updated: 0, skipped: 0 });
      const [event] = await boardEvents();
      expect(event).toMatchObject({
        feed_ref: '2281710',
        betting_open: true,
        close_lead_ms: 5 * MINUTE,
        competition: 'Somewhere League',
        category: 'Somewhereland',
        home: 'Nobody United',
      });
      const book = await storedBook(event!.id);
      const expected = priceBoardMarket({
        type: '1x2',
        line: null,
        prices: [
          { code: '1', priceMilli: 2100 },
          { code: 'X', priceMilli: 3300 },
          { code: '2', priceMilli: 3400 },
        ],
      })!;
      expect(book.get('1x2|1')).toBe(expected.selections[0]!.oddsMilli);
      expect(await marketStatus(event!.id)).toEqual(
        new Map([
          ['1x2', 'open'],
          ['ou:2.5', 'open'],
          ['btts', 'open'],
        ]),
      );

      // A new price is followed; a market the board drops is suspended.
      h.advance(2 * MINUTE);
      await readHulusportBoard(
        h.ctx,
        serveBoard(boardOf(h.now(), [ownMatch(h.now(), { homeWin: 2.3, btts: false })])).fetchImpl,
      );
      expect((await storedBook(event!.id)).get('1x2|1')).toBeGreaterThan(book.get('1x2|1')!);
      expect((await marketStatus(event!.id)).get('btts')).toBe('suspended');

      // Stale: every market suspended; fresh again: what the board quotes re-opens.
      h.advance(31 * MINUTE);
      expect(await sweepBoardEvents(h.ctx, h.now())).toBe(1);
      expect([...(await marketStatus(event!.id)).values()]).toEqual([
        'suspended',
        'suspended',
        'suspended',
      ]);
      await readHulusportBoard(
        h.ctx,
        serveBoard(boardOf(h.now(), [ownMatch(h.now(), { btts: false })])).fetchImpl,
      );
      expect(await marketStatus(event!.id)).toEqual(
        new Map([
          ['1x2', 'open'],
          ['ou:2.5', 'open'],
          ['btts', 'suspended'],
        ]),
      );

      // Switched off: suspended, and nothing new is listed.
      await switchTo(false);
      expect(await sweepBoardEvents(h.ctx, h.now())).toBe(1);
      const off = await readHulusportBoard(
        h.ctx,
        serveBoard(boardOf(h.now(), [ownMatch(h.now(), { id: 2281799, home: 'Elsewhere Rovers' })]))
          .fetchImpl,
      );
      expect(off.boardEvents.created).toBe(0);
      expect(await boardEvents()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'never lists a match of a league we list, or with a team of our catalogue',
    async () => {
      const eventId = await createdEvent();
      await switchTo(true);
      const ours = boardAround(await storedBook(eventId), h.now());
      const board = boardOf(h.now(), [
        ours.matches[0], // Arsenal v Chelsea: our event, league 17
        // Same league 17 (we list it), unknown teams: not listed.
        ownMatch(h.now(), { id: 1, league: 17, leagueName: 'Premier League' }),
        // A league of its own but with Arsenal, a team of our catalogue: not listed.
        ownMatch(h.now(), { id: 2, home: 'Arsenal', league: 98, leagueName: 'Friendlies' }),
        // A league whose name is one of our competitions: not listed.
        ownMatch(h.now(), {
          id: 3,
          home: 'Elsewhere Rovers',
          league: 55,
          leagueName: 'Premier League',
        }),
        // Stale prices: not listed.
        ownMatch(new Date(h.now().getTime() - 40 * MINUTE), {
          id: 4,
          home: 'Late Athletic',
          league: 97,
        }),
      ]);
      const summary = await readHulusportBoard(h.ctx, serveBoard(board).fetchImpl);
      expect(summary.boardEvents).toEqual({ created: 0, updated: 0, skipped: 4 });
      expect(await boardEvents()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('API-Football results for Hulusport-only matches', () => {
  const KEY = 'test-api-football-key';
  const boardMatch = (id: number, home: string, away: string, pricesAt: Date) => ({
    id,
    hom: home,
    awy: away,
    schedule: KICKOFF.toISOString(),
    odds_checked_at: pricesAt.toISOString(),
    expired: false,
    league: { id: 99, name: 'Somewhere League', sport_type: 79, group: 'Somewhereland' },
    items: [
      item('3 Way', {}, [
        ['{$competitor1}', 2.1],
        ['draw', 3.3],
        ['{$competitor2}', 3.4],
      ]),
      item('1st Half - 3 Way', {}, [
        ['{$competitor1}', 2.8],
        ['draw', 2.1],
        ['{$competitor2}', 4.2],
      ]),
    ],
  });
  const fixture = (id: number, home: string, away: string, status: string) => ({
    fixture: { id, date: KICKOFF.toISOString(), status: { short: status } },
    league: { name: 'Somewhere League', country: 'Somewhereland' },
    teams: { home: { name: home }, away: { name: away } },
    goals: { home: 2, away: 1 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: status === 'PST' ? { home: null, away: null } : { home: 2, away: 1 },
    },
  });

  it(
    'settles a finished match once its score has stood for 15 minutes, and leaves a postponed one',
    async () => {
      h = await createHarness({ hulusportUrl: MRX, secrets: { SCRAPER_SECRET_API_FOOTBALL: KEY } });
      await switchTo(true);
      const board = {
        generated_at: h.now().toISOString(),
        worker: { last_success_at: h.now().toISOString() },
        matches: [
          boardMatch(501, 'Nobody United', 'Nowhere Town', h.now()),
          boardMatch(502, 'Elsewhere Rovers', 'Late Athletic', h.now()),
        ],
      };
      expect(
        (await readHulusportBoard(h.ctx, serveBoard(board).fetchImpl)).boardEvents.created,
      ).toBe(2);

      // API-Football spells the clubs its own way; the second match was postponed.
      h.serve(
        apiFootballFixturesUrl(KICKOFF.toISOString().slice(0, 10)),
        JSON.stringify({
          errors: [],
          response: [
            fixture(9001, 'Nobody Utd', 'Nowhere Town FC', 'FT'),
            fixture(9002, 'Elsewhere Rovers', 'Late Athletic', 'PST'),
          ],
        }),
      );
      h.at(new Date(KICKOFF.getTime() + 2 * 3_600_000 + MINUTE));
      const first = await runBoardResults(h.ctx);
      expect(first).toMatchObject({
        pending: 2,
        matched: 2,
        confirming: 1,
        applied: 0,
        failedRequests: 0,
      });
      expect(h.requests.at(-1)?.headers['x-apisports-key']).toBe(KEY);

      h.advance(16 * MINUTE);
      const second = await runBoardResults(h.ctx);
      expect(second).toMatchObject({ pending: 2, matched: 2, applied: 1 });
      const events = await rows<{
        feed_ref: string;
        status: string;
        score_home: number | null;
        score_away: number | null;
        ht_score_home: number | null;
      }>(
        `SELECT feed_ref, status, score_home, score_away, ht_score_home FROM events
          WHERE feed_provider = 'hulusport' ORDER BY feed_ref`,
      );
      expect(events).toEqual([
        { feed_ref: '501', status: 'finished', score_home: 2, score_away: 1, ht_score_home: 1 },
        {
          feed_ref: '502',
          status: 'scheduled',
          score_home: null,
          score_away: null,
          ht_score_home: null,
        },
      ]);
      const audit = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.board.result_applied'`,
      );
      expect(audit[0]?.metadata).toMatchObject({
        source: 'api-football',
        fixtureId: 9001,
        status: 'FT',
      });

      // Nothing more to do for the settled one; the postponed one waits for a person.
      expect(await runBoardResults(h.ctx)).toMatchObject({ pending: 1, applied: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'cancels a board match nobody bet on that still has no result 3 days after kickoff (O-F1)',
    async () => {
      h = await createHarness({ hulusportUrl: MRX });
      await switchTo(true);
      const board = {
        generated_at: h.now().toISOString(),
        worker: { last_success_at: h.now().toISOString() },
        matches: [boardMatch(701, 'Nobody United', 'Nowhere Town', h.now())],
      };
      expect(
        (await readHulusportBoard(h.ctx, serveBoard(board).fetchImpl)).boardEvents.created,
      ).toBe(1);
      // Two days after kickoff it may still get its result: nothing is cancelled.
      h.at(new Date(KICKOFF.getTime() + 2 * 86_400_000));
      expect(await cancelStuckBoardEvents(h.ctx)).toEqual({ stuck: 0, cancelled: 0 });
      h.at(new Date(KICKOFF.getTime() + 3 * 86_400_000 + MINUTE));
      expect(await cancelStuckBoardEvents(h.ctx)).toEqual({ stuck: 1, cancelled: 1 });
      const [event] = await rows<{ status: string }>(
        `SELECT status FROM events WHERE feed_provider = 'hulusport' AND feed_ref = '701'`,
      );
      expect(event?.status).toBe('cancelled');
      const audit = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.board.stuck_cancelled'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ feedProvider: 'hulusport' });
      expect(await cancelStuckBoardEvents(h.ctx)).toEqual({ stuck: 0, cancelled: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'stores the logos of the teams it finds among the fixtures, and waits a week for the others',
    async () => {
      h = await createHarness({ hulusportUrl: MRX, secrets: { SCRAPER_SECRET_API_FOOTBALL: KEY } });
      await switchTo(true);
      const board = {
        generated_at: h.now().toISOString(),
        worker: { last_success_at: h.now().toISOString() },
        matches: [
          boardMatch(601, 'Nobody United', 'Nowhere Town', h.now()),
          boardMatch(602, 'Unlisted Rovers', 'Unknown Athletic', h.now()),
        ],
      };
      expect(
        (await readHulusportBoard(h.ctx, serveBoard(board).fetchImpl)).boardEvents.created,
      ).toBe(2);
      // Only the first match is in API-Football's list; its teams carry ids.
      h.serve(
        apiFootballFixturesUrl(KICKOFF.toISOString().slice(0, 10)),
        JSON.stringify({
          errors: [],
          response: [
            {
              fixture: { id: 9101, date: KICKOFF.toISOString(), status: { short: 'NS' } },
              league: { name: 'Somewhere League', country: 'Somewhereland' },
              teams: {
                home: { id: 7001, name: 'Nobody Utd' },
                away: { id: 7002, name: 'Nowhere Town' },
              },
              goals: { home: null, away: null },
              score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } },
            },
          ],
        }),
      );
      // API-Football's logos are 150 px PNGs.
      const logo = async (r: number, g: number, b: number) => ({
        status: 200,
        body: new Uint8Array(
          await sharp({
            create: { width: 150, height: 150, channels: 4, background: { r, g, b, alpha: 1 } },
          })
            .png()
            .toBuffer(),
        ),
        headers: { 'content-type': 'image/png' },
      });
      h.serve(teamLogoUrl(7001), await logo(200, 0, 0));
      h.serve(teamLogoUrl(7002), await logo(0, 0, 200));
      h.at(new Date(KICKOFF.getTime() - 3 * 3_600_000));

      expect(await runTeamLogos(h.ctx)).toMatchObject({
        candidates: 2,
        matched: 1,
        stored: 2,
        checked: 2,
        failedRequests: 0,
      });
      const logos = await rows<{ name: string; bytes: number; png: boolean }>(
        `SELECT t.name->>'en' AS name, octet_length(l.png) AS bytes,
                substring(l.png from 2 for 3) = 'PNG'::bytea AS png
           FROM team_logos l JOIN teams t ON t.id = l.team_id ORDER BY 1`,
      );
      expect(logos.map((l) => l.name)).toEqual(['Nobody United', 'Nowhere Town']);
      for (const logo of logos) {
        expect(logo.png).toBe(true);
        expect(logo.bytes).toBeLessThan(10_000);
      }
      // The two teams not found are not asked again within the week; nothing is left to do.
      expect(await runTeamLogos(h.ctx)).toMatchObject({ candidates: 0, stored: 0 });
      // The API shows the logo's version on the team.
      const [team] = await rows<{ logo_at: Date | null }>(
        `SELECT logo_at FROM teams WHERE name->>'en' = 'Nobody United'`,
      );
      expect(team?.logo_at).not.toBeNull();
    },
    TEST_TIMEOUT,
  );
});
