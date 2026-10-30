import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { birr } from '@vamos/core';
import { loadConfig, type AppConfig } from '@vamos/config';
import {
  ensureAccount,
  postTransaction,
  resolveReviewItem,
  seedCatalog,
  settleEventBets,
} from '@vamos/db';
import { users } from '@vamos/db/schema';
import { createTestDatabase } from '@vamos/db/testing';
import { createAdapter, PoliteFetcher } from '@vamos/scraper';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScraperContext, type ScraperContext } from '../src/context';
import {
  DEMO_SCORE,
  demoSourceConfig,
  KICKOFF_AGO_MS,
  seedResultDemo,
} from '../src/devtools/seed-result-demo';
import { runPromotion } from '../src/tasks/promote';
import { runDueSources } from '../src/tasks/scheduler';
import { HOUR, MINUTE, REDIS_URL, SETUP_TIMEOUT, TEST_TIMEOUT } from './helpers';

const PHONE = '+251911000123';
const TAG = 'rt1';

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
let redis: Redis;
let dir: string;
let config: AppConfig;
let now = new Date();

beforeAll(async () => {
  db = await createTestDatabase();
  await seedCatalog(db.db);
  await db.db.transaction(async (tx) => {
    for (const kind of [
      'house_stakes',
      'house_revenue',
      'house_tax_payable',
      'house_demo_funding',
      'house_promotions',
      'house_jackpot',
      'house_withdrawals_pending',
    ] as const) {
      await ensureAccount(tx, { kind });
    }
  });
  const [player] = await db.db
    .insert(users)
    .values({
      phone: PHONE,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
    })
    .returning({ id: users.id });
  await db.db.transaction((tx) =>
    postTransaction(tx, {
      type: 'demo_topup',
      idempotencyKey: 'seed-result-demo-test-topup',
      entries: [
        { account: { kind: 'house_demo_funding' }, amount: -birr(1_000) },
        { account: { kind: 'player_cash', userId: player!.id }, amount: birr(1_000) },
      ],
    }),
  );
  redis = new Redis(REDIS_URL, {
    keyPrefix: `vamos-test:${randomBytes(6).toString('hex')}:`,
    maxRetriesPerRequest: 2,
  });
  dir = mkdtempSync(join(tmpdir(), 'vamos-result-demo-'));
  config = loadConfig({
    LOG_LEVEL: 'silent',
    FEED_PROVIDER: 'scraped',
    SCRAPER_ARCHIVE_DIR: dir,
    SCRAPER_PORT: '0',
  });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await redis?.quit();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  await db?.drop();
}, SETUP_TIMEOUT);

/** The scraper as the owner runs it: the real clock (moved by the tests), a network that is down. */
function scraper(): ScraperContext {
  return createScraperContext({
    config,
    db: db.db,
    redis,
    logger: pino({ level: 'silent' }),
    clock: () => new Date(now.getTime()),
    fetcher: new PoliteFetcher({
      userAgent: 'VamosTest/1.0',
      robots: 'off',
      minIntervalMs: 0,
      jitterFraction: 0,
      maxAttempts: 1,
      now: () => now.getTime(),
      sleep: () => Promise.resolve(),
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND results.demo.invalid')),
    }),
  });
}

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.pool.query<T & Record<string, unknown>>(sql, params)).rows;
const count = async (sql: string): Promise<number> =>
  Number((await rows<{ n: string }>(sql))[0]?.n ?? 0);

