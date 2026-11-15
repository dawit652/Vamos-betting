import { setSourceEnabled } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness, JSON_SOURCE, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;
beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

const sourceRow = async (id: string) =>
  (await db.pool.query('SELECT * FROM scrape_sources WHERE id = $1', [id])).rows[0] as
    { enabled: boolean; name: string; config: Record<string, unknown> } | undefined;
const auditCount = async (action: string) =>
  Number(
    (await db.pool.query('SELECT count(*) AS n FROM audit_log WHERE action = $1', [action])).rows[0]
      .n,
  );

describe('sources list', () => {
  it('says so when there are no sources', async () => {
    const result = await cli.run('sources', 'list');
    expect(result).toMatchObject({ code: 0, stdout: 'no sources', stderr: '' });
  });
});

describe('sources upsert', () => {
  it('creates a source DISABLED and audits it', async () => {
    cli.files.set('a.json', JSON.stringify(OPENFOOTBALL_SOURCE));
    const result = await cli.run('sources', 'upsert', '--file', 'a.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('created source cli-openfootball');
    expect(result.stdout).toContain('disabled');
    expect((await sourceRow('cli-openfootball'))?.enabled).toBe(false);
    expect(await auditCount('scrape.source.upserted')).toBe(1);
  });

  it('is idempotent: the same file again changes and audits nothing', async () => {
    const result = await cli.run('sources', 'upsert', '--file', 'a.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('unchanged source cli-openfootball');
    expect(await auditCount('scrape.source.upserted')).toBe(1);
  });

  it('updates the config but never switches the source on or off', async () => {
    await db.db.transaction((tx) =>
      setSourceEnabled(tx, 'cli-openfootball', true, { system: 't' }),
    );
    cli.files.set('a.json', JSON.stringify({ ...OPENFOOTBALL_SOURCE, name: 'renamed' }));
    const result = await cli.run('sources', 'upsert', '--file', 'a.json');
    expect(result.stdout).toContain('updated source cli-openfootball');
    expect(result.stdout).toContain('state: enabled (unchanged)');
    expect(await sourceRow('cli-openfootball')).toMatchObject({ enabled: true, name: 'renamed' });
  });

  it('lists the sources with their state, as text and as JSON', async () => {
    cli.files.set('b.json', JSON.stringify(JSON_SOURCE));
    expect((await cli.run('sources', 'upsert', '--file', 'b.json')).code).toBe(0);
    const text = await cli.run('sources', 'list');
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/cli-json\s+generic-json\s+example-api\s+disabled\s+never run/);
    expect(text.stdout).toMatch(/cli-openfootball\s+openfootball\s+openfootball\s+enabled/);
    const json = await cli.run('sources', 'list', '--json');
    const rows = JSON.parse(json.stdout) as Array<{ id: string; enabled: boolean }>;
    expect(rows.map((r) => [r.id, r.enabled])).toEqual([
      ['cli-json', false],
      ['cli-openfootball', true],
    ]);
  });

  it('surfaces a config error clearly: a score needs a status field with a map', async () => {
    const bad = structuredClone(JSON_SOURCE) as typeof JSON_SOURCE & { id: string };
    bad.id = 'cli-bad';
    delete (bad.config.fields as Record<string, unknown>).status;
    cli.files.set('bad.json', JSON.stringify(bad));
    const result = await cli.run('sources', 'upsert', '--file', 'bad.json');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('the config of source "cli-bad" (generic-json) is not valid');
    expect(result.stderr).toMatch(/status/);
    expect(await sourceRow('cli-bad')).toBeUndefined();
  });

  it('refuses a bad config (allowed hosts do not cover the request) without writing', async () => {
    const bad = { ...OPENFOOTBALL_SOURCE, id: 'cli-hosts' };
    bad.config = { ...bad.config, allowedHosts: ['elsewhere.example.com'] };
    cli.files.set('bad.json', JSON.stringify(bad));
    const result = await cli.run('sources', 'upsert', '--file', 'bad.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not valid');
    expect(await sourceRow('cli-hosts')).toBeUndefined();
  });

  it('refuses a malformed file: not JSON, unknown adapter, extra keys, missing file', async () => {
    cli.files.set('x.json', '{not json');
    expect((await cli.run('sources', 'upsert', '--file', 'x.json')).stderr).toContain(
      'not valid JSON',
    );
    cli.files.set('x.json', JSON.stringify({ ...OPENFOOTBALL_SOURCE, adapter: 'nope' }));
    const unknown = await cli.run('sources', 'upsert', '--file', 'x.json');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('adapter');
    cli.files.set('x.json', JSON.stringify({ ...OPENFOOTBALL_SOURCE, enabled: true }));
    const extra = await cli.run('sources', 'upsert', '--file', 'x.json');
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain('enabled');
    const missing = await cli.run('sources', 'upsert', '--file', 'missing.json');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read source file missing.json');
  });

  it('exits 2 for a missing --file', async () => {
    const result = await cli.run('sources', 'upsert');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--file is required');
  });
});
