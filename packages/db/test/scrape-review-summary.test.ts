import { SCRAPE_REVIEW_KINDS } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openReviewItem, resolveReviewItem, reviewQueueSummary } from '../src/index';
import { dropTestDatabase } from './helpers';
import { createScrapeDatabase, STAFF, type ScrapeTestContext } from './scrape-fixtures';

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const open = (kind: 'unknown_team' | 'result_ready', subjectKey: string, now: Date) =>
  ctx.handle.db.transaction((t) =>
    openReviewItem(t, { kind, subjectKey, severity: 'info', title: subjectKey, payload: {}, now }),
  );

describe('reviewQueueSummary', () => {
  it('is all zeros on an empty queue, in kind order', async () => {
    const summary = await reviewQueueSummary(ctx.handle.db);
    expect(summary.map((s) => s.kind)).toEqual([...SCRAPE_REVIEW_KINDS]);
    expect(summary.every((s) => s.count === 0 && s.oldestCreatedAt === null)).toBe(true);
  });

  it('counts open items per kind with the oldest created_at; closed items are left out', async () => {
    const old = new Date('2030-01-01T00:00:00Z');
    const mid = new Date('2030-01-02T00:00:00Z');
    const late = new Date('2030-01-03T00:00:00Z');
    await open('unknown_team', 's-late', late);
    await open('unknown_team', 's-old', old);
    await open('result_ready', 's-mid', mid);
    const closed = await open('result_ready', 's-closed', new Date('2029-01-01T00:00:00Z'));
    await ctx.handle.db.transaction((t) =>
      resolveReviewItem(t, closed.item.id, {
        status: 'dismissed',
        resolution: 'test',
        actor: STAFF,
      }),
    );

    const summary = await reviewQueueSummary(ctx.handle.db);
    const of = (kind: string) => summary.find((s) => s.kind === kind)!;
    expect(of('unknown_team')).toMatchObject({ count: 2, oldestCreatedAt: old });
    expect(of('result_ready')).toMatchObject({ count: 1, oldestCreatedAt: mid });
    expect(of('odds_approval')).toMatchObject({ count: 0, oldestCreatedAt: null });

    const dismissed = await reviewQueueSummary(ctx.handle.db, 'dismissed');
    expect(dismissed.find((s) => s.kind === 'result_ready')).toMatchObject({ count: 1 });
  });
});
