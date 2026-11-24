import {
  lockEvent,
  openReviewItem,
  resolveReviewItem,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
  setTeamRatings,
  loadKickoffEvidence,
} from '@vamos/db';
import {
  assessKickoff,
  KICKOFF_EVIDENCE_WINDOW_MS,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
} from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfirmedEvents } from '../src/pipeline/auto-open';
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
  type HarnessOptions,
  type JsonEvent,
  type OfMatch,
} from './helpers';

/**
 * Rule F7b (docs/scraper.md 6.1): the scraper opens betting on a confirmed kickoff when the
 * competition has auto_open on and the event waits for a person. Through the real pipeline on a
 * real Postgres and Redis. Every "stays closed" test first proves the other conditions hold.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };
const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };
const DAY = 24 * HOUR;
const OPENED_TEXT =
  'betting opened automatically: auto open is on and the kickoff is confirmed (F7b)';

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

const MOVED_EARLIER: OfMatch = { ...ARSENAL_CHELSEA_OF, date: '2026-11-01', time: '20:00' };
const OLD_OF: OfMatch = {
  date: '2026-10-25',
  time: '15:00',
  team1: 'Liverpool FC',
  team2: 'Everton FC',
  score: { ht: [0, 0], ft: [1, 0] },
};
const OLD_JSON: JsonEvent = {
  id: 3,
  kick: '2026-10-25T15:00:00Z',
  h: 'Liverpool',
  a: 'Everton',
  st: 'FT',
  hs: '1',
  as: '0',
  hth: '0',
  hta: '0',
};
const EARLIER_JSON: JsonEvent = { ...ARSENAL_CHELSEA_JSON, kick: '2026-11-01T20:00:00Z' };
const PAST_OF: OfMatch = {
  date: '2026-10-17',
  time: '15:00',
  team1: 'Liverpool FC',
  team2: 'Everton FC',
  score: { ht: [0, 0], ft: [1, 0] },
};

async function start(options: HarnessOptions & { keepB?: boolean } = {}): Promise<void> {
  h = await createHarness(options);
  await h.ctx.db.transaction(async (tx) => {
    await setCompetitionPolicy(tx, h.premier, { autoOpen: true }, SYSTEM);
    if (options.keepB !== true) await setSourceEnabled(tx, 'src-b', false, SYSTEM);
  });
}

/** The source lists the sample fixture; one promotion pass creates the event. */
async function createdEvent(docA: OfMatch[] = [ARSENAL_CHELSEA_OF]): Promise<string> {
  h.serve(URL_A, ofDoc(docA));
  await h.run('src-a');
  await runPromotion(h.ctx);
  return (
    await rows<{ id: string }>(
      `SELECT id FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
      [h.team('Arsenal')],
    )
  )[0]!.id;
}

const eventRow = async (id: string) =>
  (
    await rows<{ betting_open: boolean; start_time: Date; status: string; feed_ref: string }>(
      `SELECT betting_open, start_time, status, feed_ref FROM events WHERE id = $1`,
      [id],
    )
  )[0]!;

/** What a trader does: opens betting on the event. */
async function openBetting(eventId: string): Promise<void> {
  await h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, true, STAFF));
}

/** Every row F7b must leave alone (events without the columns setEventBettingOpen moves). */
async function snapshot() {
  const json = async (query: string) => (await rows<{ r: unknown }>(query)).map((row) => row.r);
  return {
    events: await json(
      `SELECT to_jsonb(e) - 'betting_open' - 'state_changed_at' - 'updated_at' AS r FROM events e ORDER BY id`,
    ),
    markets: await json(`SELECT to_jsonb(m) AS r FROM markets m ORDER BY id`),
    selections: await json(`SELECT to_jsonb(s) AS r FROM selections s ORDER BY id`),
    bets: await json(`SELECT to_jsonb(b) AS r FROM bets b ORDER BY id`),
    betLegs: await json(`SELECT to_jsonb(l) AS r FROM bet_legs l ORDER BY id`),
  };
}

/** The assessment the API and the scraper make, at the harness clock. */
async function assessNow(eventId: string) {
  const evidence = (
    await loadKickoffEvidence(h.ctx.db, {
      eventIds: [eventId],
      now: h.now(),
      minMatchDurationMs: MIN_MATCH_DURATION_MS,
      staleAfterMs: SOURCE_STALE_AFTER_MS,
      evidenceWindowMs: KICKOFF_EVIDENCE_WINDOW_MS,
    })
  ).get(eventId)!;
  return assessKickoff({
    start: evidence.event.startTime,
    now: h.now(),
    statements: evidence.statements,
    person: evidence.person,
  });
}

const setRatings = (name: string, ratings: Record<string, number>) =>
  h.ctx.db.transaction((tx) => setTeamRatings(tx, h.team(name), ratings, SYSTEM));
const CHELSEA_OK = { attack: 1.2, defence: 0.9, matches: 10 };

const audits = (action: string) =>
  rows<{ target_id: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
const openItems = (subject: string, kind?: string) =>
  rows<{ id: string; kind: string; subject_key: string; payload: Record<string, unknown> }>(
    `SELECT id, kind, subject_key, payload FROM scrape_review_items
      WHERE status = 'open' AND subject_key = $1 AND ($2::text IS NULL OR kind = $2)`,
    [subject, kind ?? null],
  );
const oneXTwo = async (eventId: string): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await rows<{ code: string; odds_milli: number }>(
        `SELECT s.code, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = '1x2'`,
        [eventId],
      )
    ).map((r) => [r.code, r.odds_milli]),
  );

/** Event created closed (odds_approval open), then confirmed by C2 at KICKOFF - 71 h. */
async function confirmable(): Promise<{ eventId: string; feedRef: string }> {
  await start();
  const eventId = await createdEvent([OLD_OF, ARSENAL_CHELSEA_OF]);
  h.at(new Date(KICKOFF.getTime() - 71 * HOUR));
  await h.run('src-a');
  const feedRef = (await eventRow(eventId)).feed_ref;
  expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2' });
  expect((await eventRow(eventId)).betting_open).toBe(false);
  expect(await openItems(feedRef, 'odds_approval')).toHaveLength(1);
  return { eventId, feedRef };
}

const NONE = { checked: 0, opened: 0, failed: 0, published: 0, held: {} };

describe('F7b: automatic opening on a confirmed kickoff', () => {
  it(
    'F7b: production case: one fresh source and one never-fresh source open betting once the kickoff has held for 24 hours, far ahead too (owner, 22 Nov: no 72-hour lock)',
    async () => {
      await start({ keepB: true });
      h.at(new Date(KICKOFF.getTime() - 13 * DAY));
      h.serve(URL_A, ofDoc([PAST_OF, ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      const pass = async () => {
        await h.run('src-a');
        await h.run('src-b');
        await runPromotion(h.ctx);
      };
      await pass();
      const [event] = await rows<{ id: string; feed_ref: string; betting_open: boolean }>(
        `SELECT id, feed_ref, betting_open FROM events WHERE feed_provider = 'scraped'`,
      );
      const eventId = event!.id;
      const feedRef = event!.feed_ref;
      expect(event!.betting_open).toBe(false);
      const [item] = await openItems(feedRef, 'odds_approval');
      expect(item!.payload).toMatchObject({ reason: 'kickoff_unconfirmed' });

      // 23 hours after the source first showed the kickoff: not stable yet.
      h.at(new Date(KICKOFF.getTime() - 13 * DAY + 23 * HOUR));
      await pass();
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect(await assessNow(eventId)).toMatchObject({ confirmed: false, reasons: ['not_stable'] });

      // Held for 24 hours, 12 days before the match: C2 confirms it (the window is 30 days now).
      h.at(new Date(KICKOFF.getTime() - 13 * DAY + 25 * HOUR));
      await h.run('src-a');
      await h.run('src-b');
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2' });
      const before = await snapshot();
      await runPromotion(h.ctx);
      expect((await eventRow(eventId)).betting_open).toBe(true);

      const opened = await audits('scrape.fixture.betting_opened');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ target_id: eventId, actor_id: 'system:scraper' });
      expect(opened[0]!.metadata).toMatchObject({
        rule: 'F7b',
        feedRef,
        start: KICKOFF.toISOString(),
        basis: 'C2',
        afterK1: false,
      });
      expect(opened[0]!.metadata.evidenceKey).toMatch(/^[0-9a-f]{64}$/);
      expect(await audits('catalog.event.betting_opened')).toHaveLength(0);
      const [resolved] = await rows<{ status: string; resolved_by: string; resolution: string }>(
        `SELECT status, resolved_by, resolution FROM scrape_review_items WHERE id = $1`,
        [item!.id],
      );
      expect(resolved).toEqual({
        status: 'resolved',
        resolved_by: 'system:scraper',
        resolution: OPENED_TEXT,
      });
      expect(await snapshot()).toEqual(before);

      h.advance(10 * MINUTE);
      await runPromotion(h.ctx);
      expect(await audits('scrape.fixture.betting_opened')).toHaveLength(1);
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b: the summary counts checked, opened and published; a second pass finds nothing',
    async () => {
      await start();
      const eventId = await createdEvent([OLD_OF, ARSENAL_CHELSEA_OF]);
      expect(await openConfirmedEvents(h.ctx)).toEqual({
        checked: 1,
        opened: 0,
        failed: 0,
        published: 0,
        held: { 'kickoff:not_stable': 1 },
      });
      h.at(new Date(KICKOFF.getTime() - 71 * HOUR));
      await h.run('src-a');
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2' });
      // One event-level live message (the match delta) per opened event.
      expect(await openConfirmedEvents(h.ctx)).toEqual({
        checked: 1,
        opened: 1,
        failed: 0,
        published: 1,
        held: {},
      });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
    },
    TEST_TIMEOUT,
  );
});

describe('F7b: the competition policy', () => {
  it(
    'F7b: auto_open off or the competition disabled keeps it closed; both on opens',
    async () => {
      const { eventId } = await confirmable();
      const policy = (p: { enabled?: boolean; autoOpen?: boolean }) =>
        h.ctx.db.transaction((tx) => setCompetitionPolicy(tx, h.premier, p, SYSTEM));
      await policy({ autoOpen: false });
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
      expect((await eventRow(eventId)).betting_open).toBe(false);

      await policy({ enabled: false, autoOpen: true });
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
      expect((await eventRow(eventId)).betting_open).toBe(false);

      await policy({ enabled: true, autoOpen: true });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('F7b: a person decides', () => {
  it(
    'F7b: a trader who opened and closed betting keeps it closed',
    async () => {
      const { eventId, feedRef } = await confirmable();
      await openBetting(eventId);
      await h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, false, STAFF));
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true });
      // Trading's open/close does not resolve the item (the review queue's open_betting does), so
      // it still waits and only the latest audit (the trader's close) stops the opening.
      expect(await openItems(feedRef, 'odds_approval')).toHaveLength(1);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({
        checked: 1,
        opened: 0,
        failed: 0,
        held: { person_decided: 1 },
      });
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect(await audits('scrape.fixture.betting_opened')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b: a dismissed odds_approval item keeps it closed (not a candidate)',
    async () => {
      const { eventId, feedRef } = await confirmable();
      const [item] = await openItems(feedRef, 'odds_approval');
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, item!.id, {
          status: 'dismissed',
          resolution: 'not wanted',
          actor: STAFF,
        }),
      );
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true });
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
      expect((await eventRow(eventId)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('F7b: the gates', () => {
  it(
    'F7b/O1: a team with too few matches keeps it closed until it is calibrated again',
    async () => {
      const { eventId, feedRef } = await confirmable();
      await setRatings('Chelsea', { attack: 1.2, defence: 0.9, matches: 2 });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({
        checked: 1,
        opened: 0,
        failed: 0,
        held: { uncalibrated: 1 },
      });
      expect(await openItems(feedRef, 'odds_approval')).toHaveLength(1);
      expect((await eventRow(eventId)).betting_open).toBe(false);

      await setRatings('Chelsea', CHELSEA_OK);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b/O1: manual ratings count as calibrated',
    async () => {
      const { eventId } = await confirmable();
      await setRatings('Chelsea', { attack: 1.2, defence: 0.9, matches: 2 });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 0 });
      await setRatings('Chelsea', { attack: 1.2, defence: 0.9, matches: 2, manual: 1 });
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b/O2: prices that fail the market checks keep it closed until restored',
    async () => {
      const { eventId } = await confirmable();
      const originals = await rows<{ id: string; odds_milli: number }>(
        `SELECT s.id, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = '1x2'`,
        [eventId],
      );
      expect(originals).toHaveLength(3);
      await h.pool.query(`UPDATE selections SET odds_milli = 5000 WHERE id = ANY($1::uuid[])`, [
        originals.map((r) => r.id),
      ]);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({
        checked: 1,
        opened: 0,
        failed: 0,
        held: { price_checks: 1 },
      });
      expect((await eventRow(eventId)).betting_open).toBe(false);
      for (const row of originals) {
        await h.pool.query(`UPDATE selections SET odds_milli = $2 WHERE id = $1`, [
          row.id,
          row.odds_milli,
        ]);
      }
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b/F4: an open kickoff_change item for the event keeps it closed until resolved',
    async () => {
      const { eventId, feedRef } = await confirmable();
      const { item } = await h.ctx.db.transaction((tx) =>
        openReviewItem(tx, {
          kind: 'kickoff_change',
          subjectKey: feedRef,
          severity: 'warning',
          title: 'sources disagree',
          payload: { rules: ['F4'] },
          now: h.now(),
        }),
      );
      expect(await openItems(feedRef, 'odds_approval')).toHaveLength(1);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({
        checked: 1,
        opened: 0,
        failed: 0,
        held: { kickoff_question: 1 },
      });
      expect((await eventRow(eventId)).betting_open).toBe(false);
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, item.id, { status: 'resolved', resolution: 'checked', actor: STAFF }),
      );
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b/O3: a re-price held for a person keeps it closed; once dismissed it opens with the old prices',
    async () => {
      const { eventId, feedRef } = await confirmable();
      const oldPrices = await oneXTwo(eventId);
      await setRatings('Arsenal', { attack: 2.4, defence: 0.9, matches: 11 });
      expect(await repriceScheduledEvents(h.ctx)).toMatchObject({ held: 1 });
      const [hold] = await openItems(`${feedRef}|reprice`, 'odds_approval');
      expect(hold).toBeDefined();
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true });
      expect(await openItems(feedRef, 'odds_approval')).toHaveLength(1);
      expect(await oneXTwo(eventId)).toEqual(oldPrices);

      expect(await openConfirmedEvents(h.ctx)).toMatchObject({
        checked: 1,
        opened: 0,
        failed: 0,
        held: { reprice_held: 1 },
      });
      expect((await eventRow(eventId)).betting_open).toBe(false);

      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, hold!.id, {
          status: 'dismissed',
          resolution: 'keep the old prices',
          actor: STAFF,
        }),
      );
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 1, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      expect(await oneXTwo(eventId)).toEqual(oldPrices);
    },
    TEST_TIMEOUT,
  );
});

describe('F7b: after K1', () => {
  /** K1 closes an open event on an earlier report; the report then goes away. */
  async function closedByK1(): Promise<{ eventId: string; feedRef: string }> {
    await start();
    const eventId = await createdEvent([OLD_OF, ARSENAL_CHELSEA_OF]);
    const feedRef = (await eventRow(eventId)).feed_ref;
    await openBetting(eventId);

    h.advance(HOUR);
    h.serve(URL_A, ofDoc([OLD_OF, MOVED_EARLIER]));
    await h.run('src-a');
    await runPromotion(h.ctx);
    expect((await eventRow(eventId)).betting_open).toBe(false);
    expect(await audits('scrape.fixture.betting_closed')).toHaveLength(1);
    expect(await openItems(`${feedRef}|earlier`, 'kickoff_change')).toHaveLength(1);

    h.advance(HOUR);
    h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
    await h.run('src-a');
    await runPromotion(h.ctx);
    expect((await eventRow(eventId)).betting_open).toBe(false);
    return { eventId, feedRef };
  }

  it(
    'F7b/K1: on a source keyed by match id (like football-data.org), betting reopens once the earlier report is gone and the kickoff has been stable for 24 hours again (C2)',
    async () => {
      await start({ keepB: true });
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-a', false, SYSTEM));
      const passB = async (events: JsonEvent[]) => {
        h.serve(URL_B, jsonDoc(events));
        await h.run('src-b');
        await runPromotion(h.ctx);
      };
      await passB([OLD_JSON, ARSENAL_CHELSEA_JSON]);
      const [event] = await rows<{ id: string; feed_ref: string }>(
        `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped'`,
      );
      const eventId = event!.id;
      const feedRef = event!.feed_ref;
      await openBetting(eventId);

      h.at(new Date(KICKOFF.getTime() - 75 * HOUR));
      await passB([OLD_JSON, EARLIER_JSON]);
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect(await audits('scrape.fixture.betting_closed')).toHaveLength(1);
      expect(await openItems(`${feedRef}|earlier`, 'kickoff_change')).toHaveLength(1);

      // The source goes back to the original time: the same row, so its value changed just now.
      h.at(new Date(KICKOFF.getTime() - 70 * HOUR));
      await passB([OLD_JSON, ARSENAL_CHELSEA_JSON]);
      expect((await eventRow(eventId)).betting_open).toBe(false);

      // 10 hours after the change: within 72 hours, but not stable for 24 hours yet.
      h.at(new Date(KICKOFF.getTime() - 60 * HOUR));
      await passB([OLD_JSON, ARSENAL_CHELSEA_JSON]);
      const assessment = await assessNow(eventId);
      expect(assessment.confirmed).toBe(false);
      expect(assessment.reasons).toContain('not_stable');
      expect((await eventRow(eventId)).betting_open).toBe(false);

      // 25 hours after the change.
      h.at(new Date(KICKOFF.getTime() - 45 * HOUR));
      h.serve(URL_B, jsonDoc([OLD_JSON, ARSENAL_CHELSEA_JSON]));
      await h.run('src-b');
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2' });
      await runPromotion(h.ctx);
      expect((await eventRow(eventId)).betting_open).toBe(true);
      const opened = await audits('scrape.fixture.betting_opened');
      expect(opened).toHaveLength(1);
      expect(opened[0]!.metadata).toMatchObject({ rule: 'F7b', afterK1: true, basis: 'C2' });
      expect(await openItems(feedRef)).toHaveLength(0);
      expect(await openItems(`${feedRef}|earlier`)).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b/K1/F4d: on a source keyed by date (openfootball) an earlier report closes betting (K1) and moves the event there (F4d); when the source goes back, a later move waits for a person and betting stays closed',
    async () => {
      const { eventId, feedRef } = await closedByK1();
      // K1 closed betting first, then F4d moved the event to the earliest fresh kickoff.
      expect((await eventRow(eventId)).start_time).toEqual(new Date('2026-11-01T20:00:00Z'));
      expect(await audits('scrape.fixture.kickoff_moved')).toHaveLength(1);
      h.at(new Date(KICKOFF.getTime() - 48 * HOUR));
      await h.run('src-a');
      // The source gives 2 Nov 15:00 again: later than the start, so nothing agrees with it.
      expect(await assessNow(eventId)).toMatchObject({ confirmed: false });
      await runPromotion(h.ctx);
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect((await eventRow(eventId)).start_time).toEqual(new Date('2026-11-01T20:00:00Z'));
      // F4c's question (the old row and the new one) stays with a person: a later move is not F4d's.
      expect(await openItems(feedRef, 'kickoff_change')).toHaveLength(1);
      expect(await openItems(`${feedRef}|earlier`, 'kickoff_change')).toHaveLength(1);
      expect(await audits('scrape.fixture.betting_opened')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('F7b: locks and candidates', () => {
  it(
    'F7b: locks the event before the review items: a trader opening betting concurrently wins without a deadlock',
    async () => {
      const { eventId, feedRef } = await confirmable();
      const [item] = await openItems(feedRef, 'odds_approval');

      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (locked = resolve));
      // The API's open_betting order: the event lock, then the betting change, then the item.
      const trader = h.ctx.db.transaction(async (tx) => {
        await lockEvent(tx, eventId);
        locked();
        await gate;
        await setEventBettingOpen(tx, eventId, true, STAFF);
        await resolveReviewItem(tx, item!.id, {
          status: 'resolved',
          resolution: '{"decision":"open_betting"}',
          actor: STAFF,
        });
      });
      await holding;
      const pass = openConfirmedEvents(h.ctx);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        waiting =
          (await h.count(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
          )) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      release();
      await trader;
      expect(await pass).toMatchObject({ checked: 1, opened: 0, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      expect(await audits('scrape.fixture.betting_opened')).toHaveLength(0);
      expect(await audits('catalog.event.betting_opened')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'F7b: resulted and started events are not candidates',
    async () => {
      const { eventId } = await confirmable();
      await h.pool.query(
        `UPDATE events SET resulted_at = $2, score_home = 1, score_away = 0 WHERE id = $1`,
        [eventId, h.now()],
      );
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
      await h.pool.query(
        `UPDATE events SET resulted_at = NULL, score_home = NULL, score_away = NULL, start_time = $2 WHERE id = $1`,
        [eventId, new Date(h.now().getTime() - HOUR)],
      );
      expect(await openConfirmedEvents(h.ctx)).toEqual(NONE);
      expect((await eventRow(eventId)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
