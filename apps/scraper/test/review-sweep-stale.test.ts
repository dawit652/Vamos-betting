import { SCRAPER_ACTOR, type ScrapeReviewKind } from '@vamos/core';
import { openReviewItem, setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_DAY_PAST_MS,
  fixtureDayEnd,
  matchItemReason,
  NAME_NOT_SEEN_MS,
  sweepStaleReviewItems,
} from '../src/pipeline/review-sweep-stale';
import { runPromotion } from '../src/tasks/promote';
import { randomUUID } from 'node:crypto';
import { betLegs, bets, users } from '@vamos/db/schema';
import {
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  KICKOFF,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  type Harness,
} from './helpers';

/**
 * Rule Q2 (docs/scraper.md): items about sources that no longer run, and names nobody has seen for
 * a week, are closed by the scraper; nothing else is. On a real Postgres and Redis.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
  // The pure tests below make no harness: never close the previous one twice.
  h = undefined as unknown as Harness;
}, SETUP_TIMEOUT);

const DAY = 24 * HOUR;

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

const open = (kind: ScrapeReviewKind, subjectKey: string, at: Date = h.now()) =>
  h.ctx.db.transaction((tx) =>
    openReviewItem(tx, {
      kind,
      subjectKey,
      severity: kind.startsWith('unknown') ? 'info' : 'warning',
      title: 'test item',
      payload: {},
      now: at,
    }),
  );

type ItemRow = {
  id: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
};
const items = (kind: string, subject: string) =>
  rows<ItemRow>(
    `SELECT id, status, resolution, resolved_by FROM scrape_review_items
      WHERE kind = $1 AND subject_key = $2 ORDER BY created_at, id`,
    [kind, subject],
  );
const statuses = async (kind: string, subject: string) =>
  (await items(kind, subject)).map((item) => item.status);
const audits = () =>
  rows<{ target_id: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = 'scrape.review.swept' ORDER BY id`,
  );

async function expectSwept(kind: string, subject: string, reason: string): Promise<void> {
  const found = await items(kind, subject);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    status: 'resolved',
    resolution: `auto: ${reason}`,
    resolved_by: SCRAPER_ACTOR,
  });
}

describe('Q2: stale review items', () => {
  it(
    'Q2a: closes source_broken and source_stale of a disabled or missing source, keeps an enabled source and other subjects',
    async () => {
      h = await createHarness();
      // src-a is enabled by the harness; src-b is disabled below.
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
      await open('source_broken', 'source|src-b');
      await open('source_stale', 'source|src-b');
      await open('source_broken', 'source|ghost');
      await open('source_broken', 'source|src-a');
      await open('source_stale', 'source|src-a');
      // Not a source subject: a credit alarm, and a kind Q2 does not look at.
      await open('source_broken', 'odds_out_of_line|abc');
      await open('kickoff_change', 'source|src-b');

      // checked: the two dead source subjects, and the kickoff item Q2c looks at (and keeps).
      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 3, closed: 3, failed: 0 });
      await expectSwept('source_broken', 'source|src-b', 'source_disabled');
      await expectSwept('source_stale', 'source|src-b', 'source_disabled');
      await expectSwept('source_broken', 'source|ghost', 'source_disabled');
      expect(await statuses('source_broken', 'source|src-a')).toEqual(['open']);
      expect(await statuses('source_stale', 'source|src-a')).toEqual(['open']);
      expect(await statuses('source_broken', 'odds_out_of_line|abc')).toEqual(['open']);
      expect(await statuses('kickoff_change', 'source|src-b')).toEqual(['open']);

      const swept = await audits();
      expect(swept).toHaveLength(3);
      for (const row of swept) {
        expect(row.actor_id).toBe(SCRAPER_ACTOR);
        expect(row.metadata).toMatchObject({ rule: 'Q2', reason: 'source_disabled' });
      }
      expect(swept.map((row) => row.metadata.subjectKey).sort()).toEqual([
        'source|ghost',
        'source|src-b',
        'source|src-b',
      ]);

      // Idempotent (the kept kickoff item is looked at again, and kept).
      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 1, closed: 0, failed: 0 });
      expect(await audits()).toHaveLength(3);
    },
    TEST_TIMEOUT,
  );

  it(
    'Q2a: a source that is switched on again keeps its item (the condition is read when it runs)',
    async () => {
      h = await createHarness();
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
      await open('source_broken', 'source|src-b');
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', true, { system: 'test' }));
      expect(await sweepStaleReviewItems(h.ctx)).toMatchObject({ closed: 0 });
      expect(await statuses('source_broken', 'source|src-b')).toEqual(['open']);
    },
    TEST_TIMEOUT,
  );

  it(
    'Q2b: closes a name not seen for 7 days and keeps one seen 6 days ago; other kinds are never touched',
    async () => {
      h = await createHarness();
      const now = h.now();
      expect(NAME_NOT_SEEN_MS).toBe(7 * DAY);
      await open('unknown_team', 'team|old', new Date(now.getTime() - 8 * DAY));
      await open('unknown_competition', 'competition|old', new Date(now.getTime() - 7 * DAY - 1));
      await open('unknown_team', 'team|recent', new Date(now.getTime() - 6 * DAY));
      await open('unknown_team', 'team|edge', new Date(now.getTime() - 7 * DAY));
      // Old, but another kind.
      await open('fixture_missing', 'fx|old', new Date(now.getTime() - 30 * DAY));
      await open('source_broken', 'odds_out_of_line|old', new Date(now.getTime() - 30 * DAY));

      // checked: the two old names, and the missing fixture Q2c looks at (no match, no date: kept).
      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 3, closed: 2, failed: 0 });
      await expectSwept('unknown_team', 'team|old', 'name_not_seen');
      await expectSwept('unknown_competition', 'competition|old', 'name_not_seen');
      expect(await statuses('unknown_team', 'team|recent')).toEqual(['open']);
      // Exactly 7 days is not "older than 7 days".
      expect(await statuses('unknown_team', 'team|edge')).toEqual(['open']);
      expect(await statuses('fixture_missing', 'fx|old')).toEqual(['open']);
      expect(await statuses('source_broken', 'odds_out_of_line|old')).toEqual(['open']);

      const swept = await audits();
      expect(swept).toHaveLength(2);
      for (const row of swept) {
        expect(row.metadata).toMatchObject({ rule: 'Q2', reason: 'name_not_seen' });
      }
      expect(swept.map((row) => row.metadata.kind).sort()).toEqual([
        'unknown_competition',
        'unknown_team',
      ]);

      // The kept missing fixture is looked at again, and kept.
      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 1, closed: 0, failed: 0 });
      expect(await audits()).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'Q2b: a sighting refreshes updated_at so the item stays; an automatic close adds no dismissal and a re-sighted name opens a fresh item',
    async () => {
      h = await createHarness();
      const start = h.now();
      await open('unknown_team', 'team|seen', new Date(start.getTime() - 8 * DAY));
      // A new sighting 1 day ago moves updated_at.
      await open('unknown_team', 'team|seen', new Date(start.getTime() - DAY));
      expect(await sweepStaleReviewItems(h.ctx)).toMatchObject({ closed: 0 });

      // A week and a day later nobody has seen it.
      h.at(new Date(start.getTime() + 7 * DAY));
      expect(await sweepStaleReviewItems(h.ctx)).toMatchObject({ closed: 1 });
      const [first] = await items('unknown_team', 'team|seen');
      expect(first).toMatchObject({ status: 'resolved', resolution: 'auto: name_not_seen' });

      // The name shows up again: a new item, not marked as dismissed before (N4 may still alias it).
      const again = await open('unknown_team', 'team|seen');
      expect(again.created).toBe(true);
      expect(again.item.id).not.toBe(first!.id);
      expect(again.item.payload.dismissals).toBeUndefined();
      expect(await statuses('unknown_team', 'team|seen')).toEqual(['resolved', 'open']);
      expect(await sweepStaleReviewItems(h.ctx)).toMatchObject({ closed: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'Q2: runPromotion runs the step',
    async () => {
      h = await createHarness();
      await open('unknown_team', 'team|old', new Date(h.now().getTime() - 9 * DAY));
      await open('source_broken', 'source|ghost');
      expect(await runPromotion(h.ctx)).toBe(true);
      await expectSwept('unknown_team', 'team|old', 'name_not_seen');
      await expectSwept('source_broken', 'source|ghost', 'source_disabled');
    },
    TEST_TIMEOUT,
  );
});

describe('Q2c: questions the match has answered (owner, 23 Nov 2026)', () => {
  const start = KICKOFF;
  const facts = (over: Partial<Parameters<typeof matchItemReason>[1] & object> = {}) => ({
    status: 'scheduled',
    resultedAt: null,
    startTime: start,
    hasBets: false,
    ...over,
  });
  const before = new Date(start.getTime() - HOUR);
  const after = new Date(start.getTime() + HOUR);
  const ref = 'fx|c|h|a|2026-11-02';

  it('decides per kind, and never with bets for a kickoff question', () => {
    expect(matchItemReason('kickoff_change', facts(), ref, before)).toBeNull();
    expect(matchItemReason('kickoff_change', facts(), ref, after)).toBe('event_started');
    expect(matchItemReason('kickoff_change', facts({ hasBets: true }), ref, after)).toBeNull();
    expect(
      matchItemReason('kickoff_change', facts({ status: 'finished', hasBets: true }), ref, after),
    ).toBeNull();
    expect(matchItemReason('fixture_missing', facts(), ref, after)).toBeNull();
    expect(matchItemReason('fixture_missing', facts({ resultedAt: after }), ref, after)).toBe(
      'event_resulted',
    );
    expect(matchItemReason('fixture_missing', facts({ status: 'cancelled' }), ref, after)).toBe(
      'event_cancelled',
    );
    expect(matchItemReason('fixture_conflict', facts({ status: 'live' }), ref, before)).toBe(
      'event_started',
    );
    expect(
      matchItemReason('fixture_conflict', facts({ status: 'postponed' }), ref, after),
    ).toBeNull();
  });

  it('closes a never-created fixture two days after its day, not before; a bad key stays', () => {
    const dayEnd = fixtureDayEnd(ref)!;
    expect(dayEnd.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    const at = (ms: number) => new Date(dayEnd.getTime() + ms);
    expect(
      matchItemReason('fixture_conflict', undefined, ref, at(FIXTURE_DAY_PAST_MS - 1)),
    ).toBeNull();
    expect(matchItemReason('fixture_conflict', undefined, ref, at(FIXTURE_DAY_PAST_MS))).toBe(
      'fixture_past',
    );
    expect(fixtureDayEnd('fx|c|h|a|2026-02-30')).toBeNull();
    expect(
      matchItemReason('fixture_conflict', undefined, 'source|x', at(10 * FIXTURE_DAY_PAST_MS)),
    ).toBeNull();
  });

  /** The sample fixture's event, created by one promotion pass. */
  async function createdEvent(): Promise<{ id: string; feedRef: string }> {
    h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
    await h.run('src-a');
    await runPromotion(h.ctx);
    const [row] = await rows<{ id: string; feed_ref: string }>(
      `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
      [h.team('Arsenal')],
    );
    return { id: row!.id, feedRef: row!.feed_ref };
  }

  async function placeBet(eventId: string): Promise<void> {
    const [selection] = await rows<{ id: string; market_id: string; odds_milli: number }>(
      `SELECT s.id, s.market_id, s.odds_milli FROM selections s JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = $1 ORDER BY s.id LIMIT 1`,
      [eventId],
    );
    const [user] = await h.ctx.db
      .insert(users)
      .values({
        phone: '+251911000097',
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
        shortId: 'SWP001',
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
  }

  it(
    'closes the kickoff questions of a match that kicked off without bets, keeps the rest',
    async () => {
      h = await createHarness();
      const { feedRef } = await createdEvent();
      await open('kickoff_change', feedRef);
      await open('kickoff_change', `${feedRef}|earlier`);
      await open('fixture_missing', feedRef);
      await open('result_ready', feedRef);
      // Before the kickoff nothing moves.
      expect((await sweepStaleReviewItems(h.ctx)).closed).toBe(0);

      h.advance(start.getTime() - h.now().getTime() + HOUR);
      const summary = await sweepStaleReviewItems(h.ctx);
      expect(summary).toMatchObject({ closed: 2, failed: 0 });
      await expectSwept('kickoff_change', feedRef, 'event_started');
      await expectSwept('kickoff_change', `${feedRef}|earlier`, 'event_started');
      // A missing fixture waits for its result; results are never swept.
      expect(await statuses('fixture_missing', feedRef)).toEqual(['open']);
      expect(await statuses('result_ready', feedRef)).toEqual(['open']);
      expect((await audits()).at(-1)!.metadata).toMatchObject({
        rule: 'Q2',
        reason: 'event_started',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps a kickoff question of a match with bets, closes a missing fixture once resulted',
    async () => {
      h = await createHarness();
      const { id, feedRef } = await createdEvent();
      await placeBet(id);
      await open('kickoff_change', feedRef);
      await open('fixture_missing', feedRef);
      h.advance(start.getTime() - h.now().getTime() + 3 * HOUR);
      await h.pool.query(`UPDATE events SET status = 'finished', resulted_at = $2 WHERE id = $1`, [
        id,
        h.now(),
      ]);
      expect((await sweepStaleReviewItems(h.ctx)).closed).toBe(1);
      expect(await statuses('kickoff_change', feedRef)).toEqual(['open']);
      await expectSwept('fixture_missing', feedRef, 'event_resulted');
    },
    TEST_TIMEOUT,
  );

  it(
    'closes a conflict about a fixture never created two days after its day',
    async () => {
      h = await createHarness();
      const old = 'fx|00000000-0000-4000-8000-000000000001|a|b|2026-10-20';
      const soon = 'fx|00000000-0000-4000-8000-000000000001|a|b|2026-10-30';
      await open('fixture_conflict', old);
      await open('fixture_conflict', soon);
      expect((await sweepStaleReviewItems(h.ctx)).closed).toBe(1);
      await expectSwept('fixture_conflict', old, 'fixture_past');
      expect(await statuses('fixture_conflict', soon)).toEqual(['open']);
    },
    TEST_TIMEOUT,
  );
});
