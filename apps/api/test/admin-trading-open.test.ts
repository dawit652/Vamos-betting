import { ApiErrorSchema } from '@vamos/contracts';
import { schema, setTeamRatings, type Database } from '@vamos/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
  type SelectionFixture,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

const DAY = 24 * 3_600_000;

/** Ratings a trader has reviewed (`manual` is exactly 1: rule O1). */
const REVIEWED = { attack: 1.2, defence: 0.9, manual: 1 };

let ctx: TestContext;
let db: Database;
let trader: StaffSession;
let competitionId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  trader = await staffLogin(ctx, 'trader');
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const categoryId = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  competitionId = await insertCompetition(db, {
    sportId: 'football',
    categoryId,
    slug: 'premier-league',
    name: { en: 'Premier League' },
  });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

let teamSeq = 0;
async function newTeam(ratings?: Record<string, number>): Promise<string> {
  const n = teamSeq++;
  const id = await insertTeam(db, 'football', `T${n}`, { en: `Team ${n}` });
  if (ratings !== undefined) {
    await db.transaction((tx) => setTeamRatings(tx, id, ratings, { system: 'test' }));
  }
  return id;
}

/** An event with betting closed (or open), `feed` as its feed provider and the given 1x2 prices. */
async function newEvent(options: {
  feed: 'scraped' | 'test';
  home: string;
  away: string;
  bettingOpen?: boolean;
  /** `null`: no markets at all. */
  prices?: SelectionFixture[] | null;
}): Promise<string> {
  const { id } = await insertEvent(db, {
    sportId: 'football',
    competitionId,
    homeTeamId: options.home,
    awayTeamId: options.away,
    startTime: new Date(ctx.clock.now.getTime() + 3 * DAY),
    bettingOpen: options.bettingOpen ?? false,
  });
  if (options.feed === 'scraped') {
    await db.update(schema.events).set({ feedProvider: 'scraped' }).where(eq(schema.events.id, id));
  }
  if (options.prices !== null) await insertMarket(db, id, '1x2', null, options.prices ?? ONE_X_TWO);
  return id;
}

const setBetting = (eventId: string, open: boolean) =>
  asStaff(ctx, trader, 'POST', `/admin/trading/events/${eventId}/betting`, { open });

async function bettingOpen(eventId: string): Promise<boolean> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  return row!.bettingOpen;
}

const errorOf = (response: { json(): unknown }) => ApiErrorSchema.parse(response.json()).error;

describe('POST /admin/trading/events/:id/betting on a scraped event (rules O1 and O2)', () => {
  it('refuses to open betting while a team has never been reviewed, and names the team', async () => {
    const home = await newTeam(REVIEWED);
    const away = await newTeam();
    const eventId = await newEvent({ feed: 'scraped', home, away });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(422);
    const error = errorOf(response);
    expect(error.code).toBe('teams_uncalibrated');
    expect(error.message).toContain('Team ');
    expect(error.details).toEqual({
      teams: [{ id: away, name: expect.stringMatching(/^Team \d+$/) }],
    });
    expect(await bettingOpen(eventId)).toBe(false);
  });

  it('refuses when neither team has been reviewed', async () => {
    const home = await newTeam();
    const away = await newTeam();
    const eventId = await newEvent({ feed: 'scraped', home, away });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('teams_uncalibrated');
    expect((errorOf(response).details as { teams: unknown[] }).teams).toHaveLength(2);
    expect(await bettingOpen(eventId)).toBe(false);
  });

  it('refuses ratings that are only a few matches deep, and accepts a deep enough history', async () => {
    const shallow = await newTeam({ attack: 1.1, defence: 1, matches: 1 });
    const other = await newTeam(REVIEWED);
    const refused = await newEvent({ feed: 'scraped', home: shallow, away: other });
    expect((await setBetting(refused, true)).statusCode).toBe(422);
    expect(await bettingOpen(refused)).toBe(false);

    const deep = await newTeam({ attack: 1.1, defence: 1, matches: 1000 });
    const accepted = await newEvent({ feed: 'scraped', home: deep, away: other });
    const response = await setBetting(accepted, true);
    expect(response.statusCode).toBe(200);
    expect(await bettingOpen(accepted)).toBe(true);
  });

  it('opens betting when both teams are reviewed and the prices pass', async () => {
    const eventId = await newEvent({
      feed: 'scraped',
      home: await newTeam(REVIEWED),
      away: await newTeam(REVIEWED),
    });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true });
    expect(await bettingOpen(eventId)).toBe(true);
  });

  it('refuses prices that fail the checks (a book far below 100%)', async () => {
    const eventId = await newEvent({
      feed: 'scraped',
      home: await newTeam(REVIEWED),
      away: await newTeam(REVIEWED),
      prices: [
        ['1', 30000],
        ['X', 30000],
        ['2', 30000],
      ],
    });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(422);
    const error = errorOf(response);
    expect(error.code).toBe('prices_failed_checks');
    expect(error.details).toEqual({
      issues: [expect.objectContaining({ code: 'overround_low', market: '1x2' })],
    });
    expect(await bettingOpen(eventId)).toBe(false);
  });

  it('refuses an event that has no markets to bet on', async () => {
    const eventId = await newEvent({
      feed: 'scraped',
      home: await newTeam(REVIEWED),
      away: await newTeam(REVIEWED),
      prices: null,
    });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('prices_failed_checks');
    expect(errorOf(response).details).toEqual({
      issues: [expect.objectContaining({ code: 'no_markets' })],
    });
  });

  it('does not look at a closed market: its stale price is not what would be bettable', async () => {
    const eventId = await newEvent({
      feed: 'scraped',
      home: await newTeam(REVIEWED),
      away: await newTeam(REVIEWED),
    });
    await insertMarket(
      db,
      eventId,
      'btts',
      null,
      [
        ['yes', 30000],
        ['no', 30000],
      ],
      'closed',
    );

    expect((await setBetting(eventId, true)).statusCode).toBe(200);
    expect(await bettingOpen(eventId)).toBe(true);
  });

  it('never blocks closing betting, and repeating an open request changes nothing', async () => {
    const eventId = await newEvent({
      feed: 'scraped',
      home: await newTeam(),
      away: await newTeam(),
      bettingOpen: true,
      prices: null,
    });

    const repeat = await setBetting(eventId, true);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ changed: false });

    const close = await setBetting(eventId, false);
    expect(close.statusCode).toBe(200);
    expect(close.json()).toEqual({ changed: true });
    expect(await bettingOpen(eventId)).toBe(false);
  });

  it('leaves events of any other feed alone (no ratings, no markets: opens as before)', async () => {
    const eventId = await newEvent({
      feed: 'test',
      home: await newTeam(),
      away: await newTeam(),
      prices: null,
    });

    const response = await setBetting(eventId, true);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true });
    expect(await bettingOpen(eventId)).toBe(true);
  });

  it('answers 404 for an event that does not exist', async () => {
    const response = await setBetting('00000000-0000-4000-8000-000000000000', true);
    expect(response.statusCode).toBe(404);
  });
});
