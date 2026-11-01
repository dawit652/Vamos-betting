import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findScrapedEventId,
  latestMarketOdds,
  linkMarketOddsToEvents,
  listUnresolvedMarketOddsNames,
  pruneMarketOdds,
  setMarketOddsResolution,
  setSourceEnabled,
  touchMarketOddsOfRaw,
  upsertMarketOdds,
  type MarketOddsInput,
} from '../src/index';
import { scrapeMarketOdds } from '../src/schema/index';
import { dropTestDatabase, pgCode } from './helpers';
import { randomUUID } from 'node:crypto';
import {
  addRun,
  addSource,
  createScrapeDatabase,
  createScrapedEvent,
  KICKOFF,
  SYSTEM,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
const MIN = 60_000;
const RAW1 = randomUUID();
const RAW2 = randomUUID();
const RAW_OTHER = randomUUID();
const H = 3_600_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

/** One complete 1X2 of one bookmaker: 2.00 / 3.40 / 3.80 unless told otherwise. */
function book(
  eventId: string | null,
  bookmaker: string,
  observedAt: Date,
  options: Partial<MarketOddsInput> & { prices?: [number, number, number] } = {},
): MarketOddsInput[] {
  const { prices = [2000, 3400, 3800], ...rest } = options;
  return (['1', 'X', '2'] as const).map((selection, i) => ({
    sourceKey: 'ev-1',
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    market: '1x2',
    line: null,
    selection,
    bookmaker,
    priceMilli: prices[i]!,
    priceUpdatedAt: new Date(observedAt.getTime() - 12 * H),
    observedAt,
    competitionId: ctx.competitionId,
    homeTeamId: ctx.team('Arsenal'),
    awayTeamId: ctx.team('Chelsea'),
    eventId,
    ...rest,
  }));
}

const write = (
  sourceId: string,
  runId: string,
  rows: MarketOddsInput[],
  rawId: string | null = null,
) => ctx.handle.db.transaction((tx) => upsertMarketOdds(tx, { sourceId, runId, rawId, rows }));
const stored = (sourceId: string) =>
  ctx.handle.db.select().from(scrapeMarketOdds).where(eq(scrapeMarketOdds.sourceId, sourceId));
const latest = (eventIds: string[], now: Date, maxAgeMs = 3 * H) =>
  latestMarketOdds(ctx.handle.db, { eventIds, now, maxAgeMs });
const eventNumber = { n: 0 };
/** A fresh event on its own day, so linking by teams and kickoff is unambiguous. */
const newEvent = () =>
  createScrapedEvent(ctx, { startTime: new Date(KICKOFF.getTime() + ++eventNumber.n * 24 * H) });

describe('upsertMarketOdds', () => {
  it('stores rows and rewrites them on a newer sighting, keeping one row per key', async () => {
    await addSource(ctx.handle.db, 'up-1');
    const run1 = (await addRun(ctx.handle.db, 'up-1', 'ok', at(0))).id;
    expect(await write('up-1', run1, book(null, '23', at(0)))).toBe(3);
    expect(await stored('up-1')).toHaveLength(3);

    const run2 = (await addRun(ctx.handle.db, 'up-1', 'ok', at(20))).id;
    await write('up-1', run2, book(null, '23', at(20), { prices: [1900, 3500, 4000] }));
    const rows = await stored('up-1');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.selection, r.priceMilli, r.runId]).sort()).toEqual([
      ['1', 1900, run2],
      ['2', 4000, run2],
      ['X', 3500, run2],
    ]);
    expect(rows.every((r) => r.observedAt.getTime() === at(20).getTime())).toBe(true);
  });

  it('an older sighting never overwrites a newer one', async () => {
    await addSource(ctx.handle.db, 'up-2');
    const run1 = (await addRun(ctx.handle.db, 'up-2', 'ok', at(0))).id;
    await write('up-2', run1, book(null, '23', at(30), { prices: [1800, 3600, 4200] }));
    await write('up-2', run1, book(null, '23', at(10), { prices: [2500, 3000, 3000] }));
    const rows = await stored('up-2');
    expect(rows.map((r) => r.priceMilli).sort()).toEqual([1800, 3600, 4200]);
    expect(rows.every((r) => r.observedAt.getTime() === at(30).getTime())).toBe(true);
  });

  it('keeps two sources and two bookmakers apart, and a line apart from the 1X2', async () => {
    await addSource(ctx.handle.db, 'up-3a');
    await addSource(ctx.handle.db, 'up-3b');
    const a = (await addRun(ctx.handle.db, 'up-3a', 'ok', at(0))).id;
    const b = (await addRun(ctx.handle.db, 'up-3b', 'ok', at(0))).id;
    const ou = (['over', 'under'] as const).map((selection) => ({
      ...book(null, '23', at(0))[0]!,
      market: 'ou' as const,
      line: '2.5',
      selection,
      priceMilli: 1900,
    }));
    await write('up-3a', a, [...book(null, '23', at(0)), ...book(null, '24', at(0)), ...ou]);
    await write('up-3b', b, book(null, '23', at(0)));
    expect(await stored('up-3a')).toHaveLength(8);
    expect(await stored('up-3b')).toHaveLength(3);
  });

  it('refuses a price that is not an integer from 1010 to 1000000, and writes nothing', async () => {
    await addSource(ctx.handle.db, 'up-4');
    const run = (await addRun(ctx.handle.db, 'up-4', 'ok', at(0))).id;
    for (const bad of [1009, 1_000_001, 1850.5, Number.NaN]) {
      await expect(
        write('up-4', run, [
          ...book(null, '23', at(0)),
          ...book(null, '24', at(0), { prices: [bad, 3000, 3000] }),
        ]),
      ).rejects.toThrow(RangeError);
    }
    expect(await stored('up-4')).toHaveLength(0);
  });

  it('the database refuses a 1X2 selection with a line and an over/under without one', async () => {
    await addSource(ctx.handle.db, 'up-5');
    const run = (await addRun(ctx.handle.db, 'up-5', 'ok', at(0))).id;
    const row = book(null, '23', at(0))[0]!;
    const error = await write('up-5', run, [{ ...row, line: '2.5' }]).catch((e: unknown) => e);
    expect(pgCode(error)).toBe('23514');
    const error2 = await write('up-5', run, [
      { ...row, market: 'ou', selection: 'over', line: null },
    ]).catch((e: unknown) => e);
    expect(pgCode(error2)).toBe('23514');
  });
});

