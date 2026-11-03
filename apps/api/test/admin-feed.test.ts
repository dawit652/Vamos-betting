import {
  ApiErrorSchema,
  FeedReviewListResponse,
  FeedStatusResponse,
  ResultEventResponse,
  UpdateFeedLeagueResponse,
} from '@vamos/contracts';
import { FEED_PROVIDER, recordFeedCall, upsertFeedLeague, type Database } from '@vamos/db';
import { auditLog, events, feedResults } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
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

let ctx: TestContext;
let db: Database;
const s = {} as Record<'admin' | 'trader' | 'support', StaffSession>;
const HOUR = 3_600_000;
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';
const KEY = 'soccer_test_league';
const ev = {} as Record<'cup' | 'noScore' | 'tennis', string>;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  for (const role of ['admin', 'trader', 'support'] as const) s[role] = await staffLogin(ctx, role);

  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'england', { en: 'England' }, 10);
  const competitionId = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'fa-cup',
    name: { en: 'FA Cup' },
  });
  const home = await insertTeam(db, 'football', 'ARS', { en: 'Arsenal' });
  const away = await insertTeam(db, 'football', 'CHE', { en: 'Chelsea' });
  const now = ctx.clock.now.getTime();

  const queue = async (
    key: keyof typeof ev,
    reviewReason: string,
    score: [number, number] | null,
  ) => {
    ev[key] = (
      await insertEvent(db, {
        sportId: 'football',
        competitionId,
        homeTeamId: home,
        awayTeamId: away,
        startTime: new Date(now - 3 * HOUR),
      })
    ).id;
    await db.insert(feedResults).values({
      eventId: ev[key],
      provider: FEED_PROVIDER,
      scoreHome: score?.[0] ?? null,
      scoreAway: score?.[1] ?? null,
      firstSeenAt: new Date(now - HOUR),
      lastSeenAt: new Date(now - HOUR),
      reviewReason,
    });
  };
  await queue('cup', 'cup', [2, 1]);
  await queue('noScore', 'overdue', null);
  await queue('tennis', 'tennis', [1, 0]);

  await upsertFeedLeague(db, {
    provider: FEED_PROVIDER,
    sportKey: KEY,
    sport: 'football',
    group: 'Soccer',
    title: 'Test League',
    description: '',
    active: true,
    cup: false,
    tier: 1,
    enabled: false,
  });
  await recordFeedCall(db, {
    provider: FEED_PROVIDER,
    endpoint: 'odds',
    cost: 3,
    remaining: 480,
    used: 20,
    calledAt: new Date(now - 2 * HOUR),
  });
  await recordFeedCall(db, {
    provider: FEED_PROVIDER,
    endpoint: 'odds',
    cost: 10,
    remaining: 470,
    used: 30,
    calledAt: new Date(now - 10 * 24 * HOUR),
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('GET /admin/feed', () => {
  it('shows quota, credits spent and the leagues to a trader', async () => {
    const response = await asStaff(ctx, s.trader, 'GET', '/admin/feed');
    expect(response.statusCode, response.body).toBe(200);
    const body = FeedStatusResponse.parse(response.json());
    expect(body).toMatchObject({
      provider: 'theoddsapi',
      quota: { remaining: 480, used: 20 },
      creditsLast24h: 3,
      creditsLast30d: 13,
    });
    expect(body.quota?.at).toBe(new Date(ctx.clock.now.getTime() - 2 * HOUR).toISOString());
    expect(body.leagues.find((l) => l.sportKey === KEY)).toMatchObject({
      title: 'Test League',
      enabled: false,
      marginBps: null,
      nextStartAt: null,
    });
  });

  it('is 403 for support', async () => {
    const response = await asStaff(ctx, s.support, 'GET', '/admin/feed');
    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('forbidden');
  });
});

describe('PATCH /admin/feed/leagues/:sportKey', () => {
  const patch = (staff: StaffSession, key: string, payload: unknown) =>
    asStaff(ctx, staff, 'PATCH', `/admin/feed/leagues/${key}`, payload);

  it('lets a trader switch a league on and set its margin, and audits it', async () => {
    const response = await patch(s.trader, KEY, { enabled: true, marginBps: 700 });
    expect(response.statusCode, response.body).toBe(200);
    expect(UpdateFeedLeagueResponse.parse(response.json()).league).toMatchObject({
      sportKey: KEY,
      enabled: true,
      marginBps: 700,
    });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'feed.league.updated'), eq(auditLog.actorId, s.trader.id)));
    expect(entry?.targetId).toBe(`theoddsapi/${KEY}`);
    expect(entry?.metadata).toMatchObject({ after: { enabled: true, marginBps: 700 } });

    const reset = await patch(s.trader, KEY, { marginBps: null });
    expect(UpdateFeedLeagueResponse.parse(reset.json()).league).toMatchObject({
      enabled: true,
      marginBps: null,
    });
  });

  it('validates the body (400) and 404s an unknown league', async () => {
    for (const payload of [{}, { marginBps: 3001 }, { marginBps: -1 }, { marginBps: 5.5 }]) {
      expect((await patch(s.trader, KEY, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await patch(s.trader, 'unknown_league', { enabled: true })).statusCode).toBe(404);
  });

  it('is 403 for support', async () => {
    const response = await patch(s.support, KEY, { enabled: false });
    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error).toMatchObject({
      details: { permission: 'feed.manage' },
    });
  });
});

