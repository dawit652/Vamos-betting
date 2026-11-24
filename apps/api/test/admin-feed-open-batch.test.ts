import { OpenBatchResponse, OpenCheckResponse, type StaffRole } from '@vamos/contracts';
import { SCRAPED_FEED_PROVIDER, type ScrapeReviewKind } from '@vamos/core';
import {
  finishRun,
  openReviewItem,
  schema,
  setSourceEnabled,
  setTeamRatings,
  startRun,
  upsertMarketOdds,
  upsertSource,
  type Database,
} from '@vamos/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACK_OFFICE_ROLES,
  asStaff,
  seedStaff,
  staffLogin,
  type StaffSession,
} from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const SOURCE = 'src-open-batch';

let ctx: TestContext;
let db: Database;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;
const ids = {} as Record<'league' | 'home' | 'away', string>;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  for (const role of BACK_OFFICE_ROLES) staff.set(role, await staffLogin(ctx, role));
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  ids.league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'premier-league',
    name: { en: 'Premier League' },
  });
  ids.home = await insertTeam(db, 'football', 'OBH', { en: 'Batch Home' });
  ids.away = await insertTeam(db, 'football', 'OBA', { en: 'Batch Away' });
  for (const team of [ids.home, ids.away]) {
    await db.transaction((tx) =>
      setTeamRatings(tx, team, { attack: 1.2, defence: 0.9, manual: 1 }, { system: 'test' }),
    );
  }
  await db.transaction(async (tx) => {
    await upsertSource(
      tx,
      { id: SOURCE, name: SOURCE, adapter: 'generic-json', upstream: SOURCE, config: {} },
      { system: 'test' },
    );
    await setSourceEnabled(tx, SOURCE, true, { system: 'test' });
  });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

/** Three books at 2.10 / 3.50 / 3.70 (a 3.2% overround): fair odds about 2.17 / 3.61 / 3.82. */
const CONSENSUS = { '1': 2100, X: 3500, '2': 3700 } as const;
/** Our book made from that consensus with 6% margin: within the 3% tolerance. */
const GOOD: Array<[string, number]> = [
  ['1', 2040],
  ['X', 3400],
  ['2', 3600],
];
/** The home price is 15% too short. */
const BAD: Array<[string, number]> = [
  ['1', 1700],
  ['X', 3400],
  ['2', 3600],
];

async function addConsensus(eventId: string, startTime: Date): Promise<void> {
  // One source per event: a source's latest ok run must not start after the rows it vouches for.
  const sourceId = `${SOURCE}-${eventId.slice(0, 8)}`;
  await db.transaction(async (tx) => {
    await upsertSource(
      tx,
      { id: sourceId, name: sourceId, adapter: 'generic-json', upstream: sourceId, config: {} },
      { system: 'test' },
    );
    await setSourceEnabled(tx, sourceId, true, { system: 'test' });
  });
  const observedAt = new Date(ctx.clock.now.getTime() - 5 * MINUTE);
  const run = await startRun(db, { sourceId, startedAt: observedAt });
  await finishRun(db, run.id, { status: 'ok', finishedAt: observedAt });
  const rows = ['pinnacle', 'betsson', 'unibet_se'].flatMap((bookmaker) =>
    (['1', 'X', '2'] as const).map((selection) => ({
      sourceKey: `match-${eventId}`,
      sport: 'football',
      competitionRaw: 'Premier League',
      homeRaw: 'Home',
      awayRaw: 'Away',
      kickoff: startTime,
      priceUpdatedAt: observedAt,
      observedAt,
      competitionId: ids.league,
      homeTeamId: ids.home,
      awayTeamId: ids.away,
      eventId,
      market: '1x2' as const,
      line: null,
      selection,
      bookmaker,
      priceMilli: CONSENSUS[selection],
    })),
  );
  await db.transaction((tx) =>
    upsertMarketOdds(tx, { sourceId, runId: run.id, rawId: null, rows }),
  );
}

let subject = 0;
async function openItem(
  payload: Record<string, unknown>,
  opts: { subjectKey?: string; kind?: ScrapeReviewKind } = {},
): Promise<string> {
  ctx.clock.advance(1000);
  const { item } = await db.transaction((tx) =>
    openReviewItem(tx, {
      kind: opts.kind ?? 'odds_approval',
      subjectKey: opts.subjectKey ?? `open-batch-${subject++}`,
      severity: 'warning',
      title: 'Open betting',
      payload,
      now: ctx.clock.now,
    }),
  );
  return item.id;
}

interface Made {
  eventId: string;
  itemId: string;
}

