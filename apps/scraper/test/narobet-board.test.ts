import { BOARD_KEY_MARKER, isBoardPricedKey } from '@vamos/core';
import { latestBoardOdds, setBoardPricing, upsertBoardOdds } from '@vamos/db';
import { priceBoardMarket } from '@vamos/feed';
import { MRZ_MATCHES_PATH, narobetPricesMaxAgeMs } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
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
      expect(summary).toEqual({ matches: 2, linked: 1, unresolved: 1, skipped: 2, rejected: 1 });

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
      // Reading creates no event (Narobet-only matches are never listed).
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
