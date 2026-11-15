import { randomUUID } from 'node:crypto';
import { resolveReviewItem } from '@vamos/db';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScraperContext } from '../src/context';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyStaffConfirmations, promoteResults } from '../src/pipeline/promote-results';
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
  type HarnessOptions,
} from './helpers';

/**
 * A promotion pass whose observation read hit its row limit decides nothing for
 * the fixtures it may have cut through (the read is ordered by kickoff).
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

/** The context with a logger that records error calls. */
function withErrorLog(): { ctx: ScraperContext; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const logger = Object.assign(Object.create(h.ctx.logger) as Logger, {
    error: (obj: unknown) => {
      if (typeof obj === 'object' && obj !== null) errors.push(obj as Record<string, unknown>);
    },
  });
  return { ctx: { ...h.ctx, logger }, errors };
}

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;
const events = async () =>
  rows<{ start_time: Date; status: string; score_home: number | null; feed_ref: string }>(
    `SELECT start_time, status, score_home, feed_ref FROM events WHERE feed_provider = 'scraped' ORDER BY start_time`,
  );
const openKinds = async () =>
  (await rows<{ kind: string }>(`SELECT kind FROM scrape_review_items WHERE status = 'open'`)).map(
    (r) => r.kind,
  );

async function createdEvent(options: HarnessOptions = {}): Promise<void> {
  h = await createHarness(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

describe('fixtures: a read that hit its row limit decides nothing for the last kickoffs', () => {
  it(
    'F4: the source that would disagree is cut off; no kickoff is moved on the rest, and the next pass sees both',
    async () => {
      await createdEvent();
      h.advance(MINUTE);
      // Rows by kickoff: src-a 15:00 first, then src-b 17:00 (the dissent). Limit 1 reads only src-a.
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, date: '2026-11-04' }]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-04T17:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');

      const { ctx, errors } = withErrorLog();
      const cut = await promoteFixtures(ctx, { rowLimit: 1 });
      expect(cut).toMatchObject({ kickoffMoved: 0, created: 0, held: 0, deferred: 1 });
      expect((await events())[0]!.start_time.toISOString()).toBe(KICKOFF.toISOString());
      expect(await openKinds()).not.toContain('kickoff_change');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ limit: 1, what: 'fixtures' });

      // Complete read: the two sources disagree about the new time; a person decides.
      const full = await promoteFixtures(h.ctx);
      expect(full).toMatchObject({ kickoffMoved: 0, deferred: 0 });
      expect((await events())[0]!.start_time.toISOString()).toBe(KICKOFF.toISOString());
      expect(await openKinds()).toContain('kickoff_change');
    },
    TEST_TIMEOUT,
  );

  it(
    'F2: fixtures well before the last kickoff are decided; the later ones wait for the next pass',
    async () => {
      h = await createHarness();
      h.serve(
        URL_A,
        ofDoc([
          ARSENAL_CHELSEA_OF,
          { ...ARSENAL_CHELSEA_OF, team1: 'Liverpool FC', team2: 'Everton FC', date: '2026-11-08' },
        ]),
      );
      h.serve(
        URL_B,
        jsonDoc([
          ARSENAL_CHELSEA_JSON,
          { id: 2, kick: '2026-11-08T15:00:00Z', h: 'Liverpool', a: 'Everton', st: 'NS' },
        ]),
      );
      await h.run('src-a');
      await h.run('src-b');
      // Four rows; the read of three ends inside the Nov 8 group.
      const { ctx, errors } = withErrorLog();
      expect(await promoteFixtures(ctx, { rowLimit: 3 })).toMatchObject({
        created: 1,
        deferred: 1,
      });
      expect(errors).toHaveLength(1);
      expect((await events()).map((e) => e.start_time.toISOString())).toEqual([
        KICKOFF.toISOString(),
      ]);

      expect(await promoteFixtures(h.ctx)).toMatchObject({ created: 1, deferred: 0 });
      expect(await events()).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'a read below its limit is complete: nothing is deferred and nothing is logged',
    async () => {
      await createdEvent();
      const { ctx, errors } = withErrorLog();
      expect(await promoteFixtures(ctx, { rowLimit: 3 })).toMatchObject({ deferred: 0 });
      expect(errors).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe('results: a read that hit its row limit decides nothing for the last kickoffs', () => {
  async function finalScores(): Promise<void> {
    h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
    h.serve(URL_A, ofDoc([finishedOf([2, 0], [1, 0])]));
    h.serve(URL_B, jsonDoc([finishedJson([1, 0], [0, 0])]));
    await h.run('src-a');
    await h.run('src-b');
    h.advance(16 * MINUTE);
    await h.run('src-a');
    await h.run('src-b');
  }

  it(
    'R3: a cut read neither applies nor holds; the complete read finds the conflict',
    async () => {
      await createdEvent({ autoResults: true });
      await finalScores();
      const { ctx, errors } = withErrorLog();
      expect(await promoteResults(ctx, { rowLimit: 1 })).toMatchObject({
        applied: 0,
        held: 0,
        deferred: 1,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ limit: 1, what: 'results' });
      expect(await openKinds()).not.toContain('result_unverified');
      expect(await openKinds()).not.toContain('result_conflict');

      expect(await promoteResults(h.ctx)).toMatchObject({ held: 1, deferred: 0 });
      expect(await openKinds()).toContain('result_conflict');
    },
    TEST_TIMEOUT,
  );

  it(
    'R5: a staff confirmation is neither applied nor rejected on a cut read, and stands for the next pass',
    async () => {
      await createdEvent({ autoResults: false });
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([3, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([3, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);
      const [ready] = await rows<{ id: string }>(
        `SELECT id FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`,
      );
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, ready!.id, {
          status: 'resolved',
          resolution: JSON.stringify({ decision: 'apply_result' }),
          actor: { adminId: randomUUID() },
          now: h.now(),
        }),
      );
      // A source corrects its score before the confirmation runs; the cut read may not show it.
      h.serve(URL_B, jsonDoc([finishedJson([3, 3], [1, 0])]));
      await h.run('src-b');

      expect(await applyStaffConfirmations(withErrorLog().ctx, { rowLimit: 1 })).toEqual({
        applied: 0,
        rejected: 0,
      });
      expect((await events())[0]).toMatchObject({ status: 'scheduled', score_home: null });
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.result.confirmation_rejected'`,
        ),
      ).toBe(0);

      // The complete read sees the correction and refuses the confirmation.
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 1 });
    },
    TEST_TIMEOUT,
  );
});
