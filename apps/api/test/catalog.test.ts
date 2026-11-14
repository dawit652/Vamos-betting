import { randomUUID } from 'node:crypto';
import {
  CompetitionsResponse,
  EventDetail,
  EventListResponse,
  SportsResponse,
  type EventSummary,
} from '@vamos/contracts';
import type { Database } from '@vamos/db';
import { events, sports } from '@vamos/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeEventCursor,
  encodeEventCursor,
  addisAbabaDay,
} from '../src/modules/catalog/queries';
import { isSelectionOpen } from '../src/modules/catalog/views';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-08T12:00:00.000Z'); // 15:00 in Addis Ababa
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const hours = (n: number) => minutes(n * 60);

let ctx: TestContext;
let db: Database;

const ids = {} as Record<
  | 'football'
  | 'premier'
  | 'ethiopian'
  | 'caf'
  | 'closedCup'
  | 'nba'
  | 'atp'
  | 'arsenal'
  | 'chelsea'
  | 'liverpool'
  | 'stGeorge'
  | 'fasil'
  | 'ahly'
  | 'wydad'
  | 'celtics'
  | 'lakers'
  | 'sinner'
  | 'alcaraz',
  string
>;
const ev = {} as Record<
  | 'live'
  | 'soon'
  | 'tomorrow'
  | 'caf'
  | 'far'
  | 'finished'
  | 'inactive'
  | 'cancelled'
  | 'closedBetting'
  | 'nbaLive'
  | 'nbaSoon',
  { id: string; gameId: number }
