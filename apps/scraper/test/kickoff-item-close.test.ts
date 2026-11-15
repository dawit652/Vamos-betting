import { openReviewItem } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
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
 * Rule F4 (docs/scraper.md): the gate's open kickoff_change item of an event closes by itself once
 * its cause is gone, so a stale proposal is never left for a person to apply.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const DAY = 24 * HOUR;
const EARLIER = new Date('2026-11-02T13:00:00Z');

interface ItemRow {
  subject_key: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
}
const kickoffItems = async (): Promise<ItemRow[]> =>
  (
    await h.pool.query<ItemRow>(
      `SELECT subject_key, status, resolution, resolved_by FROM scrape_review_items
        WHERE kind = 'kickoff_change' ORDER BY subject_key, created_at`,
    )
  ).rows;
const startTime = async (): Promise<Date> =>
  (
    await h.pool.query<{ start_time: Date }>(
      `SELECT start_time FROM events WHERE feed_provider = 'scraped'`,
    )
  ).rows[0]!.start_time;
const resolvedAudits = () =>
  h.count(`SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.review.resolved'`);

/** Both sources list the fixture; promotion creates the event. Returns its feed_ref. */
async function createdEvent(): Promise<string> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const { rows } = await h.pool.query<{ feed_ref: string }>(
    `SELECT feed_ref FROM events WHERE feed_provider = 'scraped'`,
  );
  return rows[0]!.feed_ref;
}

/** One source says the match starts two hours earlier, the other keeps the time: a person is asked. */
async function oneSourceSaysEarlier(feedRef: string): Promise<void> {
  h.advance(MINUTE);
  h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time: '13:00' }]));
  await h.run('src-a');
  const summary = await promoteFixtures(h.ctx);
  expect(summary).toMatchObject({ kickoffMoved: 0, kickoffItemsClosed: 0 });
  expect(await kickoffItems()).toMatchObject([{ subject_key: feedRef, status: 'open' }]);
}

describe('F4: a kickoff_change item closes by itself once its cause is gone', () => {
  it(
    'closes when every source agrees with the kickoff again, and leaves the K1 item alone',
    async () => {
      const feedRef = await createdEvent();
      await oneSourceSaysEarlier(feedRef);
      // K1's item about the same event has its own subject.
      await h.ctx.db.transaction((tx) =>
        openReviewItem(tx, {
          kind: 'kickoff_change',
          subjectKey: `${feedRef}|earlier`,
          severity: 'critical',
          title: 'Betting closed: a source says the match starts earlier',
          payload: {},
          now: h.now(),
        }),
      );

      h.advance(MINUTE);
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      await h.run('src-a');
      const summary = await promoteFixtures(h.ctx);
      expect(summary).toMatchObject({ kickoffMoved: 0, held: 0, kickoffItemsClosed: 1 });
      expect(await startTime()).toEqual(KICKOFF);
      expect(await kickoffItems()).toEqual([
        {
          subject_key: feedRef,
          status: 'resolved',
          resolution: 'every source agrees with the kickoff of the event again',
          resolved_by: 'system:scraper',
        },
        {
          subject_key: `${feedRef}|earlier`,
          status: 'open',
          resolution: null,
          resolved_by: null,
        },
      ]);
      expect(await resolvedAudits()).toBe(1);

      // Nothing is left to close on the next pass.
      expect((await promoteFixtures(h.ctx)).kickoffItemsClosed).toBe(0);
      expect(await resolvedAudits()).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes in the transaction of the move once the second upstream agrees (F4a)',
    async () => {
      const feedRef = await createdEvent();
      await oneSourceSaysEarlier(feedRef);

      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: EARLIER.toISOString() }]));
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary).toMatchObject({ kickoffMoved: 1, held: 0 });
      expect(await startTime()).toEqual(EARLIER);
      expect(await kickoffItems()).toMatchObject([
        {
          subject_key: feedRef,
          status: 'resolved',
          resolution: 'the sources moved the kickoff (F4a)',
          resolved_by: 'system:scraper',
        },
      ]);
      expect(await resolvedAudits()).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes once the event has a result, even when no source lists the match any more',
    async () => {
      const feedRef = await createdEvent();
      await oneSourceSaysEarlier(feedRef);

      await h.pool.query(
        `UPDATE events SET status = 'finished', resulted_at = $1, score_home = 1, score_away = 0
          WHERE feed_provider = 'scraped'`,
        [new Date(KICKOFF.getTime() + 2 * HOUR)],
      );
      // Three days on, the fixture observations are older than the pass reads.
      h.at(new Date(KICKOFF.getTime() + 3 * DAY));
      const summary = await promoteFixtures(h.ctx);
      expect(summary).toMatchObject({ clusters: 0, kickoffItemsClosed: 1 });
      expect(await kickoffItems()).toMatchObject([
        {
          subject_key: feedRef,
          status: 'resolved',
          resolution: 'the event has a result or is no longer scheduled',
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps the item of a postponed event for a person',
    async () => {
      const feedRef = await createdEvent();
      await oneSourceSaysEarlier(feedRef);

      await h.pool.query(`UPDATE events SET status = 'postponed' WHERE feed_provider = 'scraped'`);
      h.at(new Date(KICKOFF.getTime() + 3 * DAY));
      expect((await promoteFixtures(h.ctx)).kickoffItemsClosed).toBe(0);
      expect(await kickoffItems()).toMatchObject([{ subject_key: feedRef, status: 'open' }]);
    },
    TEST_TIMEOUT,
  );
});
