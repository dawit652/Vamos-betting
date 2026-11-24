import { randomUUID } from 'node:crypto';
import { parseReviewPayload } from '@vamos/contracts';
import {
  loadKickoffEvidence,
  lockEvent,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
} from '@vamos/db';
import { betLegs, bets, users } from '@vamos/db/schema';
import {
  assessKickoff,
  KICKOFF_EVIDENCE_WINDOW_MS,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
} from '@vamos/scraper';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { closeBettingOnEarlierKickoff } from '../src/pipeline/kickoff-safety';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  jsonDoc,
  KICKOFF,
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
 * Kickoff safety, rules K1 to K6 (docs/scraper.md 6.1a, docs/scraper-plan/kickoff-safety.md 7.3), through
 * the real pipeline on a real Postgres: openfootball source `src-a`, policy enabled with `auto_open`
 * on, calibrated teams. The time is the harness clock; person confirmations are written with
 * an explicit time on that clock (the audit table is append-only and its own time is the wall clock).
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };
const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

const MOVED_EARLIER: OfMatch = { ...ARSENAL_CHELSEA_OF, date: '2026-11-01', time: '20:00' };
const EARLIER_START = new Date('2026-11-01T20:00:00Z');
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
    await rows<{ betting_open: boolean; start_time: Date; status: string }>(
      `SELECT betting_open, start_time, status FROM events WHERE id = $1`,
      [id],
    )
  )[0]!;

/** A person's confirmation as the API writes it, but with the audit time on the harness clock. */
async function confirmKickoff(eventId: string, startTime: Date, at: Date = h.now()): Promise<void> {
  await h.pool.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata, created_at)
     VALUES ('admin', $1, 'scrape.fixture.kickoff_confirmed', 'event', $2, $3::jsonb, $4)`,
    [
      STAFF.adminId,
      eventId,
      JSON.stringify({
        startTime: startTime.toISOString(),
        evidenceKey: 'a'.repeat(64),
        via: 'trading',
        itemId: null,
      }),
      at,
    ],
  );
}

/** What a trader does after the confirmation: opens betting on the event. */
async function openBetting(eventId: string): Promise<void> {
  await h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, true, STAFF));
}

/** A person confirms the start and opens betting. */
async function openByPerson(eventId: string): Promise<void> {
  const { start_time } = await eventRow(eventId);
  await confirmKickoff(eventId, new Date(start_time));
  await openBetting(eventId);
}

async function placeBet(eventId: string): Promise<string> {
  const [selection] = await rows<{ id: string; market_id: string; odds_milli: number }>(
    `SELECT s.id, s.market_id, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
      WHERE m.event_id = $1 AND m.key = '1x2' AND s.code = '1'`,
    [eventId],
  );
  const [user] = await h.ctx.db
    .insert(users)
    .values({
      phone: '+251911000098',
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
      shortId: 'KIK001',
      betType: 'single',
      stake: 10_000n,
      totalOddsMilli: BigInt(selection!.odds_milli),
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
    oddsMilli: selection!.odds_milli,
    requestedOddsMilli: selection!.odds_milli,
    isLive: false,
  });
  return bet!.id;
}

/** Every row K1 must leave alone (events without the three columns setEventBettingOpen moves). */
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

const closedAudits = () =>
  rows<{ target_id: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = 'scrape.fixture.betting_closed'`,
  );
const earlierItems = () =>
  rows<{
    kind: string;
    subject_key: string;
    severity: string;
    status: string;
    title: string;
    payload: Record<string, unknown>;
    updated_at: Date;
  }>(`SELECT * FROM scrape_review_items WHERE subject_key LIKE '%|earlier' ORDER BY created_at`);

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

