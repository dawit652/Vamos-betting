import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteRaw,
  finishRun,
  listPrunableRaw,
  listRecentRuns,
  markRawKeep,
  MAX_RUN_ERROR_LENGTH,
  MAX_RUN_ISSUES,
  openReviewItem,
  recentAcceptedCounts,
  recordRaw,
  ScrapeRunStateError,
  type ScrapeRunIssueJson,
  sourceHealth,
  startRun,
} from '../src/index';
import { scrapeRaw } from '../src/schema/index';
import { dropTestDatabase, pgCode } from './helpers';
import {
  addRun,
  addSource,
  createScrapeDatabase,
  sha,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
const H = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * H);
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

describe('runs', () => {
  it('start, finish, and a second finish is refused', async () => {
    await addSource(ctx.handle.db, 'run-a');
    const run = await startRun(ctx.handle.db, {
      sourceId: 'run-a',
      trigger: 'manual',
      startedAt: at(0),
    });
    expect(run).toMatchObject({
      status: 'running',
      finishedAt: null,
      trigger: 'manual',
      issues: [],
    });
    const done = await finishRun(ctx.handle.db, run.id, {
      status: 'ok',
      requests: 2,
      bytes: 1234,
      recordsSeen: 10,
      recordsAccepted: 9,
      fixtures: 9,
      results: 0,
      issues: [{ severity: 'warning', code: 'dropped_record', message: 'x' }],
    });
    expect(done).toMatchObject({
      status: 'ok',
      requests: 2,
      bytes: 1234,
      recordsAccepted: 9,
      error: null,
    });
    expect(done.finishedAt).toBeInstanceOf(Date);
    const again = await finishRun(ctx.handle.db, run.id, { status: 'failed' }).catch((e) => e);
    expect(again).toBeInstanceOf(ScrapeRunStateError);
    expect((await listRecentRuns(ctx.handle.db, { sourceId: 'run-a' }))[0]?.status).toBe('ok');
    await expect(
      finishRun(ctx.handle.db, '00000000-0000-4000-8000-000000000000', { status: 'failed' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('caps issues (fatal first) and truncates the error text', async () => {
    const run = await startRun(ctx.handle.db, { sourceId: 'run-a', startedAt: at(1) });
    const issues: ScrapeRunIssueJson[] = Array.from({ length: 250 }, (_, i) => ({
      severity: 'warning',
      code: 'dropped_record',
      message: 'm'.repeat(2000),
      context: { i },
    }));
    issues.push({ severity: 'error', code: 'bad_json', message: 'broken', fatal: true });
    const done = await finishRun(ctx.handle.db, run.id, {
      status: 'broken',
      issues,
      error: 'e'.repeat(MAX_RUN_ERROR_LENGTH + 500),
    });
    expect(done.issues).toHaveLength(MAX_RUN_ISSUES);
    expect(done.issues[0]).toMatchObject({ code: 'bad_json', fatal: true });
    expect(done.issues.at(-1)).toMatchObject({ code: 'issues_truncated' });
    expect(done.issues.every((i) => i.message.length <= 500)).toBe(true);
    expect(done.error).toHaveLength(MAX_RUN_ERROR_LENGTH);
  });

  it('the database rejects an unknown status and a running run with a finish time', async () => {
    const run = await startRun(ctx.handle.db, { sourceId: 'run-a', startedAt: at(2) });
    const error = await finishRun(ctx.handle.db, run.id, { status: 'weird' as never }).catch(
      (e) => e,
    );
    expect(pgCode(error)).toBe('23514');
    expect(
      pgCode(await startRun(ctx.handle.db, { sourceId: 'nope', startedAt: at(2) }).catch((e) => e)),
    ).toBe('23503');
  });

  it('lists the newest runs first', async () => {
    await addSource(ctx.handle.db, 'run-list');
    for (let i = 0; i < 4; i += 1) await addRun(ctx.handle.db, 'run-list', 'ok', at(10 + i));
    const runs = await listRecentRuns(ctx.handle.db, { sourceId: 'run-list', limit: 3 });
    expect(runs.map((r) => r.startedAt)).toEqual([at(13), at(12), at(11)]);
  });
});

describe('raw snapshots', () => {
  it('recordRaw is idempotent per run and url and never rewrites the content', async () => {
    await addSource(ctx.handle.db, 'raw-a');
    const run = await addRun(ctx.handle.db, 'raw-a', 'ok', at(0));
    const input = {
      runId: run.id,
      url: 'https://example.test/fixtures.json',
      status: 200,
      contentType: 'application/json',
      contentHash: sha('one'),
      bytes: 10,
      fetchedAt: at(0),
    };
    const first = await recordRaw(ctx.handle.db, input);
    expect(first.created).toBe(true);
    const second = await recordRaw(ctx.handle.db, {
      ...input,
      contentHash: sha('two'),
      recordsSeen: 5,
      recordsAccepted: 4,
    });
    expect(second.created).toBe(false);
    expect(second.raw).toMatchObject({
      id: first.raw.id,
      contentHash: sha('one'),
      recordsSeen: 5,
      recordsAccepted: 4,
    });
    const third = await recordRaw(ctx.handle.db, { ...input, recordsAccepted: 99 });
    expect(third.raw.recordsAccepted).toBe(4); // a known yield is not overwritten
    const other = await recordRaw(ctx.handle.db, { ...input, url: 'https://example.test/b.json' });
    expect(other.created).toBe(true);
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordRaw(ctx.handle.db, { ...input, url: 'https://example.test/c.json' }),
      ),
    );
    expect(parallel.filter((r) => r.created)).toHaveLength(1);
  });

  it('rejects a bad hash or status', async () => {
    const run = await addRun(ctx.handle.db, 'raw-a', 'ok', at(1));
    const base = {
      runId: run.id,
      url: 'u',
      status: 200,
      contentType: null,
      bytes: 1,
      fetchedAt: at(1),
    };
    expect(
      pgCode(await recordRaw(ctx.handle.db, { ...base, contentHash: 'abc' }).catch((e) => e)),
    ).toBe('23514');
    expect(
      pgCode(
        await recordRaw(ctx.handle.db, { ...base, contentHash: sha('x'), status: 99 }).catch(
          (e) => e,
        ),
      ),
    ).toBe('23514');
  });

  it('markRawKeep protects evidence from pruning, including shared content hashes', async () => {
    await addSource(ctx.handle.db, 'raw-b');
    const mk = async (hours: number, content: string, url: string) => {
      const run = await addRun(ctx.handle.db, 'raw-b', 'ok', at(hours));
      return (
        await recordRaw(ctx.handle.db, {
          runId: run.id,
          url,
          status: 200,
          contentType: null,
          contentHash: sha(content),
          bytes: 1,
          fetchedAt: at(hours),
        })
      ).raw;
    };
    const old1 = await mk(100, 'evidence', 'https://example.test/e');
    const old2 = await mk(101, 'evidence', 'https://example.test/e2'); // same bytes, other run
    const old3 = await mk(102, 'plain', 'https://example.test/p');
    const fresh = await mk(500, 'fresh', 'https://example.test/f');
    expect(await markRawKeep(ctx.handle.db, [])).toBe(0);
    expect(await markRawKeep(ctx.handle.db, [sha('evidence'), sha('evidence')])).toBe(2);
    expect(await markRawKeep(ctx.handle.db, [sha('evidence')])).toBe(0);
    const prunable = await listPrunableRaw(ctx.handle.db, at(200), 100);
    const ids = prunable.map((r) => r.id);
    expect(ids).toContain(old3.id);
    expect(ids).not.toContain(old1.id);
    expect(ids).not.toContain(old2.id);
    expect(ids).not.toContain(fresh.id);
    expect(prunable.every((r) => !r.keep)).toBe(true);
    expect(await listPrunableRaw(ctx.handle.db, at(200), 1)).toHaveLength(1);
    // deleteRaw never removes evidence even if asked to.
    expect(await deleteRaw(ctx.handle.db, [old1.id, old3.id])).toBe(1);
    const left = await ctx.handle.db.select({ id: scrapeRaw.id }).from(scrapeRaw);
    expect(left.map((r) => r.id)).toContain(old1.id);
    expect(left.map((r) => r.id)).not.toContain(old3.id);
  });
});

describe('recentAcceptedCounts', () => {
  it('returns the latest successful runs only, per run or per url', async () => {
    await addSource(ctx.handle.db, 'cnt');
    const url = 'https://example.test/feed.json';
    const record = async (
      hours: number,
      status: 'ok' | 'broken' | 'failed',
      accepted: number,
      withUrl = true,
    ) => {
      const run = await addRun(ctx.handle.db, 'cnt', status, at(hours), accepted);
      if (withUrl) {
        await recordRaw(ctx.handle.db, {
          runId: run.id,
          url,
          status: 200,
          contentType: null,
          contentHash: sha(`${hours}`),
          bytes: 1,
          fetchedAt: at(hours),
          recordsAccepted: accepted,
        });
        await recordRaw(ctx.handle.db, {
          runId: run.id,
          url: `${url}?other`,
          status: 200,
          contentType: null,
          contentHash: sha(`o${hours}`),
          bytes: 1,
          fetchedAt: at(hours),
          recordsAccepted: 1000 + accepted,
        });
      }
    };
    await record(1, 'ok', 100);
    await record(2, 'ok', 110);
    await record(3, 'broken', 0);
    await record(4, 'failed', 0, false);
    await record(5, 'ok', 120);
    expect(await recentAcceptedCounts(ctx.handle.db, 'cnt', undefined, 10)).toEqual([
      120, 110, 100,
    ]);
    expect(await recentAcceptedCounts(ctx.handle.db, 'cnt', url, 2)).toEqual([120, 110]);
    expect(await recentAcceptedCounts(ctx.handle.db, 'cnt', `${url}?other`, 10)).toEqual([
      1120, 1110, 1100,
    ]);
    expect(
      await recentAcceptedCounts(ctx.handle.db, 'cnt', 'https://example.test/none', 10),
    ).toEqual([]);
    expect(await recentAcceptedCounts(ctx.handle.db, 'missing', undefined, 10)).toEqual([]);
  });
});

describe('sourceHealth', () => {
  it('counts consecutive failures since the last ok run; skipped and running are neutral', async () => {
    const db = ctx.handle.db;
    await addSource(ctx.handle.db, 'h-never', { enabled: false });
    await addSource(ctx.handle.db, 'h-flaky');
    await addSource(ctx.handle.db, 'h-ok');
    await addSource(ctx.handle.db, 'h-down');

    await addRun(db, 'h-flaky', 'failed', at(1));
    await addRun(db, 'h-flaky', 'ok', at(2), 50);
    await addRun(db, 'h-flaky', 'failed', at(3));
    await addRun(db, 'h-flaky', 'skipped', at(4));
    await addRun(db, 'h-flaky', 'broken', at(5));
    await addRun(db, 'h-flaky', 'blocked', at(6));
    await startRun(db, { sourceId: 'h-flaky', startedAt: at(7) }); // still running

    await addRun(db, 'h-ok', 'failed', at(1));
    await addRun(db, 'h-ok', 'ok', at(2), 7);

    await addRun(db, 'h-down', 'failed', at(1));
    await addRun(db, 'h-down', 'failed', at(2));

    await db.transaction((tx) =>
      openReviewItem(tx, {
        kind: 'source_broken',
        subjectKey: 'h-flaky',
        severity: 'critical',
        title: 't',
        payload: {},
      }),
    );
    await db.transaction((tx) =>
      openReviewItem(tx, {
        kind: 'unknown_team',
        subjectKey: 'some name',
        severity: 'info',
        title: 't',
        payload: { sourceId: 'h-flaky' },
      }),
    );
    await db.transaction((tx) =>
      openReviewItem(tx, {
        kind: 'unknown_team',
        subjectKey: 'other',
        severity: 'info',
        title: 't',
        payload: { sourceId: 'h-ok' },
      }),
    );

    const now = at(10);
    const health = new Map((await sourceHealth(db, now)).map((h) => [h.sourceId, h]));
    expect(health.get('h-never')).toMatchObject({
      enabled: false,
      lastRun: null,
      lastOkAt: null,
      sinceLastOkMs: null,
      consecutiveFailures: 0,
      lastStatus: null,
      lastAcceptedCount: null,
      openReviewItems: 0,
    });
    expect(health.get('h-flaky')).toMatchObject({
      enabled: true,
      consecutiveFailures: 3, // failed(3), broken(5), blocked(6); the one before the ok run is forgotten
      lastStatus: 'blocked',
      lastOkAt: at(2),
      sinceLastOkMs: 8 * H,
      openReviewItems: 2,
    });
    expect(health.get('h-flaky')?.lastRun?.startedAt).toEqual(at(6));
    expect(health.get('h-ok')).toMatchObject({
      consecutiveFailures: 0,
      lastStatus: 'ok',
      lastAcceptedCount: 7,
      openReviewItems: 1,
    });
    expect(health.get('h-down')).toMatchObject({
      consecutiveFailures: 2,
      lastOkAt: null,
      sinceLastOkMs: null,
      lastStatus: 'failed',
    });
  });
});
