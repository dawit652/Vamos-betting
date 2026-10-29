import {
  AliasListResponse,
  ApiErrorSchema,
  CreateAliasResponse,
  FEED_ADAPTERS,
  FEED_DATA_CLASSES,
  FEED_FIXTURE_STATUSES,
  FEED_REPRICE_SUBJECT_SUFFIX,
  FEED_REVIEW_KINDS,
  FEED_REVIEW_STATUSES,
  FEED_ROUTE_PERMISSIONS,
  FEED_RESULT_STATUSES,
  FEED_RUN_STATUSES,
  FEED_SCORE_BASES,
  FEED_SEVERITIES,
  FEED_SPORTS,
  FeedCompetitionsResponse,
  FeedHealthResponse,
  ResolveReviewResponse,
  ReviewDetailResponse,
  ReviewListResponse,
  SetSourceEnabledResponse,
  STAFF_ROLES,
  UpdateCompetitionPolicyResponse,
  type StaffRole,
} from '@vamos/contracts';
import {
  SCRAPE_ADAPTERS,
  SCRAPE_DATA_CLASSES,
  SCRAPE_FIXTURE_STATUSES,
  SCRAPE_RESULT_STATUSES,
  SCRAPE_REVIEW_KINDS,
  SCRAPE_REVIEW_STATUSES,
  SCRAPE_RUN_STATUSES,
  SCRAPE_SCORE_BASES,
  SCRAPE_SEVERITIES,
  SCRAPE_SPORTS,
  type ScrapeReviewKind,
} from '@vamos/core';
import {
  finishRun,
  openReviewItem,
  schema,
  setSourceEnabled,
  setTeamRatings,
  startRun,
  upsertSource,
  type Database,
} from '@vamos/db';
import { normalizeName, ratingsKey, REPRICE_SUBJECT_SUFFIX } from '@vamos/scraper';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAdminRoutes } from '../src/modules/admin/common';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

let ctx: TestContext;
let db: Database;
let player: LoggedInUser;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;
const ids = {} as Record<'league' | 'cup' | 'home' | 'away' | 'other' | 'category', string>;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  for (const role of STAFF_ROLES) staff.set(role, await staffLogin(ctx, role));
  player = await registerAndLogin(ctx);

  await insertSport(db, 'football', { en: 'Football' }, 10);
  ids.category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  ids.league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: ids.category,
    slug: 'premier-league',
    name: { en: 'Premier League' },
  });
  ids.cup = await insertCompetition(db, {
    sportId: 'football',
    categoryId: ids.category,
    slug: 'cup',
    name: { en: 'Cup' },
  });
  ids.home = await insertTeam(db, 'football', 'SDT', { en: 'Saint George' });
  ids.away = await insertTeam(db, 'football', 'FAS', { en: 'Fasil Kenema' });
  ids.other = await insertTeam(db, 'football', 'BUN', { en: 'Bunna' });

  for (const [id, adapter] of [
    ['src-ok', 'openfootball'],
    ['src-off', 'generic-json'],
    ['src-never', 'generic-html'],
    ['src-new', 'openfootball'],
    ['src-old', 'openfootball'],
    ['src-broken', 'generic-json'],
    ['src-blocked', 'generic-html'],
  ] as const) {
    await db.transaction(async (tx) => {
      await upsertSource(
        tx,
        { id, name: `Source ${id}`, adapter, upstream: `up-${id}`, config: {} },
        { system: 'test' },
      );
      if (id !== 'src-off') await setSourceEnabled(tx, id, true, { system: 'test' });
    });
  }
  await okRuns('src-ok', 3, 10 * MINUTE);
  await okRuns('src-new', 1, 10 * MINUTE);
  await okRuns('src-old', 3, 5 * HOUR);
  await okRuns('src-broken', 3, 2 * HOUR);
  await oneRun('src-broken', 'broken', MINUTE * 5);
  await oneRun('src-blocked', 'blocked', MINUTE * 5);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

async function oneRun(
  sourceId: string,
  status: 'ok' | 'broken' | 'blocked' | 'failed',
  agoMs: number,
): Promise<void> {
  const startedAt = new Date(ctx.clock.now.getTime() - agoMs);
  const run = await startRun(db, { sourceId, startedAt });
  await finishRun(db, run.id, {
    status,
    recordsSeen: 12,
    recordsAccepted: 10,
    finishedAt: new Date(startedAt.getTime() + 1000),
  });
}

/** `count` successful runs, the newest `agoMs` ago, 20 minutes apart. */
async function okRuns(sourceId: string, count: number, agoMs: number): Promise<void> {
  for (let i = count - 1; i >= 0; i--) await oneRun(sourceId, 'ok', agoMs + i * 20 * MINUTE);
}

async function auditActions(action: string, targetId?: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(
      targetId === undefined
        ? eq(schema.auditLog.action, action)
        : and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)),
    );
}

let subject = 0;
/** Opens a review item at the test clock's time (a second later than the previous one). */
async function openItem(
  kind: ScrapeReviewKind,
  payload: Record<string, unknown>,
  subjectKey = `subject-${subject++}`,
): Promise<string> {
  ctx.clock.advance(1000);
  const { item } = await db.transaction((tx) =>
    openReviewItem(tx, {
      kind,
      subjectKey,
      severity: 'warning',
      title: `Item ${kind}`,
      payload,
      now: ctx.clock.now,
    }),
  );
  return item.id;
}

const eventRef = (eventId: string, kickoff: Date) => ({
  eventId,
  gameId: '1234',
  home: 'Saint George',
  away: 'Fasil Kenema',
  kickoff: kickoff.toISOString(),
});

async function newEvent(
  startsInMs: number,
  extra: { status?: 'scheduled' | 'live'; bettingOpen?: boolean } = {},
) {
  const startTime = new Date(ctx.clock.now.getTime() + startsInMs);
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.league,
    homeTeamId: ids.home,
    awayTeamId: ids.away,
    startTime,
    ...extra,
  });
  return { ...event, startTime };
}

async function eventRow(eventId: string) {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  return row!;
}

async function itemRow(itemId: string) {
  const [row] = await db
    .select()
    .from(schema.scrapeReviewItems)
    .where(eq(schema.scrapeReviewItems.id, itemId));
  return row!;
}

const resolve = (role: StaffRole, itemId: string, body: unknown) =>
  asStaff(ctx, as(role), 'POST', `/admin/feed/review/${itemId}/resolve`, body);

