import { resolveReviewItem, setSourceEnabled } from '@vamos/db';
import { MIN_MATCH_DURATION_MS, SOURCE_STALE_AFTER_MS } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { flagStaleSources } from '../src/pipeline/stale-sources';
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
  T0,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * F-02 (rule S5): a source can answer every run with a page that never changes, and every health
 * signal says "ok" while no result ever arrives. A person is told once a match the source lists has
 * ended and 48 hours have passed with nothing new from it.
 */

/** The earliest the listed match can be over, and the end of the allowance after it. */
const MATCH_END = new Date(KICKOFF.getTime() + MIN_MATCH_DURATION_MS);
const STALE_AT = new Date(MATCH_END.getTime() + SOURCE_STALE_AFTER_MS);

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

interface StaleRow {
  id: string;
  subject_key: string;
  status: string;
  title: string;
  resolution: string | null;
  payload: Record<string, unknown>;
}
const staleItems = async (status?: string): Promise<StaleRow[]> =>
  (
    await h.pool.query<StaleRow>(
      `SELECT id, subject_key, status, title, resolution, payload FROM scrape_review_items
        WHERE kind = 'source_stale' ${status === undefined ? '' : `AND status = '${status}'`}
        ORDER BY subject_key, created_at`,
    )
  ).rows;

/** Both sources list the fixture before kickoff and the event is created. */
async function listedEvent(): Promise<string> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  return (await h.pool.query<{ id: string }>(`SELECT id FROM events`)).rows[0]!.id;
}

/** Both sources answer again at `at` with the pages they always had. */
async function pollUnchanged(at: Date): Promise<void> {
  h.at(at);
  await h.run('src-a');
  await h.run('src-b');
}

describe('source_stale (F-02)', () => {
  it(
    'raises nothing until 48 hours after a listed match ended, then one item per silent source',
    async () => {
      await listedEvent();

      await pollUnchanged(new Date(STALE_AT.getTime() - MINUTE));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await staleItems()).toHaveLength(0);

      await pollUnchanged(STALE_AT);
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 2, closed: 0 });
      const [a, b] = await staleItems('open');
      expect(a).toMatchObject({
        subject_key: 'source|src-a',
        title: 'openfootball test: nothing new for 6 days',
      });
      expect(b).toMatchObject({ subject_key: 'source|src-b' });
      expect(a!.payload).toMatchObject({
        sourceId: 'src-a',
        sourceName: 'openfootball test',
        lastChangedAt: T0.toISOString(),
        hoursUnchanged: Math.floor((STALE_AT.getTime() - T0.getTime()) / HOUR),
        dueMatches: 1,
      });

      // A later pass refreshes the same two items; it opens no third.
      await pollUnchanged(new Date(STALE_AT.getTime() + HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await staleItems('open')).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'a quiet source between match days is not stale: the clock starts when a listed match ends',
    async () => {
      await listedEvent();
      // Four days after its last change, before the match is even played.
      await pollUnchanged(new Date(KICKOFF.getTime() - HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      // The match is over, but the allowance has not passed.
      await pollUnchanged(new Date(MATCH_END.getTime() + 47 * HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await staleItems()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a source that shows something new closes its own item and leaves the other one open',
    async () => {
      await listedEvent();
      await pollUnchanged(STALE_AT);
      await flagStaleSources(h.ctx);

      // Source A now shows the final score; source B is still silent.
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      h.at(new Date(STALE_AT.getTime() + 10 * MINUTE));
      await h.run('src-a');
      await h.run('src-b');
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 1 });
      const open = await staleItems('open');
      expect(open.map((i) => i.subject_key)).toEqual(['source|src-b']);
      const [closed] = await staleItems('resolved');
      expect(closed).toMatchObject({
        subject_key: 'source|src-a',
        resolution: 'the source shows news again, or no listed match is waiting on it',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'closes when the listed match has a result, however it got one',
    async () => {
      const eventId = await listedEvent();
      await pollUnchanged(STALE_AT);
      await flagStaleSources(h.ctx);
      await h.pool.query(
        `UPDATE events SET status = 'finished', resulted_at = $2, score_home = 1, score_away = 0 WHERE id = $1`,
        [eventId, h.now()],
      );
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 2 });
      expect(await staleItems('open')).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves a failing or a disabled source to its own signals',
    async () => {
      await listedEvent();
      await pollUnchanged(STALE_AT);
      // Source A starts failing, source B is switched off.
      h.serve(URL_A, { status: 500, body: 'server error' });
      h.at(new Date(STALE_AT.getTime() + 5 * MINUTE));
      await h.run('src-a');
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));

      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await staleItems()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a dismissed item stays quiet for 24 hours, then a source that is still silent is raised again',
    async () => {
      await listedEvent();
      await pollUnchanged(STALE_AT);
      await flagStaleSources(h.ctx);
      const [first] = await staleItems('open');
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, first!.id, {
          status: 'dismissed',
          resolution: JSON.stringify({ decision: 'dismiss', note: 'known' }),
          actor: { system: 'test' },
          now: h.now(),
        }),
      );

      await pollUnchanged(new Date(STALE_AT.getTime() + 23 * HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect((await staleItems('open')).map((i) => i.subject_key)).toEqual(['source|src-b']);

      await pollUnchanged(new Date(STALE_AT.getTime() + 25 * HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 1, closed: 0 });
      expect((await staleItems('open')).map((i) => i.subject_key)).toEqual([
        'source|src-a',
        'source|src-b',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'is part of the promotion pass',
    async () => {
      await listedEvent();
      await pollUnchanged(STALE_AT);
      expect(await runPromotion(h.ctx)).toBe(true);
      expect(await staleItems('open')).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );
});
