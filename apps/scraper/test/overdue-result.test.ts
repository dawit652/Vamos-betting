import { resolveReviewItem, setCompetitionPolicy } from '@vamos/db';
import { MIN_MATCH_DURATION_MS, UNVERIFIED_AFTER_MS } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { flagOverdueResults, promoteResults } from '../src/pipeline/promote-results';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedOf,
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
 * F-04: a match that should be over, that no source has a score for and that no open item is about
 * used to be silent forever. After the waiting time the gates themselves impose on a lone source
 * (R1's shortest match plus R6's wait) a person gets a `result_overdue` item.
 */

/** The moment a match with no score from any source needs a person. */
const OVERDUE_AT = new Date(KICKOFF.getTime() + MIN_MATCH_DURATION_MS + UNVERIFIED_AFTER_MS);

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

interface OverdueRow {
  id: string;
  severity: string;
  title: string;
  subject_key: string;
  status: string;
  resolution: string | null;
  payload: Record<string, unknown>;
}
const overdueItems = async (status?: string): Promise<OverdueRow[]> =>
  (
    await h.pool.query<OverdueRow>(
      `SELECT id, severity, title, subject_key, status, resolution, payload FROM scrape_review_items
        WHERE kind = 'result_overdue' ${status === undefined ? '' : `AND status = '${status}'`}
        ORDER BY created_at, id`,
    )
  ).rows;

/** Both sources list the fixture before kickoff and the event is created; returns its ids. */
async function createdEvent(options: { autoResults?: boolean } = {}) {
  h = await createHarness(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const { rows } = await h.pool.query<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events`,
  );
  return { eventId: rows[0]!.id, feedRef: rows[0]!.feed_ref };
}

describe('result_overdue (F-04)', () => {
  it(
    'raises nothing before the waiting time, one item at it, and no second one on later passes',
    async () => {
      const { eventId, feedRef } = await createdEvent();

      h.at(new Date(OVERDUE_AT.getTime() - MINUTE));
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await overdueItems()).toHaveLength(0);

      h.at(OVERDUE_AT);
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 1, closed: 0 });
      const [item] = await overdueItems('open');
      expect(item).toMatchObject({
        severity: 'warning',
        subject_key: feedRef,
        title: 'No result yet: Arsenal v Chelsea',
      });
      expect(item!.payload).toMatchObject({
        eventId,
        home: 'Arsenal',
        away: 'Chelsea',
        kickoff: KICKOFF.toISOString(),
        hoursSinceKickoff: 7,
        exposure: { openBets: 0, totalStake: '0' },
      });

      h.advance(30 * MINUTE);
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
      const open = await overdueItems('open');
      expect(open).toHaveLength(1);
      expect(open[0]!.id).toBe(item!.id);
      expect(open[0]!.payload.hoursSinceKickoff).toBe(8);
      // Nothing about the event itself changed: no result, no cancellation.
      expect(
        await h.count(
          `SELECT count(*) AS n FROM events WHERE status = 'scheduled' AND resulted_at IS NULL`,
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'is part of the promotion pass',
    async () => {
      await createdEvent();
      h.at(new Date(OVERDUE_AT.getTime() + HOUR));
      expect(await runPromotion(h.ctx)).toBe(true);
      expect(await overdueItems('open')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not speak while another result item is open for the event, and closes its own when one appears',
    async () => {
      await createdEvent({ autoResults: true });
      h.at(OVERDUE_AT);
      expect(await flagOverdueResults(h.ctx)).toMatchObject({ opened: 1 });

      // One source now has the final score; with one upstream the gate asks a person (R6).
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');
      expect(await promoteResults(h.ctx)).toMatchObject({ held: 1 });
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE kind = 'result_unverified' AND status = 'open'`,
        ),
      ).toBe(1);

      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 1 });
      expect(await overdueItems('open')).toHaveLength(0);
      expect((await overdueItems('resolved'))[0]!.resolution).toBe(
        'another item asks for the result',
      );
      // And it stays quiet while the other item is open.
      h.advance(HOUR);
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a dismissed item stays quiet for 24 hours, then a still unsettled match is raised again',
    async () => {
      await createdEvent();
      h.at(OVERDUE_AT);
      await flagOverdueResults(h.ctx);
      const [first] = await overdueItems('open');
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, first!.id, {
          status: 'dismissed',
          resolution: JSON.stringify({ decision: 'dismiss', note: 'will settle later' }),
          actor: { system: 'test' },
          now: h.now(),
        }),
      );

      h.advance(23 * HOUR);
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await overdueItems('open')).toHaveLength(0);

      h.advance(2 * HOUR);
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 1, closed: 0 });
      const all = await overdueItems();
      expect(all.map((i) => i.status)).toEqual(['dismissed', 'open']);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes by itself when the event is resulted by a person',
    async () => {
      const { eventId } = await createdEvent();
      h.at(OVERDUE_AT);
      await flagOverdueResults(h.ctx);
      await h.pool.query(
        `UPDATE events SET status = 'finished', resulted_at = $2, score_home = 2, score_away = 1 WHERE id = $1`,
        [eventId, h.now()],
      );

      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 1 });
      const [closed] = await overdueItems('resolved');
      expect(closed).toMatchObject({ resolution: 'the event has a result' });
      expect(await overdueItems('open')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes when the kickoff moved later, and does not reopen',
    async () => {
      const { eventId } = await createdEvent();
      h.at(OVERDUE_AT);
      await flagOverdueResults(h.ctx);
      await h.pool.query(
        `UPDATE events SET start_time = start_time + interval '2 days' WHERE id = $1`,
        [eventId],
      );

      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 1 });
      expect((await overdueItems('resolved'))[0]!.resolution).toBe('the kickoff moved later');
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'raises nothing for a competition whose policy is off',
    async () => {
      await createdEvent();
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
      );
      h.at(new Date(OVERDUE_AT.getTime() + HOUR));
      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await overdueItems()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not close an item about a match older than the look-back just because the list no longer reaches it',
    async () => {
      const { eventId } = await createdEvent();
      h.at(OVERDUE_AT);
      await flagOverdueResults(h.ctx);
      await h.pool.query(
        `UPDATE events SET start_time = start_time - interval '20 days' WHERE id = $1`,
        [eventId],
      );

      expect(await flagOverdueResults(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await overdueItems('open')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});