const errorOf = (response: { json(): unknown }) => ApiErrorSchema.parse(response.json()).error;

describe('contract drift', () => {
  it('keeps the closed sets of @vamos/contracts equal to the SCRAPE_* arrays of @vamos/core', () => {
    expect(FEED_SPORTS).toEqual(SCRAPE_SPORTS);
    expect(FEED_ADAPTERS).toEqual(SCRAPE_ADAPTERS);
    expect(FEED_DATA_CLASSES).toEqual(SCRAPE_DATA_CLASSES);
    expect(FEED_FIXTURE_STATUSES).toEqual(SCRAPE_FIXTURE_STATUSES);
    expect(FEED_RESULT_STATUSES).toEqual(SCRAPE_RESULT_STATUSES);
    expect(FEED_SCORE_BASES).toEqual(SCRAPE_SCORE_BASES);
    expect(FEED_RUN_STATUSES).toEqual(SCRAPE_RUN_STATUSES);
    expect(FEED_REVIEW_KINDS).toEqual(SCRAPE_REVIEW_KINDS);
    expect(FEED_REVIEW_STATUSES).toEqual(SCRAPE_REVIEW_STATUSES);
    expect(FEED_SEVERITIES).toEqual(SCRAPE_SEVERITIES);
    expect(FEED_REPRICE_SUBJECT_SUFFIX).toBe(REPRICE_SUBJECT_SUFFIX);
  });
});