/** A scraped, closed event with its stored 1X2 prices, an open odds_approval item and (by default) a fresh consensus. */
async function make(
  opts: { prices?: Array<[string, number]>; consensus?: boolean; startsInMs?: number } = {},
): Promise<Made> {
  const startTime = new Date(ctx.clock.now.getTime() + (opts.startsInMs ?? 6 * HOUR));
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: ids.league,
    homeTeamId: ids.home,
    awayTeamId: ids.away,
    startTime,
    bettingOpen: false,
  });
  await db
    .update(schema.events)
    .set({ feedProvider: SCRAPED_FEED_PROVIDER })
    .where(eq(schema.events.id, event.id));
  await insertMarket(db, event.id, '1x2', null, opts.prices ?? GOOD);
  if (opts.consensus !== false) await addConsensus(event.id, startTime);
  const itemId = await openItem({
    eventId: event.id,
    gameId: '1',
    home: 'Batch Home',
    away: 'Batch Away',
    kickoff: startTime.toISOString(),
    reason: 'auto_open_off',
    markets: [],
  });
  return { eventId: event.id, itemId };
}

const batch = (role: StaffRole, itemIds: unknown) =>
  asStaff(ctx, as(role), 'POST', '/admin/feed/review/open-batch', { itemIds });

const check = (role: StaffRole, itemIds: unknown) =>
  asStaff(ctx, as(role), 'POST', '/admin/feed/review/open-check', { itemIds });

const bettingOpen = async (eventId: string) =>
  (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!.bettingOpen;

const itemStatus = async (id: string) =>
  (await db.select().from(schema.scrapeReviewItems).where(eq(schema.scrapeReviewItems.id, id)))[0]!;

const audits = (action: string, targetId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)));

function resultOf(body: OpenBatchResponse, itemId: string) {
  return body.results.find((r) => r.itemId === itemId)!;
}

