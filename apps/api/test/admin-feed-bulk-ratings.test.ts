import {
  ApiErrorSchema,
  MapBatchResponse,
  RatingsResponse,
  SetRatingsResponse,
  STAFF_ROLES,
  type StaffRole,
} from '@vamos/contracts';
import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  openReviewItem,
  schema,
  setSourceEnabled,
  setTeamRatings,
  upsertSource,
  type Database,
} from '@vamos/db';
import { MAX_TEAM_RATING, MIN_TEAM_RATING } from '@vamos/feed';
import { normalizeName } from '@vamos/scraper';
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

const HOUR = 3_600_000;
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

let ctx: TestContext;
let db: Database;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;
const ids = {} as Record<'league' | 'a' | 'b' | 'c' | 'd', string>;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  for (const role of STAFF_ROLES) staff.set(role, await staffLogin(ctx, role));
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  ids.league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'premier-league',
    name: { en: 'Premier League' },
  });
  ids.a = await insertTeam(db, 'football', 'AAA', { en: 'Alpha United' });
  ids.b = await insertTeam(db, 'football', 'BBB', { en: 'Beta Rovers' });
  ids.c = await insertTeam(db, 'football', 'CCC', { en: 'Gamma Town' });
  ids.d = await insertTeam(db, 'football', 'DDD', { en: 'Delta City' });
  for (const id of ['src-a', 'src-b']) {
    await db.transaction(async (tx) => {
      await upsertSource(
        tx,
        { id, name: id, adapter: 'openfootball', upstream: `up-${id}`, config: {} },
        { system: 'test' },
      );
      await setSourceEnabled(tx, id, true, { system: 'test' });
    });
  }
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const errorOf = (response: { json(): unknown }) => ApiErrorSchema.parse(response.json()).error;

let subject = 0;
async function unknownTeam(
  raw: string,
  sourceId = 'src-a',
  kind: 'unknown_team' | 'source_broken' = 'unknown_team',
) {
  ctx.clock.advance(1000);
  const payload =
    kind === 'unknown_team'
      ? { sport: 'football', raw, competition: 'Cup', sourceId, suggestions: [] }
      : { sourceId, runId: 'r1', reason: 'x' };
  const { item } = await db.transaction((tx) =>
    openReviewItem(tx, {
      kind,
      subjectKey: `bulk-${subject++}`,
      severity: 'warning',
      title: `Item ${kind}`,
      payload,
      now: ctx.clock.now,
    }),
  );
  return item.id;
}

const batch = (role: StaffRole, items: unknown) =>
  asStaff(ctx, as(role), 'POST', '/admin/feed/review/map-batch', { items });

const status = async (id: string) =>
  (await db.select().from(schema.scrapeReviewItems).where(eq(schema.scrapeReviewItems.id, id)))[0]!
    .status;

const aliasesOf = (raw: string) =>
  db
    .select()
    .from(schema.teamAliases)
    .where(eq(schema.teamAliases.aliasNorm, normalizeName(raw)));

