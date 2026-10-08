import { marketKey } from '@vamos/core';
import { createRng, expectedGoals, priceFootball } from '@vamos/feed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockFeedProvider, runFeedIngest } from '../src/tasks/feed-ingest';
import {
  bookOverround,
  DEFAULT_MAX_RISE,
  driftMarketOdds,
  DRIFT_ODDS_SOURCE,
  fairOverround,
  maxDriftedOdds,
  runPrematchDrift,
} from '../src/tasks/prematch-drift';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

/** Saturday 10 Oct 2026, 12:02 in Addis Ababa. */
const NOW = new Date('2026-10-10T09:02:00Z');

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await t.db.pool.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

describe('feed ingest', () => {
  it(
    'creates the next 72 hours of fixtures plus rolling demo fixtures, idempotently',
    async () => {
      t.clock.set(NOW);
      const provider = await createMockFeedProvider(t.db.db);
      const expected = provider.fixtures(NOW, 72);

      const first = await runFeedIngest(t.ctx);
      expect(first).toMatchObject({
        fixtures: expected.length,
        created: expected.length,
        updated: 0,
        skipped: 0,
        failed: 0,
        published: 0,
      });
      expect(first.fixtures).toBeGreaterThan(50);
      expect(await count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'mock'`)).toBe(
        expected.length,
      );
      // Rolling fixtures: one every 5 minutes over the next 2 hours (12:05 … 14:00 local).
      const rolling = await count(
        `SELECT count(DISTINCT start_time) AS n FROM events
          WHERE start_time > $1 AND start_time <= $1::timestamptz + interval '2 hours'
            AND extract(minute FROM start_time)::int % 5 = 0`,
        [NOW],
      );
      expect(rolling).toBe(24);
      // Every event is scheduled with open, fully priced markets and its opening odds history.
      expect(
        await count(
          `SELECT count(*) AS n FROM events WHERE status <> 'scheduled' OR game_id < 1000`,
        ),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) AS n FROM events e
            WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.event_id = e.id)`,
        ),
      ).toBe(0);
      const selections = await count('SELECT count(*) AS n FROM selections');
      expect(await count('SELECT count(*) AS n FROM odds_history')).toBe(selections);

      const second = await runFeedIngest(t.ctx);
      expect(second).toMatchObject({
        fixtures: expected.length,
        created: 0,
        updated: 0,
        unchanged: expected.length,
        published: 0,
      });
      expect(await count('SELECT count(*) AS n FROM odds_history')).toBe(selections);
      expect(t.received).toEqual([]);
    },
    TEST_TIMEOUT * 2,
  );

  it(
    'reprices scheduled events when the feed moves and publishes the odds deltas',
    async () => {
      // Stronger Arsenal ratings move the feed's prices of every Arsenal fixture.
      await t.db.pool.query(
        `UPDATE teams SET ratings = '{"attack": 2.2, "defence": 0.5}'
          WHERE sport_id = 'football' AND short_name = 'Arsenal'`,
      );
      const feedRows = `SELECT count(*) AS n FROM odds_history WHERE source = 'feed'`;
      const before = await count(feedRows);
      const run = await runFeedIngest(t.ctx);
      expect(run.created).toBe(0);
      expect(run.updated).toBeGreaterThan(0);
      expect(run.published).toBeGreaterThan(0);
      await t.waitForMessages((messages) => messages.length >= run.published);
      expect(t.received.every((m) => m.type === 'odds' && m.data.st === 'open')).toBe(true);
      // One odds_history row and one delta per repriced selection.
      expect((await count(feedRows)) - before).toBe(run.published);
    },
    TEST_TIMEOUT,
  );
});

