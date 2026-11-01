import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { isReferenceItem, REVIEW_PAYLOAD_SCHEMAS } from '@vamos/contracts';
import {
  getReferenceBudget,
  getReferencePollState,
  raiseCloseLead,
  recordReferenceBudget,
  replaceReferenceBookPrices,
  resolveReviewItem,
  resumeEvent,
  setEventBettingOpen,
  setMarketStatus,
  upsertReferenceConsensus,
  upsertReferenceEventMap,
} from '@vamos/db';
import { closeLeadMs } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { runDueSources } from '../src/tasks/scheduler';
import { SETUP_TIMEOUT, TEST_TIMEOUT } from './helpers';
import { AGREEING_BOOKS, dayBody, eventBody, type EventSpec } from './therundown-bodies';
import { createTrHarness, HOUR, MINUTE, TR_SECRET, type TrHarness } from './therundown-helpers';

/**
 * TheRundown through the scraper (docs/therundown-plan, phase 1), on a real Postgres and Redis,
 * a fake network and synthetic responses. Nothing here touches the network.
 */

let t: TrHarness;
afterEach(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

type Row = Record<string, unknown>;
const items = (kind: string) =>
  t.rows<{
    id: string;
    subject_key: string;
    status: string;
    severity: string;
    payload: Row;
  }>(
    `SELECT id, subject_key, status, severity, payload FROM scrape_review_items WHERE kind = $1 ORDER BY created_at, id`,
    [kind],
  );
const audits = (action: string) =>
  t.rows<{ target_id: string; actor_id: string; metadata: Row }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
const dayCalls = () => t.calls.filter((c) => c.url.includes('/sports/'));
const market = async (eventId: string, key: string) =>
  (
    await t.rows<{ id: string; status: string; suspended_by: string | null }>(
      `SELECT id, status, suspended_by FROM markets WHERE event_id = $1 AND key = $2`,
      [eventId, key],
    )
  )[0]!;
const oddsSum = (eventId: string) =>
  t.count(
    `SELECT COALESCE(sum(s.odds_milli), 0) AS n FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.event_id = $1`,
    [eventId],
  );

/** An event of ours (betting open) with TheRundown's day response for it already served. */
async function withDay(
  spec: Partial<EventSpec> = {},
  event: Parameters<TrHarness['createEvent']>[0] = {},
  headers: Record<string, string> = { 'x-data-delay-seconds': '60' },
) {
  const ours = await t.createEvent(event);
  const body = dayBody([{ id: 'evt-1', kickoff: ours.start, ...spec }]);
  t.answer(t.dayUrlOf(ours.start), { status: 200, body, headers });
  return { ...ours, body };
}

describe('kickoff rule (M1): nothing is bet after a match starts', () => {
  const cases: Array<[string, (start: Date, now: Date) => Partial<EventSpec>, string]> = [
    [
      'a started status',
      (_start, now) => ({
        status: 'STATUS_IN_PROGRESS',
        kickoff: new Date(now.getTime() - 10 * MINUTE),
      }),
      'started',
    ],
    [
      'an earlier kickoff',
      (start) => ({ kickoff: new Date(start.getTime() - 2 * HOUR) }),
      'earlier_kickoff',
    ],
    ['a postponed status', () => ({ status: 'STATUS_POSTPONED' }), 'not_scheduled'],
  ];

  it.each(cases)(
    'closes betting on %s, audits it, opens one critical kickoff_change item, and writes no price',
    async (_name, specOf, reason) => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 30 * HOUR);
      const ours = await withDay(specOf(start, t.h.now()), { start });
      const before = await oddsSum(ours.eventId);

      const first = await t.tick();
      expect(first.apply).toMatchObject({ matched: 1, closed: 1, mapped: 0 });
      expect(first.apply.published).toBeGreaterThan(0);

      const event = await t.event(ours.eventId);
      expect(event).toMatchObject({ betting_open: false, status: 'scheduled' });
      expect(event.start_time).toEqual(start);
      expect(await oddsSum(ours.eventId)).toBe(before);

      const [audit, ...extra] = await audits('reference.betting_closed');
      expect(extra).toHaveLength(0);
      expect(audit).toMatchObject({ target_id: ours.eventId, actor_id: 'system:scraper' });
      expect(audit!.metadata).toMatchObject({ rule: 'M1', reason, providerEventId: 'evt-1' });
      expect(audit!.metadata.theirStatus).toBeTypeOf('string');
      expect(audit!.metadata.theirKickoff).toBeTypeOf('string');

      const [item, ...others] = await items('kickoff_change');
      expect(others).toHaveLength(0);
      expect(item).toMatchObject({
        subject_key: `${ours.feedRef}|therundown`,
        status: 'open',
        severity: 'critical',
      });
      expect(REVIEW_PAYLOAD_SCHEMAS.kickoff_change.safeParse(item!.payload).success).toBe(true);
      expect(item!.payload).toMatchObject({
        eventId: ours.eventId,
        currentKickoff: start.toISOString(),
        theirStatus: audit!.metadata.theirStatus,
        theirKickoff: audit!.metadata.theirKickoff,
        hasBets: false,
        sources: [{ sourceId: 'therundown', upstream: 'TheRundown' }],
      });
      // A closed kickoff is not a mapped price source.
      expect(await t.count(`SELECT count(*) AS n FROM reference_event_map`)).toBe(0);

      // The same answer again changes nothing: no second audit, no second item.
      t.h.advance(25 * MINUTE);
      const second = await t.tick();
      expect(second.apply.closed).toBe(0);
      expect(await audits('reference.betting_closed')).toHaveLength(1);
      expect(await items('kickoff_change')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a person who dismissed the item for that kickoff and status is not overruled; a new status closes again',
    async () => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 30 * HOUR);
      const ours = await t.createEvent({ start });
      const answerWith = (spec: Partial<EventSpec>) =>
        t.answer(t.dayUrlOf(start), dayBody([{ id: 'evt-1', kickoff: start, ...spec }]));

      answerWith({ status: 'STATUS_DELAYED' });
      await t.tick();
      expect((await t.event(ours.eventId)).betting_open).toBe(false);
      const [first] = await items('kickoff_change');
      await t.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, first!.id, {
          status: 'dismissed',
          resolution: JSON.stringify({
            decision: 'dismiss',
            note: 'checked: it kicks off on time',
          }),
          actor: { adminId: randomUUID() },
          now: t.h.now(),
        }),
      );
      await t.ctx.db.transaction((tx) => setEventBettingOpen(tx, ours.eventId, true));

      // The same status and kickoff: the person has looked, betting stays open.
      t.h.advance(25 * MINUTE);
      await t.tick();
      expect((await t.event(ours.eventId)).betting_open).toBe(true);
      expect(await audits('reference.betting_closed')).toHaveLength(1);
      expect(await items('kickoff_change')).toHaveLength(1);

      // TheRundown's status changes: that is new, betting closes again with a new item.
      answerWith({ status: 'STATUS_POSTPONED' });
      t.h.advance(25 * MINUTE);
      await t.tick();
      expect((await t.event(ours.eventId)).betting_open).toBe(false);
      expect(await audits('reference.betting_closed')).toHaveLength(2);
      const all = await items('kickoff_change');
      expect(all.map((i) => i.status)).toEqual(['dismissed', 'open']);
      expect(all[1]!.payload.theirStatus).toBe('STATUS_POSTPONED');
    },
    TEST_TIMEOUT,
  );

  it(
    'does nothing to an event that is already closed, or that is not matched exactly once',
    async () => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 30 * HOUR);
      const closed = await t.createEvent({ start, closed: true });
      t.answer(
        t.dayUrlOf(start),
        dayBody([{ id: 'evt-1', kickoff: start, status: 'STATUS_IN_PROGRESS' }]),
      );
      await t.tick();
      expect(await audits('reference.betting_closed')).toHaveLength(0);
      expect(await items('kickoff_change')).toHaveLength(0);
      expect((await t.event(closed.eventId)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('matching (M1) and the event map', () => {
  it(
    'maps a match whose teams and kickoff agree, raises the close lead, and stores prices and consensus',
    async () => {
      t = await createTrHarness();
      const ours = await withDay();
      expect((await t.event(ours.eventId)).close_lead_ms).toBe(0);
      const fetchedAt = t.h.now();

      const summary = await t.tick();
      expect(summary.apply).toMatchObject({ matched: 1, mapped: 1, closed: 0, suspended: 0 });

      const [map] = await t.rows<Row>(`SELECT * FROM reference_event_map`);
      expect(map).toMatchObject({
        provider: 'therundown',
        provider_event_id: 'evt-1',
        event_id: ours.eventId,
        provider_sport_id: 11,
        home_team_ref: 7,
        away_team_ref: 9,
        status: 'STATUS_SCHEDULED',
      });
      // 60 s late: betting closes 5 minutes before the start, instead of at it.
      expect((await t.event(ours.eventId)).close_lead_ms).toBe(closeLeadMs(60));
      expect(closeLeadMs(60)).toBe(5 * MINUTE);

      // 3 books x (1X2: 3 outcomes + over/under: 2) prices; nothing else.
      expect(await t.count(`SELECT count(*) AS n FROM reference_book_prices`)).toBe(15);
      const consensus = await t.rows<{
        market_key: string;
        fair: Record<string, number>;
        confidence: string;
        books_used: number[];
        as_of: Date;
      }>(
        `SELECT market_key, fair, confidence, books_used, as_of FROM reference_consensus ORDER BY market_key`,
      );
      expect(consensus.map((c) => c.market_key)).toEqual(['1x2', 'ou:2.5']);
      for (const row of consensus) {
        expect(row.books_used).toEqual([3, 7, 32]);
        expect(row.confidence).toBe('normal');
        expect(Object.values(row.fair).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        expect(row.as_of).toEqual(new Date(fetchedAt.getTime() - 60_000));
      }
      expect(Object.keys(consensus[0]!.fair).sort()).toEqual(['1', '2', 'X']);
      // Prices that match the market: nothing was suspended, nothing opened for review.
      expect((await market(ours.eventId, '1x2')).status).toBe('open');
      expect(await items('odds_approval')).toHaveLength(0);
      expect(await audits('reference.market_suspended')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a missing delay header counts as 300 seconds (never 0): older prices, a longer close lead',
    async () => {
      t = await createTrHarness();
      const ours = await withDay({}, {}, {});
      const fetchedAt = t.h.now();
      await t.tick();
      expect((await t.event(ours.eventId)).close_lead_ms).toBe(closeLeadMs(300));
      expect(closeLeadMs(300)).toBe(660_000);
      const [row] = await t.rows<{ as_of: Date }>(`SELECT as_of FROM reference_consensus LIMIT 1`);
      expect(row!.as_of).toEqual(new Date(fetchedAt.getTime() - 300_000));
    },
    TEST_TIMEOUT,
  );

  it(
    'raises the close lead and never lowers one a trader set',
    async () => {
      t = await createTrHarness();
      const ours = await withDay();
      await t.ctx.db.transaction((tx) => raiseCloseLead(tx, ours.eventId, 10 * MINUTE));
      await t.tick();
      expect((await t.event(ours.eventId)).close_lead_ms).toBe(10 * MINUTE);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not map or close for home and away swapped, an unknown team, or two of our events',
    async () => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 30 * HOUR);
      const one = await t.createEvent({ start });
      const bodyFor = (specs: Array<Partial<EventSpec>>) =>
        dayBody(
          specs.map((s, i) => ({
            id: `evt-${i}`,
            kickoff: start,
            status: 'STATUS_IN_PROGRESS',
            ...s,
          })),
        );

      // Their home is Chelsea: no event of ours is Chelsea v Arsenal.
      t.answer(
        t.dayUrlOf(start),
        bodyFor([
          { home: { id: 9, name: 'Chelsea' }, away: { id: 7, name: 'Arsenal' } },
          // A name no alias or catalogue entry knows.
          { home: { id: 70, name: 'Nowhere Rovers' } },
        ]),
      );
      await t.tick();
      expect((await t.event(one.eventId)).betting_open).toBe(true);

      // Two of our events for the same teams within 36 h of their kickoff: ambiguous, so nothing.
      const two = await t.createEvent({ start: new Date(start.getTime() + 10 * HOUR) });
      t.h.advance(25 * MINUTE);
      t.answer(t.dayUrlOf(start), bodyFor([{}]));
      await t.tick();
      expect((await t.event(one.eventId)).betting_open).toBe(true);
      expect((await t.event(two.eventId)).betting_open).toBe(true);

      expect(await audits('reference.betting_closed')).toHaveLength(0);
      expect(await t.count(`SELECT count(*) AS n FROM reference_event_map`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a later kickoff (beyond the 5 minute tolerance) is not mapped and closes nothing; one 36 h away is not ours',
    async () => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 30 * HOUR);
      const ours = await t.createEvent({ start });
      t.answer(
        t.dayUrlOf(start),
        dayBody([
          { id: 'later', kickoff: new Date(start.getTime() + HOUR) },
          { id: 'far', kickoff: new Date(start.getTime() + 40 * HOUR) },
        ]),
      );
      const summary = await t.tick();
      expect(summary.apply).toMatchObject({ matched: 1, mapped: 0, closed: 0 });
      expect((await t.event(ours.eventId)).betting_open).toBe(true);
      expect(await t.count(`SELECT count(*) AS n FROM reference_event_map`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'an event of the last 3 hours is polled alone once mapped (a single-event request, every minute)',
    async () => {
      t = await createTrHarness();
      const start = new Date(t.h.now().getTime() + 2 * HOUR);
      const ours = await t.createEvent({ start });
      t.answer(t.dayUrlOf(start), dayBody([{ id: 'evt-near', kickoff: start }]));
      t.answer(t.eventUrl('evt-near'), eventBody({ id: 'evt-near', kickoff: start }));
      await t.tick();
      expect(await t.count(`SELECT count(*) AS n FROM reference_event_map`)).toBe(1);

      // Mapped, and inside the last 3 hours: the event is asked for alone (not the whole day).
      t.calls.length = 0;
      t.h.advance(30_000);
      const second = await t.tick();
      expect(t.calls.map((c) => c.url)).toEqual([t.eventUrl('evt-near')]);
      expect(second.apply.mapped).toBe(1);

      // Then once a minute, no sooner.
      t.calls.length = 0;
      t.h.advance(30_000);
      await t.tick();
      expect(t.calls).toHaveLength(0);
      t.h.advance(31_000);
      await t.tick();
      expect(t.calls.map((c) => c.url)).toEqual([t.eventUrl('evt-near')]);

      // The single-event answer applies the kickoff rule too.
      t.answer(
        t.eventUrl('evt-near'),
        eventBody({ id: 'evt-near', kickoff: start, status: 'STATUS_HALFTIME' }),
      );
      t.h.advance(61_000);
      await t.tick();
      expect((await t.event(ours.eventId)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('odds-error guard (P6)', () => {
  it(
    'suspends the market that is too high, once, with an audit and one item; the other market stays open',
    async () => {
      t = await createTrHarness();
      // Home 2.10 against a fair 1.90: a player's edge of 10% on the 1X2; the total is in line.
      const ours = await withDay({}, { oneXTwo: [2100, 4200, 3900] });
      const oddsBefore = await oddsSum(ours.eventId);

      const first = await t.tick();
      expect(first.apply).toMatchObject({ mapped: 1, suspended: 1 });
      expect(await market(ours.eventId, '1x2')).toMatchObject({
        status: 'suspended',
        // Not 'feed': a market the guard stopped is lifted only by a person.
        suspended_by: 'trader',
      });
      expect((await market(ours.eventId, 'ou:2.5')).status).toBe('open');
      expect((await t.event(ours.eventId)).betting_open).toBe(true);
      // The guard never sets a price.
      expect(await oddsSum(ours.eventId)).toBe(oddsBefore);

      const [audit, ...extra] = await audits('reference.market_suspended');
      expect(extra).toHaveLength(0);
      expect(audit).toMatchObject({ actor_id: 'system:scraper' });
      expect(audit!.metadata).toMatchObject({
        rule: 'P6',
        marketKey: '1x2',
        eventId: ours.eventId,
      });
      expect(audit!.metadata.edges).toHaveLength(3);
      expect(audit!.metadata.consensus).toMatchObject({
        confidence: 'normal',
        booksUsed: [3, 7, 32],
      });

      const [item, ...others] = await items('odds_approval');
      expect(others).toHaveLength(0);
      expect(item).toMatchObject({
        subject_key: `${ours.feedRef}|reference|1x2`,
        status: 'open',
      });
      expect(REVIEW_PAYLOAD_SCHEMAS.odds_approval.safeParse(item!.payload).success).toBe(true);
      expect(item!.payload).toMatchObject({
        reason: 'market_divergence',
        eventId: ours.eventId,
        markets: [
          { market: '1x2', selections: expect.arrayContaining([{ name: '1', oddsMilli: 2100 }]) },
        ],
      });
      expect((item!.payload.consensus as Row).fair).toBeTypeOf('object');
      expect(item!.payload.edges).toHaveLength(3);
      // The back office never offers "Open betting" for it.
      expect(isReferenceItem({ kind: 'odds_approval', subjectKey: item!.subject_key })).toBe(true);

      // Idempotent: the next poll sees a suspended market and does nothing more.
      t.h.advance(25 * MINUTE);
      const second = await t.tick();
      expect(second.apply.suspended).toBe(0);
      expect(await audits('reference.market_suspended')).toHaveLength(1);
      expect(await items('odds_approval')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'automatic code never lifts it (resumeEvent without an actor); a person does, and the guard can stop it again',
    async () => {
      t = await createTrHarness();
      const ours = await withDay({}, { oneXTwo: [2100, 4200, 3900] });
      await t.tick();
      const stopped = await market(ours.eventId, '1x2');

      await t.ctx.db.transaction((tx) => resumeEvent(tx, ours.eventId));
      expect((await market(ours.eventId, '1x2')).status).toBe('suspended');
      await t.ctx.db.transaction((tx) => setMarketStatus(tx, stopped.id, 'open'));
      expect((await market(ours.eventId, '1x2')).status).toBe('suspended');

      // A trader re-opens it at the same wrong price: the next poll stops it again, and the
      // item that is still open is refreshed, not duplicated.
      await t.ctx.db.transaction((tx) =>
        setMarketStatus(tx, stopped.id, 'open', { adminId: 'trader-1' }),
      );
      expect((await market(ours.eventId, '1x2')).status).toBe('open');
      t.h.advance(25 * MINUTE);
      await t.tick();
      expect((await market(ours.eventId, '1x2')).status).toBe('suspended');
      expect(await audits('reference.market_suspended')).toHaveLength(2);
      expect(await items('odds_approval')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "without the books' health the confidence is low and the threshold wider; with it the same price stops",
    async () => {
      t = await createTrHarness();
      // Home 1.99: a player's edge of about 4.5%, over 3% but under the 5% of a low confidence.
      const ours = await withDay({}, { oneXTwo: [1990, 4200, 3900] });
      t.answer(t.affiliatesUrl, { status: 500, body: 'down' });

      await t.tick();
      const [row] = await t.rows<{ confidence: string }>(
        `SELECT confidence FROM reference_consensus WHERE market_key = '1x2'`,
      );
      expect(row!.confidence).toBe('low');
      expect((await market(ours.eventId, '1x2')).status).toBe('open');
      const health = await getReferencePollState(t.ctx.db, 'therundown', 'affiliates');
      expect(health?.details).toEqual({ status: 500, healthyBooks: null });

      // An hour later the books answer: normal confidence, and the guard stops the market.
      t.answer(t.affiliatesUrl, {
        status: 200,
        body: JSON.stringify([
          { affiliate_id: 3, status: 'healthy' },
          { affiliate_id: 7, status: 'healthy' },
          { affiliate_id: 32, status: 'healthy' },
          { affiliate_id: 9, status: 'unhealthy' },
        ]),
      });
      t.h.advance(61 * MINUTE);
      await t.tick();
      expect((await market(ours.eventId, '1x2')).status).toBe('suspended');
      const healthy = await getReferencePollState(t.ctx.db, 'therundown', 'affiliates');
      expect(healthy?.details).toEqual({ healthyBooks: [3, 7, 32] });
    },
    TEST_TIMEOUT,
  );

  it(
    'THERUNDOWN_ODDS_USE=publish is not built: it acts as reference and says so once',
    async () => {
      t = await createTrHarness({ oddsUse: 'publish', operator: true });
      const ours = await withDay({}, { oneXTwo: [2100, 3900, 4000] });
      const history = () => t.count(`SELECT count(*) AS n FROM odds_history`);
      const before = await history();
      await t.tick();
      expect((await market(ours.eventId, '1x2')).status).toBe('suspended');
      t.h.advance(25 * MINUTE);
      await t.tick();
      expect(t.logs.join('').split('is not built yet').length - 1).toBe(1);
      // Nothing wrote a price.
      expect(await history()).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'an unhealthy anchor leaves its book out: no anchor, no consensus, nothing suspended',
    async () => {
      t = await createTrHarness();
      const ours = await withDay({}, { oneXTwo: [2100, 4200, 3900] });
      t.answer(t.affiliatesUrl, {
        status: 200,
        body: JSON.stringify([
          { affiliate_id: 7, status: 'healthy' },
          { affiliate_id: 3, status: 'beta' },
          { affiliate_id: 32, status: 'unhealthy' },
        ]),
      });
      const summary = await t.tick();
      expect(summary.apply).toMatchObject({ mapped: 1, consensus: 0, suspended: 0 });
      expect((await market(ours.eventId, '1x2')).status).toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    'a market that is already suspended by a trader is left alone, and so is one far worse than the market (info)',
    async () => {
      t = await createTrHarness();
      // Every home price far below the market: an info item at most, never a suspension.
      const ours = await withDay({}, { oneXTwo: [1100, 1200, 1300] });
      const summary = await t.tick();
      expect(summary.apply).toMatchObject({ mapped: 1, suspended: 0, info: 1 });
      expect((await market(ours.eventId, '1x2')).status).toBe('open');
      expect(await items('odds_approval')).toHaveLength(0);

      const trader = await t.createEvent({
        start: new Date(t.h.now().getTime() + 31 * HOUR),
        home: 'Chelsea',
        away: 'Arsenal',
        oneXTwo: [2100, 4200, 3900],
      });
      const m = await market(trader.eventId, '1x2');
      await t.ctx.db.transaction((tx) =>
        setMarketStatus(tx, m.id, 'suspended', { adminId: 'trader-1' }),
      );
      t.answer(
        t.dayUrlOf(trader.start),
        dayBody([
          {
            id: 'evt-2',
            kickoff: trader.start,
            home: { id: 9, name: 'Chelsea' },
            away: { id: 7, name: 'Arsenal' },
          },
        ]),
      );
      t.h.advance(25 * MINUTE);
      await t.tick();
      expect(await audits('reference.market_suspended')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('the budget (A3) and failures (A2)', () => {
  it(
    'records the meters of a response, and warns when a response costs far more than expected',
    async () => {
      t = await createTrHarness();
      const ours = await withDay(
        {},
        {},
        {
          'x-data-delay-seconds': '60',
          'x-datapoints': '5000',
          'x-datapoints-used': '5000',
          'x-datapoints-remaining': '24995000',
          'x-datapoints-reset': '2026-11-30T00:00:00Z',
          'x-rate-limit': '2',
        },
      );
      await t.tick();
      const budget = await getReferenceBudget(t.ctx.db, 'therundown');
      expect(budget).toMatchObject({
        used: 5000,
        remaining: 24_995_000,
        spentToday: 5000,
        delaySeconds: 60,
        rateLimit: 2,
        level: 'unknown',
      });
      expect(budget!.resetAt).toEqual(new Date('2026-11-30T00:00:00Z'));
      // 1 event, 5 books x 5 prices: 27 points expected, 5000 charged.
      expect(t.logs.join('')).toContain('cost far more than expected');
      expect(ours.eventId).toBeTruthy();
    },
    TEST_TIMEOUT,
  );

  it(
    'a red budget stops every price request (and the level is stored)',
    async () => {
      t = await createTrHarness();
      await withDay();
      await t.ctx.db.transaction((tx) =>
        recordReferenceBudget(tx, {
          provider: 'therundown',
          now: t.h.now(),
          snapshot: {
            used: 24_900_000,
            remaining: 100_000,
            resetAt: new Date(t.h.now().getTime() + 10 * 24 * HOUR),
            observedAt: t.h.now(),
          },
        }),
      );
      const summary = await t.tick();
      expect(summary).toMatchObject({ requests: 0, level: 'red' });
      expect(t.calls).toHaveLength(0);
      expect((await getReferenceBudget(t.ctx.db, 'therundown'))?.level).toBe('red');
      expect(
        await t.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = 'therundown'`),
      ).toBe(0);

      // Prices were not asked for; the kickoff rule has nothing to read either, so a person
      // must watch the budget: nothing is opened, nothing changes.
      expect(await t.count(`SELECT count(*) AS n FROM reference_consensus`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    '401 opens source_broken (unauthorized) with the run, holds the source, and never leaks the key',
    async () => {
      t = await createTrHarness();
      await withDay();
      t.fallback({ status: 401, body: 'nope' });
      t.answer(t.affiliatesUrl, { status: 401, body: 'nope' });
      const summary = await t.tick();
      expect(summary).toMatchObject({ requests: 1, failed: 1 });

      const [run] = await t.rows<{ id: string; status: string; requests: number; issues: Row[] }>(
        `SELECT id, status, requests, issues FROM scrape_runs WHERE source_id = 'therundown'`,
      );
      expect(run).toMatchObject({ status: 'failed', requests: 1 });
      const [item] = await items('source_broken');
      expect(item).toMatchObject({ subject_key: 'source|therundown', status: 'open' });
      expect(REVIEW_PAYLOAD_SCHEMAS.source_broken.safeParse(item!.payload).success).toBe(true);
      expect(item!.payload).toMatchObject({
        sourceId: 'therundown',
        runId: run!.id,
        reason: 'unauthorized',
      });

      // The key travels only in the header, and is in no row, log or URL.
      expect(t.calls[0]!.headers['x-therundown-key']).toBe(TR_SECRET);
      expect(t.calls.some((c) => c.url.includes(TR_SECRET))).toBe(false);
      const stored = JSON.stringify([
        run,
        item,
        await t.rows(`SELECT * FROM reference_poll_state`),
      ]);
      expect(stored).not.toContain(TR_SECRET);
      expect(t.logs.join('')).not.toContain(TR_SECRET);

      // On hold: nothing is requested for 10 minutes, then it tries again.
      t.calls.length = 0;
      t.h.advance(5 * MINUTE);
      await t.tick();
      expect(t.calls).toHaveLength(0);
      t.h.advance(6 * MINUTE);
      await t.tick();
      expect(t.calls.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    '403 opens source_broken (forbidden) and the run is blocked',
    async () => {
      t = await createTrHarness();
      await withDay();
      t.fallback({ status: 403, body: '{"error":"plan"}' });
      t.answer(t.affiliatesUrl, { status: 403, body: '{"error":"plan"}' });
      await t.tick();
      const [run] = await t.rows<{ id: string; status: string }>(
        `SELECT id, status FROM scrape_runs WHERE source_id = 'therundown'`,
      );
      expect(run!.status).toBe('blocked');
      const [item] = await items('source_broken');
      expect(REVIEW_PAYLOAD_SCHEMAS.source_broken.safeParse(item!.payload).success).toBe(true);
      expect(item!.payload).toMatchObject({ reason: 'forbidden', runId: run!.id });
      expect(t.calls).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a missing key is refused before any request and opens source_broken (unauthorized) naming the variable',
    async () => {
      t = await createTrHarness({ key: false });
      await withDay();
      await t.tick();
      expect(t.calls).toHaveLength(0);
      const [item] = await items('source_broken');
      expect(item!.payload).toMatchObject({ reason: 'unauthorized' });
      expect(JSON.stringify(item!.payload)).toContain('SCRAPER_SECRET_THERUNDOWN');
      const [run] = await t.rows<{ status: string; error: string }>(
        `SELECT status, error FROM scrape_runs WHERE source_id = 'therundown'`,
      );
      expect(run).toMatchObject({ status: 'failed' });
      expect(run!.error).toContain('SCRAPER_SECRET_THERUNDOWN');
    },
    TEST_TIMEOUT,
  );

  it(
    'a 429 for the data point quota holds all price requests until its reset (and never retries); a burst 429 does not',
    async () => {
      t = await createTrHarness();
      await withDay();
      t.fallback({
        status: 429,
        body: 'data point limit reached',
        headers: { 'retry-after': '7200' },
      });
      t.answer(t.affiliatesUrl, {
        status: 429,
        body: 'data point limit reached',
        headers: { 'retry-after': '7200' },
      });
      const first = await t.tick();
      expect(first).toMatchObject({ requests: 1, level: 'red' });
      const quota = await getReferencePollState(t.ctx.db, 'therundown', 'quota');
      expect(quota?.lastOutcome).toBe('quota_exhausted');
      expect((await getReferenceBudget(t.ctx.db, 'therundown'))?.level).toBe('red');
      const [run] = await t.rows<{ status: string }>(
        `SELECT status FROM scrape_runs WHERE source_id = 'therundown'`,
      );
      expect(run!.status).toBe('blocked');

      // Held: no request at all for 2 hours.
      t.calls.length = 0;
      t.h.advance(30 * MINUTE);
      expect(await t.tick()).toMatchObject({ requests: 0, level: 'red' });
      t.h.advance(HOUR);
      await t.tick();
      expect(t.calls).toHaveLength(0);
      // After the reset time it asks again.
      t.h.advance(31 * MINUTE);
      t.fallback({ status: 404, body: 'not found' });
      await t.tick();
      expect(t.calls.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a burst 429 (Retry-After of seconds) is not the quota: the tick stops and the next one asks again',
    async () => {
      t = await createTrHarness();
      await withDay();
      t.answer(t.affiliatesUrl, {
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': '5' },
      });
      expect(await t.tick()).toMatchObject({ requests: 1, failed: 1 });
      expect(await getReferencePollState(t.ctx.db, 'therundown', 'quota')).toBeNull();
      expect(await items('source_broken')).toHaveLength(0);
      expect((await getReferenceBudget(t.ctx.db, 'therundown'))?.level ?? 'unknown').not.toBe(
        'red',
      );
      t.calls.length = 0;
      t.h.advance(15_000);
      await t.tick();
      expect(dayCalls()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a source whose lock is held, a disabled one, and one with an invalid config make no request',
    async () => {
      t = await createTrHarness();
      await withDay();
      const { tryLock } = await import('../src/lib/lock');
      const lock = await tryLock(t.ctx.redis, 'scraper:therundown:therundown', 60_000);
      expect(lock).not.toBeNull();
      expect(await t.tick()).toMatchObject({ sources: 1, locked: 1, requests: 0 });
      await lock!.release();
      expect(t.calls).toHaveLength(0);
      await t.close();

      t = await createTrHarness({ enabled: false });
      await withDay();
      expect(await t.tick()).toMatchObject({ sources: 0, requests: 0 });
      await t.close();

      t = await createTrHarness({
        config: { competitions: [], auth: { header: 'x', secret: 'SCRAPER_SECRET_X' } },
      });
      expect(await t.tick()).toMatchObject({ sources: 0, requests: 0 });
      expect(t.logs.join('')).toContain('invalid configuration');
    },
    TEST_TIMEOUT,
  );

  it(
    'a competition label that does not resolve through the aliases is skipped with a warning',
    async () => {
      t = await createTrHarness({ label: 'TheRundown Mystery Cup' });
      await withDay();
      expect(await t.tick()).toMatchObject({ sources: 1, requests: 0 });
      expect(t.calls).toHaveLength(0);
      expect(t.logs.join('')).toContain('does not resolve through the aliases');
    },
    TEST_TIMEOUT,
  );

  it(
    'THERUNDOWN_ODDS_USE=off polls nothing',
    async () => {
      t = await createTrHarness({ oddsUse: 'off' });
      await withDay();
      expect(await t.tick()).toMatchObject({ sources: 0, requests: 0 });
      expect(t.calls).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('retention (A5), the scheduler and the archive', () => {
  it(
    'prunes what is older than the retention once an hour, and nothing fresher',
    async () => {
      t = await createTrHarness();
      const old = await t.createEvent();
      const fresh = await t.createEvent({ start: new Date(t.h.now().getTime() + 40 * HOUR) });
      const seed = async (eventId: string, providerEventId: string, at: Date) =>
        t.ctx.db.transaction(async (tx) => {
          await upsertReferenceEventMap(tx, {
            provider: 'therundown',
            providerEventId,
            eventId,
            providerSportId: 11,
            homeTeamRef: 7,
            awayTeamRef: 9,
            kickoff: at,
            status: 'STATUS_SCHEDULED',
            seenAt: at,
          });
          await replaceReferenceBookPrices(tx, {
            provider: 'therundown',
            providerEventId,
            fetchedAt: at,
            asOf: at,
            prices: [
              {
                marketKey: '1x2',
                outcome: '1',
                bookId: 3,
                american: -120,
                oddsMilli: 1833,
                vendorUpdatedAt: at,
                liquidityUsd: null,
              },
            ],
          });
          await upsertReferenceConsensus(tx, [
            {
              eventId,
              provider: 'therundown',
              marketKey: '1x2',
              fair: { '1': 0.5, X: 0.25, '2': 0.25 },
              booksUsed: [3, 32],
              dispersion: 0,
              confidence: 'normal',
              asOf: at,
              computedAt: at,
            },
          ]);
        });
      await seed(old.eventId, 'evt-old', new Date(t.h.now().getTime() - 25 * HOUR));
      await seed(fresh.eventId, 'evt-fresh', new Date(t.h.now().getTime() - HOUR));

      const first = await t.tick();
      expect(first.pruned).toBe(true);
      const left = (table: string) => t.rows<Row>(`SELECT * FROM ${table}`);
      expect((await left('reference_event_map')).map((r) => r.provider_event_id)).toEqual([
        'evt-fresh',
      ]);
      expect((await left('reference_book_prices')).map((r) => r.provider_event_id)).toEqual([
        'evt-fresh',
      ]);
      expect((await left('reference_consensus')).map((r) => r.event_id)).toEqual([fresh.eventId]);

      // Only once an hour; the next run takes what has since passed 24 hours.
      t.h.advance(30 * MINUTE);
      expect((await t.tick()).pruned).toBe(false);
      t.h.advance(24 * HOUR);
      expect((await t.tick()).pruned).toBe(true);
      expect(await left('reference_event_map')).toHaveLength(0);
      expect(await left('reference_book_prices')).toHaveLength(0);
      expect(await left('reference_consensus')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'the generic scheduler skips a TheRundown source',
    async () => {
      t = await createTrHarness();
      await withDay();
      const summary = await runDueSources(t.ctx, { random: () => 0 });
      expect(summary).toMatchObject({ due: 0, ran: 0, locked: 0 });
      expect(t.calls).toHaveLength(0);
      expect(
        await t.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = 'therundown'`),
      ).toBe(0);
      // The poller, on the other hand, runs it.
      await t.tick();
      expect(t.calls.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'archives and stores no TheRundown body: no raw snapshot, no file, no observation',
    async () => {
      t = await createTrHarness();
      await withDay();
      const summary = await t.tick();
      expect(summary.ok).toBeGreaterThan(0);
      expect(dayCalls().length).toBeGreaterThan(0);

      expect(await t.count(`SELECT count(*) AS n FROM scrape_raw`)).toBe(0);
      expect(await t.count(`SELECT count(*) AS n FROM scrape_observations`)).toBe(0);
      const archived = readdirSync(t.ctx.config.scraper.archiveDir, { recursive: true });
      expect(archived).toEqual([]);
      // The run is recorded for health, without a body.
      const [run] = await t.rows<{
        status: string;
        requests: number;
        bytes: number;
        records_seen: number;
      }>(
        `SELECT status, requests, bytes, records_seen FROM scrape_runs WHERE source_id = 'therundown'`,
      );
      expect(run).toMatchObject({ status: 'ok', requests: 2, records_seen: 1 });
      expect(AGREEING_BOOKS[3]).toBeDefined();
    },
    TEST_TIMEOUT,
  );
});
