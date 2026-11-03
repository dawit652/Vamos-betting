import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FEED_PROVIDER,
  listFeedLeagues,
  listFeedReviewQueue,
  staffAcceptFeedResult,
  staffUpdateFeedLeague,
  staffVoidFeedResult,
  upsertFeedLeague,
  type CatalogIds,
} from '../src/index';
import { auditLog, events, feedResults } from '../src/schema/index';
import { createBettingDatabase, createEvent, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';

let handle: TestDb;
let ids: CatalogIds;

const actor = { adminId: '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', ip: '10.1.2.3' };
const T0 = new Date('2026-11-07T10:00:00Z');
const PAST = () => new Date(Date.now() - 3 * 3600_000);

beforeAll(async () => {
  ({ handle, ids } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** An event of the seeded catalogue with a feed result waiting for review. */
async function queued(
  reviewReason: 'cup' | 'tennis' | 'overdue' | 'unreadable',
  score: [number, number] | null,
  firstSeenAt = T0,
): Promise<string> {
  const { eventId } = await createEvent(handle.db, ids, { startTime: PAST() });
  await handle.db.insert(feedResults).values({
    eventId,
    provider: FEED_PROVIDER,
    scoreHome: score?.[0] ?? null,
    scoreAway: score?.[1] ?? null,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    reviewReason,
  });
  return eventId;
}

const audits = (action: string, targetId: string) =>
  handle.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));

async function eventRow(id: string) {
  const [row] = await handle.db.select().from(events).where(eq(events.id, id));
  return row!;
}

describe('the feed review queue', () => {
  it('lists waiting results oldest first with teams, competition, start time and Game ID', async () => {
    const later = await queued('cup', [2, 1], new Date(T0.getTime() + 60_000));
    const first = await queued('overdue', null, T0);
    // An applied row and one with no review reason are not in the queue.
    const applied = await queued('tennis', [1, 0]);
    await handle.db
      .update(feedResults)
      .set({ appliedAt: new Date() })
      .where(eq(feedResults.eventId, applied));
    const { eventId: plain } = await createEvent(handle.db, ids);
    await handle.db.insert(feedResults).values({
      eventId: plain,
      provider: FEED_PROVIDER,
      scoreHome: 1,
      scoreAway: 1,
      firstSeenAt: T0,
      lastSeenAt: T0,
    });

    const queue = await listFeedReviewQueue(handle.db);
    const mine = queue.filter((item) => [later, first].includes(item.eventId));
    expect(mine.map((item) => item.eventId)).toEqual([first, later]);
    expect(queue.map((item) => item.eventId)).not.toContain(applied);
    expect(queue.map((item) => item.eventId)).not.toContain(plain);
    const row = mine[1]!;
    const [event] = await handle.db.select().from(events).where(eq(events.id, later));
    expect(row).toMatchObject({
      gameId: event!.gameId,
      sportId: 'football',
      reviewReason: 'cup',
      scoreHome: 2,
      scoreAway: 1,
      eventStatus: 'scheduled',
    });
    expect(row.homeTeam.en).toBe('Arsenal');
    expect(row.awayTeam.en).toBe('Chelsea');
    expect(row.competition.en).toEqual(expect.any(String));
    expect(row.startTime).toEqual(event!.startTime);
    expect(mine[0]).toMatchObject({ scoreHome: null, scoreAway: null, reviewReason: 'overdue' });
  });
});

describe('accepting a feed result', () => {
  it('results the event with the feed score, marks it applied and audits it', async () => {
    const eventId = await queued('cup', [3, 1]);
    const outcome = await handle.db.transaction((tx) =>
      staffAcceptFeedResult(tx, { eventId, actor, now: new Date() }),
    );
    expect(outcome).toMatchObject({ outcome: 'resulted', status: 'finished' });
    expect(await eventRow(eventId)).toMatchObject({
      status: 'finished',
      scoreHome: 3,
      scoreAway: 1,
    });
    const [result] = await handle.db
      .select()
      .from(feedResults)
      .where(eq(feedResults.eventId, eventId));
    expect(result?.appliedAt).not.toBeNull();
    expect((await listFeedReviewQueue(handle.db)).map((i) => i.eventId)).not.toContain(eventId);
    const resulted = await audits('catalog.event.resulted', eventId);
    expect(resulted).toHaveLength(1);
    expect(resulted[0]?.actorId).toBe(actor.adminId);
    expect((await audits('feed.result.reviewed', eventId))[0]?.metadata).toMatchObject({
      decision: 'accepted',
      reviewReason: 'cup',
    });
  });

  it('refuses a row without a score (400) and changes nothing', async () => {
    const eventId = await queued('unreadable', null);
    await expect(
      handle.db.transaction((tx) => staffAcceptFeedResult(tx, { eventId, actor, now: new Date() })),
    ).rejects.toMatchObject({ status: 400, code: 'feed_result_has_no_score' });
    expect((await eventRow(eventId)).status).toBe('scheduled');
    expect((await listFeedReviewQueue(handle.db)).map((i) => i.eventId)).toContain(eventId);
  });

  it('is 404 for an event that is not waiting, including one already handled', async () => {
    const eventId = await queued('tennis', [1, 0]);
    await handle.db.transaction((tx) =>
      staffAcceptFeedResult(tx, { eventId, actor, now: new Date() }),
    );
    await expect(
      handle.db.transaction((tx) => staffAcceptFeedResult(tx, { eventId, actor, now: new Date() })),
    ).rejects.toMatchObject({ status: 404 });
    const { eventId: other } = await createEvent(handle.db, ids);
    await expect(
      handle.db.transaction((tx) =>
        staffVoidFeedResult(tx, { eventId: other, actor, now: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rolls the result back when it is refused (an event that has not started)', async () => {
    const { eventId } = await createEvent(handle.db, ids);
    await handle.db.insert(feedResults).values({
      eventId,
      provider: FEED_PROVIDER,
      scoreHome: 1,
      scoreAway: 0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      reviewReason: 'cup',
    });
    await expect(
      handle.db.transaction((tx) => staffAcceptFeedResult(tx, { eventId, actor, now: new Date() })),
    ).rejects.toMatchObject({ status: 409, code: 'event_not_started' });
    const [result] = await handle.db
      .select()
      .from(feedResults)
      .where(eq(feedResults.eventId, eventId));
    expect(result?.appliedAt).toBeNull();
  });
});

describe('voiding a feed result', () => {
  it('cancels the event, closes the row and audits it with the reason', async () => {
    const eventId = await queued('overdue', null);
    const outcome = await handle.db.transaction((tx) =>
      staffVoidFeedResult(tx, { eventId, reason: 'Match abandoned', actor, now: new Date() }),
    );
    expect(outcome).toMatchObject({ outcome: 'resulted', status: 'cancelled' });
    expect((await eventRow(eventId)).status).toBe('cancelled');
    const [result] = await handle.db
      .select()
      .from(feedResults)
      .where(eq(feedResults.eventId, eventId));
    expect(result?.appliedAt).not.toBeNull();
    expect((await audits('catalog.event.resulted', eventId))[0]?.metadata).toMatchObject({
      result: { status: 'cancelled' },
      reason: 'Match abandoned',
    });
    expect((await audits('feed.result.reviewed', eventId))[0]?.metadata).toMatchObject({
      decision: 'voided',
      reason: 'Match abandoned',
    });
  });
});

describe('staffUpdateFeedLeague', () => {
  const key = 'soccer_test_league';

  beforeAll(async () => {
    await upsertFeedLeague(handle.db, {
      provider: FEED_PROVIDER,
      sportKey: key,
      sport: 'football',
      group: 'Soccer',
      title: 'Test League',
      description: '',
      active: true,
      cup: false,
      tier: 1,
      enabled: false,
    });
  });

  const league = async () =>
    (await listFeedLeagues(handle.db, FEED_PROVIDER)).find((row) => row.sportKey === key)!;

  it('switches a league on and sets, then clears, its margin, with an audit entry each time', async () => {
    const on = await handle.db.transaction((tx) =>
      staffUpdateFeedLeague(tx, { sportKey: key, enabled: true, marginBps: 650, actor }),
    );
    expect(on).toMatchObject({ enabled: true, marginBps: 650 });
    const cleared = await handle.db.transaction((tx) =>
      staffUpdateFeedLeague(tx, { sportKey: key, marginBps: null, actor }),
    );
    expect(cleared).toMatchObject({ enabled: true, marginBps: null });
    expect(await league()).toMatchObject({ enabled: true, marginBps: null });
    const trail = await audits('feed.league.updated', `${FEED_PROVIDER}/${key}`);
    expect(trail).toHaveLength(2);
    expect(trail.map((row) => row.metadata)).toContainEqual({
      before: { enabled: false, marginBps: null },
      after: { enabled: true, marginBps: 650 },
    });
  });

  it('returns null for an unknown league and refuses a margin out of range (422)', async () => {
    expect(
      await handle.db.transaction((tx) =>
        staffUpdateFeedLeague(tx, { sportKey: 'nope', enabled: true, actor }),
      ),
    ).toBeNull();
    await expect(
      handle.db.transaction((tx) =>
        staffUpdateFeedLeague(tx, { sportKey: key, marginBps: 3001, actor }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_feed_setting' });
    expect((await league()).marginBps).toBeNull();
  });
});