>;
const atpEvents: string[] = [];
let soonMarkets: Record<string, Awaited<ReturnType<typeof insertMarket>>> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.clock.now = NOW;
  db = ctx.db.db;

  await insertSport(db, 'football', { en: 'Football', am: 'እግር ኳስ' }, 10);
  await insertSport(db, 'basketball', { en: 'Basketball', am: 'የቅርጫት ኳስ' }, 20);
  await insertSport(db, 'tennis', { en: 'Tennis', am: 'ቴኒስ' }, 30);
  await insertSport(db, 'volleyball', { en: 'Volleyball' }, 40, false);

  const england = await insertCategory(db, 'football', 'england', { en: 'England' }, 10);
  const ethiopia = await insertCategory(
    db,
    'football',
    'ethiopia',
    { en: 'Ethiopia', am: 'ኢትዮጵያ' },
    20,
  );
  const africa = await insertCategory(db, 'football', 'africa', { en: 'Africa' }, 30);
  const usa = await insertCategory(db, 'basketball', 'usa', { en: 'USA' }, 10);
  const international = await insertCategory(db, 'tennis', 'international', { en: 'World' }, 10);

  ids.premier = await insertCompetition(db, {
    sportId: 'football',
    categoryId: england,
    slug: 'premier-league',
    name: { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
    featured: true,
    sortOrder: 10,
  });
  ids.closedCup = await insertCompetition(db, {
    sportId: 'football',
    categoryId: england,
    slug: 'closed-cup',
    name: { en: 'Closed Cup' },
    active: false,
    sortOrder: 20,
  });
  ids.ethiopian = await insertCompetition(db, {
    sportId: 'football',
    categoryId: ethiopia,
    slug: 'ethiopian-premier-league',
    name: { en: 'Ethiopian Premier League', am: 'የኢትዮጵያ ፕሪምየር ሊግ' },
    featured: true,
  });
  ids.caf = await insertCompetition(db, {
    sportId: 'football',
    categoryId: africa,
    slug: 'caf-champions-league',
    name: { en: 'CAF Champions League' },
    sortOrder: 10,
  });
  await insertCompetition(db, {
    sportId: 'football',
    categoryId: africa,
    slug: 'caf-confederation-cup',
    name: { en: 'CAF Confederation Cup' },
    sortOrder: 20,
  });
  ids.nba = await insertCompetition(db, {
    sportId: 'basketball',
    categoryId: usa,
    slug: 'nba',
    name: { en: 'NBA' },
    featured: true,
  });
  ids.atp = await insertCompetition(db, {
    sportId: 'tennis',
    categoryId: international,
    slug: 'atp-tour',
    name: { en: 'ATP Tour' },
    featured: true,
  });

  ids.arsenal = await insertTeam(db, 'football', 'Arsenal', { en: 'Arsenal' });
  ids.chelsea = await insertTeam(db, 'football', 'Chelsea', { en: 'Chelsea' });
  ids.liverpool = await insertTeam(db, 'football', 'Liverpool', { en: 'Liverpool' });
  ids.stGeorge = await insertTeam(db, 'football', 'St George', {
    en: 'Saint George',
    am: 'ቅዱስ ጊዮርጊስ',
  });
  ids.fasil = await insertTeam(db, 'football', 'Fasil Kenema', {
    en: 'Fasil Kenema',
    am: 'ፋሲል ከነማ',
  });
  ids.ahly = await insertTeam(db, 'football', 'Al Ahly', { en: 'Al Ahly' });
  ids.wydad = await insertTeam(db, 'football', 'Wydad', { en: 'Wydad AC' });
  ids.celtics = await insertTeam(db, 'basketball', 'Celtics', { en: 'Boston Celtics' });
  ids.lakers = await insertTeam(db, 'basketball', 'Lakers', { en: 'Los Angeles Lakers' });
  ids.sinner = await insertTeam(db, 'tennis', 'Sinner', { en: 'Jannik Sinner' });
  ids.alcaraz = await insertTeam(db, 'tennis', 'Alcaraz', { en: 'Carlos Alcaraz' });

  const pl = { sportId: 'football', competitionId: ids.premier };
  ev.live = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.arsenal,
    awayTeamId: ids.chelsea,
    startTime: minutes(-30),
    status: 'live',
    liveMinute: 31,
    period: '1H',
    score: [1, 0],
  });
  await insertMarket(db, ev.live.id, 'cs', null, [['1-0', 6500]], 'closed');
  await insertMarket(
    db,
    ev.live.id,
    'btts',
    null,
    [
      ['yes', 1700],
      ['no', 2050],
    ],
    'suspended',
  );
  await insertMarket(db, ev.live.id, '1x2', null, ONE_X_TWO);
  await insertMarket(db, ev.live.id, 'ou', '2.5', [
    ['under', 1950],
    ['over', 1850],
  ]);
  await insertMarket(
    db,
    ev.live.id,
    'dnb',
    null,
    [
      ['1', 1300],
      ['2', 3300],
    ],
    'settled',
  );

  ev.soon = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.ethiopian,
    homeTeamId: ids.stGeorge,
    awayTeamId: ids.fasil,
    startTime: hours(2),
    gameId: 123,
  });
  soonMarkets = {
    htOneXTwo: await insertMarket(db, ev.soon.id, 'ht_1x2', null, ONE_X_TWO),
    ou25: await insertMarket(db, ev.soon.id, 'ou', '2.5', [
      ['over', 2100],
      ['under', 1720],
    ]),
    cs: await insertMarket(db, ev.soon.id, 'cs', null, [
      ['other', 9000],
      ['1-0', 6000],
      ['0-0', 8000],
    ]),
    oneXTwo: await insertMarket(db, ev.soon.id, '1x2', null, [
      ['X', 3100],
      ['2', 3900, 'suspended'],
      ['1', 2000],
    ]),
    ou15: await insertMarket(
      db,
      ev.soon.id,
      'ou',
      '1.5',
      [
        ['over', 1400],
        ['under', 2800],
      ],
      'suspended',
    ),
    dc: await insertMarket(db, ev.soon.id, 'dc', null, [
      ['X2', 1900],
      ['12', 1300],
      ['1X', 1250],
    ]),
    // Not a market type of the catalogue, or not one of football: never shown or counted.
    unknown: await insertMarket(db, ev.soon.id, 'corners', null, []),
    otherSport: await insertMarket(db, ev.soon.id, 'ml', null, [['1', 1500]]),
  };

  ev.tomorrow = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.liverpool,
    awayTeamId: ids.arsenal,
    startTime: hours(30),
  });
  await insertMarket(db, ev.tomorrow.id, '1x2', null, ONE_X_TWO);
  ev.caf = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.caf,
    homeTeamId: ids.ahly,
    awayTeamId: ids.wydad,
    startTime: hours(3),
  });
  ev.far = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.chelsea,
    awayTeamId: ids.liverpool,
    startTime: hours(80),
  });
  ev.finished = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.chelsea,
    awayTeamId: ids.arsenal,
    startTime: hours(-3),
    status: 'finished',
    score: [2, 1],
    htScore: [1, 0],
  });
  await insertMarket(db, ev.finished.id, '1x2', null, [
    ['1', 1900, 'settled'],
    ['X', 3500, 'settled'],
    ['2', 4000, 'settled'],
  ]);
  ev.inactive = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.closedCup,
    homeTeamId: ids.arsenal,
    awayTeamId: ids.liverpool,
    startTime: hours(1),
  });
  ev.cancelled = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.liverpool,
    awayTeamId: ids.chelsea,
    startTime: hours(1),
    status: 'cancelled',
  });
  ev.closedBetting = await insertEvent(db, {
    ...pl,
    homeTeamId: ids.arsenal,
    awayTeamId: ids.liverpool,
    startTime: hours(4),
    bettingOpen: false,
  });
  await insertMarket(db, ev.closedBetting.id, '1x2', null, ONE_X_TWO);

  ev.nbaLive = await insertEvent(db, {
    sportId: 'basketball',
    competitionId: ids.nba,
    homeTeamId: ids.celtics,
    awayTeamId: ids.lakers,
    startTime: minutes(-50),
    status: 'live',
    period: 'Q3',
    score: [71, 66],
  });
  await insertMarket(db, ev.nbaLive.id, 'total', '215.5', [
    ['over', 1900],
    ['under', 1900],
  ]);
  await insertMarket(db, ev.nbaLive.id, 'ml', null, [
    ['2', 2600],
    ['1', 1500],
  ]);
  ev.nbaSoon = await insertEvent(db, {
    sportId: 'basketball',
    competitionId: ids.nba,
    homeTeamId: ids.lakers,
    awayTeamId: ids.celtics,
    startTime: hours(5),
  });

  // 25 tennis matches for pagination: pairs share a start time, and two start
  // within the same millisecond (microsecond precision must survive the cursor).
  for (let i = 0; i < 25; i++) {
    const event = await insertEvent(db, {
      sportId: 'tennis',
      competitionId: ids.atp,
      homeTeamId: i % 2 === 0 ? ids.sinner : ids.alcaraz,
      awayTeamId: i % 2 === 0 ? ids.alcaraz : ids.sinner,
      startTime: hours(1 + Math.floor(i / 2)),
    });
    await insertMarket(db, event.id, 'winner', null, [
      ['1', 1800],
      ['2', 2000],
    ]);
    atpEvents.push(event.id);
  }
  await db.execute(
    sql`UPDATE ${events} SET start_time = '2026-10-08T13:00:00.123456Z' WHERE id = ${atpEvents[0]!}`,
  );
  await db.execute(
    sql`UPDATE ${events} SET start_time = '2026-10-08T13:00:00.123789Z' WHERE id = ${atpEvents[1]!}`,
  );
});

