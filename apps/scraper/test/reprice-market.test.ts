import { parseReviewPayload } from '@vamos/contracts';
import { marketConsensus, MARKET_PRICING_KEY_PREFIX, type MarketPriceRow } from '@vamos/core';
import {
  finishRun,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  startRun,
  upsertMarketOdds,
  upsertSource,
} from '@vamos/db';
import { MARKET_ODDS_MAX_AGE_MS, MIN_LEAD_MS } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
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

/**
 * Rule O4: a competition set to take its prices from the licensed bookmaker feed is re-priced from the
 * feed's consensus when at least two books list the event and the fit is good; otherwise from the
 * model, exactly as before. Every safety of re-pricing stays: bounds, O2, trader approval, betting
 * never opened, events too close to kickoff, resulted or switched-off competitions untouched.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;
const actor = { system: 'test' };

const setPolicy = (patch: Parameters<typeof setCompetitionPolicy>[2]) =>
  h.ctx.db.transaction((tx) => setCompetitionPolicy(tx, h.premier, patch, actor));
const setRatings = (name: string, ratings: Record<string, number>) =>
  h.ctx.db.transaction((tx) => setTeamRatings(tx, h.team(name), ratings, actor));

interface Created {
  eventId: string;
  feedRef: string;
}

/** The sample fixture (Arsenal v Chelsea) is created from the model; the competition may then be switched to the market. */
async function createdEvent(options: { calibrated?: boolean } = {}): Promise<Created> {
  h = await createHarness({ calibrated: options.calibrated ?? true });
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

/** The stored 1X2 of the event in milli: [home, draw, away]. */
async function storedOneXTwo(eventId: string): Promise<[number, number, number]> {
  const found = await rows<{ code: string; odds_milli: number }>(
    `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1 AND m.key = '1x2'`,
    [eventId],
  );
  const by = Object.fromEntries(found.map((r) => [r.code, r.odds_milli]));
  return [by['1']!, by['X']!, by['2']!];
}
const storedBook = async (eventId: string) =>
  JSON.stringify(
    await rows(
      `SELECT m.key, s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 ORDER BY m.key, s.code`,
      [eventId],
    ),
  );
const stamp = async (eventId: string) =>
  (
    await rows<{ ratings_key: string | null; held_key: string | null }>(
      `SELECT ratings_key, held_key FROM scrape_event_pricing WHERE event_id = $1`,
      [eventId],
    )
  )[0];
const bettingOpen = async () =>
  (await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events`))[0]!.betting_open;
const items = (kind: string, status = 'open') =>
  rows<{ subject_key: string; payload: Record<string, unknown> }>(
    `SELECT subject_key, payload FROM scrape_review_items WHERE kind = $1 AND status = $2 ORDER BY created_at`,
    [kind, status],
  );

/** A market source (its own upstream unless told) with an enabled flag and an ok run at `observedAt`. */
async function addFeed(sourceId: string, upstream = sourceId): Promise<void> {
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: sourceId,
        name: `feed ${sourceId}`,
        adapter: 'generic-json',
        upstream,
        config: { allowedHosts: ['example.test'] },
      },
      actor,
    );
    await setSourceEnabled(tx, sourceId, true, actor);
  });
}

type Prices = [number, number, number];
/**
 * One fetch of the feed: the source's run starts at `observedAt`, and each bookmaker lists the 1X2
 * (and the over/under 2.5 when given) of the event.
 */
async function listEvent(
  eventId: string,
  sourceId: string,
  books: Record<string, Prices>,
  options: { observedAt?: Date; ou25?: Record<string, [number, number]> } = {},
): Promise<void> {
  const observedAt = options.observedAt ?? h.now();
  const run = await startRun(h.ctx.db, { sourceId, startedAt: observedAt });
  await finishRun(h.ctx.db, run.id, { status: 'ok', finishedAt: observedAt });
  const ids = {
    competitionId: h.premier,
    homeTeamId: h.team('Arsenal'),
    awayTeamId: h.team('Chelsea'),
    eventId,
  };
  const common = {
    sourceKey: `match-${eventId}`,
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    priceUpdatedAt: observedAt,
    observedAt,
    ...ids,
  };
  const out = Object.entries(books).flatMap(([bookmaker, prices]) =>
    (['1', 'X', '2'] as const).map((selection, i) => ({
      ...common,
      market: '1x2' as const,
      line: null,
      selection,
      bookmaker,
      priceMilli: prices[i]!,
    })),
  );
  for (const [bookmaker, [over, under]] of Object.entries(options.ou25 ?? {})) {
    out.push(
      {
        ...common,
        market: 'ou' as never,
        line: '2.5' as never,
        selection: 'over' as never,
        bookmaker,
        priceMilli: over,
      },
      {
        ...common,
        market: 'ou' as never,
        line: '2.5' as never,
        selection: 'under' as never,
        bookmaker,
        priceMilli: under,
      },
    );
  }
  await h.ctx.db.transaction((tx) =>
    upsertMarketOdds(tx, { sourceId, runId: run.id, rawId: null, rows: out }),
  );
}

/** Two books around the stored (model) prices, the home side shortened by `homeFactor`. */
function booksNear(stored: Prices, homeFactor = 1): Record<string, Prices> {
  const scale = (factor: number): Prices => [
    Math.floor(stored[0] * factor * homeFactor),
    Math.floor(stored[1] * factor),
    Math.floor(stored[2] * factor),
  ];
  return { '19': scale(1), '23': scale(1.03) };
}

const rowsOf = (books: Record<string, Prices>): MarketPriceRow[] =>
  Object.entries(books).flatMap(([bookmaker, prices]) =>
    (['1', 'X', '2'] as const).map((selection, i) => ({
      bookmaker,
      market: '1x2' as const,
      line: null,
      selection,
      priceMilli: prices[i]!,
    })),
  );

const impliedFair = (odds: Prices): number[] => {
  const q = odds.map((o) => 1000 / o);
  const total = q.reduce((a, b) => a + b, 0);
  return q.map((p) => p / total);
};

describe('priceEvent', () => {
  it(
    'a new event (no id) is always priced by the model, whatever the policy says',
    async () => {
      const { eventId } = await createdEvent();
      await addFeed('feed-a');
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId)));
      const input = {
        eventId: null,
        homeRatings: { attack: 1.2, defence: 0.9, matches: 10 },
        awayRatings: { attack: 1.2, defence: 0.9, matches: 10 },
        minRatingMatches: 8,
        now: h.now(),
      };
      const fresh = await priceEvent(h.ctx.db, { ...input, competitionPricingSource: 'market' });
      expect(fresh).toMatchObject({ source: 'model', calibrated: true, pricesSane: true });
      expect(fresh.key.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(false);
      // Policy 'model' ignores the feed for an event that exists.
      const model = await priceEvent(h.ctx.db, {
        ...input,
        eventId,
        competitionPricingSource: 'model',
      });
      expect(model.source).toBe('model');
      expect(model.fallback).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'two books of two upstreams make a market price; two sources of one upstream are one voice',
    async () => {
      const { eventId } = await createdEvent();
      const books = booksNear(await storedOneXTwo(eventId));
      const input = {
        competitionPricingSource: 'market' as const,
        eventId,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: 8,
        now: h.now(),
      };
      // Same upstream, same bookmaker '19' from two sources, one more book from another upstream: 2 books.
      await addFeed('feed-a', 'rundown');
      await addFeed('feed-b', 'rundown');
      await listEvent(eventId, 'feed-a', { '19': books['19']! }, { observedAt: h.now() });
      await listEvent(eventId, 'feed-b', { '19': books['19']! }, { observedAt: h.now() });
      expect(await priceEvent(h.ctx.db, input)).toMatchObject({
        source: 'model',
        fallback: 'no_consensus',
      });
      await addFeed('feed-c', 'other-upstream');
      await listEvent(eventId, 'feed-c', { '19': books['23']! }, { observedAt: h.now() });
      const priced = await priceEvent(h.ctx.db, input);
      expect(priced).toMatchObject({
        source: 'market',
        calibrated: true,
        pricesSane: true,
        books: 2,
      });
      expect(priced.key.startsWith(`${MARKET_PRICING_KEY_PREFIX}|`)).toBe(true);
      expect(priced.residual!).toBeLessThanOrEqual(0.03);
    },
    TEST_TIMEOUT,
  );

  it(
    'a consensus the goals model cannot explain falls back to the model (poor_fit)',
    async () => {
      const { eventId } = await createdEvent();
      await addFeed('feed-a');
      // A 60% draw with three goals expected: no pair of Poisson means does both.
      const odds = (p: number) => Math.floor(1000 / p);
      const weird: Prices = [odds(0.2), odds(0.6), odds(0.2)];
      const total: [number, number] = [odds(0.75), odds(0.25)];
      await listEvent(
        eventId,
        'feed-a',
        { '19': weird, '23': weird },
        { ou25: { '19': total, '23': total } },
      );
      const priced = await priceEvent(h.ctx.db, {
        competitionPricingSource: 'market',
        eventId,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: 8,
        now: h.now(),
      });
      expect(priced.source).toBe('model');
      expect(priced.fallback).toBe('poor_fit');
    },
    TEST_TIMEOUT,
  );
});

describe('re-pricing from the market', () => {
  it(
    'market policy and a fresh two-book consensus: the event is re-priced from the market',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      const before = await storedOneXTwo(eventId);
      expect((await stamp(eventId))!.ratings_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(
        false,
      );
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const books = booksNear(before, 0.93);
      await listEvent(eventId, 'feed-a', books);

      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 1, repriced: 1, held: 0, failed: 0 });
      const after = await storedOneXTwo(eventId);
      expect(after).not.toEqual(before);
      // The implied 1X2 probabilities are the consensus of the two books.
      const consensus = marketConsensus(rowsOf(books)).find((c) => c.market === '1x2')!;
      const fair = impliedFair(after);
      expect(consensus.books).toBe(2);
      expect(fair[0]).toBeCloseTo(consensus.probabilities['1']!, 2);
      expect(fair[1]).toBeCloseTo(consensus.probabilities['X']!, 2);
      expect(fair[2]).toBeCloseTo(consensus.probabilities['2']!, 2);
      // The stamp holds the market key; the audit says where the prices came from.
      expect((await stamp(eventId))!.ratings_key).toMatch(/^mkt1\|1x2:\d+,\d+,\d+\/2\|/);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.repriced' AND target_id = $1`,
        [eventId],
      );
      expect(audit!.metadata).toMatchObject({
        via: 'auto',
        pricingSource: 'market',
        books: 2,
        feedRef,
      });
      expect(audit!.metadata.fitResidual as number).toBeLessThanOrEqual(0.03);
      expect(await bettingOpen()).toBe(false);

      // Idempotent while the market is as it was.
      const again = await repriceScheduledEvents(h.ctx);
      expect(again).toMatchObject({ events: 0, repriced: 0, held: 0 });
      expect(await storedOneXTwo(eventId)).toEqual(after);
    },
    TEST_TIMEOUT,
  );

  it(
    'a market that only wiggles (below half a point) does not re-price; a real move does',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const near = booksNear(await storedOneXTwo(eventId), 0.93);
      await listEvent(eventId, 'feed-a', near);
      await repriceScheduledEvents(h.ctx);
      const first = await storedOneXTwo(eventId);
      const key = (await stamp(eventId))!.ratings_key;

      h.advance(10 * MINUTE);
      const wiggle: Record<string, Prices> = Object.fromEntries(
        Object.entries(near).map(([k, p]) => [k, [p[0] + 3, p[1], p[2]] as Prices]),
      );
      await listEvent(eventId, 'feed-a', wiggle);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });
      expect((await stamp(eventId))!.ratings_key).toBe(key);

      h.advance(10 * MINUTE);
      await listEvent(eventId, 'feed-a', booksNear(first, 0.9));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, repriced: 1 });
      expect((await stamp(eventId))!.ratings_key).not.toBe(key);
    },
    TEST_TIMEOUT,
  );

  it(
    'one book only: the model prices stay and nothing is re-priced',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      const key = (await stamp(eventId))!.ratings_key;
      await listEvent(eventId, 'feed-a', {
        '19': booksNear(await storedOneXTwo(eventId), 0.9)['19']!,
      });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 0,
        repriced: 0,
        held: 0,
      });
      expect(await storedBook(eventId)).toBe(book);
      expect((await stamp(eventId))!.ratings_key).toBe(key);

      // The model still moves the event when its ratings change (today's behaviour, unchanged).
      await setRatings('Arsenal', { attack: 1.25, defence: 0.9, matches: 10 });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 1, repriced: 1 });
      expect((await stamp(eventId))!.ratings_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(
        false,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "policy 'model' ignores the feed: nothing changes",
    async () => {
      const { eventId } = await createdEvent();
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.8));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });
      await runPromotion(h.ctx);
      expect(await storedBook(eventId)).toBe(book);
      expect((await stamp(eventId))!.ratings_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(
        false,
      );
      expect(await items('odds_approval')).toHaveLength(1); // the F7 item of the creation, nothing more
    },
    TEST_TIMEOUT,
  );

  it(
    'a market-priced event whose market goes stale keeps its prices, even when the ratings change',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      await repriceScheduledEvents(h.ctx);
      const book = await storedBook(eventId);
      const key = (await stamp(eventId))!.ratings_key!;
      expect(key.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(true);

      // The feed stops: past MARKET_ODDS_MAX_AGE_MS no price is usable. The ratings change too:
      // the event does not jump back to the model.
      h.advance(MARKET_ODDS_MAX_AGE_MS + MINUTE);
      await setRatings('Arsenal', { attack: 2.5, defence: 0.6, matches: 10 });
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 0, repriced: 0, held: 0, failed: 0 });
      expect(await storedBook(eventId)).toBe(book);
      expect((await stamp(eventId))!.ratings_key).toBe(key);
      expect(await items('odds_approval')).toHaveLength(1);

      // Switching the competition back to the model hands it to the model (bounds apply).
      await setPolicy({ pricingSource: 'model' });
      const back = await repriceScheduledEvents(h.ctx);
      expect(back.repriced + back.held).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a big move, including the switch from model to market, is held for a trader',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      const stampBefore = (await stamp(eventId))!.ratings_key;
      // The market sees Chelsea as the favourite: far beyond the allowed move.
      const [home, draw, away] = await storedOneXTwo(eventId);
      const flipped: Prices = [away, draw, home];
      await listEvent(eventId, 'feed-a', {
        '19': flipped,
        '23': flipped.map((o) => Math.floor(o * 1.02)) as Prices,
      });

      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 1,
        repriced: 0,
        held: 1,
      });
      expect(await storedBook(eventId)).toBe(book);
      const held = await stamp(eventId);
      expect(held!.ratings_key).toBe(stampBefore);
      expect(held!.held_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(true);

      const [item] = await items('odds_approval');
      const reprices = (await items('odds_approval')).filter((i) =>
        i.subject_key.endsWith('|reprice'),
      );
      expect(reprices).toHaveLength(1);
      expect(reprices[0]!.subject_key).toBe(`${feedRef}|reprice`);
      expect(item).toBeDefined();
      const payload = parseReviewPayload('odds_approval', reprices[0]!.payload);
      expect(payload).not.toBeNull();
      expect(payload!.proposal).toBeDefined();
      expect(payload!.ratingsKey).toBe(held!.held_key);
      expect(payload!.pricing).toMatchObject({ source: 'market', books: 2 });
      expect(payload!.reason).toContain('price_move_too_large');

      // Not proposed again for the same market.
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });
      expect(
        (await items('odds_approval')).filter((i) => i.subject_key.endsWith('|reprice')),
      ).toHaveLength(1);
      expect(await bettingOpen()).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'a switched-off competition holds the market proposal too (S4)',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market', enabled: false });
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ held: 1, repriced: 0 });
      expect(await storedBook(eventId)).toBe(book);
      const [item] = (await items('odds_approval')).filter((i) =>
        i.subject_key.endsWith('|reprice'),
      );
      expect(item!.payload.reasons).toContain('policy_disabled');
      expect(item!.payload.pricing).toMatchObject({ source: 'market' });
    },
    TEST_TIMEOUT,
  );

  it(
    'never touches an event that starts within the minimum lead time',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      h.at(new Date(KICKOFF.getTime() - MIN_LEAD_MS + MINUTE));
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        events: 0,
        repriced: 0,
        held: 0,
      });
      expect(await storedBook(eventId)).toBe(book);
    },
    TEST_TIMEOUT,
  );

  it(
    'never touches a resulted event',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      const book = await storedBook(eventId);
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      await h.pool.query(
        `UPDATE events SET status = 'finished', resulted_at = now() WHERE id = $1`,
        [eventId],
      );
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0 });
      expect(await storedBook(eventId)).toBe(book);
    },
    TEST_TIMEOUT,
  );
});

