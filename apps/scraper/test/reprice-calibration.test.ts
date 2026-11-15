import { parseReviewPayload } from '@vamos/contracts';
import {
  lockEvent,
  recordEventPriced,
  setCompetitionPolicy,
  setTeamRatings,
  upsertFixture,
} from '@vamos/db';
import { events } from '@vamos/db/schema';
import { priceFixture } from '@vamos/feed';
import { eq } from 'drizzle-orm';
import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { MIN_RATING_MATCHES, ratingsKey } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * Uncalibrated to calibrated: an event created for teams without ratings has a
 * `ratings_uncalibrated` item and betting closed. When the teams become
 * calibrated and the prices follow, the re-price step closes that item and asks a
 * trader (an `odds_approval` item) to open betting. It never opens betting itself.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

/** The catalogue seeds these ratings (no `matches`: not calibrated); the book was priced from them. */
const SEED = {
  Arsenal: { attack: 1.5, defence: 0.68 },
  Chelsea: { attack: 1.35, defence: 0.85 },
};
/** The same strengths with enough matches: calibrated, and the same prices. */
const SAME = {
  Arsenal: { ...SEED.Arsenal, matches: 10 },
  Chelsea: { ...SEED.Chelsea, matches: 10 },
};
/** A small change: every price moves, none beyond the ratio. */
const NEAR = {
  Arsenal: { attack: 1.55, defence: 0.68, matches: 10 },
  Chelsea: { attack: 1.35, defence: 0.85, matches: 10 },
};
/** A large change for Arsenal: prices move far beyond the ratio. */
const FAR = { attack: 3, defence: 0.68, matches: 10 };

const setRatings = (name: string, ratings: Record<string, number>) =>
  h.ctx.db.transaction((tx) => setTeamRatings(tx, h.team(name), ratings, { system: 'test' }));

async function uncalibratedEvent(): Promise<{ eventId: string; feedRef: string }> {
  h = await createHarness({ calibrated: false });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string; feed_ref: string; betting_open: boolean }>(
    `SELECT id, feed_ref, betting_open FROM events WHERE feed_provider = 'scraped'`,
  );
  expect(event!.betting_open).toBe(false);
  expect(await items('ratings_uncalibrated', 'open')).toHaveLength(1);
  return { eventId: event!.id, feedRef: event!.feed_ref };
}

const items = (kind: string, status: string) =>
  rows<{
    id: string;
    subject_key: string;
    payload: Record<string, unknown>;
    resolution: string | null;
    resolved_by: string | null;
    title: string;
  }>(
    `SELECT id, subject_key, payload, resolution, resolved_by, title FROM scrape_review_items
      WHERE kind = $1 AND status = $2 ORDER BY created_at`,
    [kind, status],
  );
const openApprovals = async () =>
  (await items('odds_approval', 'open')).filter((i) => !i.subject_key.endsWith('|reprice'));
const openReprices = async () =>
  (await items('odds_approval', 'open')).filter((i) => i.subject_key.endsWith('|reprice'));