afterAll(async () => {
  await ctx?.close();
});

async function get(url: string) {
  return ctx.app.inject({ method: 'GET', url });
}

async function listIds(url: string): Promise<string[]> {
  const response = await get(url);
  expect(response.statusCode).toBe(200);
  return EventListResponse.parse(response.json()).items.map((item) => item.id);
}

/** Every page of a list, following nextCursor (from `start` when given). */
async function allPages(
  url: string,
  limit: number,
  start: string | null = null,
): Promise<EventSummary[][]> {
  const pages: EventSummary[][] = [];
  let cursor: string | null = start;
  do {
    const separator = url.includes('?') ? '&' : '?';
    const query: string = `${url}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
    const response = await get(query);
    expect(response.statusCode).toBe(200);
    const body = EventListResponse.parse(response.json());
    pages.push(body.items);
    cursor = body.nextCursor;
  } while (cursor !== null && pages.length < 50);
  return pages;
}

describe('GET /sports', () => {
  it('lists active sports with live and next-72h scheduled counts', async () => {
    const response = await get('/sports');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=5');
    const body = SportsResponse.parse(response.json());
    expect(body.items).toEqual([
      // live: the PL match. upcoming: soon, tomorrow, caf, closedBetting (not far,
      // finished, cancelled, or the inactive competition's match).
      {
        id: 'football',
        name: { en: 'Football', am: 'እግር ኳስ' },
        liveCount: 1,
        upcomingCount: 4,
      },
      {
        id: 'basketball',
        name: { en: 'Basketball', am: 'የቅርጫት ኳስ' },
        liveCount: 1,
        upcomingCount: 1,
      },
      { id: 'tennis', name: { en: 'Tennis', am: 'ቴኒስ' }, liveCount: 0, upcomingCount: 25 },
    ]);
  });
});

describe('GET /sports/:sport/competitions', () => {
  it('groups the active competitions by category with their event counts', async () => {
    const response = await get('/sports/football/competitions');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=5');
    const body = CompetitionsResponse.parse(response.json());
    expect(body.items).toEqual([
      {
        category: { slug: 'england', name: { en: 'England' } },
        competitions: [
          {
            slug: 'premier-league',
            name: { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
            eventCount: 3, // live, tomorrow, closedBetting
          },
        ],
      },
      {
        category: { slug: 'ethiopia', name: { en: 'Ethiopia', am: 'ኢትዮጵያ' } },
        competitions: [
          {
            slug: 'ethiopian-premier-league',
            name: { en: 'Ethiopian Premier League', am: 'የኢትዮጵያ ፕሪምየር ሊግ' },
            eventCount: 1,
          },
        ],
      },
      {
        category: { slug: 'africa', name: { en: 'Africa' } },
        competitions: [
          { slug: 'caf-champions-league', name: { en: 'CAF Champions League' }, eventCount: 1 },
          { slug: 'caf-confederation-cup', name: { en: 'CAF Confederation Cup' }, eventCount: 0 },
        ],
      },
    ]);
  });

  it('is 404 for an unknown or inactive sport', async () => {
    for (const sport of ['cricket', 'volleyball', 'FOOTBALL']) {
      const response = await get(`/sports/${sport}/competitions`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});

describe('GET /events', () => {
  it('defaults to football highlights: featured, live or within 24h, live first', async () => {
    const response = await get('/events');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=5');
    const body = EventListResponse.parse(response.json());
    expect(body.items.map((item) => item.id)).toEqual([
      ev.live.id,
      ev.soon.id,
      ev.closedBetting.id,
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it('builds list rows with the main market, "+N markets" and game id', async () => {
    const body = EventListResponse.parse((await get('/events?filter=highlights')).json());
    const [live, soon, closed] = body.items;

    expect(live).toMatchObject({
      gameId: String(ev.live.gameId).padStart(4, '0'),
      sport: 'football',
      competition: {
        slug: 'premier-league',
        name: { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
        category: { en: 'England' },
      },
      home: { id: ids.arsenal, name: { en: 'Arsenal' }, shortName: 'Arsenal' },
      away: { id: ids.chelsea, name: { en: 'Chelsea' }, shortName: 'Chelsea' },
      startTime: minutes(-30).toISOString(),
      status: 'live',
      liveMinute: 31,
      period: '1H',
      score: { home: 1, away: 0 },
      // ou 2.5 (open) and btts (suspended); not cs (closed) or dnb (settled).
      marketCount: 2,
    });
    expect(live?.mainMarket).toMatchObject({
      type: '1x2',
      line: null,
      name: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
      status: 'open',
    });
    expect(live?.mainMarket?.selections.map((s) => [s.code, s.label, s.oddsMilli, s.open])).toEqual(
      [
        ['1', { en: 'Arsenal', am: 'Arsenal' }, 1850, true],
        ['X', { en: 'Draw', am: 'አቻ' }, 3400, true],
        ['2', { en: 'Chelsea', am: 'Chelsea' }, 4200, true],
      ],
    );

    expect(soon).toMatchObject({
      gameId: '0123',
      status: 'scheduled',
      score: null,
      liveMinute: null,
      // dc, ou 1.5 (suspended), ou 2.5, ht_1x2, cs; not the unknown market type.
      marketCount: 5,
    });
    expect(soon?.home.name).toEqual({ en: 'Saint George', am: 'ቅዱስ ጊዮርጊስ' });
    expect(soon?.mainMarket?.selections.map((s) => [s.code, s.label.am, s.open])).toEqual([
      ['1', 'ቅዱስ ጊዮርጊስ', true],
      ['X', 'አቻ', true],
      ['2', 'ፋሲል ከነማ', false],
    ]);

    expect(closed?.mainMarket?.selections.every((s) => !s.open)).toBe(true);
    expect(closed?.marketCount).toBe(0);
  });

  it('filters upcoming: scheduled within 72h, in start order', async () => {
    expect(await listIds('/events?filter=upcoming')).toEqual([
      ev.soon.id,
      ev.caf.id,
      ev.closedBetting.id,
      ev.tomorrow.id,
    ]);
    expect(await listIds('/events?filter=upcoming&sport=basketball')).toEqual([ev.nbaSoon.id]);
  });

  it('filters live', async () => {
    expect(await listIds('/events?filter=live')).toEqual([ev.live.id]);
    const response = await get('/events?filter=live&sport=basketball');
    const body = EventListResponse.parse(response.json());
    expect(body.items.map((item) => item.id)).toEqual([ev.nbaLive.id]);
    expect(body.items[0]?.mainMarket?.type).toBe('ml');
    expect(body.items[0]?.marketCount).toBe(1);
    expect(body.items[0]?.score).toEqual({ home: 71, away: 66 });
  });

  it('filters by competition slug', async () => {
    expect(await listIds('/events?filter=upcoming&competition=premier-league')).toEqual([
      ev.closedBetting.id,
      ev.tomorrow.id,
    ]);
    expect(await listIds('/events?filter=upcoming&competition=nope')).toEqual([]);
    // A competition slug of another sport matches nothing.
    expect(await listIds('/events?filter=live&competition=nba')).toEqual([]);
  });

  it('filters today by the Addis Ababa calendar date (midnight is 21:00 UTC)', async () => {
    // 15:00 in Addis: today runs from 2026-10-07T21:00Z to 2026-10-08T21:00Z.
    expect(addisAbabaDay(NOW)).toEqual({
      start: new Date('2026-10-07T21:00:00.000Z'),
      end: new Date('2026-10-08T21:00:00.000Z'),
    });
    expect(await listIds('/events?filter=today')).toEqual([
      ev.live.id,
      ev.soon.id,
      ev.caf.id,
      ev.closedBetting.id,
    ]);

    const beforeMidnight = await insertEvent(db, {
      sportId: 'football',
      competitionId: ids.caf,
      homeTeamId: ids.wydad,
      awayTeamId: ids.ahly,
      startTime: new Date('2026-10-08T20:59:59.999Z'),
    });
    const atMidnight = await insertEvent(db, {
      sportId: 'football',
      competitionId: ids.caf,
      homeTeamId: ids.ahly,
      awayTeamId: ids.wydad,
      startTime: new Date('2026-10-08T21:00:00.000Z'),
    });
    try {
      const today = await listIds('/events?filter=today&competition=caf-champions-league');
      expect(today).toEqual([ev.caf.id, beforeMidnight.id]);

      // At 21:00 UTC it is already tomorrow in Addis Ababa.
      ctx.clock.now = new Date('2026-10-08T21:00:00.000Z');
      expect(await listIds('/events?filter=today&competition=caf-champions-league')).toEqual([
        atMidnight.id,
      ]);
      ctx.clock.now = new Date('2026-10-08T20:59:59.999Z');
      expect(await listIds('/events?filter=today&competition=caf-champions-league')).toEqual([
        ev.caf.id,
        beforeMidnight.id,
      ]);
    } finally {
      ctx.clock.now = NOW;
      await db.delete(events).where(eq(events.id, beforeMidnight.id));
      await db.delete(events).where(eq(events.id, atMidnight.id));
    }
  });

  it('pages by (start time, id) without gaps or repeats', async () => {
    const all = EventListResponse.parse(
      (await get('/events?sport=tennis&filter=upcoming&limit=100')).json(),
    ).items;
    expect(all).toHaveLength(25);
    expect(new Set(all.map((item) => item.id))).toEqual(new Set(atpEvents));
    // Ordered by the exact start time (microseconds, so the two 13:00:00.123xxx
    // matches keep their order) and then id.
    const expected = await db.execute<{ id: string }>(
      sql`SELECT id FROM ${events} WHERE sport_id = 'tennis' ORDER BY start_time, id`,
    );
    expect(all.map((item) => item.id)).toEqual(expected.rows.map((row) => row.id));
    expect(all.slice(0, 2).map((item) => item.id)).toEqual(atpEvents.slice(0, 2));
    expect(all[0]?.startTime).toBe('2026-10-08T13:00:00.123Z');
    expect(all[1]?.startTime).toBe('2026-10-08T13:00:00.123Z');

    for (const limit of [1, 2, 7, 24, 25]) {
      const pages = await allPages('/events?sport=tennis&filter=upcoming', limit);
      expect(pages.flat().map((item) => item.id)).toEqual(all.map((item) => item.id));
      expect(pages.at(-1)?.length).toBeGreaterThan(0);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(limit);
    }
  });

  it('keeps its place when events are added before the cursor', async () => {
    const first = EventListResponse.parse(
      (await get('/events?sport=tennis&filter=upcoming&limit=10')).json(),
    );
    expect(first.nextCursor).not.toBeNull();
    const early = await insertEvent(db, {
      sportId: 'tennis',
      competitionId: ids.atp,
      homeTeamId: ids.sinner,
      awayTeamId: ids.alcaraz,
      startTime: minutes(10),
    });
    try {
      const rest = (
        await allPages('/events?sport=tennis&filter=upcoming', 10, first.nextCursor)
      ).flat();
      const seen = [...first.items, ...rest].map((item) => item.id);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).not.toContain(early.id);
    } finally {
      await db.delete(events).where(eq(events.id, early.id));
    }
  });

  it('lists a given Addis Ababa date instead of the filter window', async () => {
    // 2026-10-08 in Addis: the live match and everything else starting before 21:00 UTC.
    expect(await listIds('/events?date=2026-10-08')).toEqual(await listIds('/events?filter=today'));
    // The date wins over the filter (here: live would list the live match only).
    expect(await listIds('/events?filter=live&date=2026-10-09')).toEqual([ev.tomorrow.id]);
    // 80 hours ahead is beyond "upcoming" (72h) but on its own calendar day.
    expect(await listIds('/events?date=2026-10-11')).toEqual([ev.far.id]);
    // Finished and cancelled matches of a past day are not listed; nor is an empty day.
    expect(await listIds('/events?date=2026-10-07')).toEqual([]);
    expect(await listIds('/events?date=2026-10-10')).toEqual([]);
    expect(await listIds('/events?date=2026-10-08&competition=caf-champions-league')).toEqual([
      ev.caf.id,
    ]);
    expect(await listIds('/events?sport=basketball&date=2026-10-08')).toEqual([
      ev.nbaLive.id,
      ev.nbaSoon.id,
    ]);
  });

  it('puts double chance on football rows for market=dc', async () => {
    const rows = EventListResponse.parse((await get('/events?filter=today&market=dc')).json());
    const soon = rows.items.find((item) => item.id === ev.soon.id)!;
    expect(soon.mainMarket).toMatchObject({
      id: soonMarkets.dc!.id,
      type: 'dc',
      status: 'open',
    });
    expect(soon.mainMarket!.selections.map((selection) => selection.code)).toEqual([
      '1X',
      '12',
      'X2',
    ]);
    expect(soon.mainMarket!.selections.map((selection) => selection.oddsMilli)).toEqual([
      1250, 1300, 1900,
    ]);
    // "+N markets" now counts 1X2 instead of double chance: the same number.
    const main = EventListResponse.parse((await get('/events?filter=today')).json());
    expect(soon.marketCount).toBe(main.items.find((item) => item.id === ev.soon.id)!.marketCount);
    // A match without a double chance market has no row market.
    expect(rows.items.find((item) => item.id === ev.live.id)!.mainMarket).toBeNull();
    // Other sports have no double chance: they keep their main market.
    const nba = EventListResponse.parse(
      (await get('/events?sport=basketball&filter=live&market=dc')).json(),
    );
    expect(nba.items[0]!.mainMarket).toMatchObject({ type: 'ml' });
  });

  it('lists top matches: marked by a trader, live or within 72h', async () => {
    expect(await listIds('/events?filter=top')).toEqual([]);
    await db
      .update(events)
      .set({ topMatch: true })
      .where(
        inArray(events.id, [ev.tomorrow.id, ev.caf.id, ev.far.id, ev.finished.id, ev.inactive.id]),
      );
    try {
      // Not the one 80h ahead, the finished one or the one of an inactive competition.
      expect(await listIds('/events?filter=top')).toEqual([ev.caf.id, ev.tomorrow.id]);
      expect(await listIds('/events?filter=top&limit=1')).toEqual([ev.caf.id]);
      expect(await listIds('/events?sport=basketball&filter=top')).toEqual([]);
    } finally {
      await db.update(events).set({ topMatch: false });
    }
  });

  it('rejects malformed cursors and queries', async () => {
    const valid = encodeEventCursor({
      startTime: '2026-10-08T13:00:00.123456Z',
      id: randomUUID(),
    });
    expect(decodeEventCursor(valid).startTime).toBe('2026-10-08T13:00:00.123456Z');
    expect((await get(`/events?cursor=${valid}`)).statusCode).toBe(200);
    const yearOne = encodeEventCursor({
      startTime: '0001-01-01T00:00:00.000000Z',
      id: randomUUID(),
    });
    expect((await get(`/events?cursor=${yearOne}`)).statusCode).toBe(200);

    const bad = [
      'not a cursor!',
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from(JSON.stringify(['2026-13-40T13:00:00.000000Z', randomUUID()])).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify(['2026-10-08T13:00:00.000000Z', 'x'])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-10-08T13:00:00Z', randomUUID()])).toString('base64url'),
      // Year 0000 is a valid JavaScript date but out of PostgreSQL's range (regression: was 500).
      Buffer.from(JSON.stringify(['0000-01-01T00:00:00.000000Z', randomUUID()])).toString(
        'base64url',
      ),
    ];
    for (const cursor of bad) {
      const response = await get(`/events?cursor=${encodeURIComponent(cursor)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
    }
    for (const query of [
      'filter=soon',
      'sport=cricket',
      'limit=0',
      'limit=101',
      'market=ou',
      'date=tomorrow',
      'date=2026-02-30',
      'date=2026-1-5',
    ]) {
      const response = await get(`/events?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
  });

  it('loads a page with a fixed number of queries (no N+1)', async () => {
    const pool = ctx.db.pool;
    const original = pool.query.bind(pool);
    let queries = 0;
    (pool as { query: unknown }).query = (...args: unknown[]) => {
      queries += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const response = await get('/events?sport=tennis&filter=upcoming&limit=25');
      expect(EventListResponse.parse(response.json()).items).toHaveLength(25);
      expect(queries).toBe(3); // events, markets, main-market selections
    } finally {
      (pool as { query: unknown }).query = original;
    }
  });
});

describe('GET /events/search', () => {
  async function search(q: string, extra = ''): Promise<string[]> {
    return listIds(`/events/search?q=${encodeURIComponent(q)}${extra}`);
  }

  it('finds live and coming matches by team name, in English or Amharic, in any case', async () => {
    // Arsenal: live, tomorrow and the one with betting closed; not finished or inactive ones.
    expect(await search('arsenal')).toEqual([ev.live.id, ev.closedBetting.id, ev.tomorrow.id]);
    expect(await search('ARSEN')).toEqual(await search('arsenal'));
    expect(await search('ጊዮርጊስ')).toEqual([ev.soon.id]);
    expect(await search('St George')).toEqual([ev.soon.id]); // the short name
    expect(await search('  wydad ')).toEqual([ev.caf.id]);
    expect(await search('no such team')).toEqual([]);
  });

  it('finds matches by competition name across sports, soonest first', async () => {
    expect(await search('ethiopian premier')).toEqual([ev.soon.id]);
    expect(await search('ፕሪምየር')).toEqual([ev.soon.id]);
    expect(await search('NBA')).toEqual([ev.nbaLive.id, ev.nbaSoon.id]);
    // Football (Arsenal) and tennis (Alcaraz) matches in one list, in start order.
    expect(await search('ar', '&limit=2')).toEqual([ev.live.id, atpEvents[0]]);
  });

  it('finds a match by its Game ID', async () => {
    expect(await search('123')).toEqual([ev.soon.id]);
    expect(await search('0123')).toEqual([ev.soon.id]);
  });

  it('returns list rows with the main market and no cursor', async () => {
    const body = EventListResponse.parse((await get('/events/search?q=fasil')).json());
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.mainMarket).toMatchObject({ id: soonMarkets.oneXTwo!.id, type: '1x2' });
  });

  it('treats LIKE wildcards as plain text and limits the page', async () => {
    expect(await search('%%')).toEqual([]);
    expect(await search('__')).toEqual([]);
    expect(await search('a\\')).toEqual([]);
    expect(await search('sinner', '&limit=5')).toHaveLength(5);
    expect((await search('sinner')).length).toBe(20);
  });

  it('rejects a missing, too short or too long query', async () => {
    for (const query of ['', 'q=', 'q=a', 'q=%20a%20', `q=${'x'.repeat(61)}`, 'q=ab&limit=51']) {
      const response = await get(`/events/search?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
  });
});

