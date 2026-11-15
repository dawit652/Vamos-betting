import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolveReviewItem, setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyStaffConfirmations, promoteResults } from '../src/pipeline/promote-results';
import { runPromotion } from '../src/tasks/promote';
import { pruneRaw } from '../src/tasks/prune';
import { runDueSources } from '../src/tasks/scheduler';
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

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

/** autoResults off: the confirmed result waits in a result_ready item. */
async function readyItem(): Promise<{ id: string; payload: { score: Record<string, number> } }> {
  h = await createHarness({ autoResults: false });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  await promoteFixtures(h.ctx);
  h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
  h.serve(URL_A, ofDoc([finishedOf([3, 1], [1, 0])]));
  h.serve(URL_B, jsonDoc([finishedJson([3, 1], [1, 0])]));
  await h.run('src-a');
  await h.run('src-b');
  h.advance(16 * MINUTE);
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteResults(h.ctx)).applied).toBe(0);
  const { rows } = await h.pool.query<{ id: string; payload: { score: Record<string, number> } }>(
    `SELECT id, payload FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const resolveWith = (id: string, decision: string) =>
  h.ctx.db.transaction((tx) =>
    resolveReviewItem(tx, id, {
      status: 'resolved',
      resolution: JSON.stringify({ decision }),
      actor: { adminId: randomUUID() },
      now: h.now(),
    }),
  );
const score = async () =>
  (
    await h.pool.query<{ status: string; score_home: number | null; score_away: number | null }>(
      `SELECT status, score_home, score_away FROM events WHERE feed_provider = 'scraped'`,
    )
  ).rows[0];

describe('staff confirmation', () => {
  it(
    'R5: without auto_results the item waits; apply_result applies the proposed score only, once',
    async () => {
      const item = await readyItem();
      expect(item.payload.score).toMatchObject({ home: 3, away: 1 });
      expect(await score()).toMatchObject({ status: 'scheduled', score_home: null });
      // Nothing happens before a person decides.
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 0 });

      await resolveWith(item.id, 'apply_result');
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 1, rejected: 0 });
      expect(await score()).toMatchObject({ status: 'finished', score_home: 3, score_away: 1 });
      expect(
        await h.count(`SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`),
      ).toBe(1);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_rating_applied`)).toBe(1);
      const { rows } = await h.pool.query<{ metadata: { via: string; reviewItemId: string } }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.applied'`,
      );
      expect(rows[0]?.metadata).toMatchObject({ via: 'staff', reviewItemId: item.id });

      // Idempotent, and the gate does not open a new item for a resulted event.
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 0 });
      await promoteResults(h.ctx);
      expect(
        await h.count(`SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE status = 'open' AND kind LIKE 'result_%'`,
        ),
      ).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a dismissed item, or another decision, applies nothing',
    async () => {
      const item = await readyItem();
      await resolveWith(item.id, 'dismiss');
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 0 });
      expect(await score()).toMatchObject({ status: 'scheduled' });
    },
    TEST_TIMEOUT,
  );

  it(
    'a score that no current source still shows is refused and explained; the event is untouched',
    async () => {
      const item = await readyItem();
      await resolveWith(item.id, 'apply_result');
      // Before the confirmation is applied, a source corrects its score.
      h.serve(URL_B, jsonDoc([finishedJson([3, 3], [1, 0])]));
      await h.run('src-b');
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 1 });
      expect(await score()).toMatchObject({ status: 'scheduled', score_home: null });
      expect(
        await h.count(`SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`),
      ).toBe(0);
      const { rows } = await h.pool.query<{
        payload: { rejectedBecause: string; reopenedFor: string };
      }>(`SELECT payload FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.reopenedFor).toBe(item.id);
      expect(rows[0]?.payload.rejectedBecause).toContain('disagrees');
      // Not repeated every minute.
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 0 });
    },
    TEST_TIMEOUT,
  );
});

describe('tasks', () => {
  it(
    'the scheduler runs enabled sources that are due, once per interval',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
      const options = { random: () => 0 };
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0, ran: 0 });
      h.advance(16 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await h.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = 'src-b'`)).toBe(
        0,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'the promotion task runs every step; a held lock skips it quietly',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      expect(await runPromotion(h.ctx)).toBe(true);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'scraped'`),
      ).toBe(1);
      await h.ctx.redis.set('scraper:promote', 'other', 'PX', 60_000);
      expect(await runPromotion(h.ctx)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'a source run skips quietly while its lock is held',
    async () => {
      h = await createHarness();
      await h.ctx.redis.set('scraper:source:src-a', 'other', 'PX', 60_000);
      expect((await h.run('src-a')).status).toBe('locked');
      expect(await h.count(`SELECT count(*) AS n FROM scrape_runs`)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'pruning removes old snapshots and keeps the evidence behind an applied result',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      await promoteFixtures(h.ctx);
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(1);
      const kept = await h.pool.query<{ content_hash: string }>(
        `SELECT DISTINCT content_hash FROM scrape_raw WHERE keep`,
      );
      expect(kept.rows.length).toBe(2);

      h.advance(60 * 24 * HOUR);
      const removed = await pruneRaw(h.ctx);
      expect(removed).toBeGreaterThan(0);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_raw WHERE NOT keep`)).toBe(0);
      for (const row of kept.rows) expect(await h.ctx.archive.has(row.content_hash)).toBe(true);
      expect(existsSync(h.ctx.config.scraper.archiveDir)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
