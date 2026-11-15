import { parseReviewPayload } from '@vamos/contracts';
import { CAP_KEY_MARKER, cappedPricingKey, uncappedPricingKey } from '@vamos/core';
import {
  finishRun,
  setCompetitionPolicy,
  setSourceEnabled,
  startRun,
  upsertMarketOdds,
  upsertSource,
} from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { priceEvent } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
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
 * Rule O7 (P-3 of docs/feed-quality-plan.md): never easier to beat than the market. A selection of
 * the 1X2 or of an over/under line the books quote that we price above the best fresh book price
 * raises the odds_out_of_line alarm (`source_broken`, reason `odds_out_of_line`); with
 * SCRAPER_CAP_AT_BEST_PRICE=on the price is also capped at that book price. Markets the books do not
 * quote never change.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const actor = { system: 'test' };
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

/** Arsenal v Chelsea, created from the (calibrated) model; the cap setting as given. */
async function createdEvent(cap: 'off' | 'on'): Promise<{ eventId: string; feedRef: string }> {
  h = await createHarness({ capAtBestPrice: cap });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped'`,
  );
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'feed-a',
        name: 'feed feed-a',
        adapter: 'generic-json',
        upstream: 'feed-a',
        config: { allowedHosts: ['example.test'] },
      },
      actor,
    );
    await setSourceEnabled(tx, 'feed-a', true, actor);
  });
  return { eventId: event!.id, feedRef: event!.feed_ref };
}

/** Every stored price of the event: `<market key>|<code>` → milli. */
async function storedBook(eventId: string): Promise<Map<string, number>> {
  const found = await rows<{ key: string; code: string; odds_milli: number }>(
    `SELECT m.key, s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1`,
    [eventId],
  );
  return new Map(found.map((r) => [`${r.key}|${r.code}`, r.odds_milli]));
}

type Quote = { bookmaker: string; market: '1x2' | 'ou'; line: string | null; selection: string };
/** One fetch of feed-a at the current clock: each quote at its price. */
async function listQuotes(eventId: string, quotes: Array<Quote & { price: number }>) {
  const observedAt = h.now();
  const run = await startRun(h.ctx.db, { sourceId: 'feed-a', startedAt: observedAt });
  await finishRun(h.ctx.db, run.id, { status: 'ok', finishedAt: observedAt });
  const out = quotes.map((q) => ({
    sourceKey: `match-${eventId}`,
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    priceUpdatedAt: observedAt,
    observedAt,
    competitionId: h.premier,
    homeTeamId: h.team('Arsenal'),
    awayTeamId: h.team('Chelsea'),
    eventId,
    bookmaker: q.bookmaker,
    market: q.market as never,
    line: q.line as never,
    selection: q.selection as never,
    priceMilli: q.price,
  }));
  await h.ctx.db.transaction((tx) =>
    upsertMarketOdds(tx, { sourceId: 'feed-a', runId: run.id, rawId: null, rows: out }),
  );
}

const firstBook = new Map<string, Map<string, number>>();
/**
 * Two books quoting the 1X2 and the 2.5 line: pinnacle at our stored prices, unibet 3% above them,
 * except the home side, which pinnacle quotes at `homeFactor` of ours (the best home price) and
 * unibet 1% below that.
 */
async function listBooks(
  eventId: string,
  homeFactor: number,
  extra: Array<Quote & { price: number }> = [],
): Promise<void> {
  // Around the event's first stored (model) prices, whatever a cap did to them since.
  if (!firstBook.has(eventId)) firstBook.set(eventId, await storedBook(eventId));
  const book = firstBook.get(eventId)!;
  const quotes: Array<Quote & { price: number }> = [];
  for (const [bookmaker, up, homeUp] of [
    ['pinnacle', 1, 1],
    ['unibet', 1.03, 0.99],
  ] as const) {
    const at = (key: string, factor: number) => Math.floor(book.get(key)! * factor);
    quotes.push(
      {
        bookmaker,
        market: '1x2',
        line: null,
        selection: '1',
        price: at('1x2|1', homeFactor * homeUp),
      },
      { bookmaker, market: '1x2', line: null, selection: 'X', price: at('1x2|X', up) },
      { bookmaker, market: '1x2', line: null, selection: '2', price: at('1x2|2', up) },
      { bookmaker, market: 'ou', line: '2.5', selection: 'over', price: at('ou:2.5|over', up) },
      { bookmaker, market: 'ou', line: '2.5', selection: 'under', price: at('ou:2.5|under', up) },
    );
  }
  await listQuotes(eventId, [...quotes, ...extra]);
}