const bettingOpen = async () =>
  (await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events`))[0]!.betting_open;

describe('uncalibrated to calibrated: the re-price step hands the event to a trader', () => {
  it(
    'R-2: the ratings item names each team O1 waits for, with its rated matches',
    async () => {
      await uncalibratedEvent();
      const needed = Math.max(h.ctx.config.scraper.minRatingMatches, MIN_RATING_MATCHES);
      const [item] = await items('ratings_uncalibrated', 'open');
      const teams = item!.payload.uncalibratedTeams as { name: string; matches: number }[];
      expect(teams).toEqual([
        { teamId: h.team('Arsenal'), name: 'Arsenal', matches: 0, needed },
        { teamId: h.team('Chelsea'), name: 'Chelsea', matches: 0, needed },
      ]);
      expect(item!.payload.reason).toBe(
        `ratings_uncalibrated: Arsenal 0 of ${needed} rated matches; Chelsea 0 of ${needed} rated matches`,
      );
      // The payload still reads as the contract's odds payload.
      expect(parseReviewPayload('ratings_uncalibrated', item!.payload)).not.toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'O1/O3: prices follow the new ratings within the ratio: the uncalibrated item closes, odds_approval opens, betting stays closed',
    async () => {
      const { eventId, feedRef } = await uncalibratedEvent();
      // Still uncalibrated: nothing changes.
      await repriceScheduledEvents(h.ctx);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(1);
      expect(await openApprovals()).toHaveLength(0);

      // A backfill or a trader gives both teams ratings.
      await setRatings('Arsenal', NEAR.Arsenal);
      await setRatings('Chelsea', NEAR.Chelsea);
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ repriced: 1, held: 0, failed: 0 });

      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      const [closed] = await items('ratings_uncalibrated', 'resolved');
      expect(closed!.subject_key).toBe(feedRef);
      expect(closed!.resolved_by).toBe('system:scraper');
      expect(JSON.parse(closed!.resolution!)).toEqual({ decision: 'calibrated' });

      const [approval] = await openApprovals();
      expect(approval!.subject_key).toBe(feedRef);
      // The contract shape: the feed screen reads it, and `open_betting` needs the event id.
      const payload = parseReviewPayload('odds_approval', approval!.payload);
      expect(payload).not.toBeNull();
      expect(payload!.eventId).toBe(eventId);
      expect(payload!.home).toBe('Arsenal');
      expect(payload!.markets.length).toBeGreaterThan(0);
      expect(approval!.payload.proposal).toBeUndefined();
      // The prices shown are the ones now stored.
      const stored = await rows<{ code: string; odds_milli: number }>(
        `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = '1x2'`,
        [eventId],
      );
      const shown = payload!.markets.find((m) => m.market === '1x2')!;
      expect(Object.fromEntries(shown.selections.map((s) => [s.name, s.oddsMilli]))).toEqual(
        Object.fromEntries(stored.map((r) => [r.code, r.odds_milli])),
      );

      // Nothing opens betting here, and repeated passes change nothing.
      expect(await bettingOpen()).toBe(false);
      await repriceScheduledEvents(h.ctx);
      await runPromotion(h.ctx);
      expect(await bettingOpen()).toBe(false);
      expect(await openApprovals()).toHaveLength(1);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      expect(await items('ratings_uncalibrated', 'resolved')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'O3: a re-price beyond the ratio is held; the uncalibrated item stays open until the held proposal is applied',
    async () => {
      const { eventId, feedRef } = await uncalibratedEvent();
      await setRatings('Arsenal', FAR);
      await setRatings('Chelsea', SAME.Chelsea);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ held: 1, repriced: 0 });
      const [held] = await openReprices();
      expect(held!.subject_key).toBe(`${feedRef}|reprice`);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(1);
      expect(await openApprovals()).toHaveLength(0);
      // Not raised again for the same ratings; the uncalibrated item is still waiting.
      await repriceScheduledEvents(h.ctx);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(1);

      // A trader applies the held proposal (what `apply_reprice` does in the API).
      const key = ratingsKey(FAR, SAME.Chelsea);
      await h.ctx.db.transaction(async (tx) => {
        await lockEvent(tx, eventId);
        const [event] = await tx
          .select({
            competitionId: events.competitionId,
            homeTeamId: events.homeTeamId,
            awayTeamId: events.awayTeamId,
            startTime: events.startTime,
          })
          .from(events)
          .where(eq(events.id, eventId));
        await upsertFixture(
          tx,
          {
            feedProvider: SCRAPED_FEED_PROVIDER,
            feedRef,
            sport: 'football',
            ...event!,
          },
          priceFixture('football', FAR, SAME.Chelsea),
          { now: h.now() },
        );
        await recordEventPriced(tx, eventId, key, h.now());
      });
      await repriceScheduledEvents(h.ctx);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      expect(JSON.parse((await items('ratings_uncalibrated', 'resolved'))[0]!.resolution!)).toEqual(
        { decision: 'calibrated' },
      );
      expect(await openApprovals()).toHaveLength(1);
      expect(await bettingOpen()).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'O3: ratings whose prices equal the stored ones need no re-price, and still hand the event over',
    async () => {
      await uncalibratedEvent();
      // Same strengths, now backed by matches: the model's book is the stored one.
      expect(JSON.stringify(priceFixture('football', SAME.Arsenal, SAME.Chelsea))).toBe(
        JSON.stringify(priceFixture('football', SEED.Arsenal, SEED.Chelsea)),
      );
      await setRatings('Arsenal', SAME.Arsenal);
      await setRatings('Chelsea', SAME.Chelsea);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, held: 0 });
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      expect(await openApprovals()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'S4: a switched-off competition keeps the uncalibrated item; switching it on hands the event over',
    async () => {
      await uncalibratedEvent();
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
      );
      await setRatings('Arsenal', NEAR.Arsenal);
      await setRatings('Chelsea', NEAR.Chelsea);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ held: 1, repriced: 0 });
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(1);
      expect(await openApprovals()).toHaveLength(0);

      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: true }, { system: 'test' }),
      );
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1 });
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      expect(await openApprovals()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a trader who already opened betting is not asked again',
    async () => {
      const { eventId } = await uncalibratedEvent();
      await h.pool.query(`UPDATE events SET betting_open = true WHERE id = $1`, [eventId]);
      await setRatings('Arsenal', NEAR.Arsenal);
      await setRatings('Chelsea', NEAR.Chelsea);
      await repriceScheduledEvents(h.ctx);
      expect(await items('ratings_uncalibrated', 'open')).toHaveLength(0);
      expect(await openApprovals()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});
