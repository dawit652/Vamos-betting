import { setCompetitionPolicy } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { runPromotion } from '../src/tasks/promote';
import { cliHarness } from './cli-helpers';
import {
  ARSENAL_CHELSEA_OF,
  createHarness,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  type Harness,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };

async function start(autoOpen: boolean): Promise<ReturnType<typeof cliHarness>> {
  const harness = await createHarness();
  h = harness;
  await harness.ctx.db.transaction((tx) =>
    setCompetitionPolicy(tx, harness.premier, { autoOpen }, SYSTEM),
  );
  harness.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  await harness.run('src-a');
  await runPromotion(harness.ctx);
  return cliHarness({ db: harness.ctx.db });
}

const writes = async () => ({
  audit: await h!.count('SELECT count(*) FROM audit_log'),
  items: await h!.count('SELECT count(*) FROM scrape_review_items'),
  events: await h!.count('SELECT count(*) FROM events'),
});

describe('feed report', () => {
  it(
    'explains a locked event in plain English and counts the review queue',
    async () => {
      const cli = await start(false);
      const before = await writes();
      const result = await cli.run('feed', 'report');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Arsenal v Chelsea');
      expect(result.stdout).toContain(
        'auto open is off for this competition (or the competition is switched off)',
      );
      expect(result.stdout).toMatch(/odds_approval: 1/);
      expect(result.stdout).toContain('policy_off: 1');
      expect(await writes()).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'says when the kickoff opens, with auto open on',
    async () => {
      const cli = await start(true);
      const result = await cli.run('feed', 'report', '--days', '10');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('kickoff not confirmed:');
      expect(result.stdout).toContain('opens from 2026-10-30 15:00');
      expect(result.stdout).not.toContain('auto open is off');
    },
    TEST_TIMEOUT,
  );

  it(
    'prints one JSON object with --json and writes nothing',
    async () => {
      const cli = await start(true);
      const before = await writes();
      const result = await cli.run('feed', 'report', '--json');
      expect(result.code).toBe(0);
      const json = JSON.parse(result.stdout) as {
        days: number;
        competitions: unknown[];
        sources: unknown[];
        reviewQueue: Array<{ kind: string; count: number }>;
        lockedMatches: Array<{ kickoff: string; home: string; reasons: Array<{ code: string }> }>;
      };
      expect(json.days).toBe(7);
      expect(json.reviewQueue.find((k) => k.kind === 'odds_approval')?.count).toBe(1);
      expect(json.lockedMatches).toHaveLength(1);
      expect(json.lockedMatches[0]?.kickoff).toBe('2026-11-02T15:00:00.000Z');
      expect(json.lockedMatches[0]?.reasons.map((r) => r.code)).toContain('kickoff_unconfirmed');
      expect(await writes()).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it('rejects a bad --days with exit code 2', async () => {
    const cli = cliHarness();
    for (const bad of ['0', '31', 'x', '1.5']) {
      const result = await cli.run('feed', 'report', '--days', bad);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--days must be a whole number from 1 to 30');
    }
    expect((await cli.run('feed')).code).toBe(2);
  });
});
