import { SCRAPER_ACTOR } from '@vamos/core';
import {
  openReviewItem,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
} from '@vamos/db';
import { REPRICE_SUBJECT_SUFFIX } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepReviewQueue } from '../src/pipeline/review-sweep';
import { runPromotion } from '../src/tasks/promote';
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
  type HarnessOptions,
} from './helpers';

/**
 * Rule Q1 (docs/scraper.md): the sweeper closes the requests to open betting and the held re-prices
 * that became pointless, and nothing else. Through the real pipeline on a real Postgres and Redis.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };
const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

async function start(options: HarnessOptions = {}): Promise<void> {
  h = await createHarness(options);
  await h.ctx.db.transaction(async (tx) => {
    await setCompetitionPolicy(tx, h.premier, { enabled: true }, SYSTEM);
    await setSourceEnabled(tx, 'src-b', false, SYSTEM);
  });
}

/** The source lists the sample fixture; one promotion pass creates the event, betting closed. */
async function createdEvent(): Promise<{ eventId: string; feedRef: string }> {
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  await h.run('src-a');
  await runPromotion(h.ctx);
  const [event] = await rows<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
    [h.team('Arsenal')],
  );
  return { eventId: event!.id, feedRef: event!.feed_ref };
}

const openBetting = (eventId: string) =>
  h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, true, STAFF));

const openItem = (kind: 'odds_approval' | 'kickoff_change', subjectKey: string) =>
  h.ctx.db.transaction((tx) =>
    openReviewItem(tx, {
      kind,
      subjectKey,
      severity: 'warning',
      title: 'test item',
      payload: {},
      now: h.now(),
    }),
  );

type ItemRow = {
  id: string;
  kind: string;
  subject_key: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
};
const items = (subject: string, kind?: string) =>
  rows<ItemRow>(
    `SELECT id, kind, subject_key, status, resolution, resolved_by FROM scrape_review_items
      WHERE subject_key = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY id`,
    [subject, kind ?? null],
  );