describe('K2 at creation (F7)', () => {
  it(
    'K2: one source that is not known to be fresh creates the event closed, with kickoff_unconfirmed',
    async () => {
      await start();
      const eventId = await createdEvent();
      expect((await eventRow(eventId)).betting_open).toBe(false);
      const [item] = await rows<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM scrape_review_items WHERE status = 'open'`,
      );
      expect(item!.kind).toBe('odds_approval');
      expect(item!.payload).toMatchObject({
        rules: ['F7'],
        reasons: ['kickoff_unconfirmed'],
        reason: 'kickoff_unconfirmed',
        autoOpen: true,
        calibrated: true,
        kickoffConfirmed: false,
      });
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.created'`,
      );
      expect(audit!.metadata).toMatchObject({
        bettingOpen: false,
        kickoffConfirmed: false,
        kickoffBasis: null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'K2/C1: two fresh sources of two upstreams agree: auto_open opens at creation, and K1 still closes when one moves earlier',
    async () => {
      await start({ keepB: true });
      // Both sources have a listed match that ended long ago (so their freshness is known).
      h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([OLD_JSON, ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      await runPromotion(h.ctx);
      const [event] = await rows<{ id: string; betting_open: boolean }>(
        `SELECT id, betting_open FROM events WHERE feed_provider = 'scraped'`,
      );
      expect(event!.betting_open).toBe(true);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.created'`,
      );
      expect(audit!.metadata).toMatchObject({
        bettingOpen: true,
        kickoffConfirmed: true,
        kickoffBasis: 'C1',
      });
      expect(await assessNow(event!.id)).toMatchObject({ confirmed: true, basis: 'C1' });

      // K1 runs whatever the basis: the second source now says the match starts 5 hours earlier.
      h.advance(HOUR);
      h.serve(
        URL_B,
        jsonDoc([OLD_JSON, { ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T10:00:00Z' }]),
      );
      await h.run('src-a');
      await h.run('src-b');
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 1, closed: 1 });
      expect((await eventRow(event!.id)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('K1: an earlier kickoff closes betting', () => {
  it(
    'K1/K3: closes only betting_open, audits it, opens a critical item the contract parses; rows are unchanged; a bet stands',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      const betId = await placeBet(eventId);
      expect((await eventRow(eventId)).betting_open).toBe(true);
      // The pass finds nothing while the source agrees (and the closure is not triggered by the person's record).
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 1, closed: 0 });

      h.advance(HOUR);
      h.serve(URL_A, ofDoc([MOVED_EARLIER]));
      await h.run('src-a');
      const before = await snapshot();
      const [betBefore] = await rows(`SELECT * FROM bets WHERE id = $1`, [betId]);

      expect(await runPromotion(h.ctx)).toBe(true);

      const after = await rows<{ betting_open: boolean; start_time: Date; status: string }>(
        `SELECT betting_open, start_time, status FROM events WHERE id = $1`,
        [eventId],
      );
      expect(after[0]).toMatchObject({ betting_open: false, status: 'scheduled' });
      expect(new Date(after[0]!.start_time)).toEqual(KICKOFF);
      // Nothing but the betting switch moved.
      expect(await snapshot()).toEqual(before);
      expect((await rows(`SELECT * FROM bets WHERE id = $1`, [betId]))[0]).toEqual(betBefore);
      expect(await h.count(`SELECT count(*) AS n FROM markets WHERE status <> 'open'`)).toBe(0);

      const audits = await closedAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ target_id: eventId, actor_id: 'system:scraper' });
      expect(audits[0]!.metadata).toMatchObject({
        rule: 'K1',
        start: KICKOFF.toISOString(),
        earlier: [
          {
            sourceId: 'src-a',
            upstream: 'openfootball',
            kickoff: EARLIER_START.toISOString(),
            changedAt: h.now().toISOString(),
          },
        ],
      });
      expect(audits[0]!.metadata.evidenceKey).toMatch(/^[0-9a-f]{64}$/);
      expect(audits[0]!.metadata.feedRef).toMatch(/^fx\|/);

      const items = await earlierItems();
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item).toMatchObject({
        kind: 'kickoff_change',
        severity: 'critical',
        status: 'open',
        subject_key: `${audits[0]!.metadata.feedRef as string}|earlier`,
      });
      expect(item.title).toBe(
        'Betting closed: Arsenal v Chelsea may start earlier: src-a says 2026-11-01 20:00 UTC (ours 2026-11-02 15:00 UTC)',
      );
      expect(parseReviewPayload('kickoff_change', item.payload)).toEqual({
        eventId,
        currentKickoff: KICKOFF.toISOString(),
        proposedKickoff: EARLIER_START.toISOString(),
        sources: [
          { sourceId: 'src-a', upstream: 'openfootball', changedAt: h.now().toISOString() },
        ],
        hasBets: true,
      });
      expect(item.payload).toMatchObject({
        rule: 'K1',
        reason: 'earlier_kickoff',
        evidenceKey: audits[0]!.metadata.evidenceKey,
        bettingClosedAt: h.now().toISOString(),
        exposure: { openBets: 1, totalStake: '10000' },
        statements: [
          {
            sourceId: 'src-a',
            kind: 'fixture',
            status: 'scheduled',
            kickoff: EARLIER_START.toISOString(),
          },
        ],
      });

      // K3: the F4 item (a separate subject) is the gate's; nothing opens betting by itself.
      h.advance(HOUR);
      await runPromotion(h.ctx);
      expect((await eventRow(eventId)).betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'K6: a second pass with the same data changes nothing: no audit, the item is not refreshed',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([MOVED_EARLIER]));
      await h.run('src-a');
      await runPromotion(h.ctx);
      expect(await closedAudits()).toHaveLength(1);
      const [first] = await earlierItems();
      const state = () =>
        rows(`SELECT betting_open, state_changed_at, updated_at FROM events WHERE id = $1`, [
          eventId,
        ]);
      const eventBefore = await state();

      h.advance(10 * 60_000);
      await h.run('src-a');
      const summary = await closeBettingOnEarlierKickoff(h.ctx);
      expect(summary).toEqual({ checked: 0, closed: 0, failed: 0, published: 0 });
      await runPromotion(h.ctx);
      expect(await closedAudits()).toHaveLength(1);
      const [second] = await earlierItems();
      expect(second!.updated_at).toEqual(first!.updated_at);
      expect(await state()).toEqual(eventBefore);
    },
    TEST_TIMEOUT,
  );

  it(
    'K1: a person who confirmed the start after the report keeps betting open; a newer report closes it again',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([MOVED_EARLIER]));
      await h.run('src-a');
      await runPromotion(h.ctx);
      expect((await eventRow(eventId)).betting_open).toBe(false);

      // The trader checks the official site: our time is right. Confirms the start, opens betting.
      h.advance(HOUR);
      await confirmKickoff(eventId, KICKOFF);
      await openBetting(eventId);
      h.advance(10 * 60_000);
      await h.run('src-a');
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 1, closed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      expect(await closedAudits()).toHaveLength(1);

      // The source moves to yet another earlier time: that report is new, nobody looked at it.
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, date: '2026-11-01', time: '12:00' }]));
      await h.run('src-a');
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 1, closed: 1 });
      expect((await eventRow(eventId)).betting_open).toBe(false);
      expect(await closedAudits()).toHaveLength(2);
      // One item per subject: refreshed with the newest report.
      const items = await earlierItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.payload).toMatchObject({ proposedKickoff: '2026-11-01T12:00:00.000Z' });
    },
    TEST_TIMEOUT,
  );

  it(
    'K1 re-reads under the row lock: a confirmation committed while the pass waits for the lock stops the closure',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([MOVED_EARLIER]));
      await h.run('src-a');

      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (locked = resolve));
      // A trader holds the event lock, writes the confirmation and commits only when released.
      const trader = h.ctx.db.transaction(async (tx) => {
        await lockEvent(tx, eventId);
        await tx.execute(sql`
          INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata, created_at)
          VALUES ('admin', ${STAFF.adminId}, 'scrape.fixture.kickoff_confirmed', 'event', ${eventId},
            ${JSON.stringify({ startTime: KICKOFF.toISOString(), evidenceKey: 'b'.repeat(64) })}::jsonb,
            ${new Date(h.now().getTime() + 60_000).toISOString()}::timestamptz)`);
        locked();
        await gate;
      });
      await holding;
      const pass = closeBettingOnEarlierKickoff(h.ctx);
      // The pass has looked at the committed data (no confirmation yet) and now waits for the lock.
      for (let i = 0; i < 100; i += 1) {
        if (
          (await h.count(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
          )) > 0
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await trader;
      expect(await pass).toMatchObject({ checked: 1, closed: 0, failed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      expect(await closedAudits()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'K1: a trader who closed betting first makes the pass a no-op; started and resulted events are never touched',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([MOVED_EARLIER]));
      await h.run('src-a');
      await h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, false, STAFF));
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 0, closed: 0 });
      expect(await closedAudits()).toHaveLength(0);

      // Open again, but the event has started: prematch betting closes by itself, K1 leaves it.
      await openBetting(eventId);
      await h.pool.query(`UPDATE events SET start_time = $2 WHERE id = $1`, [
        eventId,
        new Date(h.now().getTime() - HOUR),
      ]);
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 0, closed: 0 });
      // Resulted (scored): not a candidate either.
      await h.pool.query(
        `UPDATE events SET start_time = $2, resulted_at = $3, score_home = 1, score_away = 0 WHERE id = $1`,
        [eventId, KICKOFF, h.now()],
      );
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 0, closed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'K5: a postponed report, even for an earlier time, never closes betting (it only dissents)',
    async () => {
      await start({ keepB: true });
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(
        URL_B,
        jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T10:00:00Z', st: 'PST' }]),
      );
      await h.run('src-b');
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ checked: 1, closed: 0 });
      expect((await eventRow(eventId)).betting_open).toBe(true);
      // It only dissents: the kickoff is no longer confirmed (K5), nothing else happens.
      const assessment = await assessNow(eventId);
      expect(assessment).toMatchObject({ confirmed: false, earlier: [] });
      expect(assessment.reasons).toContain('void_status_reported');
      expect(await closedAudits()).toHaveLength(0);
      // No status change, nothing voided.
      expect((await eventRow(eventId)).status).toBe('scheduled');
    },
    TEST_TIMEOUT,
  );

  it(
    'K1: an error on one event (an unusable start) is logged and the pass goes on with the next',
    async () => {
      await start();
      const first = await createdEvent([ARSENAL_CHELSEA_OF]);
      await openByPerson(first);
      // A second fixture, Liverpool v Everton, whose event is opened by hand.
      const second: OfMatch = {
        date: '2026-11-03',
        time: '15:00',
        team1: 'Liverpool FC',
        team2: 'Everton FC',
      };
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF, second]));
      await h.run('src-a');
      await runPromotion(h.ctx);
      const [other] = await rows<{ id: string }>(
        `SELECT id FROM events WHERE feed_provider = 'scraped' AND id <> $1`,
        [first],
      );
      await openByPerson(other!.id);
      // The first event gets an unrepresentable start (RangeError in the rules); the second a report.
      await h.pool.query(`UPDATE events SET start_time = 'infinity' WHERE id = $1`, [first]);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF, { ...second, date: '2026-11-02', time: '20:00' }]));
      await h.run('src-a');
      const summary = await closeBettingOnEarlierKickoff(h.ctx);
      expect(summary).toMatchObject({ checked: 2, closed: 1, failed: 1 });
      expect((await eventRow(other!.id)).betting_open).toBe(false);
      expect((await eventRow(first)).betting_open).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('K2/K4 through the pipeline', () => {
  it(
    'C2: a fresh source unchanged for 24 hours confirms the kickoff, also more than 72 hours ahead (owner, 22 Nov 2026: the window is 30 days)',
    async () => {
      await start();
      // A source that has shown a past result is known; nothing waits on it: fresh.
      const eventId = await createdEvent([OLD_OF, ARSENAL_CHELSEA_OF]);
      // 73 hours before kickoff: no longer too early for a single source.
      h.at(new Date(KICKOFF.getTime() - 73 * HOUR));
      await h.run('src-a');
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2', reasons: [] });
      // 71 hours before kickoff, the statement has been unchanged for more than a day.
      h.at(new Date(KICKOFF.getTime() - 71 * HOUR));
      await h.run('src-a');
      expect(await assessNow(eventId)).toMatchObject({ confirmed: true, basis: 'C2', reasons: [] });
    },
    TEST_TIMEOUT,
  );

  it(
    'C2: a frozen source (a listed fixture ended 48 hours ago and nothing changed since) is not fresh',
    async () => {
      await start();
      // A fixture that ends shortly after the source's last change and stays "scheduled" in the file.
      const stuck: OfMatch = {
        date: '2026-10-29',
        time: '14:00',
        team1: 'Liverpool FC',
        team2: 'Everton FC',
      };
      const eventId = await createdEvent([stuck, ARSENAL_CHELSEA_OF]);
      h.at(new Date(KICKOFF.getTime() - 40 * HOUR));
      await h.run('src-a');
      expect(await assessNow(eventId)).toMatchObject({
        confirmed: false,
        basis: null,
        reasons: ['source_not_fresh'],
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'K4/F4b: one source moving the kickoff later while betting is open moves nothing; a betting_open item asks a person',
    async () => {
      await start();
      const eventId = await createdEvent();
      await openByPerson(eventId);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time: '16:00' }]));
      await h.run('src-a');
      await runPromotion(h.ctx);
      const state = await eventRow(eventId);
      expect(state.betting_open).toBe(true);
      expect(new Date(state.start_time)).toEqual(KICKOFF);
      const [item] = await rows<{ severity: string; payload: Record<string, unknown> }>(
        `SELECT severity, payload FROM scrape_review_items
          WHERE kind = 'kickoff_change' AND status = 'open' AND subject_key NOT LIKE '%|earlier'`,
      );
      expect(item!.severity).toBe('warning');
      expect(item!.payload).toMatchObject({ rules: ['F4'], reasons: ['betting_open'] });
      // A later report is not an earlier kickoff: K1 stays silent.
      expect(await earlierItems()).toHaveLength(0);
      expect(await closedAudits()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});
