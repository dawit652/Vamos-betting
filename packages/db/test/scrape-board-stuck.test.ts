import { birr } from '@vamos/core';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelStuckBoardEvent,
  stuckBoardEventsWithoutBets,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { events, markets } from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  place,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';

/**
 * Owner's decision of 23 Nov 2026 (O-F1, docs/plans/feed-gaps-2026-11-23.md): a board match still
 * without a result 3 days after kickoff is cancelled when nobody bet on it; one with a bet stays
 * with a person, and our own catalogue's matches are never touched.
 */

const DAY = 86_400_000;
const WINDOW = 3 * DAY;

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** Moves an event into the past and onto a feed (a board's, or our own). */
async function make(event: TestEvent, feedProvider: string, kickoff: Date): Promise<void> {
  await handle.db
    .update(events)
    .set({ feedProvider, startTime: kickoff })
    .where(eq(events.id, event.eventId));
}

describe('stuck board matches (O-F1)', () => {
  it('cancels a board match nobody bet on 3 days after kickoff, and nothing else', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - WINDOW - DAY);
    const recent = new Date(now.getTime() - 2 * DAY);

    // A bet on one board match, placed before its kickoff.
    const withBet = await createEvent(handle.db, ids);
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(100));
    const bet = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: withBet.home, oddsMilli: 2000 }],
      settings,
    });
    expect(bet.replayed).toBe(false);
    await make(withBet, 'hulusport', old);

    const noBet = await createEvent(handle.db, ids);
    await make(noBet, 'hulusport', old);
    const narobet = await createEvent(handle.db, ids);
    await make(narobet, 'narobet', old);
    const tooRecent = await createEvent(handle.db, ids);
    await make(tooRecent, 'hulusport', recent);
    const ours = await createEvent(handle.db, ids);
    await make(ours, 'scraped', old);

    const stuck = await stuckBoardEventsWithoutBets(handle.db, {
      now,
      olderThanMs: WINDOW,
      limit: 100,
    });
    expect(stuck.map((e) => e.eventId).sort()).toEqual([noBet.eventId, narobet.eventId].sort());

    const cancel = (eventId: string) =>
      handle.db.transaction((tx) =>
        cancelStuckBoardEvent(tx, eventId, { now, olderThanMs: WINDOW }),
      );
    const outcome = await cancel(noBet.eventId);
    expect(outcome).toMatchObject({ outcome: 'resulted', status: 'cancelled' });
    expect(outcome!.marketsVoided).toBeGreaterThan(0);
    // Checked again under the lock: the match with a bet, the recent one and ours are left alone.
    expect(await cancel(withBet.eventId)).toBeNull();
    expect(await cancel(tooRecent.eventId)).toBeNull();
    expect(await cancel(ours.eventId)).toBeNull();
    // Once cancelled it no longer qualifies.
    expect(await cancel(noBet.eventId)).toBeNull();

    const rows = await handle.db
      .select({ id: events.id, status: events.status, resultedAt: events.resultedAt })
      .from(events)
      .where(inArray(events.id, [noBet.eventId, withBet.eventId, ours.eventId]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(noBet.eventId)?.status).toBe('cancelled');
    expect(byId.get(noBet.eventId)?.resultedAt).not.toBeNull();
    expect(byId.get(withBet.eventId)).toMatchObject({ status: 'scheduled', resultedAt: null });
    expect(byId.get(ours.eventId)).toMatchObject({ status: 'scheduled', resultedAt: null });
    const voided = await handle.db
      .select({ status: markets.status })
      .from(markets)
      .where(eq(markets.eventId, noBet.eventId));
    expect(voided.every((m) => m.status === 'void')).toBe(true);
  });
});