const audits = () =>
  rows<{ target_id: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = 'scrape.review.swept' ORDER BY id`,
  );

/** The one item of a subject and kind is resolved by the scraper with this resolution. */
async function expectSwept(subject: string, kind: string, reason: string): Promise<void> {
  const found = await items(subject, kind);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    status: 'resolved',
    resolution: `auto: ${reason}`,
    resolved_by: SCRAPER_ACTOR,
  });
}

const expectOpen = async (subject: string, kind: string) =>
  expect((await items(subject, kind)).map((item) => item.status)).toEqual(['open']);

const setStatus = (eventId: string, status: string) =>
  h.pool.query(`UPDATE events SET status = $2 WHERE id = $1`, [eventId, status]);

describe('Q1: review queue sweeper', () => {
  it(
    'Q1: an F7 odds_approval item stays while betting is closed and closes with betting_open once a trader opens it',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      await expectOpen(feedRef, 'odds_approval');

      expect(await sweepReviewQueue(h.ctx)).toEqual({ checked: 1, closed: 0, failed: 0 });
      await expectOpen(feedRef, 'odds_approval');

      await openBetting(eventId);
      expect(await sweepReviewQueue(h.ctx)).toEqual({ checked: 1, closed: 1, failed: 0 });
      await expectSwept(feedRef, 'odds_approval', 'betting_open');
      const swept = await audits();
      expect(swept).toHaveLength(1);
      expect(swept[0]).toMatchObject({
        target_id: (await items(feedRef, 'odds_approval'))[0]!.id,
        actor_id: SCRAPER_ACTOR,
        metadata: { kind: 'odds_approval', subjectKey: feedRef, reason: 'betting_open', eventId },
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: ratings_uncalibrated closes with betting_open, and on another event with event_started after kickoff',
    async () => {
      await start({ calibrated: false });
      const first = await createdEvent();
      await expectOpen(first.feedRef, 'ratings_uncalibrated');
      expect(await sweepReviewQueue(h.ctx)).toMatchObject({ closed: 0, failed: 0 });
      await openBetting(first.eventId);
      await sweepReviewQueue(h.ctx);
      await expectSwept(first.feedRef, 'ratings_uncalibrated', 'betting_open');
      // The F7 request of the same subject (if any) goes with it.
      for (const item of await items(first.feedRef)) expect(item.status).toBe('resolved');
      await h.close();

      await start({ calibrated: false });
      const second = await createdEvent();
      await expectOpen(second.feedRef, 'ratings_uncalibrated');
      h.at(new Date(KICKOFF.getTime() + HOUR));
      await sweepReviewQueue(h.ctx);
      await expectSwept(second.feedRef, 'ratings_uncalibrated', 'event_started');
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: a held re-price stays open while betting is open and closes with event_started after kickoff',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      const subject = `${feedRef}${REPRICE_SUBJECT_SUFFIX}`;
      await openItem('odds_approval', subject);
      await openBetting(eventId);

      await sweepReviewQueue(h.ctx);
      await expectOpen(subject, 'odds_approval');
      // The request on the feed_ref, not the re-price, was closed by betting_open.
      await expectSwept(feedRef, 'odds_approval', 'betting_open');

      h.at(new Date(KICKOFF.getTime() + 1));
      expect(await sweepReviewQueue(h.ctx)).toEqual({ checked: 1, closed: 1, failed: 0 });
      await expectSwept(subject, 'odds_approval', 'event_started');
      expect((await audits()).at(-1)!.metadata).toMatchObject({
        subjectKey: subject,
        reason: 'event_started',
        eventId,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: event_started covers live and finished events; resulted and cancelled have their own reasons',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      const reprice = `${feedRef}${REPRICE_SUBJECT_SUFFIX}`;
      await openItem('odds_approval', reprice);

      await setStatus(eventId, 'live');
      await sweepReviewQueue(h.ctx);
      await expectSwept(feedRef, 'odds_approval', 'event_started');
      await expectSwept(reprice, 'odds_approval', 'event_started');

      // event_resulted comes before event_started and event_cancelled.
      await h.pool.query(
        `UPDATE scrape_review_items SET status = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL`,
      );
      await h.pool.query(`UPDATE events SET resulted_at = $2 WHERE id = $1`, [eventId, h.now()]);
      await sweepReviewQueue(h.ctx);
      await expectSwept(feedRef, 'odds_approval', 'event_resulted');
      await expectSwept(reprice, 'odds_approval', 'event_resulted');

      await h.pool.query(
        `UPDATE scrape_review_items SET status = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL`,
      );
      await h.pool.query(`UPDATE events SET resulted_at = NULL WHERE id = $1`, [eventId]);
      await setStatus(eventId, 'cancelled');
      await sweepReviewQueue(h.ctx);
      await expectSwept(feedRef, 'odds_approval', 'event_cancelled');
      await expectSwept(reprice, 'odds_approval', 'event_cancelled');

      await h.pool.query(
        `UPDATE scrape_review_items SET status = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL`,
      );
      await setStatus(eventId, 'abandoned');
      await sweepReviewQueue(h.ctx);
      await expectSwept(feedRef, 'odds_approval', 'event_cancelled');
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: an item whose subject matches no event closes with event_missing and a null eventId',
    async () => {
      await start();
      await openItem('odds_approval', 'ghost-ref');
      await openItem('odds_approval', `ghost-ref${REPRICE_SUBJECT_SUFFIX}`);
      expect(await sweepReviewQueue(h.ctx)).toEqual({ checked: 2, closed: 2, failed: 0 });
      await expectSwept('ghost-ref', 'odds_approval', 'event_missing');
      await expectSwept(`ghost-ref${REPRICE_SUBJECT_SUFFIX}`, 'odds_approval', 'event_missing');
      for (const audit of await audits()) {
        expect(audit.metadata).toMatchObject({ reason: 'event_missing', eventId: null });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: items of other kinds and other subjects are never touched',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      await openItem('kickoff_change', feedRef);
      await openItem('kickoff_change', `${feedRef}|earlier`);
      await openItem('odds_approval', `${feedRef}|earlier`);
      await openItem('kickoff_change', 'ghost-ref');
      await h.pool.query(`UPDATE events SET resulted_at = $2 WHERE id = $1`, [eventId, h.now()]);
      const before = await rows(
        `SELECT id, status, resolution FROM scrape_review_items
          WHERE NOT (kind = 'odds_approval' AND subject_key = $1) ORDER BY id`,
        [feedRef],
      );

      await sweepReviewQueue(h.ctx);
      await expectSwept(feedRef, 'odds_approval', 'event_resulted');
      const after = await rows(
        `SELECT id, status, resolution FROM scrape_review_items
          WHERE NOT (kind = 'odds_approval' AND subject_key = $1) ORDER BY id`,
        [feedRef],
      );
      expect(after).toEqual(before);
      await expectOpen(feedRef, 'kickoff_change');
      await expectOpen(`${feedRef}|earlier`, 'kickoff_change');
      await expectOpen(`${feedRef}|earlier`, 'odds_approval');
      await expectOpen('ghost-ref', 'kickoff_change');
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: a postponed event keeps a held re-price; a started event with betting closed loses it',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      const reprice = `${feedRef}${REPRICE_SUBJECT_SUFFIX}`;
      await openItem('odds_approval', reprice);
      await setStatus(eventId, 'postponed');
      expect(await sweepReviewQueue(h.ctx)).toMatchObject({ closed: 0 });
      await expectOpen(reprice, 'odds_approval');
      await expectOpen(feedRef, 'odds_approval');
      // Postponed with a past start time is still postponed: not started.
      h.at(new Date(KICKOFF.getTime() + HOUR));
      expect(await sweepReviewQueue(h.ctx)).toMatchObject({ closed: 0 });
      await expectOpen(reprice, 'odds_approval');
    },
    TEST_TIMEOUT,
  );

  it(
    'Q1: a second pass closes nothing, changes no event or pricing row, and runPromotion runs the step',
    async () => {
      await start();
      const { eventId, feedRef } = await createdEvent();
      await openBetting(eventId);
      const snapshot = async () => ({
        events: await rows(`SELECT to_jsonb(e) AS r FROM events e ORDER BY id`),
        markets: await rows(`SELECT to_jsonb(m) AS r FROM markets m ORDER BY id`),
        selections: await rows(`SELECT to_jsonb(s) AS r FROM selections s ORDER BY id`),
        pricing: await rows(`SELECT to_jsonb(p) AS r FROM scrape_event_pricing p ORDER BY 1`),
      });
      const before = await snapshot();

      // The promotion pass runs the sweep as its last step.
      expect(await runPromotion(h.ctx)).toBe(true);
      await expectSwept(feedRef, 'odds_approval', 'betting_open');
      expect(await audits()).toHaveLength(1);

      expect(await sweepReviewQueue(h.ctx)).toEqual({ checked: 0, closed: 0, failed: 0 });
      expect(await audits()).toHaveLength(1);
      expect(await snapshot()).toEqual(before);
    },
    TEST_TIMEOUT,
  );
});