describe('prematch drift', () => {
  it(
    'nudges a few scheduled events within bounds, keeping every book at its fair overround',
    async () => {
      const before = t.received.length;
      const rng = createRng('drift-test');
      let changed = 0;
      for (let run = 0; run < 15; run++) {
        const summary = await runPrematchDrift(t.ctx, { rng, eventsPerRun: 4, marketsPerEvent: 3 });
        expect(summary.events.length).toBeLessThanOrEqual(4);
        changed += summary.changed;
      }
      expect(changed).toBeGreaterThan(0);
      expect(
        await count(`SELECT count(*) AS n FROM odds_history WHERE source = $1`, [
          DRIFT_ODDS_SOURCE,
        ]),
      ).toBe(changed);
      await t.waitForMessages((messages) => messages.length - before >= changed);

      // Every drifted price stays within -10% / +3% of the feed's last price for it.
      const { rows } = await t.db.pool.query<{ odds: number; feed: number }>(
        `SELECT s.odds_milli AS odds,
                (SELECT h.odds_milli FROM odds_history h
                  WHERE h.selection_id = s.id AND h.source = 'feed'
                  ORDER BY h.id DESC LIMIT 1) AS feed
           FROM selections s
          WHERE EXISTS (SELECT 1 FROM odds_history d
                         WHERE d.selection_id = s.id AND d.source = $1)`,
        [DRIFT_ODDS_SOURCE],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const { odds, feed } of rows) {
        expect(odds).toBeGreaterThanOrEqual(Math.ceil(feed * 0.9) - 10);
        expect(odds).toBeLessThanOrEqual(maxDriftedOdds(feed, DEFAULT_MAX_RISE));
        expect(odds).toBeGreaterThanOrEqual(1001);
      }
      // Every book that was nudged still has its fair overround (2 for double chance).
      const { rows: books } = await t.db.pool.query<{ type: string; overround: number }>(
        `SELECT m.type, sum(1000.0 / s.odds_milli)::float AS overround
           FROM markets m JOIN selections s ON s.market_id = m.id
          WHERE m.id IN (SELECT s2.market_id FROM selections s2
                           JOIN odds_history d ON d.selection_id = s2.id AND d.source = $1)
          GROUP BY m.id, m.type`,
        [DRIFT_ODDS_SOURCE],
      );
      expect(books.length).toBeGreaterThan(0);
      for (const { type, overround } of books) {
        expect(overround).toBeGreaterThanOrEqual(fairOverround(type));
      }

      // The feed has not moved since, so the next ingest keeps the drifted prices.
      const feedRows = await count(`SELECT count(*) AS n FROM odds_history WHERE source = 'feed'`);
      const ingest = await runFeedIngest(t.ctx);
      expect(ingest).toMatchObject({ created: 0, updated: 0, published: 0 });
      expect(await count(`SELECT count(*) AS n FROM odds_history WHERE source = 'feed'`)).toBe(
        feedRows,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves markets with a manual price alone',
    async () => {
      const { rows } = await t.db.pool.query<{ id: string; event_id: string }>(
        `SELECT m.id, m.event_id FROM markets m JOIN events e ON e.id = m.event_id
        WHERE e.status = 'scheduled' AND m.status = 'open' AND m.type = '1x2'
        ORDER BY e.start_time DESC LIMIT 1`,
      );
      const market = rows[0]!;
      await t.db.pool.query(
        `INSERT INTO odds_history (selection_id, odds_milli, source)
       SELECT id, odds_milli, 'manual' FROM selections WHERE market_id = $1 AND code = '1'`,
        [market.id],
      );
      // Drift only this event (the only scheduled event after its predecessor's start).
      const { rows: starts } = await t.db.pool.query<{ start_time: Date }>(
        'SELECT start_time FROM events WHERE id = $1',
        [market.event_id],
      );
      const driftRows = `SELECT count(*) AS n FROM odds_history h
        JOIN selections s ON s.id = h.selection_id WHERE s.market_id = $1 AND h.source = $2`;
      const before = await count(driftRows, [market.id, DRIFT_ODDS_SOURCE]);
      const saved = t.clock.now;
      t.clock.set(new Date(starts[0]!.start_time.getTime() - 1));
      try {
        for (let run = 0; run < 10; run++) {
          await runPrematchDrift(t.ctx, {
            rng: createRng(`manual-${run}`),
            eventsPerRun: 50,
            marketsPerEvent: 50,
          });
        }
      } finally {
        t.clock.set(saved);
      }
      expect(await count(driftRows, [market.id, DRIFT_ODDS_SOURCE])).toBe(before);
      // Its other markets were drifted.
      const others = await count(
        `SELECT count(*) AS n FROM odds_history h JOIN selections s ON s.id = h.selection_id
         JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 AND m.id <> $2 AND h.source = $3`,
        [market.event_id, market.id, DRIFT_ODDS_SOURCE],
      );
      expect(others).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

describe('driftMarketOdds', () => {
  const bounds = { minStep: 0.01, maxStep: 0.03, maxDeviation: 0.1, maxRise: DEFAULT_MAX_RISE };

  it('keeps every price within its bounds and every book at overround >= 1', () => {
    const rng = createRng('drift-property');
    for (let i = 0; i < 2000; i++) {
      const size = rng.int(2, 6);
      // A fair book with a margin of 0–8%.
      const weights = Array.from({ length: size }, () => 0.05 + rng.next());
      const total = weights.reduce((a, b) => a + b, 0);
      const margin = 1 + rng.next() * 0.08;
      const base = weights.map((w) =>
        Math.min(1_000_000, Math.max(1010, Math.floor(1000 / ((w / total) * margin) / 10) * 10)),
      );
      const current = base.map((odds) => Math.round(odds * (0.92 + rng.next() * 0.16)));
      const next = driftMarketOdds(
        current.map((oddsMilli, index) => ({ oddsMilli, baseOddsMilli: base[index]! })),
        rng,
        bounds,
      );
      if (next === null) continue;
      expect(next).toHaveLength(size);
      expect(bookOverround(next)).toBeGreaterThanOrEqual(1);
      next.forEach((odds, index) => {
        expect(Number.isSafeInteger(odds)).toBe(true);
        expect(odds).toBeGreaterThanOrEqual(1001);
        expect(odds).toBeLessThanOrEqual(maxDriftedOdds(base[index]!, DEFAULT_MAX_RISE));
      });
    }
  });

  it('never drifts a selection above its fair price, so no book or market mix is a sure win (regression)', () => {
    const complements: Array<[string, string]> = [
      ['1', 'X2'],
      ['X', '12'],
      ['2', '1X'],
    ];
    const violations: string[] = [];
    for (const [name, home, away] of [
      ['equal teams', { attack: 1, defence: 1 }, { attack: 1, defence: 1 }],
      ['a favourite', { attack: 1.75, defence: 0.78 }, { attack: 0.9, defence: 1.02 }],
    ] as const) {
      const goals = expectedGoals(home, away);
      const feed = priceFootball(goals.home, goals.away);
      const rng = createRng(`drift-arbitrage|${name}`);
      for (let run = 0; run < 100; run++) {
        const drifted = new Map(
          feed.map((m) => [
            marketKey(m.type, m.line),
            new Map(m.selections.map((s) => [s.code, s.oddsMilli])),
          ]),
        );
        for (let round = 0; round < 30; round++) {
          for (const market of feed) {
            const key = marketKey(market.type, market.line);
            const current = drifted.get(key)!;
            const next = driftMarketOdds(
              market.selections.map((s) => ({
                oddsMilli: current.get(s.code)!,
                baseOddsMilli: s.oddsMilli,
              })),
              rng,
              bounds,
              fairOverround(market.type),
            );
            if (next === null) continue;
            market.selections.forEach((s, i) => current.set(s.code, next[i]!));
            const sum = bookOverround([...current.values()]);
            if (sum < fairOverround(market.type)) violations.push(`${name} ${key} book ${sum}`);
            for (const s of market.selections) {
              // The feed prices at most 1 / (p × 1.06): up to +3% keeps odds × p < 1.
              if (current.get(s.code)! > Math.floor(s.oddsMilli * (1 + DEFAULT_MAX_RISE))) {
                violations.push(`${name} ${key} ${s.code} ${current.get(s.code)}`);
              }
            }
          }
          // Backing complementary 1X2 and double-chance selections is never a sure win.
          const result = drifted.get('1x2')!;
          const chance = drifted.get('dc')!;
          for (const [single, double] of complements) {
            const sum = 1000 / result.get(single)! + 1000 / chance.get(double)!;
            if (sum < 1) violations.push(`${name} ${single}+${double} ${sum}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never raises a price of 1.01 or less, whose margin may already be gone', () => {
    const rng = createRng('drift-floor');
    for (let i = 0; i < 200; i++) {
      const next = driftMarketOdds(
        [
          { oddsMilli: 1010, baseOddsMilli: 1010 },
          { oddsMilli: 1005, baseOddsMilli: 1005 },
          { oddsMilli: 60_000, baseOddsMilli: 60_000 },
        ],
        rng,
        bounds,
      );
      if (next === null) continue;
      expect(next[0]).toBeLessThanOrEqual(1010);
      expect(next[1]).toBeLessThanOrEqual(1005);
    }
    expect(maxDriftedOdds(1010, DEFAULT_MAX_RISE)).toBe(1010);
    expect(maxDriftedOdds(2000, DEFAULT_MAX_RISE)).toBe(2060);
    expect(fairOverround('dc')).toBe(2);
    expect(fairOverround('1x2')).toBe(1);
  });

  it('is deterministic for a seeded random source', () => {
    const book = [
      { oddsMilli: 2100, baseOddsMilli: 2100 },
      { oddsMilli: 3400, baseOddsMilli: 3400 },
      { oddsMilli: 3500, baseOddsMilli: 3500 },
    ];
    expect(driftMarketOdds(book, createRng('same'), bounds)).toEqual(
      driftMarketOdds(book, createRng('same'), bounds),
    );
  });
});
