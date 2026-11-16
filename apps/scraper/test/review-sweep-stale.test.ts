import { SCRAPER_ACTOR, type ScrapeReviewKind } from '@vamos/core';
import { openReviewItem, setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { NAME_NOT_SEEN_MS, sweepStaleReviewItems } from '../src/pipeline/review-sweep-stale';
import { runPromotion } from '../src/tasks/promote';
import { createHarness, HOUR, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * Rule Q2 (docs/scraper.md): items about sources that no longer run, and names nobody has seen for
 * a week, are closed by the scraper; nothing else is. On a real Postgres and Redis.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
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
      WHERE kind = $1 AND subject_key = $2 ORDER BY id`,
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

      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 2, closed: 3, failed: 0 });
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

      // Idempotent.
      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 0, closed: 0, failed: 0 });
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

      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 2, closed: 2, failed: 0 });
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

      expect(await sweepStaleReviewItems(h.ctx)).toEqual({ checked: 0, closed: 0, failed: 0 });
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
