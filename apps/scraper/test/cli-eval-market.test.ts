import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliHarness } from './cli-helpers';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/football-data-sample.csv'), 'utf8');

describe('eval market', () => {
  it('prints the sections for a file, without a database', async () => {
    const cli = cliHarness();
    cli.files.set('sample.csv', FIXTURE);
    const r = await cli.run('eval', 'market', '--file', 'sample.csv');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Market-path evaluation (close odds): 44 matches read, 41 priced');
    for (const title of [
      '1X2',
      'Over/under 2.5',
      'Both teams',
      'Asian handicap',
      'Half-time 1X2',
      'Correct score',
    ]) {
      expect(r.stdout).toContain(title);
    }
    expect(r.stdout).toContain('Per division');
  });

  it('--json is machine-readable and --file can repeat', async () => {
    const cli = cliHarness();
    cli.files.set('a.csv', FIXTURE);
    cli.files.set('b.csv', FIXTURE);
    const r = await cli.run('eval', 'market', '--file', 'a.csv', '--file', 'b.csv', '--json');
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as { rows: number; overall: { matches: number } };
    expect(json.rows).toBe(88);
    expect(json.overall.matches).toBe(82);
  });

  it('needs exactly one of --file and --dir, and a readable file', async () => {
    const cli = cliHarness();
    expect((await cli.run('eval', 'market')).code).toBe(2);
    expect((await cli.run('eval', 'market', '--file', 'x.csv', '--dir', 'd')).code).toBe(2);
    expect((await cli.run('eval', 'market', '--file', 'missing.csv')).code).toBe(1);
  });
});