describe('GET /events/:id and /events/by-game-id/:gameId', () => {
  it('returns every market in display order with ordered, labelled selections', async () => {
    const response = await get(`/events/${ev.soon.id}`);
    expect(response.statusCode).toBe(200);
    const body = EventDetail.parse(response.json());
    expect(body.id).toBe(ev.soon.id);
    expect(body.gameId).toBe('0123');
    expect(body.htScore).toBeNull();
    expect(body.marketCount).toBe(5);
    expect(body.mainMarket?.id).toBe(soonMarkets.oneXTwo!.id);
    expect(body.markets.map((m) => [m.type, m.line, m.status, m.name.en])).toEqual([
      ['1x2', null, 'open', 'Match Result'],
      ['dc', null, 'open', 'Double Chance'],
      ['ou', '1.5', 'suspended', 'Total Goals Over/Under'],
      ['ou', '2.5', 'open', 'Total Goals Over/Under'],
      ['ht_1x2', null, 'open', 'Half-time Result'],
      ['cs', null, 'open', 'Correct Score'],
    ]);
    const byType = (type: string, line: string | null = null) =>
      body.markets.find((m) => m.type === type && m.line === line)!;
    expect(byType('dc').selections.map((s) => [s.code, s.label])).toEqual([
      ['1X', { en: 'Saint George or Draw', am: 'ቅዱስ ጊዮርጊስ ወይም አቻ' }],
      ['12', { en: 'Saint George or Fasil Kenema', am: 'ቅዱስ ጊዮርጊስ ወይም ፋሲል ከነማ' }],
      ['X2', { en: 'Draw or Fasil Kenema', am: 'አቻ ወይም ፋሲል ከነማ' }],
    ]);
    expect(byType('ou', '2.5').selections.map((s) => [s.code, s.label, s.oddsMilli])).toEqual([
      ['over', { en: 'Over 2.5', am: 'ከ2.5 በላይ' }, 2100],
      ['under', { en: 'Under 2.5', am: 'ከ2.5 በታች' }, 1720],
    ]);
    expect(byType('ou', '1.5').selections.every((s) => !s.open)).toBe(true);
    expect(byType('cs').selections.map((s) => s.code)).toEqual(['0-0', '1-0', 'other']);
    expect(byType('cs').selections[2]?.label).toEqual({ en: 'Any other score', am: 'ሌላ ውጤት' });
    expect(byType('1x2').selections.map((s) => s.id)).toEqual([
      soonMarkets.oneXTwo!.selectionIds['1'],
      soonMarkets.oneXTwo!.selectionIds['X'],
      soonMarkets.oneXTwo!.selectionIds['2'],
    ]);
  });

  it('finds an event by its Game ID, padded or not', async () => {
    const padded = await get('/events/by-game-id/0123');
    expect(padded.statusCode).toBe(200);
    expect(EventDetail.parse(padded.json()).id).toBe(ev.soon.id);
    const plain = await get('/events/by-game-id/123');
    expect(EventDetail.parse(plain.json()).id).toBe(ev.soon.id);

    const live = await get(`/events/by-game-id/${ev.nbaLive.gameId}`);
    const detail = EventDetail.parse(live.json());
    expect(detail.sport).toBe('basketball');
    expect(detail.markets.map((m) => [m.type, m.line])).toEqual([
      ['ml', null],
      ['total', '215.5'],
    ]);
  });

  it('shows finished events with their scores and closed selections', async () => {
    const body = EventDetail.parse((await get(`/events/${ev.finished.id}`)).json());
    expect(body.status).toBe('finished');
    expect(body.score).toEqual({ home: 2, away: 1 });
    expect(body.htScore).toEqual({ home: 1, away: 0 });
    expect(body.marketCount).toBe(0);
    expect(body.markets.flatMap((m) => m.selections).every((s) => !s.open)).toBe(true);
  });

  it('is 404 for events of an inactive competition or sport, like every list (regression)', async () => {
    // The closed cup's match is in no list, so it is not found by id or Game ID either.
    expect(await listIds('/events?filter=upcoming')).not.toContain(ev.inactive.id);
    for (const url of [`/events/${ev.inactive.id}`, `/events/by-game-id/${ev.inactive.gameId}`]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    await db.update(sports).set({ active: false }).where(eq(sports.id, 'basketball'));
    try {
      expect((await get(`/events/${ev.nbaSoon.id}`)).statusCode).toBe(404);
      expect((await get(`/events/by-game-id/${ev.nbaLive.gameId}`)).statusCode).toBe(404);
    } finally {
      await db.update(sports).set({ active: true }).where(eq(sports.id, 'basketball'));
    }
    expect((await get(`/events/${ev.nbaSoon.id}`)).statusCode).toBe(200);
  });

  it('is 404 for unknown or malformed ids', async () => {
    for (const url of [
      `/events/${randomUUID()}`,
      '/events/not-a-uuid',
      '/events/1234',
      '/events/by-game-id/99999',
      '/events/by-game-id/99',
      '/events/by-game-id/abc',
      '/events/by-game-id/1234567',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});

describe('selection open flag', () => {
  const event = { status: 'scheduled', bettingOpen: true, startTime: hours(1) } as const;
  const market = { status: 'open' } as const;
  const selection = { status: 'open' } as const;

  it('is open only when selection, market and event all allow betting', () => {
    expect(isSelectionOpen(event, market, selection, NOW)).toBe(true);
    expect(isSelectionOpen({ ...event, status: 'live' }, market, selection, NOW)).toBe(true);
    expect(isSelectionOpen(event, market, { status: 'suspended' }, NOW)).toBe(false);
    expect(isSelectionOpen(event, market, { status: 'settled' }, NOW)).toBe(false);
    for (const status of ['suspended', 'closed', 'settled', 'void'] as const) {
      expect(isSelectionOpen(event, { status }, selection, NOW)).toBe(false);
    }
    expect(isSelectionOpen({ ...event, bettingOpen: false }, market, selection, NOW)).toBe(false);
    for (const status of ['finished', 'cancelled', 'postponed', 'abandoned'] as const) {
      expect(isSelectionOpen({ ...event, status }, market, selection, NOW)).toBe(false);
    }
    // Prematch betting closes at the start time, even before the kick-off is recorded.
    expect(isSelectionOpen(event, market, selection, hours(1))).toBe(false);
    expect(isSelectionOpen({ ...event, startTime: minutes(-30) }, market, selection, NOW)).toBe(
      false,
    );
    expect(
      isSelectionOpen(
        { ...event, status: 'live', startTime: minutes(-30) },
        market,
        selection,
        NOW,
      ),
    ).toBe(true);
  });

  it('closes a scheduled event past its start time in every view (regression)', async () => {
    const late = await insertEvent(db, {
      sportId: 'football',
      competitionId: ids.premier,
      homeTeamId: ids.liverpool,
      awayTeamId: ids.chelsea,
      startTime: minutes(-30),
    });
    await insertMarket(db, late.id, '1x2', null, ONE_X_TWO);
    try {
      const detail = EventDetail.parse((await get(`/events/${late.id}`)).json());
      expect(detail.status).toBe('scheduled');
      expect(detail.markets[0]?.selections.map((s) => s.open)).toEqual([false, false, false]);
      const today = EventListResponse.parse((await get('/events?filter=today')).json());
      const row = today.items.find((item) => item.id === late.id);
      expect(row?.mainMarket?.selections.every((s) => !s.open)).toBe(true);
      expect(await listIds('/events?filter=highlights')).not.toContain(late.id);
      // Until its start time the same event is open.
      ctx.clock.now = minutes(-31);
      const before = EventDetail.parse((await get(`/events/${late.id}`)).json());
      expect(before.markets[0]?.selections.every((s) => s.open)).toBe(true);
    } finally {
      ctx.clock.now = NOW;
      await db.delete(events).where(eq(events.id, late.id));
    }
  });

  it('follows suspensions and event status changes in the API', async () => {
    const before = EventDetail.parse((await get(`/events/${ev.tomorrow.id}`)).json());
    expect(before.markets[0]?.selections.every((s) => s.open)).toBe(true);

    await db.update(events).set({ status: 'postponed' }).where(eq(events.id, ev.tomorrow.id));
    try {
      const postponed = EventDetail.parse((await get(`/events/${ev.tomorrow.id}`)).json());
      expect(postponed.markets[0]?.selections.some((s) => s.open)).toBe(false);
      expect(postponed.score).toBeNull();
    } finally {
      await db.update(events).set({ status: 'scheduled' }).where(eq(events.id, ev.tomorrow.id));
    }
  });
});