describe('POST /admin/feed/review/map-batch', () => {
  it('needs trading.status: 401 anonymous, 403 for roles without it, trader and admin pass', async () => {
    const item = await unknownTeam('Perm Check FC');
    const body = { items: [{ itemId: item, targetId: ids.a, scope: 'all' }] };
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/admin/feed/review/map-batch',
      payload: body,
    });
    expect(anon.statusCode).toBe(401);
    for (const role of ['support', 'kyc', 'finance', 'compliance'] as const) {
      const response = await batch(role, body.items);
      expect(response.statusCode, role).toBe(403);
    }
    expect(await status(item)).toBe('open');
    expect((await batch('trader', body.items)).statusCode).toBe(200);
  });

  it('validates the body: empty, too many, duplicates, bad scope, extra keys', async () => {
    const item = await unknownTeam('Validation FC');
    const ok = { itemId: item, targetId: ids.a, scope: 'all' };
    const many = Array.from({ length: 51 }, (_, i) => ({ ...ok, itemId: `item-${i}` }));
    for (const [what, items] of [
      ['empty', []],
      ['over 50', many],
      ['duplicate', [ok, ok]],
      ['scope', [{ ...ok, scope: 'everywhere' }]],
      ['extra key', [{ ...ok, score: '1-0' }]],
      ['missing target', [{ itemId: item, scope: 'all' }]],
    ] as const) {
      const response = await batch('trader', items);
      expect(response.statusCode, what).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    }
    expect(
      (await asStaff(ctx, as('trader'), 'POST', '/admin/feed/review/map-batch', {})).statusCode,
    ).toBe(400);
    expect(await status(item)).toBe('open');
  });

  it('maps source-scoped to the item source and all-source with no source, audited like the single route', async () => {
    const scoped = await unknownTeam('Scoped Spelling', 'src-b');
    const global = await unknownTeam('Global Spelling', 'src-a');
    const response = await batch('trader', [
      { itemId: scoped, targetId: ids.a, scope: 'source' },
      { itemId: global, targetId: ids.b, scope: 'all' },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const result = MapBatchResponse.parse(response.json());
    expect(result).toMatchObject({ mapped: 2, failed: 0 });
    expect(result.results.map((r) => r.itemId)).toEqual([scoped, global]);
    expect(result.results[0]!.item).toMatchObject({
      status: 'resolved',
      resolvedBy: as('trader').id,
      resolution: {
        decision: 'map_alias',
        targetId: ids.a,
        sourceId: 'src-b',
        by: as('trader').id,
      },
    });
    expect(result.results[1]!.item!.resolution).toMatchObject({ targetId: ids.b, sourceId: null });

    const [scopedAlias] = await aliasesOf('Scoped Spelling');
    expect(scopedAlias).toMatchObject({
      teamId: ids.a,
      sourceId: 'src-b',
      createdBy: as('trader').id,
    });
    const [globalAlias] = await aliasesOf('Global Spelling');
    expect(globalAlias).toMatchObject({ teamId: ids.b, sourceId: null });
    for (const [alias, item] of [
      [scopedAlias!, scoped],
      [globalAlias!, global],
    ] as const) {
      const audit = (action: string, targetId: string) =>
        db
          .select()
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)));
      expect(await audit('scrape.alias.added', alias.id)).toHaveLength(1);
      expect(await audit('scrape.review.resolved', item)).toHaveLength(1);
    }
  });

  it('applies per item: a failure leaves that item open and the others mapped', async () => {
    const good = await unknownTeam('Partial Good');
    const closed = await unknownTeam('Partial Closed');
    const wrongKind = await unknownTeam('', 'src-a', 'source_broken');
    const badTarget = await unknownTeam('Partial Bad Target');
    const badUuid = await unknownTeam('Partial Bad Id');
    // closed meanwhile
    expect(
      (await batch('trader', [{ itemId: closed, targetId: ids.c, scope: 'all' }])).statusCode,
    ).toBe(200);

    const response = await batch('trader', [
      { itemId: good, targetId: ids.c, scope: 'source' },
      { itemId: closed, targetId: ids.c, scope: 'all' },
      { itemId: wrongKind, targetId: ids.c, scope: 'all' },
      { itemId: ABSENT_ID, targetId: ids.c, scope: 'all' },
      { itemId: badTarget, targetId: ABSENT_ID, scope: 'all' },
      { itemId: badUuid, targetId: 'nope', scope: 'all' },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const result = MapBatchResponse.parse(response.json());
    expect(result).toMatchObject({ mapped: 1, failed: 5 });
    expect(result.results.map((r) => r.error?.code ?? 'ok')).toEqual([
      'ok',
      'review_closed',
      'decision_not_allowed',
      'not_found',
      'not_found',
      expect.any(String),
    ]);
    expect(await status(good)).toBe('resolved');
    expect(await status(wrongKind)).toBe('open');
    expect(await status(badTarget)).toBe('open');
    expect(await status(badUuid)).toBe('open');
    expect(await aliasesOf('Partial Bad Target')).toHaveLength(0);
    expect(await aliasesOf('Partial Good')).toHaveLength(1);
  });
});

