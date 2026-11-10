import { parseReviewPayload } from '@vamos/contracts';
import { marketConsensus, MARKET_PRICING_KEY_PREFIX, type MarketPriceRow } from '@vamos/core';
import {
  finishRun,
  loadKickoffEvidence,
  resolveReviewItem,
  resumeEvent,
  setCompetitionPolicy,
  setMarketStatus,
  setSourceEnabled,
  setTeamRatings,
  startRun,
  upsertMarketOdds,
  upsertSource,
} from '@vamos/db';
import {
  assessKickoff,
  KICKOFF_EVIDENCE_WINDOW_MS,
  MARKET_CLOSE_LEAD_MS,
  MARKET_ODDS_MAX_AGE_MS,
  MIN_LEAD_MS,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
} from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfirmedEvents } from '../src/pipeline/auto-open';
import { backedByMarket, priceEvent } from '../src/pipeline/event-pricing';
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
 * Rule O5: a competition set to take its prices from the licensed bookmaker feed is re-priced from the
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
/** The stored over/under of the event at `line` in milli: [over, under]. */
async function storedOverUnder(eventId: string, line = '2.5'): Promise<[number, number]> {
  const found = await rows<{ code: string; odds_milli: number }>(
    `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1 AND m.key = $2`,
    [eventId, `ou:${line}`],
  );
  const by = Object.fromEntries(found.map((r) => [r.code, r.odds_milli]));
  return [by['over']!, by['under']!];
}
/** The 2.5 line every book lists by default: the event's first stored (model) prices, fixed. */
const defaultOu25 = new Map<string, [number, number]>();
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
 * and an over/under line of the event. By default every book lists the 2.5 line at the event's
 * stored (model) prices, so the goals have a line to be fitted to (rule T2); `ou25` gives each
 * book's prices instead (`{}`: no line at all), at `ouLine` (default 2.5).
 */