describe('touchMarketOddsOfRaw', () => {
  it('moves observed_at, run and snapshot of the rows of one snapshot (a 304)', async () => {
    await addSource(ctx.handle.db, 'touch-1');
    const run1 = (await addRun(ctx.handle.db, 'touch-1', 'ok', at(0))).id;
    await write('touch-1', run1, book(null, '23', at(0)), RAW1);
    await write('touch-1', run1, book(null, '24', at(0), { sourceKey: 'ev-other' }), RAW_OTHER);
    const run2 = (await addRun(ctx.handle.db, 'touch-1', 'ok', at(30))).id;
    const touched = await ctx.handle.db.transaction((tx) =>
      touchMarketOddsOfRaw(tx, {
        sourceId: 'touch-1',
        fromRawId: RAW1,
        toRawId: RAW2,
        runId: run2,
        seenAt: at(30),
      }),
    );
    expect(touched).toBe(3);
    const rows = await stored('touch-1');
    const moved = rows.filter((r) => r.rawId === RAW2);
    expect(moved).toHaveLength(3);
    expect(
      moved.every((r) => r.runId === run2 && r.observedAt.getTime() === at(30).getTime()),
    ).toBe(true);
    const other = rows.filter((r) => r.rawId === RAW_OTHER);
    expect(other.every((r) => r.runId === run1 && r.observedAt.getTime() === at(0).getTime())).toBe(
      true,
    );
  });

  it('never moves observed_at backwards', async () => {
    await addSource(ctx.handle.db, 'touch-2');
    const run = (await addRun(ctx.handle.db, 'touch-2', 'ok', at(0))).id;
    await write('touch-2', run, book(null, '23', at(60)), RAW1);
    await ctx.handle.db.transaction((tx) =>
      touchMarketOddsOfRaw(tx, {
        sourceId: 'touch-2',
        fromRawId: RAW1,
        toRawId: RAW2,
        runId: run,
        seenAt: at(10),
      }),
    );
    expect(
      (await stored('touch-2')).every((r) => r.observedAt.getTime() === at(60).getTime()),
    ).toBe(true);
  });
});