describe('/admin/feed/ratings', () => {
  const put = (role: StaffRole, teamId: string, body: unknown) =>
    asStaff(ctx, as(role), 'PUT', `/admin/feed/ratings/${teamId}`, body);
  const list = (role: StaffRole, query = '') =>
    asStaff(ctx, as(role), 'GET', `/admin/feed/ratings${query}`);

  it('lists rated teams with a name filter; teams without ratings are not listed', async () => {
    await db.transaction((tx) =>
      setTeamRatings(tx, ids.a, { attack: 1.2, defence: 0.9, matches: 12 }, { system: 'test' }),
    );
    const all = RatingsResponse.parse((await list('trader')).json());
    expect(all).toMatchObject({ min: MIN_TEAM_RATING, max: MAX_TEAM_RATING, truncated: false });
    expect(all.teams).toEqual([
      expect.objectContaining({
        teamId: ids.a,
        team: 'AAA',
        attack: 1.2,
        defence: 0.9,
        matches: 12,
        manual: false,
        upcoming: null,
      }),
    ]);
    const hit = RatingsResponse.parse((await list('admin', '?team=alpha')).json());
    expect(hit.teams.map((t) => t.team)).toEqual(['AAA']);
    const miss = RatingsResponse.parse((await list('trader', '?team=beta')).json());
    expect(miss.teams).toEqual([]);
    expect((await list('trader', '?team=%20')).statusCode).toBe(400);
    expect((await asStaff(ctx, as('kyc'), 'GET', '/admin/feed/ratings')).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/feed/ratings' })).statusCode).toBe(
      401,
    );
  });

  it('unrated lists the teams of upcoming scraped matches that are not calibrated', async () => {
    const make = async (home: string, away: string, inMs: number) => {
      const event = await insertEvent(db, {
        sportId: 'football',
        competitionId: ids.league,
        homeTeamId: home,
        awayTeamId: away,
        startTime: new Date(ctx.clock.now.getTime() + inMs),
      });
      await db
        .update(schema.events)
        .set({ feedProvider: SCRAPED_FEED_PROVIDER })
        .where(eq(schema.events.id, event.id));
    };
    // b plays twice, c once, a (12 matches) is calibrated, d has no match to come.
    await make(ids.a, ids.b, 5 * HOUR);
    await make(ids.b, ids.c, 8 * HOUR);
    const response = await list('trader', '?unrated=true');
    expect(response.statusCode, response.body).toBe(200);
    const body = RatingsResponse.parse(response.json());
    expect(body.minMatches).toBeGreaterThanOrEqual(8);
    expect(body.teams.map((t) => [t.team, t.upcoming, t.matches, t.attack])).toEqual([
      ['BBB', 2, 0, null],
      ['CCC', 1, 0, null],
    ]);
    expect(body.teams[0]!.nextKickoff).toBe(
      new Date(ctx.clock.now.getTime() + 5 * HOUR).toISOString(),
    );
    const filtered = RatingsResponse.parse(
      (await list('trader', '?unrated=true&team=gamma')).json(),
    );
    expect(filtered.teams.map((t) => t.team)).toEqual(['CCC']);
  });

  it('sets manual ratings: manual = 1, audited with before and after, calibrated afterwards', async () => {
    const response = await put('trader', ids.b, { attack: 1.4, defence: 0.8 });
    expect(response.statusCode, response.body).toBe(200);
    const body = SetRatingsResponse.parse(response.json());
    expect(body).toMatchObject({
      changed: true,
      team: { teamId: ids.b, team: 'BBB', attack: 1.4, defence: 0.8, matches: 0, manual: true },
    });
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, ids.b));
    expect(row!.ratings).toEqual({ attack: 1.4, defence: 0.8, matches: 0, manual: 1 });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'scrape.ratings.updated'),
          eq(schema.auditLog.targetId, ids.b),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'admin',
      actorId: as('trader').id,
      metadata: { before: null, after: { attack: 1.4, defence: 0.8, matches: 0, manual: 1 } },
    });

    // Same values again change and audit nothing; matches is optional and kept otherwise.
    const again = SetRatingsResponse.parse(
      (await put('admin', ids.b, { attack: 1.4, defence: 0.8 })).json(),
    );
    expect(again.changed).toBe(false);
    const withMatches = await put('admin', ids.b, { attack: 1.4, defence: 0.8, matches: 20 });
    expect(SetRatingsResponse.parse(withMatches.json()).team.matches).toBe(20);
    const after = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'scrape.ratings.updated'),
          eq(schema.auditLog.targetId, ids.b),
        ),
      );
    expect(after).toHaveLength(2);

    // b is now calibrated (manual), so it no longer shows as unrated.
    const unrated = RatingsResponse.parse((await list('trader', '?unrated=true')).json());
    expect(unrated.teams.map((t) => t.team)).toEqual(['CCC']);
  });

  it('keeps other stored keys when setting by hand', async () => {
    await db.transaction((tx) =>
      setTeamRatings(
        tx,
        ids.d,
        { attack: 1, defence: 1, matches: 3, backfilled_through: 20260101 },
        { system: 'test' },
      ),
    );
    expect((await put('trader', ids.d, { attack: 1.1, defence: 0.95 })).statusCode).toBe(200);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, ids.d));
    expect(row!.ratings).toEqual({
      attack: 1.1,
      defence: 0.95,
      matches: 3,
      backfilled_through: 20260101,
      manual: 1,
    });
  });

  it('validates: band, finite numbers, matches, strict keys, ids, unknown team', async () => {
    for (const [what, body, code] of [
      ['attack too low', { attack: MIN_TEAM_RATING - 0.01, defence: 1 }, 'rating_out_of_band'],
      ['defence too high', { attack: 1, defence: MAX_TEAM_RATING + 0.01 }, 'rating_out_of_band'],
      ['string', { attack: '1', defence: 1 }, 'validation_error'],
      ['missing defence', { attack: 1 }, 'validation_error'],
      ['fraction matches', { attack: 1, defence: 1, matches: 1.5 }, 'validation_error'],
      ['negative matches', { attack: 1, defence: 1, matches: -1 }, 'validation_error'],
      ['huge matches', { attack: 1, defence: 1, matches: 10_001 }, 'validation_error'],
      ['extra key', { attack: 1, defence: 1, manual: 0 }, 'validation_error'],
    ] as const) {
      const response = await put('trader', ids.c, body);
      expect(response.statusCode, what).toBe(code === 'rating_out_of_band' ? 422 : 400);
      expect(errorOf(response).code, what).toBe(code);
    }
    expect((await put('trader', ABSENT_ID, { attack: 1, defence: 1 })).statusCode).toBe(404);
    expect((await put('trader', 'nope', { attack: 1, defence: 1 })).statusCode).toBe(404);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, ids.c));
    expect(row!.ratings).toBeNull();
  });

  it('needs trading.odds to set: 401 anonymous, 403 support, kyc, finance and compliance', async () => {
    const anon = await ctx.app.inject({
      method: 'PUT',
      url: `/admin/feed/ratings/${ids.c}`,
      payload: { attack: 1, defence: 1 },
    });
    expect(anon.statusCode).toBe(401);
    for (const role of ['support', 'kyc', 'finance', 'compliance'] as const) {
      expect((await put(role, ids.c, { attack: 1, defence: 1 })).statusCode, role).toBe(403);
    }
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, ids.c));
    expect(row!.ratings).toBeNull();
  });
});