async function listEvent(
  eventId: string,
  sourceId: string,
  books: Record<string, Prices>,
  options: {
    observedAt?: Date;
    ou25?: Record<string, [number, number]>;
    ouLine?: string;
  } = {},
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
  let ou25 = options.ou25;
  if (ou25 === undefined) {
    if (!defaultOu25.has(eventId)) defaultOu25.set(eventId, await storedOverUnder(eventId));
    const line = defaultOu25.get(eventId)!;
    ou25 = Object.fromEntries(Object.keys(books).map((bookmaker) => [bookmaker, line]));
  }
  const ouLine = options.ouLine ?? '2.5';
  for (const [bookmaker, [over, under]] of Object.entries(ou25)) {
    out.push(
      {
        ...common,
        market: 'ou' as never,
        line: ouLine as never,
        selection: 'over' as never,
        bookmaker,
        priceMilli: over,
      },
      {
        ...common,
        market: 'ou' as never,
        line: ouLine as never,
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

/** Three books around the stored prices, one of them sharp (Pinnacle): enough for O1m. */
function strongBooksNear(stored: Prices, homeFactor = 1): Record<string, Prices> {
  const [a, b] = Object.values(booksNear(stored, homeFactor));
  return { pinnacle: a!, betsson: b!, unibet_se: b! };
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
    'without an over/under line the market is not used (no_totals); a 3.5 line in place of 2.5 is enough',
    async () => {
      const { eventId } = await createdEvent();
      await addFeed('feed-a');
      const books = booksNear(await storedOneXTwo(eventId));
      const input = {
        competitionPricingSource: 'market' as const,
        eventId,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: 8,
        now: h.now(),
      };
      // Rule T2: fitted to the 1X2 alone the goals would come out too low.
      await listEvent(eventId, 'feed-a', books, { ou25: {} });
      expect(await priceEvent(h.ctx.db, input)).toMatchObject({
        source: 'model',
        fallback: 'no_totals',
      });
      // Rule T1: a 3.5 consensus (a book's main line is often 3.5) gives the goals their line.
      const ou35 = await storedOverUnder(eventId, '3.5');
      await listEvent(eventId, 'feed-a', books, {
        ou25: { '19': ou35, '23': ou35 },
        ouLine: '3.5',
      });
      const priced = await priceEvent(h.ctx.db, input);
      expect(priced).toMatchObject({
        source: 'market',
        books: 2,
        booksOu25: 0,
        totalsLine: '3.5',
      });
      expect(priced.fallback).toBeUndefined();
      expect(priced.key).toMatch(/^mkt1\|1x2:\d+,\d+,\d+\/2\|ou3\.5:\d+\/2$/);
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
    'a market-priced competition closes prematch betting MARKET_CLOSE_LEAD_MS before kickoff; the model does not',
    async () => {
      const { eventId } = await createdEvent();
      const leadOf = async () =>
        (
          await rows<{ close_lead_ms: number }>('SELECT close_lead_ms FROM events WHERE id = $1', [
            eventId,
          ])
        )[0]!.close_lead_ms;
      // The model's own prices are not late: no lead.
      await repriceScheduledEvents(h.ctx);
      expect(await leadOf()).toBe(0);

      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      await repriceScheduledEvents(h.ctx);
      expect(await leadOf()).toBe(MARKET_CLOSE_LEAD_MS);
      // Never lowered: switching back to the model keeps the lead.
      await setPolicy({ pricingSource: 'model' });
      await repriceScheduledEvents(h.ctx);
      expect(await leadOf()).toBe(MARKET_CLOSE_LEAD_MS);
    },
    TEST_TIMEOUT,
  );

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

describe('market_stale alarm (docs/theoddsapi-plan 4.8)', () => {
  const staleItems = async (eventId: string) =>
    (
      await rows<{ status: string; reason: string }>(
        `SELECT status, payload->>'reason' AS reason FROM scrape_review_items
          WHERE kind = 'source_broken' AND subject_key = $1 ORDER BY created_at`,
        [`market_stale|${eventId}`],
      )
    ).map((r) => [r.status, r.reason]);

  it(
    'opens once when a market-priced match within 24 h keeps stale prices, and resolves on fresh prices',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      // A day and a half before kickoff the market prices the match.
      h.at(new Date(KICKOFF.getTime() - 36 * HOUR));
      const books = booksNear(await storedOneXTwo(eventId), 0.93);
      await listEvent(eventId, 'feed-a', books);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1 });
      expect(await staleItems(eventId)).toEqual([]);

      // 20 h before kickoff those prices are 16 h old: the match keeps them, and the alarm opens.
      h.at(new Date(KICKOFF.getTime() - 20 * HOUR));
      await repriceScheduledEvents(h.ctx);
      await repriceScheduledEvents(h.ctx);
      expect(await staleItems(eventId)).toEqual([['open', 'market_stale']]);

      // Fresh prices: the alarm resolves.
      await listEvent(eventId, 'feed-a', books);
      await repriceScheduledEvents(h.ctx);
      expect(await staleItems(eventId)).toEqual([['resolved', 'market_stale']]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stays quiet for stale prices more than 24 h before kickoff',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      h.at(new Date(KICKOFF.getTime() - 72 * HOUR));
      await listEvent(eventId, 'feed-a', booksNear(await storedOneXTwo(eventId), 0.93));
      await repriceScheduledEvents(h.ctx);
      h.at(new Date(KICKOFF.getTime() - 48 * HOUR));
      await repriceScheduledEvents(h.ctx);
      expect(await staleItems(eventId)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'P-7: opens too when fresh books can no longer be fitted (no over/under line)',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      h.at(new Date(KICKOFF.getTime() - 20 * HOUR));
      const books = booksNear(await storedOneXTwo(eventId), 0.93);
      await listEvent(eventId, 'feed-a', books);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1 });
      // The books stop listing an over/under line: a fresh 1X2 with nothing to fit the goals to.
      h.advance(MINUTE);
      await listEvent(eventId, 'feed-a', books, { ou25: {} });
      await repriceScheduledEvents(h.ctx);
      expect(await staleItems(eventId)).toEqual([['open', 'market_stale']]);
    },
    TEST_TIMEOUT,
  );
});

describe('A2: markets suspended while the prices cannot be trusted', () => {
  const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };
  /** The event's markets as `status/suspended_by` (distinct). */
  const statuses = async (eventId: string) =>
    new Set(
      (
        await rows<{ status: string; suspended_by: string | null }>(
          `SELECT status, suspended_by FROM markets WHERE event_id = $1`,
          [eventId],
        )
      ).map((r) => `${r.status}/${r.suspended_by ?? '-'}`),
    );
  const marketStatus = async (eventId: string, key: string) =>
    (
      await rows<{ status: string; suspended_by: string | null }>(
        `SELECT status, suspended_by FROM markets WHERE event_id = $1 AND key = $2`,
        [eventId, key],
      )
    ).map((r) => `${r.status}/${r.suspended_by ?? '-'}`)[0];
  const suspendedFor = async (eventId: string) =>
    (
      await rows<{ suspended_for: string | null }>(
        `SELECT suspended_for FROM scrape_event_pricing WHERE event_id = $1`,
        [eventId],
      )
    )[0]?.suspended_for ?? null;
  const audits = (action: string) =>
    rows<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );

  /** The market flips the favourite: the re-price is held for a trader (O3). */
  async function heldEvent(): Promise<Created> {
    const created = await createdEvent();
    await setPolicy({ pricingSource: 'market' });
    await addFeed('feed-a');
    const [home, draw, away] = await storedOneXTwo(created.eventId);
    const flipped: Prices = [away, draw, home];
    await listEvent(created.eventId, 'feed-a', {
      '19': flipped,
      '23': flipped.map((o) => Math.floor(o * 1.02)) as Prices,
    });
    return created;
  }
  /** A person dismisses the held proposal: the old prices stand. */
  async function dismissHold(feedRef: string): Promise<void> {
    const [item] = await rows<{ id: string }>(
      `SELECT id FROM scrape_review_items WHERE subject_key = $1 AND status = 'open'`,
      [`${feedRef}|reprice`],
    );
    await h.ctx.db.transaction((tx) =>
      resolveReviewItem(tx, item!.id, { status: 'dismissed', resolution: 'test', actor: STAFF }),
    );
  }

  it(
    'a held re-price suspends every market; the prices stay; once dismissed the markets re-open',
    async () => {
      const { eventId, feedRef } = await heldEvent();
      const book = await storedBook(eventId);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({
        held: 1,
        suspended: 1,
        resumed: 0,
        failed: 0,
      });
      expect(await statuses(eventId)).toEqual(new Set(['suspended/feed']));
      expect(await suspendedFor(eventId)).toBe('reprice_held');
      expect(await storedBook(eventId)).toBe(book);
      const [suspended] = await audits('scrape.fixture.suspended');
      expect(suspended!.metadata).toMatchObject({ feedRef, rule: 'A2', reason: 'reprice_held' });
      expect(suspended!.metadata.markets).toBeGreaterThan(0);
      // Nothing more while the cause stays.
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 0, resumed: 0 });

      await dismissHold(feedRef);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ resumed: 1, failed: 0 });
      expect(await statuses(eventId)).toEqual(new Set(['open/-']));
      expect(await suspendedFor(eventId)).toBeNull();
      expect((await audits('scrape.fixture.resumed'))[0]!.metadata).toMatchObject({
        reason: 'reprice_held',
      });
      expect(await storedBook(eventId)).toBe(book);
      expect(await bettingOpen()).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "never lifts a trader's suspension",
    async () => {
      const { eventId, feedRef } = await heldEvent();
      const [market] = await rows<{ id: string }>(
        `SELECT id FROM markets WHERE event_id = $1 AND key = '1x2'`,
        [eventId],
      );
      await h.ctx.db.transaction((tx) => setMarketStatus(tx, market!.id, 'suspended', STAFF));
      await repriceScheduledEvents(h.ctx);
      expect(await marketStatus(eventId, '1x2')).toBe('suspended/trader');
      await dismissHold(feedRef);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ resumed: 1 });
      expect(await marketStatus(eventId, '1x2')).toBe('suspended/trader');
      expect(await marketStatus(eventId, 'btts')).toBe('open/-');
    },
    TEST_TIMEOUT,
  );

  it(
    'a trader who re-opens the markets during a hold is not overruled',
    async () => {
      const { eventId } = await heldEvent();
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 1 });
      await h.ctx.db.transaction((tx) => resumeEvent(tx, eventId, STAFF));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 0, resumed: 0 });
      expect(await statuses(eventId)).toEqual(new Set(['open/-']));
      expect(await suspendedFor(eventId)).toBe('reprice_held');
    },
    TEST_TIMEOUT,
  );

  it(
    'within 3 h of kickoff a market-priced match with no fresh prices for 30 minutes is suspended; fresh prices re-open it',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      h.at(new Date(KICKOFF.getTime() - 4 * HOUR));
      const books = booksNear(await storedOneXTwo(eventId), 0.93);
      await listEvent(eventId, 'feed-a', books);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, suspended: 0 });

      // 50 minutes old but more than 3 h before kickoff: still bettable.
      h.at(new Date(KICKOFF.getTime() - 190 * MINUTE));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 0 });
      // 70 minutes old within 3 h of kickoff: usable for pricing, not fresh enough to bet on.
      h.at(new Date(KICKOFF.getTime() - 170 * MINUTE));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 1, repriced: 0 });
      expect(await suspendedFor(eventId)).toBe('market_lapsed');
      expect(await statuses(eventId)).toEqual(new Set(['suspended/feed']));

      await listEvent(eventId, 'feed-a', books);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ resumed: 1, failed: 0 });
      expect(await statuses(eventId)).toEqual(new Set(['open/-']));
      expect(await suspendedFor(eventId)).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'a model-priced match is never suspended for a lapsed market',
    async () => {
      const { eventId } = await createdEvent();
      await setPolicy({ pricingSource: 'market' });
      // No feed at all: the prices are the model's, so there is no market to lapse.
      h.at(new Date(KICKOFF.getTime() - HOUR));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ suspended: 0 });
      expect(await statuses(eventId)).toEqual(new Set(['open/-']));
    },
    TEST_TIMEOUT,
  );

  it(
    'a switched-off competition holds the proposal but suspends nothing (S4)',
    async () => {
      const { eventId } = await heldEvent();
      await setPolicy({ enabled: false });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ held: 1, suspended: 0 });
      expect(await statuses(eventId)).toEqual(new Set(['open/-']));
    },
    TEST_TIMEOUT,
  );
});

