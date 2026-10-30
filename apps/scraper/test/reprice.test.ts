import { randomUUID } from 'node:crypto';
import { setCompetitionPolicy, setTeamRatings } from '@vamos/db';
import { bets, betLegs, users } from '@vamos/db/schema';
import { priceFixture } from '@vamos/feed';
import { ratingsKey } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedJson,
  HOUR,
  jsonDoc,
  KICKOFF,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/** Rule O3: re-pricing scheduled events after ratings change (docs/scraper-plan/06). */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

const BASE = { attack: 1.2, defence: 0.9, matches: 10 };
/** A small change: every 1x2 price moves, none by more than MAX_PRICE_MOVE_RATIO. */
const SMALL = { attack: 1.26, defence: 0.9, matches: 11 };
/**
 * A change between the two: the 1X2 and the 2.5 line move by less than MAX_PRICE_MOVE_RATIO
 * (1.18 at most), but correct score, which only follows them, moves by 1.46 (F-09).
 */
const MEDIUM = { attack: 1.4, defence: 0.9, matches: 11 };
/** A large change: the home price moves far beyond the ratio. */
const LARGE = { attack: 2.4, defence: 0.9, matches: 11 };

const setRatings = (name: string, ratings: Record<string, number>) =>
  h.ctx.db.transaction((tx) => setTeamRatings(tx, h.team(name), ratings, { system: 'test' }));

async function createdEvent(): Promise<{ eventId: string; feedRef: string }> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped'`,
  );
  return { eventId: event!.id, feedRef: event!.feed_ref };
}

/** code -> odds of the 1x2 market of the event. */
async function oneXTwo(eventId: string): Promise<Record<string, number>> {
  const found = await rows<{ code: string; odds_milli: number }>(
    `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1 AND m.key = '1x2'`,
    [eventId],
  );
  return Object.fromEntries(found.map((r) => [r.code, r.odds_milli]));
}

/** What the model prices for Arsenal v Chelsea now, as code -> odds of the 1x2 market. */
async function modelOneXTwo(): Promise<Record<string, number>> {
  const ratings = (name: string) =>
    h.pool
      .query<{ ratings: Record<string, number> }>(`SELECT ratings FROM teams WHERE id = $1`, [
        h.team(name),
      ])
      .then((r) => r.rows[0]!.ratings);
  const market = priceFixture('football', await ratings('Arsenal'), await ratings('Chelsea')).find(
    (m) => m.type === '1x2',
  )!;
  return Object.fromEntries(market.selections.map((s) => [s.code, s.oddsMilli]));
}

const audits = (action: string) =>
  h.count(`SELECT count(*) AS n FROM audit_log WHERE action = $1`, [action]);
const openReprice = () =>
  rows<{ id: string; subject_key: string; payload: Record<string, unknown>; updated_at: Date }>(
    `SELECT id, subject_key, payload, updated_at FROM scrape_review_items
      WHERE kind = 'odds_approval' AND status = 'open' AND subject_key LIKE '%|reprice'`,
  );
const stamp = async (eventId: string) =>
  (
    await rows<{ ratings_key: string | null; held_key: string | null }>(
      `SELECT ratings_key, held_key FROM scrape_event_pricing WHERE event_id = $1`,
      [eventId],
    )
  )[0];

