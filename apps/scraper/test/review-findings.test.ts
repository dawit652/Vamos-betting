import { setCompetitionPolicy } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedJson,
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
 * Regression tests for the independent review of 2026-10 (docs/scraper-plan/review-2026-10.md).
 * Each describe block is one finding.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;
const event = async () =>
  (
    await rows<{
      status: string;
      start_time: Date;
      score_home: number | null;
      score_away: number | null;
    }>(
      `SELECT status, start_time, score_home, score_away FROM events WHERE feed_provider = 'scraped'`,
    )
  )[0]!;
const openKinds = async () =>
  (await rows<{ kind: string }>(`SELECT kind FROM scrape_review_items WHERE status = 'open'`)).map(
    (r) => r.kind,
  );

/** Both sources list the fixture; promotion creates the event. */
async function createdEvent(options: { autoResults?: boolean } = {}): Promise<void> {
  h = await createHarness(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

const switchOff = () =>
  h.ctx.db.transaction((tx) =>
    setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
  );

describe('review finding 5: a switched-off competition stops kickoff moves and automatic results', () => {
  it(
    'S4/F4: both sources move the kickoff but a disabled policy only proposes the change',
    async () => {
      await createdEvent();
      await switchOff();
      h.advance(MINUTE);
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time: '17:00' }]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T17:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary.kickoffMoved).toBe(0);
      expect((await event()).start_time.toISOString()).toBe(KICKOFF.toISOString());
      expect(await openKinds()).toContain('kickoff_change');
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.kickoff_moved'`,
        ),
      ).toBe(0);

      // Switched on again, the same observations move the kickoff (nothing else changed).
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: true }, { system: 'test' }),
      );
      expect((await promoteFixtures(h.ctx)).kickoffMoved).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'S4/R5: agreeing sources do not auto-apply a result while the policy is off',
    async () => {
      await createdEvent({ autoResults: true });
      await switchOff();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 0], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 0], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteResults(h.ctx);
      expect(summary.applied).toBe(0);
      expect(await event()).toMatchObject({ status: 'scheduled', score_home: null });
      expect(await openKinds()).toContain('result_ready');
    },
    TEST_TIMEOUT,
  );

  it(
    'R5: an extra-time competition is never applied automatically either',
    async () => {
      await createdEvent({ autoResults: true });
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { extraTime: true }, { system: 'test' }),
      );
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 0], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 0], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(await event()).toMatchObject({ status: 'scheduled', score_home: null });
      expect(await openKinds()).toContain('result_ready');
    },
    TEST_TIMEOUT,
  );
});
