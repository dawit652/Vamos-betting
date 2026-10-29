import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cli/csv';
import { catalogDatabase, cliHarness, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

describe('parseCsv', () => {
  it('reads quotes, escaped quotes, commas, CRLF, a BOM and skips blank lines', () => {
    const rows = parseCsv('﻿a,b\r\n\r\n"x, y","say ""hi""",\n"two\nlines",z');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['x, y', 'say "hi"', ''] },
      { line: 4, cells: ['two\nlines', 'z'] },
    ]);
  });

  it('rejects an unclosed quote', () => {
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
  });
});

describe('aliases import', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    cli.files.set('src.json', JSON.stringify(OPENFOOTBALL_SOURCE));
    expect((await cli.run('sources', 'upsert', '--file', 'src.json')).code).toBe(0);
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  const aliasCount = async () => {
    const q = (t: string) => db.pool.query(`SELECT count(*) AS n FROM ${t}`);
    return (
      Number((await q('team_aliases')).rows[0].n) +
      Number((await q('competition_aliases')).rows[0].n)
    );
  };
  const HEADER = 'kind,sport,alias,target,source\n';

  it('adds team and competition aliases, normalising the alias text', async () => {
    cli.files.set(
      'a.csv',
      HEADER +
        'team,football,Spurs,Tottenham,\n' +
        'team,football,"Arsenal F.C.",Arsenal,cli-openfootball\n' +
        'competition,football,English Premier League,premier-league,*\n',
    );
    const result = await cli.run('aliases', 'import', '--file', 'a.csv');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('added team alias "spurs" -> Tottenham (all sources)');
    expect(result.stdout).toContain('-> Arsenal (cli-openfootball)');
    expect(result.stdout).toContain('3 added, 0 already present');
    expect(await aliasCount()).toBe(3);
    const audited = await db.pool.query(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.alias.added'`,
    );
    expect(Number(audited.rows[0].n)).toBe(3);
  });

  it('is idempotent: the same file again adds nothing', async () => {
    const result = await cli.run('aliases', 'import', '--file', 'a.csv');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 added, 3 already present');
    expect(await aliasCount()).toBe(3);
  });

  it('accepts columns in any order and the source column left out', async () => {
    cli.files.set('b.csv', 'target,alias,sport,kind\nEverton,Toffees,football,team\n');
    const result = await cli.run('aliases', 'import', '--file', 'b.csv', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      created: [{ kind: 'team', alias: 'toffees', target: 'Everton', source: null }],
    });
  });

  it('is all or nothing: every bad row is listed and none is imported', async () => {
    const before = await aliasCount();
    cli.files.set(
      'c.csv',
      HEADER +
        'team,football,Gunners,Arsenal,\n' + // fine, must not be kept
        'team,football,Nobody FC,No Such Team,\n' +
        'competition,football,Cup,no-such-league,\n' +
        'team,football,Reds,Liverpool,no-such-source\n' +
        'team,football,Spurs,Arsenal,\n', // "spurs" already means Tottenham
    );
    const result = await cli.run('aliases', 'import', '--file', 'c.csv');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('nothing was imported: 4 problem(s)');
    expect(result.stderr).toContain('line 3: no team with short name "No Such Team" in football');
    expect(result.stderr).toContain('line 4: no competition with slug "no-such-league"');
    expect(result.stderr).toContain('line 5: unknown source "no-such-source"');
    expect(result.stderr).toContain('line 6: "spurs" already maps to a different team');
    expect(await aliasCount()).toBe(before);
  });

  it('refuses a malformed file with the line numbers, and writes nothing', async () => {
    const before = await aliasCount();
    cli.files.set(
      'd.csv',
      HEADER + 'club,football,X,Arsenal,\nteam,rugby,Y,Arsenal,\nteam,football, ,Arsenal,\n',
    );
    const result = await cli.run('aliases', 'import', '--file', 'd.csv');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('line 2: kind must be "team" or "competition"');
    expect(result.stderr).toContain('line 3: sport must be one of football');
    expect(result.stderr).toContain('line 4: the alias is empty');
    cli.files.set('e.csv', 'kind,alias\nteam,X\n');
    const header = await cli.run('aliases', 'import', '--file', 'e.csv');
    expect(header.code).toBe(1);
    expect(header.stderr).toContain('missing: sport, target');
    cli.files.set('f.csv', '');
    expect((await cli.run('aliases', 'import', '--file', 'f.csv')).stderr).toContain('is empty');
    expect((await cli.run('aliases', 'import', '--file', 'missing.csv')).code).toBe(1);
    expect(await aliasCount()).toBe(before);
  });
});