describe('the results review queue', () => {
  it('lists the waiting results to a trader and is 403 for support', async () => {
    const response = await asStaff(ctx, s.trader, 'GET', '/admin/feed/results');
    expect(response.statusCode, response.body).toBe(200);
    const { items } = FeedReviewListResponse.parse(response.json());
    expect(items.map((i) => i.eventId).sort()).toEqual([ev.cup, ev.noScore, ev.tennis].sort());
    expect(items.find((i) => i.eventId === ev.cup)).toMatchObject({
      homeTeam: { en: 'Arsenal' },
      awayTeam: { en: 'Chelsea' },
      competition: { en: 'FA Cup' },
      scoreHome: 2,
      scoreAway: 1,
      reviewReason: 'cup',
    });
    expect((await asStaff(ctx, s.support, 'GET', '/admin/feed/results')).statusCode).toBe(403);
  });

  it('lets a trader accept a result: the event finishes with the feed score', async () => {
    const response = await asStaff(ctx, s.trader, 'POST', `/admin/feed/results/${ev.cup}/accept`, {
      reason: 'Checked against the BBC',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(ResultEventResponse.parse(response.json())).toMatchObject({
      eventId: ev.cup,
      status: 'finished',
      outcome: 'resulted',
    });
    const [row] = await db.select().from(events).where(eq(events.id, ev.cup));
    expect(row).toMatchObject({ status: 'finished', scoreHome: 2, scoreAway: 1 });
    const queue = FeedReviewListResponse.parse(
      (await asStaff(ctx, s.trader, 'GET', '/admin/feed/results')).json(),
    );
    expect(queue.items.map((i) => i.eventId)).not.toContain(ev.cup);
    // Already handled: gone.
    const again = await asStaff(ctx, s.trader, 'POST', `/admin/feed/results/${ev.cup}/accept`, {});
    expect(again.statusCode).toBe(404);
  });

  it('refuses to accept a row without a score (400) but lets staff void it', async () => {
    const refused = await asStaff(
      ctx,
      s.trader,
      'POST',
      `/admin/feed/results/${ev.noScore}/accept`,
      {},
    );
    expect(refused.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(refused.json()).error.code).toBe('feed_result_has_no_score');

    const voided = await asStaff(ctx, s.admin, 'POST', `/admin/feed/results/${ev.noScore}/void`, {
      reason: 'Postponed',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(ResultEventResponse.parse(voided.json()).status).toBe('cancelled');
    const [row] = await db.select().from(events).where(eq(events.id, ev.noScore));
    expect(row?.status).toBe('cancelled');
  });

  it('is 403 for support, 404 for an unknown event and 404 for a malformed id', async () => {
    for (const action of ['accept', 'void']) {
      const url = `/admin/feed/results/${ev.tennis}/${action}`;
      expect((await asStaff(ctx, s.support, 'POST', url, {})).statusCode).toBe(403);
      expect(
        (await asStaff(ctx, s.trader, 'POST', `/admin/feed/results/${ABSENT_ID}/${action}`, {}))
          .statusCode,
      ).toBe(404);
      expect(
        (await asStaff(ctx, s.trader, 'POST', `/admin/feed/results/not-a-uuid/${action}`, {}))
          .statusCode,
      ).toBe(404);
    }
    const [row] = await db.select().from(events).where(eq(events.id, ev.tennis));
    expect(row?.status).toBe('scheduled');
  });
});
