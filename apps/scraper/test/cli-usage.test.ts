import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../src/cli';
import { cliHarness, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { ARSENAL_CHELSEA_OF, ofDoc } from './helpers';

describe('command line', () => {
  const cli = cliHarness();

  it('prints the usage and exits 2 without a command', async () => {
    const result = await cli.run();
    expect(result.code).toBe(2);
    expect(result.stdout).toBe(USAGE);
  });

  it('prints the usage and exits 0 for help', async () => {
    for (const args of [['help'], ['--help'], ['sources', 'list', '--help']]) {
      const result = await cli.run(...args);
      expect(result).toMatchObject({ code: 0, stdout: USAGE });
    }
  });

  it('exits 2 for an unknown command, a missing sub-command and an unknown option', async () => {
    const unknown = await cli.run('frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "frobnicate"');
    expect(unknown.stderr).toContain('usage:');
    expect((await cli.run('sources')).stderr).toContain('"sources" needs a sub-command');
    expect((await cli.run('sources', 'remove')).code).toBe(2);
    const option = await cli.run('dry-parse', '--bogus');
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('--bogus');
    expect((await cli.run('sources', 'list', 'extra')).stderr).toContain('unexpected argument');
  });

  it('documents every command', () => {
    for (const name of [
      'sources list',
      'sources upsert',
      'dry-parse',
      'dry-fetch',
      'aliases import',
      'ratings backfill',
    ]) {
      expect(USAGE).toContain(name);
    }
  });
});

describe('as a program (tsx, real files, no database)', () => {
  const run = promisify(execFile);
  const exec = (...args: string[]) =>
    run('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], { cwd: join(__dirname, '..') }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );

  it('dry-parse reads files, prints to stdout and exits 0; failures exit 1 or 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vamos-cli-'));
    try {
      writeFileSync(join(dir, 'source.json'), JSON.stringify(OPENFOOTBALL_SOURCE));
      writeFileSync(join(dir, 'page.json'), ofDoc([ARSENAL_CHELSEA_OF]));
      const ok = await exec(
        ...[
          'dry-parse',
          '--source-file',
          join(dir, 'source.json'),
          '--document',
          join(dir, 'page.json'),
        ],
      );
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('Arsenal FC v Chelsea FC');
      const missing = await exec(
        'dry-parse',
        '--source-file',
        join(dir, 'none.json'),
        '--document',
        'x',
      );
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('cannot read source file');
      expect((await exec('nope')).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
