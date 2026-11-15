import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFamilyHistory, MARKET_FAMILY_HISTORY_ACTION } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from './cli-helpers';
import { createHarness, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/** `eval families` (check 0.6, task A2): the history test of the factory's families. */

const FIXTURE = readFileSync(join(__dirname, 'fixtures/football-data-sample.csv'), 'utf8');

interface Json {
  matches: number;
  stored: string | null;
  families: Array<{
    family: string;
    matches: number;
    selections: number;
    marginBps: number;
    suggestedMarginBps: number;
    passed: boolean;
  }>;
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('eval families', () => {
  it('tests every family offline, without a database, at the default margins', async () => {
    const cli = cliHarness();
    cli.files.set('sample.csv', FIXTURE);
    const r = await cli.run('eval', 'families', '--file', 'sample.csv', '--json');
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Json;
    expect(json.stored).toBeNull();
    expect(json.matches).toBe(41);
    expect(json.families.length).toBeGreaterThan(60);
    for (const f of json.families) {
      expect(f.matches).toBeGreaterThan(0);
      expect(f.matches).toBeLessThanOrEqual(41);
      // 41 matches: no selection reaches 200, so nothing raises a margin; only the hold can fail.
      expect(f.suggestedMarginBps).toBe(f.marginBps);
    }
    const text = await cli.run('eval', 'families', '--file', 'sample.csv');
    expect(text.stdout).toContain('suggested');
    expect(text.stdout).toContain('htft_ou');
  });

  it('measures the pricing switches of task 2.2 offline, never with --write', async () => {
    const cli = cliHarness();
    cli.files.set('sample.csv', FIXTURE);
    const base = JSON.parse(
      (await cli.run('eval', 'families', '--file', 'sample.csv', '--json')).stdout,
    ) as Json & { families: Array<{ family: string; holdBps: number }> };
    const r = await cli.run(
      'eval',
      'families',
      '--file',
      'sample.csv',
      '--first-half-share',
      '0.45',
      '--draw-correction=-0.1',
      '--json',
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Json & {
      grids: unknown;
      families: Array<{ family: string; holdBps: number }>;
    };
    expect(json.grids).toEqual({ firstHalfShare: 0.45, drawCorrection: -0.1 });
    const hold = (j: { families: Array<{ family: string; holdBps: number }> }, f: string) =>
      j.families.find((x) => x.family === f)?.holdBps;
    // A half-time family moves with the first-half share.
    expect(hold(json, 'h2_ou')).not.toBe(hold(base, 'h2_ou'));
    expect(
      (await cli.run('eval', 'families', '--file', 'sample.csv', '--first-half-share', '0.9')).code,
    ).toBe(2);
    expect(
      (
        await cli.run(
          'eval',
          'families',
          '--file',
          'sample.csv',
          '--write',
          '--first-half-share',
          '0.45',
        )
      ).code,
    ).toBe(2);
  });

  it('needs exactly one of --file and --dir', async () => {
    const cli = cliHarness();
    expect((await cli.run('eval', 'families')).code).toBe(2);
    expect((await cli.run('eval', 'families', '--file', 'x.csv', '--dir', 'd')).code).toBe(2);
    expect((await cli.run('eval', 'families', '--file', 'missing.csv')).code).toBe(1);
  });

  it(
    '--write stores the result for the weekly job, audited',
    async () => {
      const cli = cliHarness({ db: h.ctx.db });
      cli.files.set('sample.csv', FIXTURE);
      const r = await cli.run('eval', 'families', '--file', 'sample.csv', '--write', '--json');
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout) as Json;
      expect(json.stored).not.toBeNull();
      const stored = await loadFamilyHistory(h.ctx.db);
      expect(stored?.matches).toBe(41);
      expect(stored?.files).toEqual(['sample.csv']);
      expect(Object.keys(stored!.families).sort()).toEqual(
        json.families.map((f) => f.family).sort(),
      );
      expect(
        await h.count(`SELECT count(*) AS n FROM audit_log WHERE action = $1`, [
          MARKET_FAMILY_HISTORY_ACTION,
        ]),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );
});