describe('findScrapedEventId and linkMarketOddsToEvents', () => {
  const teams = () => ({
    competitionId: ctx.competitionId,
    homeTeamId: ctx.team('Liverpool'),
    awayTeamId: ctx.team('Everton'),
  });

  it('finds the one event of the pairing within the window, else null', async () => {
    const start = new Date(KICKOFF.getTime() + 40 * 24 * H);
    const one = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Everton',
      startTime: start,
    });
    const db = ctx.handle.db;
    expect(await findScrapedEventId(db, { ...teams(), kickoff: start }, 6 * H)).toBe(one.eventId);
    expect(
      await findScrapedEventId(
        db,
        { ...teams(), kickoff: new Date(start.getTime() + 5 * H) },
        6 * H,
      ),
    ).toBe(one.eventId);
    expect(
      await findScrapedEventId(
        db,
        { ...teams(), kickoff: new Date(start.getTime() + 7 * H) },
        6 * H,
      ),
    ).toBeNull();
    // Home and away swapped is another match.
    expect(
      await findScrapedEventId(
        db,
        {
          ...teams(),
          homeTeamId: ctx.team('Everton'),
          awayTeamId: ctx.team('Liverpool'),
          kickoff: start,
        },
        6 * H,
      ),
    ).toBeNull();
  });

  it('two events of the pairing in the window: nothing is guessed', async () => {
    const start = new Date(KICKOFF.getTime() + 50 * 24 * H);
    await createScrapedEvent(ctx, { home: 'Liverpool', away: 'Everton', startTime: start });
    await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Everton',
      startTime: new Date(start.getTime() + 2 * H),
    });
    expect(
      await findScrapedEventId(ctx.handle.db, { ...teams(), kickoff: start }, 6 * H),
    ).toBeNull();
  });

  it('links rows read before the event existed, only rows seen since `since`', async () => {
    await addSource(ctx.handle.db, 'link-1');
    const run = (await addRun(ctx.handle.db, 'link-1', 'ok', at(0))).id;
    const start = new Date(KICKOFF.getTime() + 60 * 24 * H);
    const rows = [
      ...book(null, '23', at(0), {
        sourceKey: 'new',
        kickoff: start,
        homeTeamId: ctx.team('Liverpool'),
        awayTeamId: ctx.team('Everton'),
      }),
      // Unresolved name: never linked.
      ...book(null, '24', at(0), { sourceKey: 'unknown', kickoff: start, homeTeamId: null }),
      // Seen long ago: left alone.
      ...book(null, '25', at(-600), {
        sourceKey: 'old',
        kickoff: new Date(start.getTime() + 24 * H),
        homeTeamId: ctx.team('Liverpool'),
        awayTeamId: ctx.team('Everton'),
      }),
    ];
    await write('link-1', run, rows);
    const none = await ctx.handle.db.transaction((tx) =>
      linkMarketOddsToEvents(tx, { since: at(-60), windowMs: 6 * H }),
    );
    expect(none).toBe(0);

    const event = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Everton',
      startTime: start,
    });
    const linked = await ctx.handle.db.transaction((tx) =>
      linkMarketOddsToEvents(tx, { since: at(-60), windowMs: 6 * H }),
    );
    expect(linked).toBe(3);
    const after = await stored('link-1');
    expect(after.filter((r) => r.eventId === event.eventId).map((r) => r.sourceKey)).toEqual([
      'new',
      'new',
      'new',
    ]);
    expect(after.filter((r) => r.sourceKey !== 'new').every((r) => r.eventId === null)).toBe(true);
  });
});

describe('unresolved names', () => {
  it('lists the distinct names of rows with an unresolved id, and setMarketOddsResolution fills them', async () => {
    await addSource(ctx.handle.db, 'res-1');
    const run = (await addRun(ctx.handle.db, 'res-1', 'ok', at(0))).id;
    await write('res-1', run, [
      ...book(null, '23', at(0), { sourceKey: 'a', homeRaw: 'Arsenal FC??', homeTeamId: null }),
      ...book(null, '24', at(0), { sourceKey: 'a', homeRaw: 'Arsenal FC??', homeTeamId: null }),
      ...book(null, '23', at(0), { sourceKey: 'b' }),
      ...book(null, '25', at(-900), { sourceKey: 'c', homeRaw: 'Old Name', homeTeamId: null }),
    ]);
    const names = await listUnresolvedMarketOddsNames(ctx.handle.db, {
      since: at(-60),
      limit: 100,
    });
    const mine = names.filter((n) => n.sourceId === 'res-1');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      homeRaw: 'Arsenal FC??',
      competitionId: ctx.competitionId,
      homeTeamId: null,
    });

    const changed = await ctx.handle.db.transaction((tx) =>
      setMarketOddsResolution(tx, mine[0]!, {
        competitionId: ctx.competitionId,
        homeTeamId: ctx.team('Arsenal'),
        awayTeamId: ctx.team('Chelsea'),
      }),
    );
    expect(changed).toBe(6);
    const after = await listUnresolvedMarketOddsNames(ctx.handle.db, {
      since: at(-60),
      limit: 100,
    });
    expect(after.filter((n) => n.sourceId === 'res-1')).toHaveLength(0);
  });
});