describe('O3: re-pricing after ratings change', () => {
  it(
    'a creation stamps the ratings; nothing is re-priced while they are the same',
    async () => {
      const { eventId } = await createdEvent();
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(BASE, BASE));
      const before = await oneXTwo(eventId);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
      expect(await oneXTwo(eventId)).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'a move within the ratio is applied once, audited, and repeated runs change nothing',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      const before = await oneXTwo(eventId);
      await setRatings('Arsenal', SMALL);

      const first = await repriceScheduledEvents(h.ctx);
      expect(first).toMatchObject({ events: 1, repriced: 1, held: 0, failed: 0 });
      expect(first.published).toBeGreaterThan(0);
      const after = await oneXTwo(eventId);
      expect(after).toEqual(await modelOneXTwo());
      expect(after).not.toEqual(before);
      for (const code of Object.keys(before)) {
        const ratio = after[code]! / before[code]!;
        expect(ratio).toBeGreaterThanOrEqual(0.8);
        expect(ratio).toBeLessThanOrEqual(1.25);
      }
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(SMALL, BASE));
      expect(await audits('scrape.fixture.repriced')).toBe(1);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.repriced'`,
      );
      expect(audit!.metadata).toMatchObject({ feedRef, via: 'auto' });
      expect(await openReprice()).toHaveLength(0);
      // The history keeps both prices.
      expect(
        await h.count(
          `SELECT count(*) AS n FROM odds_history oh JOIN selections s ON s.id = oh.selection_id
            JOIN markets m ON m.id = s.market_id WHERE m.event_id = $1 AND oh.source = 'feed'`,
          [eventId],
        ),
      ).toBeGreaterThan(Object.keys(before).length);

      const history = await h.count(`SELECT count(*) AS n FROM odds_history`);
      for (let i = 0; i < 3; i++) {
        expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
        expect((await runPromotion(h.ctx)) && (await repriceScheduledEvents(h.ctx)).events).toBe(0);
      }
      expect(await oneXTwo(eventId)).toEqual(after);
      expect(await h.count(`SELECT count(*) AS n FROM odds_history`)).toBe(history);
      expect(await audits('scrape.fixture.repriced')).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a learned home advantage reprices through the same O3 gate (F-07)',
    async () => {
      const { eventId } = await createdEvent();
      const before = await oneXTwo(eventId);
      const learned = { ...BASE, homeAdvantage: 1.25 };
      await setRatings('Arsenal', learned);

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 1,
        held: 0,
      });
      const after = await oneXTwo(eventId);
      expect(after).toEqual(await modelOneXTwo());
      // Arsenal (home) shorter, Chelsea (away) longer, within the ratio.
      expect(after['1']!).toBeLessThan(before['1']!);
      expect(after['2']!).toBeGreaterThan(before['2']!);
      for (const code of Object.keys(before)) {
        const ratio = after[code]! / before[code]!;
        expect(ratio).toBeGreaterThanOrEqual(0.8);
        expect(ratio).toBeLessThanOrEqual(1.25);
      }
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(learned, BASE));
    },
    TEST_TIMEOUT,
  );

  it(
    'a move beyond the ratio in a market other than the 1X2 and the 2.5 line does not hold the event (F-09)',
    async () => {
      const { eventId } = await createdEvent();
      const allPrices = async (): Promise<Record<string, number>> =>
        Object.fromEntries(
          (
            await rows<{ key: string; code: string; odds_milli: number }>(
              `SELECT m.key, s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
                WHERE m.event_id = $1`,
              [eventId],
            )
          ).map((r) => [`${r.key}|${r.code}`, r.odds_milli]),
        );
      const before = await allPrices();
      await setRatings('Arsenal', MEDIUM);

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 1,
        held: 0,
        failed: 0,
      });
      expect(await openReprice()).toHaveLength(0);
      const after = await allPrices();
      const ratio = (key: string): number =>
        Math.max(after[key]! / before[key]!, before[key]! / after[key]!);
      // The main markets moved within the ratio, the other ones did not, and all were re-priced.
      for (const key of Object.keys(before)) {
        if (key.startsWith('1x2|') || key.startsWith('ou:2.5|')) {
          expect(ratio(key)).toBeLessThanOrEqual(1.25);
        }
      }
      expect(Math.max(...Object.keys(before).map(ratio))).toBeGreaterThan(1.25);
      expect(after).not.toEqual(before);
      expect(await oneXTwo(eventId)).toEqual(await modelOneXTwo());
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(MEDIUM, BASE));
    },
    TEST_TIMEOUT,
  );

  it(
    'a move beyond the ratio keeps the old prices, opens a reprice item once, and is not raised again',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      const before = await oneXTwo(eventId);
      await setRatings('Arsenal', LARGE);

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 0,
        held: 1,
      });
      expect(await oneXTwo(eventId)).toEqual(before);
      expect(await audits('scrape.fixture.repriced')).toBe(0);
      const [item] = await openReprice();
      expect(item!.subject_key).toBe(`${feedRef}|reprice`);
      expect(item!.payload).toMatchObject({
        eventId,
        feedRef,
        reasons: expect.arrayContaining(['price_move_too_large']),
        ratingsKey: ratingsKey(LARGE, BASE),
        home: expect.any(String),
        away: expect.any(String),
        gameId: expect.any(String),
        proposal: expect.any(Array),
      });
      // The proposal is the model's book for the new ratings.
      const proposal = item!.payload.proposal as Array<{
        type: string;
        selections: Array<{ code: string; oddsMilli: number }>;
      }>;
      const oneX2 = proposal.find((m) => m.type === '1x2')!;
      expect(Object.fromEntries(oneX2.selections.map((s) => [s.code, s.oddsMilli]))).toEqual(
        await modelOneXTwo(),
      );
      // The held key remembers it, the price stamp is the old one.
      expect(await stamp(eventId)).toMatchObject({
        ratings_key: ratingsKey(BASE, BASE),
        held_key: ratingsKey(LARGE, BASE),
      });

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, held: 0 });
      expect(await openReprice()).toHaveLength(1);
      expect((await openReprice())[0]!.updated_at).toEqual(item!.updated_at);

      // Other ratings: the open item is refreshed, still one.
      await setRatings('Arsenal', { ...LARGE, attack: 2.2, matches: 12 });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, held: 1 });
      const refreshed = await openReprice();
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]!.id).toBe(item!.id);
      expect(refreshed[0]!.payload.ratingsKey).toBe(
        ratingsKey({ ...LARGE, attack: 2.2, matches: 12 }, BASE),
      );

      // Ratings come back within the ratio: re-priced, and the item closes by itself.
      await setRatings('Arsenal', SMALL);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 1,
        held: 0,
      });
      expect(await openReprice()).toHaveLength(0);
      expect(await oneXTwo(eventId)).toEqual(await modelOneXTwo());
      expect(await stamp(eventId)).toMatchObject({ held_key: null });
    },
    TEST_TIMEOUT,
  );

  it(
    'existing bets keep their odds; the event is re-priced for new bets only',
    async () => {
      const { eventId } = await createdEvent();
      const before = await oneXTwo(eventId);
      const [selection] = await rows<{ id: string; market_id: string }>(
        `SELECT s.id, s.market_id FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = '1x2' AND s.code = '1'`,
        [eventId],
      );
      const [user] = await h.ctx.db
        .insert(users)
        .values({
          phone: '+251911000099',
          passwordHash: 'x',
          dateOfBirth: '1990-01-01',
          status: 'active',
          termsAcceptedAt: h.now(),
        })
        .returning({ id: users.id });
      const [bet] = await h.ctx.db
        .insert(bets)
        .values({
          userId: user!.id,
          shortId: 'ABC123',
          betType: 'single',
          stake: 10_000n,
          totalOddsMilli: BigInt(before['1']!),
          potentialGrossPayout: 0n,
          potentialBonus: 0n,
          potentialTax: 0n,
          potentialNetPayout: 0n,
          status: 'open',
          oddsChangePolicy: 'none',
          idempotencyKey: randomUUID(),
          terms: { betRules: {}, multiBonus: {}, tax: {} },
          placedAt: h.now(),
        })
        .returning({ id: bets.id });
      await h.ctx.db.insert(betLegs).values({
        betId: bet!.id,
        position: 0,
        eventId,
        marketId: selection!.market_id,
        selectionId: selection!.id,
        oddsMilli: before['1']!,
        requestedOddsMilli: before['1']!,
        isLive: false,
      });

      await setRatings('Arsenal', SMALL);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, failed: 0 });
      expect((await oneXTwo(eventId))['1']).not.toBe(before['1']);
      const [leg] = await rows<{ odds_milli: number }>(
        `SELECT odds_milli FROM bet_legs WHERE bet_id = $1`,
        [bet!.id],
      );
      expect(leg!.odds_milli).toBe(before['1']);
      const [stored] = await rows<{ total_odds_milli: string }>(
        `SELECT total_odds_milli FROM bets WHERE id = $1`,
        [bet!.id],
      );
      expect(BigInt(stored!.total_odds_milli)).toBe(BigInt(before['1']!));
    },
    TEST_TIMEOUT,
  );

  it(
    'a closed event is re-priced but stays closed; an open one stays open',
    async () => {
      const { eventId } = await createdEvent();
      // F7: new events start closed (autoOpen is off).
      expect((await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events`))[0]).toEqual(
        {
          betting_open: false,
        },
      );
      const before = await oneXTwo(eventId);
      await setRatings('Arsenal', SMALL);
      expect((await repriceScheduledEvents(h.ctx)).repriced).toBe(1);
      expect(await oneXTwo(eventId)).not.toEqual(before);
      expect((await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events`))[0]).toEqual(
        {
          betting_open: false,
        },
      );

      await h.pool.query(`UPDATE events SET betting_open = true`);
      await setRatings('Arsenal', { ...SMALL, attack: 1.3, matches: 12 });
      expect((await repriceScheduledEvents(h.ctx)).repriced).toBe(1);
      expect((await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events`))[0]).toEqual(
        {
          betting_open: true,
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'a closed market keeps its price and does not hold the rest',
    async () => {
      const { eventId } = await createdEvent();
      await h.pool.query(
        `UPDATE markets SET status = 'closed' WHERE event_id = $1 AND key = '1x2'`,
        [eventId],
      );
      const before = await oneXTwo(eventId);
      // Far beyond the ratio for the 1x2, but that market is closed.
      await setRatings('Arsenal', LARGE);
      const summary = await repriceScheduledEvents(h.ctx);
      expect(await oneXTwo(eventId)).toEqual(before);
      // The over/under and the rest move by large amounts too, so this is held or applied
      // by the same rule as for the open markets, never by the closed one.
      expect(summary.events).toBe(1);
      const open = await openReprice();
      for (const item of open) {
        const proposal = item.payload.proposal as Array<{ type: string }>;
        expect(proposal.some((m) => m.type === '1x2')).toBe(false);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'never re-prices an event that is live, resulted, starts within MIN_LEAD_MS or has uncalibrated teams',
    async () => {
      const { eventId } = await createdEvent();
      const before = await oneXTwo(eventId);
      await setRatings('Arsenal', SMALL);

      // Starts within 10 minutes.
      h.at(new Date(KICKOFF.getTime() - 9 * MINUTE));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
      h.at(new Date(KICKOFF.getTime() - 3 * HOUR));

      await h.pool.query(`UPDATE events SET status = 'live'`);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
      await h.pool.query(`UPDATE events SET status = 'scheduled', resulted_at = now()`);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
      await h.pool.query(`UPDATE events SET resulted_at = NULL`);
      expect(await oneXTwo(eventId)).toEqual(before);

      // Teams that are not calibrated (fewer matches than the minimum) are not priced from.
      await setRatings('Chelsea', { attack: 1.2, defence: 0.9, matches: 2 });
      const skipped = await repriceScheduledEvents(h.ctx);
      expect(skipped).toMatchObject({ repriced: 0, held: 0, skipped: 1 });
      expect(await oneXTwo(eventId)).toEqual(before);
      expect(await openReprice()).toHaveLength(0);
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(BASE, BASE));

      // Calibrated again (a trader vouches for the team): it is re-priced.
      await setRatings('Chelsea', { attack: 1.2, defence: 0.9, matches: 2, manual: 1 });
      expect((await repriceScheduledEvents(h.ctx)).repriced).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a switched-off competition changes no price by itself: a hold says so, and switching it on applies it',
    async () => {
      const { eventId } = await createdEvent();
      const before = await oneXTwo(eventId);
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
      );
      await setRatings('Arsenal', SMALL);

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 0,
        held: 1,
      });
      expect(await oneXTwo(eventId)).toEqual(before);
      const [item] = await openReprice();
      expect(item!.payload.reasons).toEqual(['policy_disabled']);
      // Held for these ratings: not raised again while the policy stays off.
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });

      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: true }, { system: 'test' }),
      );
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 1,
        held: 0,
      });
      expect(await oneXTwo(eventId)).toEqual(await modelOneXTwo());
      expect(await openReprice()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'an event from before the stamp existed is looked at once and then remembered',
    async () => {
      const { eventId } = await createdEvent();
      await h.pool.query(`DELETE FROM scrape_event_pricing`);
      const before = await oneXTwo(eventId);
      // Same ratings: the model's book is the stored one, so nothing changes but the stamp.
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, repriced: 1 });
      expect(await oneXTwo(eventId)).toEqual(before);
      expect((await stamp(eventId))?.ratings_key).toBe(ratingsKey(BASE, BASE));
      expect(await audits('scrape.fixture.repriced')).toBe(0);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'the promotion pass re-prices the other events of a team right after its result is applied',
    async () => {
      h = await createHarness();
      const second = {
        date: '2026-11-09',
        time: '15:00',
        team1: 'Chelsea FC',
        team2: 'Arsenal FC',
      };
      const secondJson = {
        id: 3,
        kick: '2026-11-09T15:00:00Z',
        h: 'Chelsea',
        a: 'Arsenal',
        st: 'NS' as const,
      };
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF, second]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON, secondJson]));
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteFixtures(h.ctx)).created).toBe(2);
      const [later] = await rows<{ id: string }>(`SELECT id FROM events WHERE start_time > $1`, [
        new Date(KICKOFF.getTime() + HOUR),
      ]);
      const before = await h.pool.query(
        `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 ORDER BY m.key, s.code`,
        [later!.id],
      );

      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, score: { ht: [1, 0], ft: [4, 0] } }, second]));
      h.serve(URL_B, jsonDoc([{ ...finishedJson([4, 0], [1, 0]) }, secondJson]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect(await runPromotion(h.ctx)).toBe(true);

      expect(await h.count(`SELECT count(*) AS n FROM events WHERE status = 'finished'`)).toBe(1);
      const ratings = await rows<{ id: string; ratings: Record<string, number> }>(
        `SELECT id, ratings FROM teams WHERE id = ANY($1)`,
        [[h.team('Arsenal'), h.team('Chelsea')]],
      );
      const of = (name: string) => ratings.find((r) => r.id === h.team(name))!.ratings;
      const key = ratingsKey(of('Chelsea'), of('Arsenal'));
      const state = (await stamp(later!.id))!;
      // Re-priced (stamp moved) or held for a person (the key is remembered): either way it was looked at.
      expect([state.ratings_key, state.held_key]).toContain(key);
      const after = await h.pool.query(
        `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 ORDER BY m.key, s.code`,
        [later!.id],
      );
      if (state.ratings_key === key) expect(after.rows).not.toEqual(before.rows);
      else expect(after.rows).toEqual(before.rows);
    },
    TEST_TIMEOUT,
  );
});
