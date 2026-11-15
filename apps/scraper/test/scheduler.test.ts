import { finishRun, setSourceEnabled, startRun, type ScrapeRunIssueJson } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { runDueSources } from '../src/tasks/scheduler';
import {
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  type Harness,
} from './helpers';

/** The scheduler skips a source until the retry time its last run asked for. */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const options = { random: () => 0 };
const runsOf = (sourceId: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = $1`, [sourceId]);

/** Only src-a is enabled, and its last run, two hours ago, ended `status` with these issues. */
async function afterRun(
  status: 'failed' | 'blocked',
  issuesAt: (now: Date) => ScrapeRunIssueJson[],
): Promise<Date> {
  h = await createHarness();
  const issues = issuesAt(h.now());
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
  const startedAt = new Date(h.now().getTime() - 2 * HOUR);
  await h.ctx.db.transaction(async (tx) => {
    const run = await startRun(tx, { sourceId: 'src-a', trigger: 'schedule', startedAt });
    await finishRun(tx, run.id, {
      status,
      issues,
      error: issues[0]?.message ?? null,
      finishedAt: new Date(startedAt.getTime() + MINUTE),
    });
  });
  return startedAt;
}

const plus = (date: Date, ms: number): Date => new Date(date.getTime() + ms);
const blocked = (retryAt: Date): ScrapeRunIssueJson => ({
  severity: 'error',
  code: 'blocked',
  message: 'the site told us to stop; backing off',
  context: { url: URL_A, retryAt: retryAt.toISOString() },
});

describe('scheduler: skip until retryAt', () => {
  it(
    'a failed source is not run before the retry time its last run asked for, and runs after it',
    async () => {
      // Two hours since the failure: the backed-off cadence (30 minutes) alone would make it due.
      await afterRun('blocked', (now) => [blocked(plus(now, 3 * HOUR))]);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0, ran: 0 });
      expect(await runsOf('src-a')).toBe(1);

      h.advance(2 * HOUR + 59 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0, ran: 0 });
      expect(await runsOf('src-a')).toBe(1);

      h.advance(2 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await runsOf('src-a')).toBe(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'the latest of several retry times counts',
    async () => {
      await afterRun('failed', (now) => [
        { ...blocked(plus(now, HOUR)), code: 'circuit_open' },
        blocked(plus(now, 4 * HOUR)),
      ]);
      h.advance(3 * HOUR);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0, ran: 0 });
      h.advance(HOUR + MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a retry time already in the past, or none at all, only leaves the failure backoff',
    async () => {
      await afterRun('blocked', (now) => [blocked(plus(now, -HOUR))]);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a failure without a retry time is run once its backoff has passed',
    async () => {
      await afterRun('failed', () => [
        { severity: 'error', code: 'fetch_timeout', message: 'timed out' },
      ]);
      // Backoff after one failure: 30 minutes; the failure was two hours ago.
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a source that has not failed ignores a stale retry time',
    async () => {
      await afterRun('failed', (now) => [blocked(plus(now, 3 * HOUR))]);
      // A good run after the failure clears the failure count: the old retry time no longer applies.
      await h.ctx.db.transaction(async (tx) => {
        const startedAt = new Date(h.now().getTime() - HOUR);
        const run = await startRun(tx, { sourceId: 'src-a', trigger: 'schedule', startedAt });
        await finishRun(tx, run.id, {
          status: 'ok',
          issues: [],
          finishedAt: new Date(startedAt.getTime() + MINUTE),
        });
      });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );
});