describe('latestMarketOdds: what the pricing step may read', () => {
  const books = (rows: Awaited<ReturnType<typeof latest>>) => [
    ...new Set(rows.map((r) => `${r.sourceId}:${r.bookmaker}`)),
  ];

  it('a price that has not moved for 12 hours counts when the latest fetch lists it', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'fresh-1', { upstream: 'rundown' });
    const run = (await addRun(ctx.handle.db, 'fresh-1', 'ok', at(30))).id;
    // priceUpdatedAt is 12 h before the sighting (book() default).
    await write('fresh-1', run, [
      ...book(event.eventId, '23', at(30)),
      ...book(event.eventId, '24', at(30)),
    ]);
    const rows = await latest([event.eventId], at(40));
    expect(books(rows)).toEqual(['fresh-1:23', 'fresh-1:24']);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      eventId: event.eventId,
      upstream: 'rundown',
      market: '1x2',
      line: null,
      priceMilli: 2000,
    });
    expect(rows[0]!.observedAt).toEqual(at(30));
    expect(rows[0]!.priceUpdatedAt).toEqual(at(30 - 12 * 60));
  });

  it('a bookmaker the latest fetch no longer lists drops out whole', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'drop-1');
    const run1 = (await addRun(ctx.handle.db, 'drop-1', 'ok', at(0))).id;
    await write('drop-1', run1, [
      ...book(event.eventId, '23', at(0)),
      ...book(event.eventId, '24', at(0)),
      ...book(event.eventId, '25', at(0)),
    ]);
    expect(books(await latest([event.eventId], at(5)))).toEqual([
      'drop-1:23',
      'drop-1:24',
      'drop-1:25',
    ]);
    const run2 = (await addRun(ctx.handle.db, 'drop-1', 'ok', at(30))).id;
    await write('drop-1', run2, [
      ...book(event.eventId, '23', at(30)),
      ...book(event.eventId, '24', at(30)),
    ]);
    expect(books(await latest([event.eventId], at(35)))).toEqual(['drop-1:23', 'drop-1:24']);
  });

  it('an event the latest successful run no longer lists drops out', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'gone-1');
    const run1 = (await addRun(ctx.handle.db, 'gone-1', 'ok', at(0))).id;
    await write('gone-1', run1, book(event.eventId, '23', at(0)));
    expect(await latest([event.eventId], at(5))).toHaveLength(3);
    // The next ok run lists other events only: nothing was written for this one after it started.
    await addRun(ctx.handle.db, 'gone-1', 'ok', at(30));
    expect(await latest([event.eventId], at(35))).toEqual([]);
  });

  it('a failed run is not a latest successful run: the rows stay current until they age out', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'failed-1');
    const run1 = (await addRun(ctx.handle.db, 'failed-1', 'ok', at(0))).id;
    await write('failed-1', run1, book(event.eventId, '23', at(0)));
    await addRun(ctx.handle.db, 'failed-1', 'failed', at(30));
    await addRun(ctx.handle.db, 'failed-1', 'broken', at(45));
    expect(await latest([event.eventId], at(50))).toHaveLength(3);
    expect(await latest([event.eventId], at(3 * 60 + 1))).toEqual([]);
  });

  it('prices last listed longer ago than maxAgeMs are left out; exactly maxAgeMs counts', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'age-1');
    const run = (await addRun(ctx.handle.db, 'age-1', 'ok', at(0))).id;
    await write('age-1', run, book(event.eventId, '23', at(0)));
    expect(await latest([event.eventId], at(2 * 60), 3 * H)).toHaveLength(3);
    expect(await latest([event.eventId], at(3 * 60), 3 * H)).toHaveLength(3);
    expect(await latest([event.eventId], at(3 * 60 + 1), 3 * H)).toEqual([]);
    expect(await latest([event.eventId], at(3 * 60 + 1), 4 * H)).toHaveLength(3);
    expect(await latest([event.eventId], at(30), 10 * MIN)).toEqual([]);
  });

  it('is decided per source: a stale source leaves the fresh one', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'two-a', { upstream: 'up-a' });
    await addSource(ctx.handle.db, 'two-b', { upstream: 'up-b' });
    const a = (await addRun(ctx.handle.db, 'two-a', 'ok', at(0))).id;
    const b = (await addRun(ctx.handle.db, 'two-b', 'ok', at(200))).id;
    await write('two-a', a, book(event.eventId, '23', at(0)));
    await write('two-b', b, book(event.eventId, '23', at(200)));
    const rows = await latest([event.eventId], at(210));
    expect(books(rows)).toEqual(['two-b:23']);
    expect(rows.every((r) => r.upstream === 'up-b')).toBe(true);
  });

  it('a disabled source never votes', async () => {
    const event = await newEvent();
    await addSource(ctx.handle.db, 'off-1');
    const run = (await addRun(ctx.handle.db, 'off-1', 'ok', at(0))).id;
    await write('off-1', run, book(event.eventId, '23', at(0)));
    expect(await latest([event.eventId], at(5))).toHaveLength(3);
    await ctx.handle.db.transaction((tx) => setSourceEnabled(tx, 'off-1', false, SYSTEM));
    expect(await latest([event.eventId], at(5))).toEqual([]);
    await ctx.handle.db.transaction((tx) => setSourceEnabled(tx, 'off-1', true, SYSTEM));
    expect(await latest([event.eventId], at(5))).toHaveLength(3);
  });

  it('rows with no event are never returned; an empty list of events returns nothing', async () => {
    await addSource(ctx.handle.db, 'noevent-1');
    const run = (await addRun(ctx.handle.db, 'noevent-1', 'ok', at(0))).id;
    await write('noevent-1', run, book(null, '23', at(0)));
    const event = await newEvent();
    expect(await latest([event.eventId], at(5))).toEqual([]);
    expect(await latest([], at(5))).toEqual([]);
  });

  it('reads several events at once, sorted by event, source, market, line, bookmaker, selection', async () => {
    const e1 = await newEvent();
    const e2 = await newEvent();
    await addSource(ctx.handle.db, 'multi-1');
    const run = (await addRun(ctx.handle.db, 'multi-1', 'ok', at(0))).id;
    const ou = (eventId: string, line: string) =>
      (['over', 'under'] as const).map((selection) => ({
        ...book(eventId, '23', at(0))[0]!,
        market: 'ou' as const,
        line,
        selection,
        priceMilli: 1900,
        sourceKey: `k-${eventId}`,
      }));
    await write('multi-1', run, [
      ...book(e2.eventId, '24', at(0), { sourceKey: `k-${e2.eventId}` }),
      ...book(e1.eventId, '24', at(0), { sourceKey: `k-${e1.eventId}` }),
      ...book(e1.eventId, '23', at(0), { sourceKey: `k-${e1.eventId}` }),
      ...ou(e1.eventId, '2.5'),
      ...ou(e1.eventId, '1.5'),
    ]);
    const rows = await latest([e2.eventId, e1.eventId, e1.eventId], at(5));
    const ids = [e1.eventId, e2.eventId].sort();
    expect(rows.map((r) => r.eventId)).toEqual(
      [...rows.map((r) => r.eventId)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(new Set(rows.map((r) => r.eventId))).toEqual(new Set(ids));
    const first = rows.filter((r) => r.eventId === e1.eventId);
    expect(first.map((r) => `${r.market}:${r.line}:${r.bookmaker}:${r.selection}`)).toEqual([
      '1x2:null:23:1',
      '1x2:null:23:2',
      '1x2:null:23:X',
      '1x2:null:24:1',
      '1x2:null:24:2',
      '1x2:null:24:X',
      'ou:1.5:23:over',
      'ou:1.5:23:under',
      'ou:2.5:23:over',
      'ou:2.5:23:under',
    ]);
  });
});

describe('pruneMarketOdds', () => {
  it('deletes rows last seen before the cut-off, oldest first, at most `limit`', async () => {
    await addSource(ctx.handle.db, 'prune-1');
    const run = (await addRun(ctx.handle.db, 'prune-1', 'ok', at(0))).id;
    await write('prune-1', run, [
      ...book(null, '23', at(-3 * 24 * 60)),
      ...book(null, '24', at(-2 * 24 * 60)),
      ...book(null, '25', at(0)),
    ]);
    expect(await pruneMarketOdds(ctx.handle.db, at(-24 * 60), 4)).toBe(4);
    expect(await pruneMarketOdds(ctx.handle.db, at(-24 * 60), 4)).toBe(2);
    expect((await stored('prune-1')).map((r) => r.bookmaker)).toEqual(['25', '25', '25']);
  });
});
