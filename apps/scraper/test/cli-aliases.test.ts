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

describe('aliases list and remove', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    cli.files.set('src.json', JSON.stringify(OPENFOOTBALL_SOURCE));
    expect((await cli.run('sources', 'upsert', '--file', 'src.json')).code).toBe(0);
    cli.files.set(
      'a.csv',
      'kind,sport,alias,target,source\n' +
        'team,football,Spurs,Tottenham,\n' +
        'team,football,Gunners,Arsenal,cli-openfootball\n' +
        'competition,football,English Premier League,premier-league,*\n',
    );
    expect((await cli.run('aliases', 'import', '--file', 'a.csv')).code).toBe(0);
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  interface Listed {
    id: string;
    kind: string;
    alias: string;
    source: string | null;
  }
  const list = async (...args: string[]): Promise<Listed[]> => {
    const result = await cli.run('aliases', 'list', '--json', ...args);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    return (JSON.parse(result.stdout) as { aliases: Listed[] }).aliases;
  };
  const removedAudits = async (id: string) =>
    Number(
      (
        await db.pool.query(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.alias.removed' AND target_id = $1`,
          [id],
        )
      ).rows[0].n,
    );

  it('lists every alias with its id, as a table and as JSON', async () => {
    const text = await cli.run('aliases', 'list');
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^id\s+kind\s+alias\s+target\s+source\s+created/);
    expect(text.stdout).toMatch(/spurs\s+Tottenham/);
    expect(text.stdout).toContain('3 alias(es)');
    const all = await list();
    expect(all.map((a) => a.alias).sort()).toEqual(['english premier league', 'gunners', 'spurs']);
    expect(all.find((a) => a.alias === 'gunners')?.source).toBe('cli-openfootball');
  });

  it('filters by --kind and --q (name or target, case-insensitive)', async () => {
    expect((await list('--kind', 'competition')).map((a) => a.alias)).toEqual([
      'english premier league',
    ]);
    expect((await list('--kind', 'team')).map((a) => a.kind)).toEqual(['team', 'team']);
    expect((await list('--q', 'SPUR')).map((a) => a.alias)).toEqual(['spurs']);
    expect((await list('--q', 'arsenal')).map((a) => a.alias)).toEqual(['gunners']);
    expect(await list('--q', 'zzz-nothing')).toEqual([]);
    const bad = await cli.run('aliases', 'list', '--kind', 'player');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--kind must be "team" or "competition"');
  });

  it('removes a team alias and a competition alias by id, audited once', async () => {
    const [spurs] = await list('--q', 'spurs');
    const result = await cli.run('aliases', 'remove', '--id', spurs!.id);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('removed team alias "spurs" (all sources)');
    expect(await list('--q', 'spurs')).toEqual([]);
    expect(await removedAudits(spurs!.id)).toBe(1);

    const [competition] = await list('--kind', 'competition');
    expect((await cli.run('aliases', 'remove', '--id', competition!.id, '--json')).code).toBe(0);
    expect(await list('--kind', 'competition')).toEqual([]);
    expect(await removedAudits(competition!.id)).toBe(1);
  });

  it('fails for an unknown or already removed id and audits nothing more', async () => {
    const [gunners] = await list('--q', 'gunners');
    expect((await cli.run('aliases', 'remove', '--id', gunners!.id)).code).toBe(0);
    for (const id of [gunners!.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const result = await cli.run('aliases', 'remove', '--id', id);
      expect(result.code, id).toBe(1);
      expect(result.stderr).toContain('no alias with id');
    }
    expect(await removedAudits(gunners!.id)).toBe(1);
    expect((await cli.run('aliases', 'remove')).code).toBe(2);
  });

  it('lets an alias be added again after removal (the point of removing)', async () => {
    cli.files.set('b.csv', 'kind,sport,alias,target\nteam,football,Spurs,Everton\n');
    expect((await cli.run('aliases', 'import', '--file', 'b.csv')).code).toBe(0);
    expect((await list('--q', 'spurs')).length).toBe(1);
  });
});

describe('aliases export and import --skip-problems (L4, docs/plans/name-learning.md)', () => {
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

  const HEADER = 'kind,sport,alias,target,source\n';

  it('exports every alias in the import columns, and the export imports as already present', async () => {
    cli.files.set(
      'a.csv',
      HEADER +
        'team,football,Spurs,Tottenham,\n' +
        'team,football,"The Gunners",Arsenal,cli-openfootball\n' +
        'competition,football,English Premier League,premier-league,*\n',
    );
    expect((await cli.run('aliases', 'import', '--file', 'a.csv')).code).toBe(0);
    const out = await cli.run('aliases', 'export');
    expect(out.code).toBe(0);
    expect(out.stdout.split('\n')).toEqual([
      'kind,sport,alias,target,source',
      'competition,football,english premier league,premier-league,',
      'team,football,spurs,Tottenham,',
      'team,football,the gunners,Arsenal,cli-openfootball',
    ]);
    expect(out.stderr).toBe('3 aliases exported');
    cli.files.set('export.csv', `${out.stdout}\n`);
    const again = await cli.run('aliases', 'import', '--file', 'export.csv');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('0 added, 3 already present');
  });

  it('--skip-problems adds what it can, skips the rest and never re-adds a removed alias', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM team_aliases WHERE alias_norm = 'spurs'`,
    );
    expect((await cli.run('aliases', 'remove', '--id', rows[0]!.id)).code).toBe(0);
    cli.files.set(
      'b.csv',
      HEADER +
        'team,football,Spurs,Tottenham,\n' +
        'team,football,Nobody FC,Nobody,\n' +
        'team,football,Gooners,Arsenal,\n',
    );
    // All or nothing without the flag, as before.
    expect((await cli.run('aliases', 'import', '--file', 'b.csv')).code).not.toBe(0);
    const result = await cli.run('aliases', 'import', '--file', 'b.csv', '--skip-problems');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skipped line 2: "spurs" was removed by someone');
    expect(result.stdout).toContain('skipped line 3: no team with short name "Nobody" in football');
    expect(result.stdout).toContain('1 added, 0 already present, 2 skipped');
    const count = async (alias: string) =>
      Number(
        (
          await db.pool.query(`SELECT count(*) AS n FROM team_aliases WHERE alias_norm = $1`, [
            alias,
          ])
        ).rows[0].n,
      );
    expect(await count('spurs')).toBe(0);
    expect(await count('gooners')).toBe(1);
  });
});
