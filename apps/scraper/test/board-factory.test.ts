import { setHulusportPricing } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { readHulusportBoard } from '../src/tasks/hulusport';
import {
  createHarness,
  KICKOFF,
  MINUTE,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type Harness,
} from './helpers';

/**
 * The market factory on Hulusport-only matches (owner's request of 16 Nov 2026: about 500 options
 * per match): with SCRAPER_FACTORY_MARKETS=on a board event also gets the factory's markets, priced
 * from the expected goals that explain the board's own 1X2 and goal line.
 */

const MRX = 'http://mrx.test:3100';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const item = (name: string, specifier: Record<string, string>, odds: Array<[string, number]>) => ({
  bet_group: { name },
  specifier,
  odds: odds.map(([outcome, odd]) => ({ bet_type: { name: outcome }, odd, is_available: true })),
});

/** A board match in a league of its own; `totals: false` leaves out its over/under. */
function board(pricesAt: Date, opts: { totals?: boolean } = {}) {
  return {
    generated_at: pricesAt.toISOString(),
    worker: { last_success_at: pricesAt.toISOString() },
    matches: [
      {
        id: 2281710,
        hom: 'Nobody United',
        awy: 'Nowhere Town',
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
          ...(opts.totals === false
            ? []
            : [
                item('Over/Under', { total: '2.5' }, [
                  ['over {total}', 1.95],
                  ['under {total}', 1.85],
                ]),
              ]),
          item('Both teams to score', {}, [
            ['yes', 1.8],
            ['no', 1.95],
          ]),
        ],
      },
    ],
  };
}

const serve = (doc: unknown) => async () =>
  new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } });

async function counts() {
  const { rows } = await h.pool.query<{
    markets: string;
    open: string;
    selections: string;
    factory_open: string;
  }>(
    `SELECT count(DISTINCT m.id) AS markets,
            count(DISTINCT m.id) FILTER (WHERE m.status = 'open') AS open,
            count(s.id) AS selections,
            count(DISTINCT m.id) FILTER (
              WHERE m.status = 'open' AND m.type NOT IN ('1x2', 'ou', 'btts')
            ) AS factory_open
       FROM events e JOIN markets m ON m.event_id = e.id JOIN selections s ON s.market_id = m.id
      WHERE e.feed_provider = 'hulusport'`,
  );
  const row = rows[0]!;
  return {
    markets: Number(row.markets),
    open: Number(row.open),
    selections: Number(row.selections),
    factoryOpen: Number(row.factory_open),
  };
}

describe('the market factory on Hulusport-only matches', () => {
  it(
    'adds about 500 options priced from the board, and suspends them without a goal line',
    async () => {
      h = await createHarness({ hulusportUrl: MRX, factoryMarkets: true });
      await h.ctx.db.transaction((tx) => setHulusportPricing(tx, true, actor));
      const first = await readHulusportBoard(h.ctx, serve(board(h.now())));
      expect(first.boardEvents.created).toBe(1);
      const listed = await counts();
      expect(listed.markets).toBeGreaterThan(100);
      expect(listed.selections).toBeGreaterThanOrEqual(500);
      expect(listed.open).toBe(listed.markets);

      // Every price is a real price with our rules: above 1.00 and an integer milli.
      const { rows: bad } = await h.pool.query(
        `SELECT s.id FROM selections s JOIN markets m ON m.id = s.market_id
           JOIN events e ON e.id = m.event_id
          WHERE e.feed_provider = 'hulusport' AND (s.odds_milli <= 1000 OR s.odds_milli IS NULL)`,
      );
      expect(bad).toEqual([]);

      // Without a goal line the board's prices cannot be explained: the factory's markets close.
      h.advance(2 * MINUTE);
      await readHulusportBoard(h.ctx, serve(board(h.now(), { totals: false })));
      const closed = await counts();
      expect(closed.factoryOpen).toBe(0);
      expect(closed.markets).toBe(listed.markets);

      // The goal line is back: they re-open.
      h.advance(2 * MINUTE);
      await readHulusportBoard(h.ctx, serve(board(h.now())));
      expect((await counts()).factoryOpen).toBe(listed.factoryOpen);
    },
    TEST_TIMEOUT,
  );

  it(
    'adds none while SCRAPER_FACTORY_MARKETS is off',
    async () => {
      h = await createHarness({ hulusportUrl: MRX, factoryMarkets: false });
      await h.ctx.db.transaction((tx) => setHulusportPricing(tx, true, actor));
      await readHulusportBoard(h.ctx, serve(board(h.now())));
      expect(await counts()).toMatchObject({ markets: 3, open: 3 });
    },
    TEST_TIMEOUT,
  );
});
