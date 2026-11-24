import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boardOddsSummary,
  getBoardPricing,
  getHulusportPricing,
  latestBoardOdds,
  setBoardPricing,
  upsertBoardOdds,
  type BoardOddsInput,
} from '../src/scrape/index';
import { auditLog } from '../src/schema/index';
import { dropTestDatabase } from './helpers';
import {
  createScrapeDatabase,
  createScrapedEvent,
  SYSTEM,
  type ScrapeTestContext,
} from './scrape-fixtures';

/**
 * Narobet (mr-z) as a second board beside Hulusport (docs/plans/narobet-feed.md): a match on both
 * boards is not a conflict, each board has its own summary and its own back office switch.
 */

let ctx: ScrapeTestContext;

beforeAll(async () => {
  ctx = await createScrapeDatabase();
});

afterAll(async () => {
  await dropTestDatabase(ctx.handle);
});

const NOW = new Date('2026-11-21T10:00:00Z');
const KICK = new Date('2026-11-22T16:30:00Z');
const MAX_AGE = 30 * 60_000;
const oneX2 = (home: number) => [
  {
    type: '1x2',
    line: null,
    prices: [
      { code: '1', priceMilli: home },
      { code: 'X', priceMilli: 3600 },
      { code: '2', priceMilli: 4200 },
    ],
  },
];

const row = (
  board: 'hulusport' | 'narobet',
  key: string,
  eventId: string,
  home: number,
): BoardOddsInput => ({
  sourceKey: `${board}:${key}`,
  board,
  competitionRaw: 'England. Premier League',
  homeRaw: 'Arsenal',
  awayRaw: 'Chelsea',
  kickoff: KICK,
  homeTeamId: null,
  awayTeamId: null,
  eventId,
  markets: oneX2(home),
  pricesAt: NOW,
  observedAt: NOW,
});

describe('boards: Hulusport and Narobet', () => {
  it('a match on both boards: each board reads its own row, no conflict', async () => {
    const { eventId } = await createScrapedEvent(ctx, { startTime: KICK });
    await ctx.handle.db.transaction((tx) =>
      upsertBoardOdds(tx, [
        row('hulusport', '1', eventId, 1850),
        row('narobet', 'cm-1', eventId, 1900),
      ]),
    );
    const read = (board?: 'hulusport' | 'narobet') =>
      latestBoardOdds(ctx.handle.db, {
        eventId,
        now: NOW,
        maxAgeMs: MAX_AGE,
        ...(board ? { board } : {}),
      });
    expect((await read())?.sourceKey).toBe('hulusport:1');
    expect((await read('hulusport'))?.sourceKey).toBe('hulusport:1');
    expect((await read('narobet'))?.sourceKey).toBe('narobet:cm-1');
    expect((await read('narobet'))?.markets[0]?.prices[0]?.priceMilli).toBe(1900);

    // Two rows of ONE board on the event is still a conflict.
    await ctx.handle.db.transaction((tx) =>
      upsertBoardOdds(tx, [row('narobet', 'cm-2', eventId, 1950)]),
    );
    expect(await read('narobet')).toBeNull();
    expect((await read('hulusport'))?.sourceKey).toBe('hulusport:1');
  });

  it('summarises each board on its own', async () => {
    const narobet = await boardOddsSummary(ctx.handle.db, {
      now: NOW,
      maxAgeMs: MAX_AGE,
      limit: 10,
      board: 'narobet',
    });
    const hulusport = await boardOddsSummary(ctx.handle.db, {
      now: NOW,
      maxAgeMs: MAX_AGE,
      limit: 10,
    });
    expect(narobet).toMatchObject({ upcoming: 2, linked: 2, fresh: 2 });
    expect(hulusport).toMatchObject({ upcoming: 1, linked: 1, fresh: 1 });
  });

  it('the Narobet switch is off by default, its own setting, and audited', async () => {
    expect((await getBoardPricing(ctx.handle.db, 'narobet')).enabled).toBe(false);
    const on = await ctx.handle.db.transaction((tx) =>
      setBoardPricing(tx, 'narobet', true, SYSTEM),
    );
    expect(on.enabled).toBe(true);
    // Hulusport's switch is not touched.
    expect((await getHulusportPricing(ctx.handle.db)).enabled).toBe(false);
    const audits = await ctx.handle.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'scrape.narobet_pricing.updated'),
          eq(auditLog.targetId, 'narobet_pricing'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      before: { enabled: false },
      after: { enabled: true },
    });
    // Setting the same value again writes nothing.
    await ctx.handle.db.transaction((tx) => setBoardPricing(tx, 'narobet', true, SYSTEM));
    const again = await ctx.handle.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'scrape.narobet_pricing.updated'));
    expect(again).toHaveLength(1);
  });
});
