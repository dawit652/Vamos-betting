import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness, JSON_SOURCE, OPENFOOTBALL_SOURCE } from './cli-helpers';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedJson,
  finishedOf,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

describe('dry-parse (no database, no network)', () => {
  const cli = cliHarness();
  cli.files.set('of.json', JSON.stringify(OPENFOOTBALL_SOURCE));
  cli.files.set('json.json', JSON.stringify(JSON_SOURCE));

  it('prints the fixtures and results of a saved openfootball document', async () => {
    cli.files.set('page.json', ofDoc([ARSENAL_CHELSEA_OF, finishedOf([2, 1], [1, 0])]));
    const result = await cli.run(
      'dry-parse',
      '--source-file',
      'of.json',
      '--document',
      'page.json',
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Premier League: Arsenal FC v Chelsea FC');
    expect(result.stdout).toMatch(/result .*\[finished 2-1 \(ht 1-0\), regular_time\]/);
  });

  it('parses a generic-json document and honours --url, --at and --limit', async () => {
    cli.files.set(
      'events.json',
      jsonDoc([ARSENAL_CHELSEA_JSON, { ...ARSENAL_CHELSEA_JSON, id: 2, h: 'Everton', a: 'Spurs' }]),
    );
    const result = await cli.run(
      ...['dry-parse', '--source-file', 'json.json', '--document', 'events.json'],
      ...['--url', URL_B, '--at', '2026-10-29T12:00:00Z', '--limit', '1'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 fixtures, 0 results');
    expect(result.stdout).toContain('... 1 more fixtures (use --limit)');
  });

  it('writes the observations as JSON with --json', async () => {
    cli.files.set('page.json', ofDoc([ARSENAL_CHELSEA_OF]));
    const result = await cli.run(
      ...['dry-parse', '--source-file', 'of.json', '--document', 'page.json', '--json'],
    );
    const body = JSON.parse(result.stdout) as { fixtures: Array<{ home: string }>; issues: [] };
    expect(body.fixtures.map((f) => f.home)).toEqual(['Arsenal FC']);
  });

  it('reports a document it cannot understand and exits 1', async () => {
    cli.files.set('page.json', '<html>not json</html>');
    const result = await cli.run(
      'dry-parse',
      '--source-file',
      'of.json',
      '--document',
      'page.json',
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('(fatal)');
  });

  it('prints the issues of a partly bad document but exits 0', async () => {
    cli.files.set(
      'page.json',
      ofDoc([ARSENAL_CHELSEA_OF, { ...ARSENAL_CHELSEA_OF, time: '99:99', team1: 'Spurs' }]),
    );
    const result = await cli.run(
      'dry-parse',
      '--source-file',
      'of.json',
      '--document',
      'page.json',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 fixtures');
    expect(result.stdout).toMatch(/error {2}\w+:/);
  });

  it('exits 1 for an invalid source file, a missing document, and 2 for bad options', async () => {
    const bad = structuredClone(JSON_SOURCE);
    delete (bad.config.fields as Record<string, unknown>).status;
    cli.files.set('bad.json', JSON.stringify(bad));
    const config = await cli.run(
      'dry-parse',
      '--source-file',
      'bad.json',
      '--document',
      'page.json',
    );
    expect(config.code).toBe(1);
    expect(config.stderr).toContain('is not valid');
    const missing = await cli.run(
      'dry-parse',
      '--source-file',
      'of.json',
      '--document',
      'nope.html',
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read document nope.html');
    expect((await cli.run('dry-parse', '--source-file', 'of.json')).code).toBe(2);
    const at = await cli.run(
      ...['dry-parse', '--source-file', 'of.json', '--document', 'page.json', '--at', 'soon'],
    );
    expect(at.code).toBe(2);
  });
});

describe('dry-fetch (the fake network of the runner tests)', () => {
  let h: Harness;
  let cli: ReturnType<typeof cliHarness>;
  beforeAll(async () => {
    h = await createHarness();
    cli = cliHarness({ fetcher: h.ctx.fetcher });
    cli.files.set('of.json', JSON.stringify({ ...OPENFOOTBALL_SOURCE, id: 'src-a' }));
    cli.files.set('json.json', JSON.stringify({ ...JSON_SOURCE, id: 'src-b' }));
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await h?.close();
  }, SETUP_TIMEOUT);

  const TABLES = [
    'scrape_runs',
    'scrape_raw',
    'scrape_observations',
    'scrape_observation_history',
    'scrape_review_items',
    'audit_log',
    'outbox_events',
    'events',
  ];
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const table of TABLES) out[table] = await h.count(`SELECT count(*) AS n FROM ${table}`);
    return out;
  };
  const archiveFiles = () => readdirSync(h.ctx.config.scraper.archiveDir, { recursive: true });

  it('fetches, parses and prints, and writes nothing anywhere', async () => {
    h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
    const before = await counts();
    const filesBefore = archiveFiles();
    const result = await cli.run('dry-fetch', '--source-file', 'of.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`GET ${URL_A}`);
    expect(result.stdout).toContain('200 application/json');
    expect(result.stdout).toContain('Premier League: Arsenal FC v Chelsea FC');
    expect(result.stdout).toContain('nothing was written');
    expect(await counts()).toEqual(before);
    expect(archiveFiles()).toEqual(filesBefore);
    expect(Object.keys(before)).toContain('scrape_observations');
  });

  it('works for a json source, and --json says that nothing was written', async () => {
    h.serve(URL_B, jsonDoc([finishedJson([1, 0])]));
    const result = await cli.run('dry-fetch', '--source-file', 'json.json', '--json');
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as {
      written: boolean;
      requests: Array<{ ok: boolean; results: unknown[] }>;
    };
    expect(body.written).toBe(false);
    expect(body.requests[0]).toMatchObject({ ok: true });
    expect(body.requests[0]!.results).toHaveLength(1);
  });

  it('exits 1 when the site answers with an error', async () => {
    h.serve(URL_A, { status: 404, body: 'gone' });
    const result = await cli.run('dry-fetch', '--source-file', 'of.json');
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/error \(http_error\)|refused|404/);
  });

  it('exits 1 for a page that cannot be parsed', async () => {
    h.serve(URL_A, '<html>maintenance</html>');
    const result = await cli.run('dry-fetch', '--source-file', 'of.json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('(fatal)');
  });

  it('keeps the allow-list: a redirect to a host outside allowedHosts is refused', async () => {
    h.serve(URL_A, {
      status: 302,
      body: '',
      headers: { location: 'https://evil.example.com/en1.json' },
    });
    h.serve('https://evil.example.com/en1.json', ofDoc([ARSENAL_CHELSEA_OF]));
    const result = await cli.run('dry-fetch', '--source-file', 'of.json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('refused (host_not_allowed)');
    expect(result.stdout).not.toContain('Arsenal');
  });

  it('exits 1 for a config the runner would refuse, without fetching', async () => {
    const bad = structuredClone(OPENFOOTBALL_SOURCE);
    bad.config.allowedHosts = ['other.example.com'];
    cli.files.set('host.json', JSON.stringify(bad));
    const result = await cli.run('dry-fetch', '--source-file', 'host.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not valid');
  });
});
