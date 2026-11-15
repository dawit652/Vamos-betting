import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openReviewItem, resolveReviewItem } from '../src/index';
import { dropTestDatabase } from './helpers';
import { createScrapeDatabase, STAFF, type ScrapeTestContext } from './scrape-fixtures';

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const open = (subjectKey: string, now: Date, payload: Record<string, unknown> = {}) =>
  ctx.handle.db.transaction((t) =>
    openReviewItem(t, {
      kind: 'unknown_team',
      subjectKey,
      severity: 'info',
      title: subjectKey,
      payload,
      now,
    }),
  );
const close = (id: string, status: 'resolved' | 'dismissed', resolution: string, now: Date) =>
  ctx.handle.db.transaction((t) =>
    resolveReviewItem(t, id, { status, resolution, actor: STAFF, now }),
  );

describe('openReviewItem: earlier dismissals (Q-3)', () => {
  it('a first item has no dismissals', async () => {
    const { item } = await open('q3-first', new Date('2031-01-01T00:00:00Z'));
    expect(item.payload.dismissals).toBeUndefined();
  });

  it('a re-raised item counts the dismissals and keeps the last note and date', async () => {
    const first = await open('q3-subject', new Date('2031-01-01T00:00:00Z'), { raw: 'X' });
    await close(
      first.item.id,
      'dismissed',
      JSON.stringify({ decision: 'dismiss', note: 'old note' }),
      new Date('2031-01-02T00:00:00Z'),
    );
    const second = await open('q3-subject', new Date('2031-01-03T00:00:00Z'), { raw: 'X' });
    expect(second.created).toBe(true);
    expect(second.item.payload).toMatchObject({
      raw: 'X',
      dismissals: { count: 1, lastNote: 'old note', lastAt: '2031-01-02T00:00:00.000Z' },
    });
    await close(
      second.item.id,
      'dismissed',
      JSON.stringify({ decision: 'dismiss', note: 'newer note' }),
      new Date('2031-01-04T00:00:00Z'),
    );
    const third = await open('q3-subject', new Date('2031-01-05T00:00:00Z'), { raw: 'X' });
    expect(third.item.payload.dismissals).toEqual({
      count: 2,
      lastNote: 'newer note',
      lastAt: '2031-01-04T00:00:00.000Z',
    });
  });

  it('survives a refresh of the open item and ignores resolved items', async () => {
    const a = await open('q3-refresh', new Date('2031-02-01T00:00:00Z'));
    await close(a.item.id, 'resolved', 'fixed', new Date('2031-02-02T00:00:00Z'));
    const b = await open('q3-refresh', new Date('2031-02-03T00:00:00Z'));
    expect(b.item.payload.dismissals).toBeUndefined();
    await close(b.item.id, 'dismissed', 'plain text', new Date('2031-02-04T00:00:00Z'));
    const c = await open('q3-refresh', new Date('2031-02-05T00:00:00Z'));
    const refreshed = await open('q3-refresh', new Date('2031-02-06T00:00:00Z'), { fresh: true });
    expect(refreshed.created).toBe(false);
    expect(refreshed.item.id).toBe(c.item.id);
    expect(refreshed.item.payload).toMatchObject({
      fresh: true,
      dismissals: { count: 1, lastNote: 'plain text' },
    });
  });
});