describe('/admin/feed RBAC', () => {
  it('registers exactly the contract routes, each with its permission', () => {
    const registered = Object.fromEntries(
      listAdminRoutes(ctx.deps)
        .filter((route) => route.url.startsWith('/admin/feed'))
        .map((route) => [`${route.method} ${route.url}`, route.access]),
    );
    expect(registered).toEqual(FEED_ROUTE_PERMISSIONS);
  });

  it('answers 401 without a staff session (or with a player one) and 403 to roles without the permission', async () => {
    const reviewId = await openItem('source_broken', {
      sourceId: 'src-ok',
      runId: 'r1',
      reason: 'x',
      recordsAccepted: 0,
      baseline: null,
    });
    const view: StaffRole[] = ['admin', 'trader'];
    const table: Array<[method: 'GET' | 'POST' | 'PUT', url: string, allowed: StaffRole[]]> = [
      ['GET', '/admin/feed/health', view],
      ['GET', '/admin/feed/review', view],
      ['GET', `/admin/feed/review/${reviewId}`, view],
      ['POST', `/admin/feed/review/${reviewId}/resolve`, view],
      ['GET', '/admin/feed/aliases', view],
      ['POST', '/admin/feed/aliases', view],
      ['PUT', '/admin/feed/sources/src-off', view],
      ['GET', '/admin/feed/competitions', view],
      ['PUT', `/admin/feed/competitions/${ids.cup}`, ['admin']],
    ];
    for (const [method, url, allowed] of table) {
      expect((await ctx.app.inject({ method, url })).statusCode, url).toBe(401);
      const asPlayer = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${player.sessionToken}` },
      });
      expect(asPlayer.statusCode, url).toBe(401);
      for (const role of STAFF_ROLES) {
        // An empty body: refused by validation (400) once past the guard.
        const response = await asStaff(
          ctx,
          as(role),
          method,
          url,
          method === 'GET' ? undefined : {},
        );
        const label = `${role} ${method} ${url}`;
        if (allowed.includes(role)) {
          expect(response.statusCode, `${label}: ${response.body}`).toBeLessThan(500);
          expect([401, 403], label).not.toContain(response.statusCode);
        } else {
          expect(response.statusCode, label).toBe(403);
          expect(errorOf(response).code).toBe('forbidden');
        }
      }
    }
    // The finer rule of the competition policy: a trader holds trading.status, not settings.edit.
    const trader = await asStaff(
      ctx,
      as('trader'),
      'PUT',
      `/admin/feed/competitions/${ids.cup}`,
      {},
    );
    expect(trader.statusCode).toBe(403);
    expect(errorOf(trader).details).toEqual({ permission: 'settings.edit' });
  });
});

describe('GET /admin/feed/health', () => {
  it('reports each source with its state, the queue counts and the policy counts', async () => {
    await openItem('unknown_team', {
      sport: 'football',
      raw: 'Health FC',
      competition: 'Cup',
      sourceId: 'src-ok',
      suggestions: [],
    });
    const response = await asStaff(ctx, as('trader'), 'GET', '/admin/feed/health');
    expect(response.statusCode, response.body).toBe(200);
    const body = FeedHealthResponse.parse(response.json());
    const state = Object.fromEntries(body.sources.map((source) => [source.id, source.state]));
    expect(state).toEqual({
      'src-blocked': 'blocked',
      'src-broken': 'broken',
      'src-never': 'stale',
      'src-new': 'learning',
      'src-off': 'disabled',
      'src-ok': 'ok',
      'src-old': 'stale',
    });
    const ok = body.sources.find((source) => source.id === 'src-ok')!;
    expect(ok).toMatchObject({
      name: 'Source src-ok',
      adapter: 'openfootball',
      upstream: 'up-src-ok',
      enabled: true,
      consecutiveFailures: 0,
      lastRun: { status: 'ok', recordsSeen: 12, recordsAccepted: 10 },
    });
    expect(ok.openReviewItems).toBeGreaterThanOrEqual(1);
    expect(body.sources.find((source) => source.id === 'src-never')).toMatchObject({
      lastRun: null,
      lastOkAt: null,
    });
    expect(body.sources.find((source) => source.id === 'src-broken')!.consecutiveFailures).toBe(1);
    expect(Object.keys(body.queue.byKind).sort()).toEqual([...FEED_REVIEW_KINDS].sort());
    expect(body.queue.byKind.unknown_team).toBeGreaterThanOrEqual(1);
    expect(body.queue.open).toBe(Object.values(body.queue.byKind).reduce((a, b) => a + b, 0));
    expect(body.competitions).toEqual({ total: 2, enabled: 0, autoOpen: 0, autoResults: 0 });
  });
});

describe('review queue', () => {
  it('lists newest first, filters by status and kind (lists too) and pages with an opaque cursor', async () => {
    const first = await openItem('fixture_missing', { detail: 'one' });
    const second = await openItem('score_basis_unknown', { detail: 'two' });
    const third = await openItem('fixture_conflict', { detail: 'three' });
    expect((await resolve('admin', second, { decision: 'dismiss', note: 'no' })).statusCode).toBe(
      200,
    );

    const all = ReviewListResponse.parse(
      (await asStaff(ctx, as('trader'), 'GET', '/admin/feed/review?limit=100')).json(),
    );
    const order = all.items.map((item) => item.id);
    expect(order.indexOf(third)).toBeLessThan(order.indexOf(second));
    expect(order.indexOf(second)).toBeLessThan(order.indexOf(first));
    expect(all.nextCursor).toBeNull();

    const open = ReviewListResponse.parse(
      (await asStaff(ctx, as('trader'), 'GET', '/admin/feed/review?status=open&limit=100')).json(),
    );
    expect(open.items.every((item) => item.status === 'open')).toBe(true);
    expect(open.items.map((item) => item.id)).not.toContain(second);

    const kinds = ReviewListResponse.parse(
      (
        await asStaff(
          ctx,
          as('trader'),
          'GET',
          '/admin/feed/review?kind=fixture_missing,score_basis_unknown&status=open,dismissed',
        )
      ).json(),
    );
    expect(kinds.items.map((item) => item.id)).toEqual([second, first]);

    const one = ReviewListResponse.parse(
      (
        await asStaff(
          ctx,
          as('trader'),
          'GET',
          '/admin/feed/review?kind=fixture_missing,score_basis_unknown,fixture_conflict&limit=2',
        )
      ).json(),
    );
    expect(one.items.map((item) => item.id)).toEqual([third, second]);
    expect(one.nextCursor).not.toBeNull();
    const next = ReviewListResponse.parse(
      (
        await asStaff(
          ctx,
          as('trader'),
          'GET',
          `/admin/feed/review?kind=fixture_missing,score_basis_unknown,fixture_conflict&limit=2&cursor=${one.nextCursor}`,
        )
      ).json(),
    );
    expect(next.items.map((item) => item.id)).toEqual([first]);
    expect(next.nextCursor).toBeNull();

    const bad = await asStaff(ctx, as('trader'), 'GET', '/admin/feed/review?cursor=nonsense');
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('invalid_cursor');
    expect(
      (await asStaff(ctx, as('trader'), 'GET', '/admin/feed/review?kind=nope')).statusCode,
    ).toBe(400);
  });

  it('shows one item with its payload and resolution, 404 for an unknown id', async () => {
    const id = await openItem('fixture_missing', { detail: 'detail' });
    const detail = ReviewDetailResponse.parse(
      (await asStaff(ctx, as('trader'), 'GET', `/admin/feed/review/${id}`)).json(),
    );
    expect(detail.item).toMatchObject({
      id,
      kind: 'fixture_missing',
      status: 'open',
      payload: { detail: 'detail' },
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
    });
    for (const bad of [ABSENT_ID, 'not-a-uuid']) {
      expect(
        (await asStaff(ctx, as('trader'), 'GET', `/admin/feed/review/${bad}`)).statusCode,
      ).toBe(404);
    }
  });
});

describe('POST /admin/feed/review/:id/resolve', () => {
  it('rejects a body with a score or any unknown field, whatever the decision', async () => {
    const id = await openItem('result_ready', {
      ...eventRef(ABSENT_ID, new Date(ctx.clock.now.getTime() - HOUR)),
      score: { home: 1, away: 0, htHome: null, htAway: null },
      sources: [],
      exposure: { openBets: 0, totalStake: '0' },
    });
    const score = { home: 9, away: 9, htHome: null, htAway: null };
    const bodies = [
      { decision: 'apply_result', score },
      { decision: 'apply_result', home: 9, away: 9 },
      { decision: 'dismiss', note: 'x', score },
      { decision: 'map_alias', targetId: ids.home, score },
      { decision: 'open_betting', score },
      { decision: 'apply_kickoff', score },
      { decision: 'apply_reprice', score },
      { decision: 'apply_reprice', oddsMilli: 2000 },
      { decision: 'apply_reprice', proposal: [] },
      { decision: 'cancel_event' },
      { decision: 'void' },
      {},
    ];
    for (const body of bodies) {
      const response = await resolve('admin', id, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    }
    expect((await itemRow(id)).status).toBe('open');
  });

  it('dismisses any open item with the note, audited; a second resolve is 409; unknown id 404', async () => {
    const id = await openItem('fixture_conflict', { detail: 'd' });
    const response = await resolve('trader', id, { decision: 'dismiss', note: '  not ours  ' });
    expect(response.statusCode, response.body).toBe(200);
    const body = ResolveReviewResponse.parse(response.json());
    expect(body.changed).toBe(true);
    expect(body.item).toMatchObject({
      id,
      status: 'dismissed',
      resolvedBy: as('trader').id,
      resolution: { decision: 'dismiss', note: 'not ours', by: as('trader').id },
    });
    const audit = await auditActions('scrape.review.dismissed', id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'admin', actorId: as('trader').id });

    const again = await resolve('trader', id, { decision: 'dismiss', note: 'again' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('review_closed');
    expect(
      (await resolve('trader', ABSENT_ID, { decision: 'dismiss', note: 'x' })).statusCode,
    ).toBe(404);
    expect((await resolve('trader', 'nope', { decision: 'dismiss', note: 'x' })).statusCode).toBe(
      404,
    );
    // A dismissal needs a note.
    const noNote = await resolve('trader', await openItem('fixture_missing', { detail: 'd' }), {
      decision: 'dismiss',
    });
    expect(noNote.statusCode).toBe(400);
  });

  it('refuses a decision the kind does not take with 422 decision_not_allowed', async () => {
    const broken = await openItem('source_broken', {
      sourceId: 'src-ok',
      runId: 'r',
      reason: 'x',
      recordsAccepted: 0,
      baseline: null,
    });
    const odds = await openItem('odds_approval', {
      ...eventRef(ABSENT_ID, ctx.clock.now),
      reason: null,
      markets: [],
    });
    const reprice = await openItem(
      'odds_approval',
      { ...eventRef(ABSENT_ID, ctx.clock.now), reason: null, markets: [] },
      'fx|some-event|reprice',
    );
    const attempts: Array<[string, unknown]> = [
      [broken, { decision: 'map_alias', targetId: ids.home }],
      [broken, { decision: 'open_betting' }],
      [broken, { decision: 'apply_result' }],
      [broken, { decision: 'apply_kickoff' }],
      [odds, { decision: 'apply_result' }],
      [odds, { decision: 'apply_kickoff' }],
      [odds, { decision: 'map_alias', targetId: ids.home }],
      // An odds_approval item that is not a re-price takes no apply_reprice, and a re-price no open_betting.
      [odds, { decision: 'apply_reprice' }],
      [broken, { decision: 'apply_reprice' }],
      [reprice, { decision: 'open_betting' }],
    ];
    for (const [id, body] of attempts) {
      const response = await resolve('admin', id, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(errorOf(response).code).toBe('decision_not_allowed');
    }
    expect((await itemRow(broken)).status).toBe('open');
    expect((await itemRow(odds)).status).toBe('open');
    expect((await itemRow(reprice)).status).toBe('open');
  });

  it('map_alias adds the normalised alias (all sources or one), closes the item, audits; the same name for another target is 409', async () => {
    const raw = '  Saint-George  S.C.  ';
    const item = await openItem('unknown_team', {
      sport: 'football',
      raw,
      competition: 'Premier League',
      sourceId: 'src-ok',
      suggestions: [],
    });
    const response = await resolve('trader', item, { decision: 'map_alias', targetId: ids.home });
    expect(response.statusCode, response.body).toBe(200);
    const body = ResolveReviewResponse.parse(response.json());
    expect(body.item).toMatchObject({
      status: 'resolved',
      resolvedBy: as('trader').id,
      resolution: {
        decision: 'map_alias',
        targetId: ids.home,
        sourceId: null,
        by: as('trader').id,
      },
    });
    const norm = normalizeName(raw);
    const [alias] = await db
      .select()
      .from(schema.teamAliases)
      .where(eq(schema.teamAliases.aliasNorm, norm));
    expect(alias).toMatchObject({
      sportId: 'football',
      teamId: ids.home,
      sourceId: null,
      createdBy: as('trader').id,
    });
    expect(await auditActions('scrape.alias.added', alias!.id)).toHaveLength(1);
    expect(await auditActions('scrape.review.resolved', item)).toHaveLength(1);

    // The same name, another item, another target: the alias exists with a different team.
    const clash = await openItem('unknown_team', {
      sport: 'football',
      raw,
      competition: 'Cup',
      sourceId: 'src-off',
      suggestions: [],
    });
    const conflict = await resolve('trader', clash, { decision: 'map_alias', targetId: ids.away });
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict).code).toBe('alias_conflict');
    expect((await itemRow(clash)).status).toBe('open');
    // The same target again is idempotent.
    const same = await resolve('trader', clash, { decision: 'map_alias', targetId: ids.home });
    expect(same.statusCode, same.body).toBe(200);
    expect(
      await db.select().from(schema.teamAliases).where(eq(schema.teamAliases.aliasNorm, norm)),
    ).toHaveLength(1);

    // For one source only.
    const scoped = await openItem('unknown_team', {
      sport: 'football',
      raw: 'Bunna Gebeya',
      competition: 'Cup',
      sourceId: 'src-ok',
      suggestions: [],
    });
    const forSource = await resolve('trader', scoped, {
      decision: 'map_alias',
      targetId: ids.other,
      sourceId: 'src-ok',
    });
    expect(forSource.statusCode, forSource.body).toBe(200);
    const [scopedAlias] = await db
      .select()
      .from(schema.teamAliases)
      .where(eq(schema.teamAliases.aliasNorm, normalizeName('Bunna Gebeya')));
    expect(scopedAlias).toMatchObject({ teamId: ids.other, sourceId: 'src-ok' });
  });

  it('map_alias on an unknown_competition maps a competition; unknown targets and sources are 404', async () => {
    const item = await openItem('unknown_competition', {
      sport: 'football',
      raw: 'Ethiopian Premier League 2026',
      sourceId: 'src-ok',
      suggestions: [],
    });
    for (const [body, what] of [
      [{ decision: 'map_alias', targetId: ABSENT_ID }, 'absent competition'],
      [{ decision: 'map_alias', targetId: 'nope' }, 'malformed target'],
      [{ decision: 'map_alias', targetId: ids.league, sourceId: 'no-such-source' }, 'source'],
      // A team id is not a competition.
      [{ decision: 'map_alias', targetId: ids.home }, 'team as competition'],
    ] as const) {
      const response = await resolve('trader', item, body);
      expect(response.statusCode, what).toBe(404);
    }
    expect((await itemRow(item)).status).toBe('open');
    const ok = await resolve('trader', item, { decision: 'map_alias', targetId: ids.league });
    expect(ok.statusCode, ok.body).toBe(200);
    const [alias] = await db
      .select()
      .from(schema.competitionAliases)
      .where(
        eq(schema.competitionAliases.aliasNorm, normalizeName('Ethiopian Premier League 2026')),
      );
    expect(alias).toMatchObject({ competitionId: ids.league, sourceId: null });
  });

  it('open_betting opens a closed, scheduled, unresulted event that starts in time, and publishes the delta', async () => {
    const event = await newEvent(3 * HOUR, { bettingOpen: false });
    const item = await openItem('odds_approval', {
      ...eventRef(event.id, event.startTime),
      reason: 'Too few rated matches',
      markets: [],
    });
    const publish = vi.spyOn(ctx.redis, 'pipeline');
    const response = await resolve('trader', item, { decision: 'open_betting' });
    expect(response.statusCode, response.body).toBe(200);
    expect(publish).toHaveBeenCalled();
    publish.mockRestore();
    const body = ResolveReviewResponse.parse(response.json());
    expect(body.item).toMatchObject({
      status: 'resolved',
      resolution: { decision: 'open_betting', eventId: event.id, by: as('trader').id },
    });
    expect((await eventRow(event.id)).bettingOpen).toBe(true);
    expect(await auditActions('catalog.event.betting_opened', event.id)).toHaveLength(1);
    expect(await auditActions('scrape.review.resolved', item)).toHaveLength(1);
  });

  it('open_betting is refused (422, nothing changes) for a live, resulted, open, too-close or missing event', async () => {
    const cases: Array<[string, string, string]> = [];
    const live = await newEvent(-HOUR, { status: 'live', bettingOpen: false });
    cases.push(['live', live.id, 'event_not_scheduled']);
    const resulted = await newEvent(3 * HOUR, { bettingOpen: false });
    await db
      .update(schema.events)
      .set({ resultedAt: ctx.clock.now })
      .where(eq(schema.events.id, resulted.id));
    cases.push(['resulted', resulted.id, 'event_not_scheduled']);
    const open = await newEvent(3 * HOUR, { bettingOpen: true });
    cases.push(['already open', open.id, 'betting_already_open']);
    const close = await newEvent(5 * MINUTE, { bettingOpen: false });
    cases.push(['too close', close.id, 'kickoff_too_close']);
    cases.push(['missing', ABSENT_ID, 'event_not_found']);
    cases.push(['malformed id', 'nope', 'event_not_found']);
    for (const [label, eventId, code] of cases) {
      const item = await openItem('odds_approval', {
        ...eventRef(eventId, ctx.clock.now),
        reason: null,
        markets: [],
      });
      const response = await resolve('trader', item, { decision: 'open_betting' });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(422);
      expect(errorOf(response).code, label).toBe(code);
      expect((await itemRow(item)).status, label).toBe('open');
    }
    expect((await eventRow(live.id)).bettingOpen).toBe(false);
    expect((await eventRow(close.id)).bettingOpen).toBe(false);
    // The kickoff bound is MIN_LEAD_MS (10 minutes): just over it is fine.
    const justEnough = await newEvent(11 * MINUTE, { bettingOpen: false });
    const item = await openItem('odds_approval', {
      ...eventRef(justEnough.id, justEnough.startTime),
      reason: null,
      markets: [],
    });
    expect((await resolve('trader', item, { decision: 'open_betting' })).statusCode).toBe(200);
  });

  it('apply_result stores only the decision text and touches nothing else; both result kinds', async () => {
    const event = await newEvent(-3 * HOUR, { status: 'live' });
    for (const kind of ['result_ready', 'result_unverified'] as const) {
      const item = await openItem(kind, {
        ...eventRef(event.id, event.startTime),
        score: { home: 3, away: 1, htHome: 1, htAway: 0 },
        sources: [],
        exposure: { openBets: 2, totalStake: '150000' },
      });
      const response = await resolve('trader', item, {
        decision: 'apply_result',
        ...(kind === 'result_ready' ? {} : { note: 'checked on TV' }),
      });
      expect(response.statusCode, response.body).toBe(200);
      const row = await itemRow(item);
      expect(row.status).toBe('resolved');
      expect(row.resolution).toBe(`{"decision":"apply_result","by":"${as('trader').id}"}`);
      expect(row.resolvedBy).toBe(as('trader').id);
      // The view reads the text back as an object.
      expect(ResolveReviewResponse.parse(response.json()).item.resolution).toEqual({
        decision: 'apply_result',
        by: as('trader').id,
      });
      expect(await auditActions('scrape.review.resolved', item)).toHaveLength(1);
    }
    // No score is written by a request: the event is as it was.
    const after = await eventRow(event.id);
    expect(after).toMatchObject({
      status: 'live',
      scoreHome: null,
      scoreAway: null,
      resultedAt: null,
    });
  });

  it('apply_kickoff moves only the start time; markets and odds stay; refused when too close, live or resulted', async () => {
    const event = await newEvent(3 * HOUR);
    const market = await insertMarket(db, event.id, '1x2', null, ONE_X_TWO);
    const proposed = new Date(event.startTime.getTime() + 2 * HOUR);
    const snapshot = async () => ({
      markets: await db.select().from(schema.markets).where(eq(schema.markets.eventId, event.id)),
      selections: await db
        .select()
        .from(schema.selections)
        .where(eq(schema.selections.marketId, market.id)),
      history: await db.select().from(schema.oddsHistory),
    });
    const before = await snapshot();
    const item = await openItem('kickoff_change', {
      eventId: event.id,
      currentKickoff: event.startTime.toISOString(),
      proposedKickoff: proposed.toISOString(),
      sources: [],
      hasBets: false,
    });
    const response = await resolve('trader', item, { decision: 'apply_kickoff' });
    expect(response.statusCode, response.body).toBe(200);
    expect(ResolveReviewResponse.parse(response.json()).item).toMatchObject({
      status: 'resolved',
      resolution: { decision: 'apply_kickoff', eventId: event.id, by: as('trader').id },
    });
    const moved = await eventRow(event.id);
    expect(moved.startTime.toISOString()).toBe(proposed.toISOString());
    expect(moved).toMatchObject({ status: 'scheduled', bettingOpen: true, resultedAt: null });
    expect(await snapshot()).toEqual(before);
    expect(await auditActions('scrape.review.resolved', item)).toHaveLength(1);

    const refusals: Array<[string, string, Date, string]> = [];
    const soon = await newEvent(3 * HOUR);
    refusals.push([
      'too close',
      soon.id,
      new Date(ctx.clock.now.getTime() + 5 * MINUTE),
      'kickoff_too_close',
    ]);
    refusals.push(['past', soon.id, new Date(ctx.clock.now.getTime() - HOUR), 'kickoff_too_close']);
    const live = await newEvent(-HOUR, { status: 'live' });
    refusals.push([
      'live',
      live.id,
      new Date(ctx.clock.now.getTime() + 3 * HOUR),
      'event_not_scheduled',
    ]);
    const resulted = await newEvent(3 * HOUR);
    await db
      .update(schema.events)
      .set({ resultedAt: ctx.clock.now })
      .where(eq(schema.events.id, resulted.id));
    refusals.push([
      'resulted',
      resulted.id,
      new Date(ctx.clock.now.getTime() + 4 * HOUR),
      'event_not_scheduled',
    ]);
    refusals.push([
      'missing',
      ABSENT_ID,
      new Date(ctx.clock.now.getTime() + 4 * HOUR),
      'event_not_found',
    ]);
    for (const [label, eventId, to, code] of refusals) {
      const refused = await openItem('kickoff_change', {
        eventId,
        currentKickoff: ctx.clock.now.toISOString(),
        proposedKickoff: to.toISOString(),
        sources: [],
        hasBets: true,
      });
      const result = await resolve('trader', refused, { decision: 'apply_kickoff' });
      expect(result.statusCode, `${label}: ${result.body}`).toBe(422);
      expect(errorOf(result).code, label).toBe(code);
      expect((await itemRow(refused)).status, label).toBe('open');
    }
    expect((await eventRow(soon.id)).startTime.toISOString()).toBe(soon.startTime.toISOString());
  });

  describe('apply_reprice (rule O3)', () => {
    const RATINGS = { attack: 1.2, defence: 0.9, matches: 10 };
    // Far beyond MAX_PRICE_MOVE_RATIO either way, and a sane 1x2 book (overround about 1.04).
    const PROPOSAL = [
      {
        type: '1x2',
        line: null,
        selections: [
          { code: '1', oddsMilli: 2400 },
          { code: 'X', oddsMilli: 3400 },
          { code: '2', oddsMilli: 3000 },
        ],
      },
    ];
    const pricesOf = async (marketId: string) =>
      Object.fromEntries(
        (
          await db.select().from(schema.selections).where(eq(schema.selections.marketId, marketId))
        ).map((row) => [row.code, row.oddsMilli]),
      );
    const stampOf = async (eventId: string) =>
      (
        await db
          .select()
          .from(schema.scrapeEventPricing)
          .where(eq(schema.scrapeEventPricing.eventId, eventId))
      )[0];

    async function repriceCase(
      startsInMs = 3 * HOUR,
      options: {
        proposal?: unknown;
        ratingsKey?: string | undefined;
        subject?: (feedRef: string) => string;
        markets?: Array<[string, string | null, Array<[string, number]>]>;
      } = {},
    ) {
      await db.transaction(async (tx) => {
        await setTeamRatings(tx, ids.home, RATINGS, { system: 'test' });
        await setTeamRatings(tx, ids.away, RATINGS, { system: 'test' });
      });
      const event = await newEvent(startsInMs);
      const market = await insertMarket(db, event.id, '1x2', null, ONE_X_TWO);
      for (const [type, line, selectionRows] of options.markets ?? []) {
        await insertMarket(db, event.id, type, line, selectionRows);
      }
      const feedRef = (await eventRow(event.id)).feedRef;
      const item = await openItem(
        'odds_approval',
        {
          ...eventRef(event.id, event.startTime),
          reason: 'price_move_too_large 1x2 1 1850 → 2400',
          markets: [],
          ...('proposal' in options && options.proposal === undefined
            ? {}
            : { proposal: options.proposal ?? PROPOSAL }),
          ...('ratingsKey' in options && options.ratingsKey === undefined
            ? {}
            : { ratingsKey: options.ratingsKey ?? ratingsKey(RATINGS, RATINGS) }),
        },
        options.subject?.(feedRef) ?? `${feedRef}${REPRICE_SUBJECT_SUFFIX}`,
      );
      return { event, market, item, feedRef };
    }

    it('applies the stored proposal in one transaction, stamps the ratings, audits and publishes', async () => {
      const { event, market, item } = await repriceCase();
      const before = await pricesOf(market.id);
      expect(before).toEqual({ '1': 1850, X: 3400, '2': 4200 });
      const publish = vi.spyOn(ctx.redis, 'pipeline');
      const response = await resolve('trader', item, { decision: 'apply_reprice' });
      expect(response.statusCode, response.body).toBe(200);
      expect(publish).toHaveBeenCalled();
      publish.mockRestore();

      expect(ResolveReviewResponse.parse(response.json()).item).toMatchObject({
        status: 'resolved',
        resolution: {
          decision: 'apply_reprice',
          eventId: event.id,
          oddsChanged: 2,
          by: as('trader').id,
        },
      });
      expect(await pricesOf(market.id)).toEqual({ '1': 2400, X: 3400, '2': 3000 });
      const history = await db
        .select()
        .from(schema.oddsHistory)
        .where(eq(schema.oddsHistory.selectionId, market.selectionIds['1']!));
      expect(history.map((h) => [h.oddsMilli, h.source])).toEqual([[2400, 'feed']]);
      // The event itself is untouched: still open for betting, same start.
      expect(await eventRow(event.id)).toMatchObject({
        status: 'scheduled',
        bettingOpen: true,
        startTime: event.startTime,
      });
      expect((await stampOf(event.id))?.ratingsKey).toBe(ratingsKey(RATINGS, RATINGS));
      const [audit] = await auditActions('scrape.fixture.repriced', event.id);
      expect(audit).toMatchObject({ actorType: 'admin', actorId: as('trader').id });
      expect(audit!.metadata).toMatchObject({ via: 'staff', reviewItemId: item, oddsChanged: 2 });
      expect(await auditActions('scrape.review.resolved', item)).toHaveLength(1);

      // Closed now: a second resolve changes nothing.
      const again = await resolve('trader', item, { decision: 'apply_reprice' });
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).code).toBe('review_closed');
    });

    it('is refused, with nothing changed, for a stale proposal, a live, resulted, missing or too close event', async () => {
      const cases: Array<
        [string, () => Promise<{ item: string; market: { id: string } }>, number, string]
      > = [];
      cases.push([
        'ratings moved since',
        async () => {
          const c = await repriceCase();
          await db.transaction((tx) =>
            setTeamRatings(
              tx,
              ids.home,
              { ...RATINGS, attack: 1.3, matches: 11 },
              { system: 'test' },
            ),
          );
          return c;
        },
        409,
        'proposal_stale',
      ]);
      cases.push([
        'live',
        async () => {
          const c = await repriceCase();
          await db
            .update(schema.events)
            .set({ status: 'live' })
            .where(eq(schema.events.id, c.event.id));
          return c;
        },
        422,
        'event_not_scheduled',
      ]);
      cases.push([
        'resulted',
        async () => {
          const c = await repriceCase();
          await db
            .update(schema.events)
            .set({ resultedAt: ctx.clock.now })
            .where(eq(schema.events.id, c.event.id));
          return c;
        },
        422,
        'event_not_scheduled',
      ]);
      cases.push(['too close', () => repriceCase(5 * MINUTE), 422, 'kickoff_too_close']);
      cases.push([
        'event deleted',
        async () => {
          const c = await repriceCase();
          // The item points at an event that does not exist.
          await db
            .update(schema.scrapeReviewItems)
            .set({
              payload: {
                ...eventRef(ABSENT_ID, ctx.clock.now),
                reason: null,
                markets: [],
                proposal: PROPOSAL,
                ratingsKey: ratingsKey(RATINGS, RATINGS),
              },
            })
            .where(eq(schema.scrapeReviewItems.id, c.item));
          return c;
        },
        422,
        'event_not_found',
      ]);
      cases.push([
        'another event',
        async () => {
          // The payload names an event whose feed_ref is not the item's subject.
          const c = await repriceCase();
          const other = await newEvent(4 * HOUR);
          await insertMarket(db, other.id, '1x2', null, ONE_X_TWO);
          await db
            .update(schema.scrapeReviewItems)
            .set({
              payload: {
                ...eventRef(other.id, other.startTime),
                reason: null,
                markets: [],
                proposal: PROPOSAL,
                ratingsKey: ratingsKey(RATINGS, RATINGS),
              },
            })
            .where(eq(schema.scrapeReviewItems.id, c.item));
          return c;
        },
        422,
        'invalid_payload',
      ]);
      cases.push([
        'no proposal',
        () => repriceCase(3 * HOUR, { proposal: undefined }),
        422,
        'invalid_payload',
      ]);
      cases.push([
        'no ratings fingerprint',
        () => repriceCase(3 * HOUR, { ratingsKey: undefined }),
        422,
        'invalid_payload',
      ]);
      cases.push([
        'insane book (overround too high)',
        () =>
          repriceCase(3 * HOUR, {
            proposal: [
              {
                type: '1x2',
                line: null,
                selections: [
                  { code: '1', oddsMilli: 1500 },
                  { code: 'X', oddsMilli: 1500 },
                  { code: '2', oddsMilli: 1500 },
                ],
              },
            ],
          }),
        422,
        'proposal_not_applicable',
      ]);
      cases.push([
        'a market the event does not have',
        () =>
          repriceCase(3 * HOUR, {
            proposal: [
              ...PROPOSAL,
              {
                type: 'btts',
                line: null,
                selections: [
                  { code: 'yes', oddsMilli: 1800 },
                  { code: 'no', oddsMilli: 2100 },
                ],
              },
            ],
          }),
        422,
        'proposal_not_applicable',
      ]);
      cases.push([
        'a market the proposal lacks',
        () =>
          repriceCase(3 * HOUR, {
            markets: [
              [
                'btts',
                null,
                [
                  ['yes', 1800],
                  ['no', 2100],
                ],
              ],
            ],
          }),
        422,
        'proposal_not_applicable',
      ]);
      const audited = (await auditActions('scrape.fixture.repriced')).length;
      for (const [label, make, status, code] of cases) {
        const { item, market } = await make();
        const before = await pricesOf(market.id);
        const response = await resolve('trader', item, { decision: 'apply_reprice' });
        expect(response.statusCode, `${label}: ${response.body}`).toBe(status);
        expect(errorOf(response).code, label).toBe(code);
        expect((await itemRow(item)).status, label).toBe('open');
        expect(await pricesOf(market.id), label).toEqual(before);
      }
      expect(await auditActions('scrape.fixture.repriced')).toHaveLength(audited);
    });

    it('leaves a closed market alone and still applies the rest', async () => {
      const { event, item } = await repriceCase(3 * HOUR, {
        proposal: [
          ...PROPOSAL,
          {
            type: 'btts',
            line: null,
            selections: [
              { code: 'yes', oddsMilli: 1000 + 800 },
              { code: 'no', oddsMilli: 2100 },
            ],
          },
        ],
      });
      // The event has no btts market in this case: add it closed, so the proposal's btts is skipped.
      const closed = await insertMarket(
        db,
        event.id,
        'btts',
        null,
        [
          ['yes', 1700],
          ['no', 2200],
        ],
        'closed',
      );
      const response = await resolve('trader', item, { decision: 'apply_reprice' });
      expect(response.statusCode, response.body).toBe(200);
      expect(await pricesOf(closed.id)).toEqual({ yes: 1700, no: 2200 });
    });
  });

  it('never cancels or voids an event: no decision changes an event status', async () => {
    const cancelled = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.status, 'cancelled'));
    expect(cancelled).toEqual([]);
  });
});

describe('aliases', () => {
  it('creates an alias (201), is idempotent (200, created false), audits, and refuses a clash with 409', async () => {
    const create = (body: unknown, role: StaffRole = 'trader') =>
      asStaff(ctx, as(role), 'POST', '/admin/feed/aliases', body);
    const response = await create({ kind: 'team', raw: ' Fasil  Ketema ', targetId: ids.away });
    expect(response.statusCode, response.body).toBe(201);
    const created = CreateAliasResponse.parse(response.json());
    expect(created.created).toBe(true);
    expect(created.alias).toMatchObject({
      kind: 'team',
      sport: 'football',
      normalized: normalizeName('Fasil Ketema'),
      targetId: ids.away,
      targetName: 'Fasil Kenema',
      sourceId: null,
      createdBy: as('trader').id,
    });
    expect(await auditActions('scrape.alias.added', created.alias.id)).toHaveLength(1);

    const again = await create({ kind: 'team', raw: 'fasil ketema', targetId: ids.away });
    expect(again.statusCode).toBe(200);
    const same = CreateAliasResponse.parse(again.json());
    expect(same.created).toBe(false);
    expect(same.alias.id).toBe(created.alias.id);

    const clash = await create({ kind: 'team', raw: 'Fasil Ketema', targetId: ids.home });
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash).code).toBe('alias_conflict');

    const scoped = await create({
      kind: 'team',
      raw: 'Fasil Ketema',
      targetId: ids.home,
      sourceId: 'src-ok',
    });
    expect(scoped.statusCode, scoped.body).toBe(201);
    expect(CreateAliasResponse.parse(scoped.json()).alias.sourceId).toBe('src-ok');

    const competition = await create({
      kind: 'competition',
      raw: 'Ligue Ethiopia',
      targetId: ids.cup,
    });
    expect(competition.statusCode, competition.body).toBe(201);
    expect(CreateAliasResponse.parse(competition.json()).alias).toMatchObject({
      kind: 'competition',
      targetName: 'Cup',
    });
    expect(await auditActions('scrape.alias.added')).not.toHaveLength(0);
  });

  it('refuses unknown targets and sources (404), unknown fields and empty names (400)', async () => {
    const create = (body: unknown) =>
      asStaff(ctx, as('trader'), 'POST', '/admin/feed/aliases', body);
    expect((await create({ kind: 'team', raw: 'X Team', targetId: ABSENT_ID })).statusCode).toBe(
      404,
    );
    expect((await create({ kind: 'team', raw: 'X Team', targetId: 'nope' })).statusCode).toBe(404);
    // A competition id is not a team.
    expect((await create({ kind: 'team', raw: 'X Team', targetId: ids.league })).statusCode).toBe(
      404,
    );
    expect(
      (await create({ kind: 'team', raw: 'X Team', targetId: ids.home, sourceId: 'no-such' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await create({ kind: 'team', raw: 'X Team', targetId: ids.home, extra: 1 })).statusCode,
    ).toBe(400);
    expect((await create({ kind: 'team', raw: '   ', targetId: ids.home })).statusCode).toBe(400);
    // A name that normalises to nothing is refused by the service.
    const empty = await create({ kind: 'team', raw: '---', targetId: ids.home });
    expect(empty.statusCode).toBe(422);
    expect(errorOf(empty).code).toBe('scrape_bad_alias');
  });

  it('lists newest first with filters and a cursor', async () => {
    const list = async (query = '') =>
      AliasListResponse.parse(
        (await asStaff(ctx, as('trader'), 'GET', `/admin/feed/aliases${query}`)).json(),
      );
    const all = await list('?limit=100');
    expect(all.items.length).toBeGreaterThanOrEqual(4);
    const times = all.items.map((item) => item.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.nextCursor).toBeNull();

    expect(
      (await list('?kind=competition')).items.every((item) => item.kind === 'competition'),
    ).toBe(true);
    expect((await list('?sourceId=src-ok')).items.every((item) => item.sourceId === 'src-ok')).toBe(
      true,
    );
    const found = await list('?q=ketema');
    expect(found.items.length).toBeGreaterThanOrEqual(2);
    expect(found.items.every((item) => item.normalized.includes('ketema'))).toBe(true);
    expect((await list('?q=zzzz-nothing')).items).toEqual([]);

    const first = await list('?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]!.id);
    const second = await list(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.id)).toEqual(
      all.items.slice(2, 4).map((item) => item.id),
    );
    expect(
      (await asStaff(ctx, as('trader'), 'GET', '/admin/feed/aliases?limit=0')).statusCode,
    ).toBe(400);
  });
});

describe('PUT /admin/feed/sources/:id', () => {
  it('switches a source off and on, audited, and answers with its health', async () => {
    const put = (id: string, body: unknown, role: StaffRole = 'trader') =>
      asStaff(ctx, as(role), 'PUT', `/admin/feed/sources/${id}`, body);
    const off = await put('src-ok', { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(SetSourceEnabledResponse.parse(off.json()).source).toMatchObject({
      id: 'src-ok',
      enabled: false,
      state: 'disabled',
    });
    expect(await auditActions('scrape.source.disabled', 'src-ok')).toHaveLength(1);
    const repeat = await put('src-ok', { enabled: false });
    expect(repeat.statusCode).toBe(200);
    expect(await auditActions('scrape.source.disabled', 'src-ok')).toHaveLength(1);

    const enabledBefore = (await auditActions('scrape.source.enabled', 'src-ok')).length;
    const on = await put('src-ok', { enabled: true }, 'admin');
    expect(SetSourceEnabledResponse.parse(on.json()).source).toMatchObject({
      enabled: true,
      state: 'ok',
    });
    expect(await auditActions('scrape.source.enabled', 'src-ok')).toHaveLength(enabledBefore + 1);

    expect((await put('no-such-source', { enabled: true })).statusCode).toBe(404);
    expect((await put('src-ok', { enabled: 'yes' })).statusCode).toBe(400);
    expect((await put('src-ok', { enabled: true, name: 'x' })).statusCode).toBe(400);
    expect((await put('src-ok', {})).statusCode).toBe(400);
  });
});

describe('competition policy', () => {
  const put = (id: string, body: unknown, role: StaffRole) =>
    asStaff(ctx, as(role), 'PUT', `/admin/feed/competitions/${id}`, body);

  it('lists every competition, all flags off until a policy exists', async () => {
    const response = await asStaff(ctx, as('trader'), 'GET', '/admin/feed/competitions');
    expect(response.statusCode, response.body).toBe(200);
    const { items } = FeedCompetitionsResponse.parse(response.json());
    expect(items.map((item) => item.name)).toEqual(['Cup', 'Premier League']);
    expect(items[0]).toEqual({
      competitionId: ids.cup,
      name: 'Cup',
      sport: 'football',
      enabled: false,
      autoOpen: false,
      autoResults: false,
      extraTime: false,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('lets an admin change any flag (audited with before and after); a trader only turns safety flags off', async () => {
    const on = await put(ids.league, { enabled: true, autoOpen: true, extraTime: true }, 'admin');
    expect(on.statusCode, on.body).toBe(200);
    expect(UpdateCompetitionPolicyResponse.parse(on.json()).competition).toMatchObject({
      competitionId: ids.league,
      enabled: true,
      autoOpen: true,
      autoResults: false,
      extraTime: true,
      updatedBy: as('admin').id,
    });
    const audit = await auditActions('scrape.policy.updated', ids.league);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      before: { enabled: false, autoOpen: false },
      after: { enabled: true, autoOpen: true },
    });

    // A trader: turning off is allowed, on is not, extraTime is not.
    const off = await put(ids.league, { autoOpen: false, enabled: false }, 'trader');
    expect(off.statusCode, off.body).toBe(200);
    expect(UpdateCompetitionPolicyResponse.parse(off.json()).competition).toMatchObject({
      enabled: false,
      autoOpen: false,
      extraTime: true,
      updatedBy: as('trader').id,
    });
    for (const body of [
      { enabled: true },
      { extraTime: false },
      { autoOpen: false, autoResults: true },
      {},
    ]) {
      const refused = await put(ids.league, body, 'trader');
      expect(refused.statusCode, JSON.stringify(body)).toBe(403);
      expect(errorOf(refused).details).toEqual({ permission: 'settings.edit' });
    }
    // Other roles never get through the guard.
    expect((await put(ids.league, { enabled: false }, 'support')).statusCode).toBe(403);

    const health = FeedHealthResponse.parse(
      (await asStaff(ctx, as('trader'), 'GET', '/admin/feed/health')).json(),
    );
    expect(health.competitions).toEqual({ total: 2, enabled: 0, autoOpen: 0, autoResults: 0 });
  });

  it('answers 404 for a competition that does not exist and 400 for an empty or unknown-field body', async () => {
    expect((await put(ABSENT_ID, { enabled: true }, 'admin')).statusCode).toBe(404);
    expect((await put('nope', { enabled: true }, 'admin')).statusCode).toBe(404);
    expect((await put(ABSENT_ID, { enabled: false }, 'trader')).statusCode).toBe(404);
    expect((await put(ids.cup, {}, 'admin')).statusCode).toBe(400);
    expect((await put(ids.cup, { enabled: true, name: 'x' }, 'admin')).statusCode).toBe(400);
    expect((await put(ids.cup, { enabled: 'on' }, 'admin')).statusCode).toBe(400);
    // Nothing was written for the competition.
    expect(await auditActions('scrape.policy.updated', ids.cup)).toHaveLength(0);
  });
});