describe('POST /admin/feed/review/open-batch', () => {
  it('needs trading.status: 401 without a session, 403 to other roles', async () => {
    const one = await make();
    const url = '/admin/feed/review/open-batch';
    expect(
      (await ctx.app.inject({ method: 'POST', url, payload: { itemIds: [one.itemId] } }))
        .statusCode,
    ).toBe(401);
    for (const role of BACK_OFFICE_ROLES) {
      const response = await batch(role, [one.itemId]);
      expect(response.statusCode, role).toBe(role === 'admin' || role === 'trader' ? 200 : 403);
    }
  });

  it('validates the body: 1..50 distinct ids, no extra keys', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const many = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const body of [
      { itemIds: [] },
      { itemIds: [id, id] },
      { itemIds: many },
      { itemIds: [id], extra: 1 },
      {},
    ]) {
      const response = await asStaff(
        ctx,
        as('trader'),
        'POST',
        '/admin/feed/review/open-batch',
        body,
      );
      expect(response.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });

  it('opens a within-tolerance item exactly like the single decision, marked as a batch', async () => {
    const made = await make();
    const response = await batch('trader', [made.itemId]);
    expect(response.statusCode, response.body).toBe(200);
    const body = OpenBatchResponse.parse(response.json());
    expect(body).toMatchObject({ opened: 1, failed: 0 });
    expect(resultOf(body, made.itemId).item).toMatchObject({
      status: 'resolved',
      resolution: {
        decision: 'open_betting',
        eventId: made.eventId,
        batch: true,
        by: as('trader').id,
      },
    });
    expect(await bettingOpen(made.eventId)).toBe(true);
    expect(await audits('catalog.event.betting_opened', made.eventId)).toHaveLength(1);
    expect(await audits('scrape.review.resolved', made.itemId)).toHaveLength(1);
    const marker = await audits('scrape.review.open_batch', made.eventId);
    expect(marker).toHaveLength(1);
    expect(marker[0]!.metadata).toMatchObject({ batch: true, reviewItemId: made.itemId });
  });

  it('refuses an out-of-tolerance item and leaves it open', async () => {
    const made = await make({ prices: BAD });
    const body = OpenBatchResponse.parse((await batch('trader', [made.itemId])).json());
    expect(body).toMatchObject({ opened: 0, failed: 1 });
    expect(resultOf(body, made.itemId).error?.code).toBe('out_of_tolerance');
    expect(await bettingOpen(made.eventId)).toBe(false);
    expect((await itemStatus(made.itemId)).status).toBe('open');
  });

  it('refuses an item with no fresh consensus (no_consensus)', async () => {
    const made = await make({ consensus: false });
    const body = OpenBatchResponse.parse((await batch('trader', [made.itemId])).json());
    expect(resultOf(body, made.itemId).error?.code).toBe('no_consensus');
    expect(await bettingOpen(made.eventId)).toBe(false);
    expect((await itemStatus(made.itemId)).status).toBe('open');
  });

  it('refuses a re-price item, and an item that is not odds_approval', async () => {
    const made = await make();
    const reprice = await openItem(
      {
        eventId: made.eventId,
        gameId: '1',
        home: 'a',
        away: 'b',
        kickoff: new Date(ctx.clock.now.getTime() + 6 * HOUR).toISOString(),
        reason: 'reprice',
        markets: [],
      },
      { subjectKey: 'feed-ref-1|reprice' },
    );
    const other = await openItem(
      { sourceId: SOURCE, runId: 'r1', reason: 'x' },
      { kind: 'source_broken' },
    );
    const body = OpenBatchResponse.parse((await batch('trader', [reprice, other])).json());
    expect(body).toMatchObject({ opened: 0, failed: 2 });
    expect(resultOf(body, reprice).error?.code).toBe('decision_not_allowed');
    expect(resultOf(body, other).error?.code).toBe('decision_not_allowed');
    expect(await bettingOpen(made.eventId)).toBe(false);
    expect((await itemStatus(reprice)).status).toBe('open');
  });

  it('a partial failure leaves the others opened, results in request order', async () => {
    const good1 = await make();
    const bad = await make({ prices: BAD });
    const good2 = await make();
    const closed = await make();
    const dismissed = await asStaff(
      ctx,
      as('trader'),
      'POST',
      `/admin/feed/review/${closed.itemId}/resolve`,
      { decision: 'dismiss', note: 'not needed' },
    );
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    const missing = '00000000-0000-4000-8000-0000000000aa';
    const order = [good1.itemId, bad.itemId, closed.itemId, missing, good2.itemId];
    const response = await batch('trader', order);
    expect(response.statusCode, response.body).toBe(200);
    const body = OpenBatchResponse.parse(response.json());
    expect(body.results.map((r) => r.itemId)).toEqual(order);
    expect(body.results.map((r) => r.ok)).toEqual([true, false, false, false, true]);
    expect(body).toMatchObject({ opened: 2, failed: 3 });
    expect(resultOf(body, closed.itemId).error?.code).toBe('review_closed');
    expect(resultOf(body, missing).error?.code).toBe('not_found');
    expect(await bettingOpen(good1.eventId)).toBe(true);
    expect(await bettingOpen(good2.eventId)).toBe(true);
    expect(await bettingOpen(bad.eventId)).toBe(false);
    expect(await bettingOpen(closed.eventId)).toBe(false);
  });

  it('still refuses what the single decision refuses: kickoff too close, prices failing O2, uncalibrated teams', async () => {
    const soon = await make({ startsInMs: 5 * MINUTE });
    const insane = await make({
      prices: [
        ['1', 30000],
        ['X', 30000],
        ['2', 30000],
      ],
    });
    const home = await insertTeam(db, 'football', 'OBU1', { en: 'Unrated Home' });
    const away = await insertTeam(db, 'football', 'OBU2', { en: 'Unrated Away' });
    const unrated = await make();
    await db
      .update(schema.events)
      .set({ homeTeamId: home, awayTeamId: away })
      .where(eq(schema.events.id, unrated.eventId));
    const body = OpenBatchResponse.parse(
      (await batch('trader', [soon.itemId, insane.itemId, unrated.itemId])).json(),
    );
    expect(resultOf(body, soon.itemId).error?.code).toBe('kickoff_too_close');
    expect(resultOf(body, insane.itemId).error?.code).toBe('prices_failed_checks');
    expect(resultOf(body, unrated.itemId).error?.code).toBe('teams_uncalibrated');
    expect(body.opened).toBe(0);
    for (const m of [soon, insane, unrated]) expect(await bettingOpen(m.eventId)).toBe(false);
  });

  it('refuses an event whose betting is already open', async () => {
    const made = await make();
    await db
      .update(schema.events)
      .set({ bettingOpen: true })
      .where(eq(schema.events.id, made.eventId));
    const body = OpenBatchResponse.parse((await batch('trader', [made.itemId])).json());
    expect(resultOf(body, made.itemId).error?.code).toBe('betting_already_open');
  });

  it('a second call for an opened item reports review_closed', async () => {
    const made = await make();
    await batch('trader', [made.itemId]);
    const body = OpenBatchResponse.parse((await batch('trader', [made.itemId])).json());
    expect(resultOf(body, made.itemId).error?.code).toBe('review_closed');
  });
});

describe('POST /admin/feed/review/open-check', () => {
  it('needs trading.status and reports each item (read only)', async () => {
    const good = await make();
    const bad = await make({ prices: BAD });
    const none = await make({ consensus: false });
    expect((await check('support', [good.itemId])).statusCode).toBe(403);
    const response = await check('trader', [
      good.itemId,
      bad.itemId,
      none.itemId,
      '00000000-0000-4000-8000-0000000000bb',
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const body = OpenCheckResponse.parse(response.json());
    expect(body.toleranceBps).toBe(300);
    expect(body.results.map((r) => [r.withinTolerance, r.reason])).toEqual([
      [true, null],
      [false, 'out_of_tolerance'],
      [false, 'no_consensus'],
      [false, 'not_open_item'],
    ]);
    expect(body.results[0]!.selections).toHaveLength(3);
    expect(await bettingOpen(good.eventId)).toBe(false);
    expect((await itemStatus(good.itemId)).status).toBe('open');
  });
});
