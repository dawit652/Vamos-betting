import { ApiErrorSchema } from '@vamos/contracts';
import { schema, type Database } from '@vamos/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertSport,
  insertTeam,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

const MINUTE = 60_000;

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
/** An event that kicked off `minutesAgo` minutes ago, of the scraped feed unless told. */
async function startedEvent(minutesAgo: number, feed: 'scraped' | 'test' = 'scraped') {
  const n = teamSeq++;
  const { id } = await insertEvent(db, {
    sportId: 'football',
    competitionId,
    homeTeamId: await insertTeam(db, 'football', `H${n}`, { en: `Home ${n}` }),
    awayTeamId: await insertTeam(db, 'football', `A${n}`, { en: `Away ${n}` }),
    startTime: new Date(ctx.clock.now.getTime() - minutesAgo * MINUTE),
    bettingOpen: false,
  });
  if (feed === 'scraped') {
    await db.update(schema.events).set({ feedProvider: 'scraped' }).where(eq(schema.events.id, id));
  }
  return id;
}

const result = (eventId: string, body: Record<string, unknown>) =>
  asStaff(ctx, trader, 'POST', `/admin/trading/events/${eventId}/result`, body);
const finished = { status: 'finished', score: { home: 1, away: 0, htHome: 0, htAway: 0 } };
const errorOf = (response: { json(): unknown }) => ApiErrorSchema.parse(response.json()).error;

async function statusOf(eventId: string): Promise<string> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  return row!.status;
}

describe('POST /admin/trading/events/:id/result on a scraped match (S-5, R1 floor)', () => {
  it('refuses a finished result before 105 minutes after kickoff, and says from when', async () => {
    const eventId = await startedEvent(104);
    const response = await result(eventId, finished);
    expect(response.statusCode).toBe(409);
    const error = errorOf(response);
    expect(error.code).toBe('match_not_over');
    const earliest = (error.details as { earliest: string }).earliest;
    expect(new Date(earliest).getTime()).toBe(ctx.clock.now.getTime() + MINUTE);
    expect(await statusOf(eventId)).toBe('scheduled');
  });

  it('accepts a finished result from 105 minutes after kickoff', async () => {
    const eventId = await startedEvent(105);
    const response = await result(eventId, finished);
    expect(response.statusCode).toBe(200);
    expect(await statusOf(eventId)).toBe('finished');
  });

  it('never delays a cancellation or a postponement', async () => {
    const cancelled = await startedEvent(-60);
    expect((await result(cancelled, { status: 'cancelled' })).statusCode).toBe(200);
    expect(await statusOf(cancelled)).toBe('cancelled');
    const postponed = await startedEvent(30);
    expect((await result(postponed, { status: 'postponed' })).statusCode).toBe(200);
    expect(await statusOf(postponed)).toBe('postponed');
  });

  it('leaves the events of any other feed as before', async () => {
    const eventId = await startedEvent(30, 'test');
    const response = await result(eventId, finished);
    expect(response.statusCode).toBe(200);
    expect(await statusOf(eventId)).toBe('finished');
  });
});