describe('seed:result-demo', () => {
  let seeded: Awaited<ReturnType<typeof seedResultDemo>>;

  it(
    'refuses to run outside demo mode',
    async () => {
      await expect(
        seedResultDemo({ config: { ...config, mode: 'licensed' }, db: db.db, redis }, TAG),
      ).rejects.toThrow(/demo/);
      expect(await count(`SELECT count(*) AS n FROM scrape_sources`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'builds a scraped event, a current result from an enabled source and two bets placed before kickoff',
    async () => {
      now = new Date();
      seeded = await seedResultDemo({ config, db: db.db, redis, now: () => now }, TAG, {
        playerPhone: PHONE,
      });

      const kickoff = new Date(seeded.kickoff);
      expect(Math.abs(now.getTime() - kickoff.getTime() - KICKOFF_AGO_MS)).toBeLessThan(2 * MINUTE);
      const [event] = await rows<{
        feed_provider: string;
        feed_ref: string;
        status: string;
        betting_open: boolean;
        result: string | null;
      }>(
        `SELECT feed_provider, feed_ref, status, betting_open, resulted_at::text AS result
           FROM events WHERE id = $1`,
        [seeded.eventId],
      );
      expect(event).toMatchObject({
        feed_provider: 'scraped',
        feed_ref: seeded.feedRef,
        status: 'scheduled',
        betting_open: true,
        result: null,
      });
      expect(
        await count(`SELECT count(*) AS n FROM markets WHERE event_id = '${seeded.eventId}'`),
      ).toBeGreaterThan(0);
      // Created by the scraper's own gate: audited as the scraper, with the 1x2 priced by the model.
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.created' AND actor_id = 'system:scraper'`,
        ),
      ).toBe(1);

      const [source] = await rows<{ enabled: boolean; adapter: string }>(
        `SELECT enabled, adapter FROM scrape_sources WHERE id = $1`,
        [seeded.sourceId],
      );
      expect(source).toMatchObject({ enabled: true, adapter: 'generic-json' });
      // The config is a valid one for the real adapter: the scheduler never opens a "bad config" item.
      expect(
        createAdapter({
          id: seeded.sourceId,
          adapter: 'generic-json',
          upstream: seeded.sourceId,
          config: demoSourceConfig(TAG),
        }).ok,
      ).toBe(true);

      const obs = await rows<{
        kind: string;
        status: string;
        source_key: string;
        score: unknown;
        score_basis: string | null;
        competition_id: string | null;
        home_team_id: string | null;
        away_team_id: string | null;
        first_seen_at: Date;
      }>(
        `SELECT kind, status, source_key, score, score_basis, competition_id, home_team_id,
                away_team_id, first_seen_at
           FROM scrape_observations WHERE source_id = $1 ORDER BY kind`,
        [seeded.sourceId],
      );
      expect(obs.map((o) => [o.kind, o.status, o.source_key])).toEqual([
        ['fixture', 'scheduled', seeded.upstreamId],
        ['result', 'finished', seeded.upstreamId],
      ]);
      const result = obs[1]!;
      expect(result.score).toEqual(DEMO_SCORE);
      expect(result.score_basis).toBe('regular_time');
      expect(result.competition_id).toBe(seeded.competition.id);
      expect(result.home_team_id).toBe(seeded.teams.home);
      expect(result.away_team_id).toBe(seeded.teams.away);
      // The fixture was first listed days before kickoff, the score only just now.
      expect(obs[0]!.first_seen_at.getTime()).toBeLessThan(kickoff.getTime() - 24 * HOUR);
      expect(Math.abs(result.first_seen_at.getTime() - now.getTime())).toBeLessThan(2 * MINUTE);
      // The pages were archived like any real read.
      expect(await count(`SELECT count(*) AS n FROM scrape_raw`)).toBe(3);
      expect(await count(`SELECT count(*) AS n FROM scrape_runs WHERE status = 'ok'`)).toBe(3);

      expect(seeded.bets.map((b) => [b.pick, b.stake])).toEqual([
        ['home', '10000'],
        ['away', '5000'],
      ]);
      const placed = await rows<{ status: string; placed_at: Date }>(
        `SELECT status, placed_at FROM bets ORDER BY stake DESC`,
      );
      expect(placed.map((b) => b.status)).toEqual(['open', 'open']);
      for (const bet of placed) expect(bet.placed_at.getTime()).toBeLessThan(kickoff.getTime());
      // Nothing was raised on the way: no item for a trader yet.
      expect(await count(`SELECT count(*) AS n FROM scrape_review_items`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'is idempotent: the same tag again adds no source, event, observation, run, item or bet',
    async () => {
      const before = await Promise.all(
        ['scrape_sources', 'events', 'scrape_observations', 'scrape_runs', 'bets', 'teams'].map(
          (t) => count(`SELECT count(*) AS n FROM ${t}`),
        ),
      );
      const again = await seedResultDemo({ config, db: db.db, redis }, TAG, {
        playerPhone: PHONE,
      });
      expect(again).toMatchObject({
        eventId: seeded.eventId,
        kickoff: seeded.kickoff,
        sourceId: seeded.sourceId,
      });
      expect(again.bets.map((b) => b.shortId)).toEqual(seeded.bets.map((b) => b.shortId));
      expect(
        await Promise.all(
          ['scrape_sources', 'events', 'scrape_observations', 'scrape_runs', 'bets', 'teams'].map(
            (t) => count(`SELECT count(*) AS n FROM ${t}`),
          ),
        ),
      ).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'a player that does not exist is an error that says so',
    async () => {
      await expect(
        seedResultDemo({ config, db: db.db, redis }, TAG, { playerPhone: '+251911999999' }),
      ).rejects.toThrow(/sign up/);
    },
    TEST_TIMEOUT,
  );

  it(
    'the gates raise result_unverified (R6) and nothing else; the scheduler adds no noise',
    async () => {
      const ctx = scraper();
      // The scheduler leaves the source alone: it was read a moment ago.
      expect(await runDueSources(ctx, { random: () => 0 })).toMatchObject({ due: 0 });

      expect(await runPromotion(ctx)).toBe(true);
      const items = await rows<{ kind: string; status: string; payload: Record<string, unknown> }>(
        `SELECT kind, status, payload FROM scrape_review_items`,
      );
      expect(items.map((i) => [i.kind, i.status])).toEqual([['result_unverified', 'open']]);
      expect(items[0]!.payload).toMatchObject({
        eventId: seeded.eventId,
        score: DEMO_SCORE,
        upstreams: [seeded.sourceId],
      });
      expect(items[0]!.payload.exposure).toMatchObject({ openBets: 2, totalStake: '15000' });
      const [event] = await rows<{ status: string }>(`SELECT status FROM events`);
      expect(event?.status).toBe('scheduled');
      // A second pass changes nothing.
      await runPromotion(ctx);
      expect(await count(`SELECT count(*) AS n FROM scrape_review_items`)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a trader applying the result: the next pass results the event with exactly that score and the bets settle',
    async () => {
      const ctx = scraper();
      const [item] = await rows<{ id: string }>(
        `SELECT id FROM scrape_review_items WHERE kind = 'result_unverified' AND status = 'open'`,
      );
      await db.db.transaction((tx) =>
        resolveReviewItem(tx, item!.id, {
          status: 'resolved',
          resolution: JSON.stringify({ decision: 'apply_result' }),
          actor: { adminId: '00000000-0000-4000-8000-000000000001' },
          now: ctx.clock(),
        }),
      );
      // Nothing changes until the scraper's pass.
      expect((await rows<{ status: string }>(`SELECT status FROM events`))[0]?.status).toBe(
        'scheduled',
      );

      await runPromotion(ctx);
      const [event] = await rows<{
        status: string;
        score_home: number;
        score_away: number;
        ht_score_home: number;
        ht_score_away: number;
      }>(`SELECT status, score_home, score_away, ht_score_home, ht_score_away FROM events`);
      expect(event).toEqual({
        status: 'finished',
        score_home: 2,
        score_away: 1,
        ht_score_home: 1,
        ht_score_away: 0,
      });
      const [applied] = await rows<{ metadata: { via: string; reviewItemId: string } }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.applied'`,
      );
      expect(applied?.metadata).toMatchObject({ via: 'staff', reviewItemId: item!.id });
      expect(
        await count(`SELECT count(*) AS n FROM scrape_review_items WHERE status = 'open'`),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_log WHERE action LIKE 'scrape.result.%rejected'`,
        ),
      ).toBe(0);

      // What the worker does on event.resulted: the home bet wins, the away bet loses.
      await db.db.transaction((tx) => settleEventBets(tx, seeded.eventId, ctx.clock()));
      const settled = await rows<{ status: string; stake: string; net: string | null }>(
        `SELECT status, stake::text AS stake, settled_net_payout::text AS net FROM bets b ORDER BY b.stake DESC`,
      );
      expect(settled.map((b) => [b.status, b.stake])).toEqual([
        ['won', '10000'],
        ['lost', '5000'],
      ]);
      expect(BigInt(settled[0]!.net!)).toBeGreaterThan(10000n);
    },
    TEST_TIMEOUT,
  );

  it(
    'about an hour on the scheduler reads the source, which fails: no source_broken item, nothing opened for the finished event',
    async () => {
      now = new Date(now.getTime() + 61 * MINUTE);
      const ctx = scraper();
      expect(await runDueSources(ctx, { random: () => 0 })).toMatchObject({ due: 1, ran: 1 });
      expect(
        await rows<{ status: string }>(
          `SELECT status FROM scrape_runs ORDER BY started_at DESC LIMIT 1`,
        ),
      ).toEqual([{ status: 'failed' }]);
      await runPromotion(ctx);
      expect(
        await count(`SELECT count(*) AS n FROM scrape_review_items WHERE status = 'open'`),
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM scrape_review_items WHERE kind = 'source_broken'`),
      ).toBe(0);
      expect(await rows<{ status: string }>(`SELECT status FROM events`)).toEqual([
        { status: 'finished' },
      ]);
    },
    TEST_TIMEOUT,
  );
});