const openAlarms = (eventId: string) =>
  rows<{ severity: string; title: string; payload: Record<string, unknown> }>(
    `SELECT severity, title, payload FROM scrape_review_items
      WHERE kind = 'source_broken' AND status = 'open' AND subject_key = $1`,
    [`odds_out_of_line|${eventId}`],
  );
const resolvedAlarms = (eventId: string) =>
  rows<{ resolution: string }>(
    `SELECT resolution FROM scrape_review_items
      WHERE kind = 'source_broken' AND status = 'resolved' AND subject_key = $1`,
    [`odds_out_of_line|${eventId}`],
  );
const stampKey = async (eventId: string) =>
  (
    await rows<{ ratings_key: string }>(
      `SELECT ratings_key FROM scrape_event_pricing WHERE event_id = $1`,
      [eventId],
    )
  )[0]!.ratings_key;

describe('rule O7: never above the best book price', () => {
  it(
    'off: an event priced above the best book keeps its prices and the alarm opens; it resolves when the books move',
    async () => {
      const { eventId, feedRef } = await createdEvent('off');
      const before = await storedBook(eventId);
      const key = await stampKey(eventId);
      const home = before.get('1x2|1')!;
      await listBooks(eventId, 0.95);

      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ repriced: 0, held: 0, failed: 0 });
      expect(await storedBook(eventId)).toEqual(before);
      expect(await stampKey(eventId)).toBe(key);

      const [alarm, ...more] = await openAlarms(eventId);
      expect(more).toEqual([]);
      expect(alarm!.severity).toBe('warning');
      expect(alarm!.title).toBe(
        '1 selection priced above the best bookmaker price, not capped (SCRAPER_CAP_AT_BEST_PRICE=off)',
      );
      expect(alarm!.payload).toMatchObject({
        reason: 'odds_out_of_line',
        eventId,
        feedRef,
        capped: false,
        selections: [
          {
            market: '1x2',
            line: null,
            selection: '1',
            ourOddsMilli: home,
            bestOddsMilli: Math.floor(home * 0.95),
            bestBookmaker: 'feed-a:pinnacle',
          },
        ],
      });
      // The back office reads it as any source_broken item.
      expect(() => parseReviewPayload('source_broken', alarm!.payload)).not.toThrow();

      // Refreshed, never doubled, while it holds.
      await repriceScheduledEvents(h.ctx);
      expect(await openAlarms(eventId)).toHaveLength(1);

      // The books lengthen the home side above ours: resolved, prices still as they were.
      h.advance(MINUTE);
      await listBooks(eventId, 1.02);
      await repriceScheduledEvents(h.ctx);
      expect(await openAlarms(eventId)).toEqual([]);
      expect(await resolvedAlarms(eventId)).toEqual([
        { resolution: 'no selection is priced above the best book price any more' },
      ]);
      expect(await storedBook(eventId)).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'on: the price is capped at the best book price, the alarm says so, nothing else changes',
    async () => {
      const { eventId } = await createdEvent('on');
      const before = await storedBook(eventId);
      const key = await stampKey(eventId);
      const home = before.get('1x2|1')!;
      const capped = Math.floor(home * 0.95);
      await listBooks(eventId, 0.95);

      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ repriced: 1, held: 0, failed: 0 });
      const after = await storedBook(eventId);
      expect(after.get('1x2|1')).toBe(capped);
      // Every other price, of the quoted markets and of the markets the books do not quote, as before.
      for (const [selection, odds] of before) {
        if (selection !== '1x2|1') expect(after.get(selection), selection).toBe(odds);
      }
      expect(after.size).toBe(before.size);
      // The stamp carries the cap, on top of the ratings key.
      const stamped = await stampKey(eventId);
      expect(stamped).toBe(`${key}${CAP_KEY_MARKER}1x2|1=${capped}`);
      expect(uncappedPricingKey(stamped)).toBe(key);

      const [alarm] = await openAlarms(eventId);
      expect(alarm!.severity).toBe('info');
      expect(alarm!.title).toBe('1 selection capped at the best bookmaker price (O7)');
      expect(alarm!.payload).toMatchObject({
        reason: 'odds_out_of_line',
        capped: true,
        selections: [{ selection: '1', ourOddsMilli: home, bestOddsMilli: capped }],
      });
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.repriced' AND target_id = $1`,
        [eventId],
      );
      expect(audit!.metadata).toMatchObject({
        capped: true,
        outOfLine: [{ market: '1x2', selection: '1', ourOddsMilli: home, bestOddsMilli: capped }],
      });

      // Idempotent while the books stay.
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ events: 0, repriced: 0 });
      expect(await storedBook(eventId)).toEqual(after);

      // The books lengthen the home side again: the cap lifts, our own price is back, resolved.
      h.advance(MINUTE);
      await listBooks(eventId, 1.02);
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ repriced: 1, failed: 0 });
      expect(await storedBook(eventId)).toEqual(before);
      expect(await stampKey(eventId)).toBe(key);
      expect(await openAlarms(eventId)).toEqual([]);
      expect(await resolvedAlarms(eventId)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'on: a cap the bounds refuse is held for a person like any re-price (O2/O3 not bypassed)',
    async () => {
      const { eventId, feedRef } = await createdEvent('on');
      const before = await storedBook(eventId);
      await listBooks(eventId, 0.6);

      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary).toMatchObject({ repriced: 0, held: 1, failed: 0 });
      expect(await storedBook(eventId)).toEqual(before);
      const [hold] = await rows<{ payload: { reason: string } }>(
        `SELECT payload FROM scrape_review_items
          WHERE kind = 'odds_approval' AND status = 'open' AND subject_key = $1`,
        [`${feedRef}|reprice`],
      );
      expect(hold!.payload.reason).toMatch(/price_move_too_large|overround_high/);
      expect(await openAlarms(eventId)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'market prices are capped too, and their key carries the cap',
    async () => {
      const { eventId } = await createdEvent('off');
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { pricingSource: 'market' }, actor),
      );
      // Two books whose margin is larger than ours: 5% and 6% under the model's prices.
      const book = await storedBook(eventId);
      const quotes: Array<Quote & { price: number }> = [];
      for (const [bookmaker, factor] of [
        ['pinnacle', 0.95],
        ['unibet', 0.94],
      ] as const) {
        for (const [market, line, selection, key] of [
          ['1x2', null, '1', '1x2|1'],
          ['1x2', null, 'X', '1x2|X'],
          ['1x2', null, '2', '1x2|2'],
          ['ou', '2.5', 'over', 'ou:2.5|over'],
          ['ou', '2.5', 'under', 'ou:2.5|under'],
        ] as const) {
          quotes.push({
            bookmaker,
            market,
            line,
            selection,
            price: Math.floor(book.get(key)! * factor),
          });
        }
      }
      await listQuotes(eventId, quotes);
      const input = {
        competitionPricingSource: 'market' as const,
        eventId,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: 8,
        now: h.now(),
      };
      const off = await priceEvent(h.ctx.db, input);
      expect(off.source).toBe('market');
      expect(off.capped).toBeUndefined();
      expect(off.outOfLine.length).toBeGreaterThan(0);
      for (const o of off.outOfLine) {
        expect(o.bestBookmaker).toBe('feed-a:pinnacle');
        expect(o.ourOddsMilli).toBeGreaterThan(o.bestOddsMilli);
      }

      const on = await priceEvent(h.ctx.db, { ...input, capAtBestPrice: true });
      expect(on.source).toBe('market');
      expect(on.capped).toBe(true);
      expect(on.outOfLine).toEqual(off.outOfLine);
      expect(on.key).toBe(cappedPricingKey(off.key, off.outOfLine));
      expect(on.key.startsWith(`${off.key}${CAP_KEY_MARKER}`)).toBe(true);
      expect(on.pricesSane).toBe(true);
      // The out-of-line selections at the best book price; every other price as the market made it.
      const flat = (markets: typeof on.markets) =>
        new Map(
          markets.flatMap((m) =>
            m.selections.map((s) => [`${m.type}${m.line ?? ''}|${s.code}`, s.oddsMilli] as const),
          ),
        );
      const capped = new Map(
        off.outOfLine.map((o) => [`${o.market}${o.line ?? ''}|${o.selection}`, o.bestOddsMilli]),
      );
      const before = flat(off.markets);
      for (const [selection, odds] of flat(on.markets)) {
        expect(odds, selection).toBe(capped.get(selection) ?? before.get(selection));
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'the alarm resolves once the event leaves the re-pricing pass',
    async () => {
      const { eventId } = await createdEvent('off');
      await listBooks(eventId, 0.95);
      await repriceScheduledEvents(h.ctx);
      expect(await openAlarms(eventId)).toHaveLength(1);
      // Kickoff is near: the pass no longer looks at the event.
      h.at(new Date(KICKOFF.getTime() - MINUTE));
      await repriceScheduledEvents(h.ctx);
      expect(await openAlarms(eventId)).toEqual([]);
      expect((await resolvedAlarms(eventId))[0]!.resolution).toMatch(/left the re-pricing pass/);
    },
    TEST_TIMEOUT,
  );
});