describe('uncalibrated teams and the market', () => {
  it(
    'an event created for uncalibrated teams is priced from the market and handed to a trader, betting stays closed',
    async () => {
      const { eventId, feedRef } = await createdEvent({ calibrated: false });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);
      // Even with auto_open on: re-pricing never opens betting.
      await setPolicy({ pricingSource: 'market', autoOpen: true });
      await addFeed('feed-a');
      // Without a market, uncalibrated teams change nothing (O1).
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, calibrated: 0 });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);

      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.95));
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ events: 1, repriced: 1, calibrated: 1, failed: 0 });
      expect((await stamp(eventId))!.ratings_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(true);

      expect(await items('ratings_uncalibrated')).toHaveLength(0);
      const [closed] = await items('ratings_uncalibrated', 'resolved');
      expect(closed!.subject_key).toBe(feedRef);
      const approvals = (await items('odds_approval')).filter(
        (i) => !i.subject_key.endsWith('|reprice'),
      );
      expect(approvals).toHaveLength(1);
      const payload = parseReviewPayload('odds_approval', approvals[0]!.payload);
      expect(payload).not.toBeNull();
      expect(payload!.eventId).toBe(eventId);
      expect(payload!.reason).toBe('market_priced');
      expect(payload!.pricing).toMatchObject({ source: 'market', books: 2 });
      expect(payload!.markets.length).toBeGreaterThan(0);
      expect(await bettingOpen()).toBe(false);

      // Nothing further happens, and betting is still closed after a whole promotion pass.
      await runPromotion(h.ctx);
      expect(await bettingOpen()).toBe(false);
      expect(await items('odds_approval')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a stale market does not hand an event over; a fresh one does',
    async () => {
      const { eventId } = await createdEvent({ calibrated: false });
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.95), {
        observedAt: new Date(h.now().getTime() - MARKET_ODDS_MAX_AGE_MS - HOUR),
      });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, calibrated: 0 });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.95));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, calibrated: 1 });
    },
    TEST_TIMEOUT,
  );
});