describe('uncalibrated teams and the market', () => {
  it(
    'an event created for uncalibrated teams is priced from a strong market and handed to a trader; re-pricing does not open betting',
    async () => {
      const { eventId, feedRef } = await createdEvent({ calibrated: false });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);
      // Even with auto_open on: re-pricing never opens betting.
      await setPolicy({ pricingSource: 'market', autoOpen: true });
      await addFeed('feed-a');
      // Without a market, uncalibrated teams change nothing (O1).
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, calibrated: 0 });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);

      await listEvent(eventId, 'feed-a', strongBooksNear(await storedOneXTwo(eventId), 0.95));
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
      expect(payload!.pricing).toMatchObject({ source: 'market', books: 3 });
      expect(payload!.markets.length).toBeGreaterThan(0);
      expect(await bettingOpen()).toBe(false);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.calibrated'`,
      );
      expect(audit!.metadata.bookmakers).toEqual([
        'feed-a:betsson',
        'feed-a:pinnacle',
        'feed-a:unibet_se',
      ]);
    },
    TEST_TIMEOUT,
  );

  /** K2 as F7b assesses it, at the harness clock. */
  async function kickoffNow(eventId: string) {
    const now = h.now();
    const evidence = (
      await loadKickoffEvidence(h.ctx.db, {
        eventIds: [eventId],
        now,
        minMatchDurationMs: MIN_MATCH_DURATION_MS,
        staleAfterMs: SOURCE_STALE_AFTER_MS,
        evidenceWindowMs: KICKOFF_EVIDENCE_WINDOW_MS,
      })
    ).get(eventId)!;
    return assessKickoff({
      start: evidence.event.startTime,
      now,
      statements: evidence.statements,
      person: evidence.person,
    });
  }

  /**
   * 71 h before kickoff both sources list the fixture again, source A with a finished match that
   * shows it is fresh: the kickoff is confirmed (K2, C2), as in auto-open.test.ts.
   */
  async function confirmKickoff(): Promise<void> {
    h.at(new Date(KICKOFF.getTime() - 71 * HOUR));
    h.serve(
      URL_A,
      ofDoc([
        {
          date: '2026-10-25',
          time: '15:00',
          team1: 'Liverpool FC',
          team2: 'Everton FC',
          score: { ht: [0, 0], ft: [1, 0] },
        },
        ARSENAL_CHELSEA_OF,
      ]),
    );
    await h.run('src-a');
    await h.run('src-b');
  }

  it(
    'O1m: F7b opens betting on uncalibrated teams once a strong market backs the stored prices',
    async () => {
      const { eventId } = await createdEvent({ calibrated: false });
      await setPolicy({ pricingSource: 'market', autoOpen: true });
      await addFeed('feed-a');
      await confirmKickoff();
      await listEvent(eventId, 'feed-a', strongBooksNear(await storedOneXTwo(eventId), 0.95));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, calibrated: 1 });
      expect(await kickoffNow(eventId)).toMatchObject({ confirmed: true });
      expect(
        await backedByMarket(h.ctx.db, {
          competitionPricingSource: 'market',
          eventId,
          homeRatings: null,
          awayRatings: null,
          minRatingMatches: 8,
          now: h.now(),
        }),
      ).toBe(true);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1, failed: 0 });
      expect(await bettingOpen()).toBe(true);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.betting_opened'`,
      );
      expect(audit!.metadata).toMatchObject({ rule: 'F7b', calibration: 'market' });
    },
    TEST_TIMEOUT,
  );

  it(
    'O1m: a thin market (two books, or three without a sharp one) prices the event but never hands it over',
    async () => {
      const { eventId } = await createdEvent({ calibrated: false });
      await setPolicy({ pricingSource: 'market', autoOpen: true });
      await addFeed('feed-a');
      await confirmKickoff();
      const stored = await storedOneXTwo(eventId);
      await listEvent(eventId, 'feed-a', booksNear(stored, 0.95));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, calibrated: 0 });
      expect((await stamp(eventId))!.ratings_key!.startsWith(MARKET_PRICING_KEY_PREFIX)).toBe(true);
      expect(await items('ratings_uncalibrated')).toHaveLength(1);
      expect(await items('odds_approval')).toHaveLength(0);

      const [a, b] = Object.values(booksNear(stored, 0.95));
      h.advance(MINUTE);
      await listEvent(eventId, 'feed-a', { onexbet: a!, betsson: b!, unibet_se: b! });
      await repriceScheduledEvents(h.ctx);
      expect(await items('ratings_uncalibrated')).toHaveLength(1);

      // A whole pass leaves betting closed; Pinnacle joining backs the prices.
      await runPromotion(h.ctx);
      expect(await bettingOpen()).toBe(false);
      h.advance(MINUTE);
      await listEvent(eventId, 'feed-a', { pinnacle: a!, betsson: b!, unibet_se: b! });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ calibrated: 1 });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1 });
      expect(await bettingOpen()).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'O1m: a handed-over event whose sharp book drops out does not open',
    async () => {
      const { eventId } = await createdEvent({ calibrated: false });
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      await confirmKickoff();
      const stored = await storedOneXTwo(eventId);
      await listEvent(eventId, 'feed-a', strongBooksNear(stored, 0.95));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ calibrated: 1 });
      // The latest fetch no longer lists Pinnacle: the consensus is thin again.
      const [a, b] = Object.values(booksNear(stored, 0.95));
      h.advance(MINUTE);
      await listEvent(eventId, 'feed-a', { betsson: b!, unibet_se: b!, onexbet: a! });
      await repriceScheduledEvents(h.ctx);
      await setPolicy({ autoOpen: true });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 0, failed: 0 });
      expect(await bettingOpen()).toBe(false);
      // Every other condition holds: Pinnacle back in its place opens it.
      h.advance(MINUTE);
      await listEvent(eventId, 'feed-a', { betsson: b!, unibet_se: b!, pinnacle: a! });
      await repriceScheduledEvents(h.ctx);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1 });
      expect(await bettingOpen()).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a stale market does not hand an event over; a fresh one does',
    async () => {
      const { eventId } = await createdEvent({ calibrated: false });
      await setPolicy({ pricingSource: 'market' });
      await addFeed('feed-a');
      await listEvent(eventId, 'feed-a', strongBooksNear(await storedOneXTwo(eventId), 0.95), {
        observedAt: new Date(h.now().getTime() - MARKET_ODDS_MAX_AGE_MS - HOUR),
      });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, calibrated: 0 });
      expect(await items('ratings_uncalibrated')).toHaveLength(1);
      await listEvent(eventId, 'feed-a', strongBooksNear(await storedOneXTwo(eventId), 0.95));
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, calibrated: 1 });
    },
    TEST_TIMEOUT,
  );
});
