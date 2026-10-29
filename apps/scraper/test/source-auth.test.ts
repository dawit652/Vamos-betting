import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { getSource } from '@vamos/db';
import { PoliteFetcher } from '@vamos/scraper';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from './cli-helpers';
import {
  ARSENAL_CHELSEA_JSON,
  createHarness,
  jsonDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type Harness,
} from './helpers';
import type { ScraperContext } from '../src/context';
import { runSource } from '../src/pipeline/run-source';

/**
 * A source that needs an API key in a header (docs/scraper.md 6.7): the key comes from the
 * environment by NAME, is sent to the allowed host, and is found nowhere afterwards.
 */

const SECRET = 'k3y-4f2c9a7e1b6d0835-DO-NOT-LEAK';
const VAR = 'SCRAPER_SECRET_API_FOOTBALL';
const API_URL = 'https://v3.football.api-sports.io/fixtures?league=162&season=2026';

const SOURCE_FILE = {
  id: 'api-auth',
  name: 'api with a key (test)',
  adapter: 'generic-json',
  upstream: 'api-sports-test',
  config: {
    allowedHosts: ['v3.football.api-sports.io'],
    requests: [{ url: API_URL, purpose: 'both' }],
    auth: { header: 'x-apisports-key', secret: VAR },
    sport: 'football',
    recordsPath: 'data.events[*]',
    fields: {
      home: 'h',
      away: 'a',
      competition: { path: 'league' },
      kickoff: { path: 'kick', format: 'iso' },
      externalRef: 'id',
      status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
      score: { homePath: 'hs', awayPath: 'as' },
    },
    scoreBasis: 'regular_time',
  },
};

type Call = { url: string; headers: Record<string, string> };
type Answer = (url: URL, call: Call) => Response | Error;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const cli = cliHarness({ db: h.ctx.db });
  cli.files.set('api.json', JSON.stringify(SOURCE_FILE));
  const upsert = await cli.run('sources', 'upsert', '--file', 'api.json');
  if (upsert.code !== 0) throw new Error(upsert.stderr);
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const body = () => jsonDoc([ARSENAL_CHELSEA_JSON]);
const robots = new Response('not found', { status: 404 });
const ok: Answer = (url) =>
  url.pathname === '/robots.txt'
    ? robots.clone()
    : new Response(body(), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetcher on a fake network, reading secrets from `env` (not process.env). */
function fetcherFor(answer: Answer, env: Record<string, string | undefined>) {
  const calls: Call[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: 'VamosTest/1.0',
    robots: 'enforce',
    minIntervalMs: 0,
    jitterFraction: 0,
    maxAttempts: 1,
    now: () => h.now().getTime(),
    sleep: () => Promise.resolve(),
    secrets: (name) => env[name],
    fetchImpl: (input, init) => {
      const call = { url: input, headers: { ...(init.headers as Record<string, string>) } };
      calls.push(call);
      const out = answer(new URL(input), call);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  });
  return { fetcher, calls };
}

/** A context whose logger writes every level into a string. */
function capture(fetcher: PoliteFetcher): { ctx: ScraperContext; logs: () => string } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = pino({ level: 'trace' }, sink);
  return { ctx: { ...h.ctx, fetcher, logger }, logs: () => lines.join('') };
}

const run = async (ctx: ScraperContext) =>
  runSource(ctx, (await getSource(h.ctx.db, 'api-auth'))!, { trigger: 'manual' });

function archiveText(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        parts.push(path, ...[]);
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      parts.push(path, bytes.toString('latin1'));
      try {
        parts.push(gunzipSync(bytes).toString('latin1'));
      } catch {
        /* not gzip: the raw bytes above were searched */
      }
    }
  };
  walk(h.ctx.config.scraper.archiveDir);
  return parts.join('\n');
}

/** Every row of every table of the test database, as text. */
async function databaseText(): Promise<string> {
  const { rows } = await h.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const { table_name } of rows) {
    const dump = await h.pool.query<{ t: string }>(`SELECT t::text AS t FROM "${table_name}" t`);
    parts.push(...dump.rows.map((r) => r.t));
  }
  return parts.join('\n');
}

async function expectNoTrace(logs: string): Promise<void> {
  expect(logs).not.toContain(SECRET);
  expect(await databaseText()).not.toContain(SECRET);
  expect(archiveText()).not.toContain(SECRET);
}

describe('a source with an API key header', () => {
  it('stores the NAME of the variable and never a value', async () => {
    const row = await getSource(h.ctx.db, 'api-auth');
    expect(row?.config).toMatchObject({ auth: { header: 'x-apisports-key', secret: VAR } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it(
    'sends the key to the allowed host, parses the answer, and leaves no trace of the value',
    async () => {
      const { fetcher, calls } = fetcherFor(ok, { [VAR]: SECRET });
      const { ctx, logs } = capture(fetcher);
      const result = await run(ctx);
      expect(result).toMatchObject({ status: 'ok', requests: 1, fixtures: 1 });

      const document = calls.filter((c) => new URL(c.url).pathname === '/fixtures');
      expect(document).toHaveLength(1);
      expect(document[0]?.headers['x-apisports-key']).toBe(SECRET);
      // robots.txt of the same host is read without it
      const robotsCall = calls.find((c) => new URL(c.url).pathname === '/robots.txt');
      expect(robotsCall?.headers['x-apisports-key']).toBeUndefined();

      expect(logs()).toContain('source run finished'); // the capture works
      await expectNoTrace(logs());
    },
    TEST_TIMEOUT,
  );

  it(
    'redacts the key from a network error that quotes the request, in the run issue, the logs and the database',
    async () => {
      const { fetcher } = fetcherFor(
        (url, call) =>
          url.pathname === '/robots.txt'
            ? robots.clone()
            : new Error(`socket hang up; request was ${JSON.stringify(call.headers)}`),
        { [VAR]: SECRET },
      );
      const { ctx, logs } = capture(fetcher);
      const result = await run(ctx);
      expect(result.status).toBe('failed');
      const { rows } = await h.pool.query<{ issues: Array<{ code: string; message: string }> }>(
        'SELECT issues FROM scrape_runs WHERE id = $1',
        [result.runId],
      );
      expect(rows[0]?.issues[0]).toMatchObject({ code: 'fetch_network' });
      expect(rows[0]?.issues[0]?.message).toContain('[redacted]');
      await expectNoTrace(logs());
    },
    TEST_TIMEOUT,
  );

  it(
    'drops a response that echoes the key: it is not archived and not parsed',
    async () => {
      const { fetcher } = fetcherFor(
        (url, call) =>
          url.pathname === '/robots.txt'
            ? robots.clone()
            : new Response(JSON.stringify({ debug: call.headers, ...JSON.parse(body()) }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        { [VAR]: SECRET },
      );
      const { ctx, logs } = capture(fetcher);
      const result = await run(ctx);
      expect(result).toMatchObject({ status: 'failed', fixtures: 0 });
      const { rows } = await h.pool.query<{ issues: Array<{ code: string; message: string }> }>(
        'SELECT issues FROM scrape_runs WHERE id = $1',
        [result.runId],
      );
      expect(rows[0]?.issues[0]).toMatchObject({ code: 'secret_echoed' });
      await expectNoTrace(logs());
    },
    TEST_TIMEOUT,
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])(
    'fails closed before any request when the variable is %s',
    async (_name, value) => {
      const { fetcher, calls } = fetcherFor(ok, { [VAR]: value });
      const { ctx, logs } = capture(fetcher);
      const result = await run(ctx);
      expect(result.status).toBe('failed');
      expect(calls).toEqual([]); // not even robots.txt
      const { rows } = await h.pool.query<{
        status: string;
        error: string;
        issues: Array<{ code: string; message: string; severity: string }>;
      }>('SELECT status, error, issues FROM scrape_runs WHERE id = $1', [result.runId]);
      expect(rows[0]?.issues).toEqual([
        expect.objectContaining({ code: 'secret_missing', severity: 'error' }),
      ]);
      expect(rows[0]?.issues[0]?.message).toContain(VAR);
      expect(rows[0]?.error).toContain(VAR);
      await expectNoTrace(logs());
    },
    TEST_TIMEOUT,
  );

  it(
    'a key with a line break inside is refused (secret_invalid) without a request',
    async () => {
      const { fetcher, calls } = fetcherFor(ok, { [VAR]: `${SECRET}\nx-injected: 1` });
      const { ctx, logs } = capture(fetcher);
      const result = await run(ctx);
      expect(result.status).toBe('failed');
      expect(calls).toEqual([]);
      const { rows } = await h.pool.query<{ issues: Array<{ code: string }> }>(
        'SELECT issues FROM scrape_runs WHERE id = $1',
        [result.runId],
      );
      expect(rows[0]?.issues[0]?.code).toBe('secret_invalid');
      await expectNoTrace(logs());
    },
    TEST_TIMEOUT,
  );

  it(
    'the context reads the key from its own reader, not from process.env',
    async () => {
      process.env[VAR] = 'from-process-env-must-not-be-used';
      try {
        const { fetcher, calls } = fetcherFor(ok, {});
        const { ctx } = capture(fetcher);
        expect((await run(ctx)).status).toBe('failed');
        expect(calls).toEqual([]);
      } finally {
        delete process.env[VAR];
      }
    },
    TEST_TIMEOUT,
  );
});

describe('source files', () => {
  const cli = () => {
    const c = cliHarness({ db: h.ctx.db });
    return c;
  };

  it('refuses a key written into the config and does not print it', async () => {
    const attempts: Array<[string, unknown]> = [
      ['as the variable name', { header: 'x-apisports-key', secret: SECRET }],
      ['as an extra value', { header: 'x-apisports-key', secret: VAR, value: SECRET }],
      ['as a header map', { headers: { 'x-apisports-key': SECRET } }],
    ];
    for (const [, auth] of attempts) {
      const c = cli();
      c.files.set(
        'bad.json',
        JSON.stringify({
          ...SOURCE_FILE,
          id: 'api-bad',
          config: { ...SOURCE_FILE.config, auth },
        }),
      );
      const result = await c.run('sources', 'upsert', '--file', 'bad.json');
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    }
    expect(await h.count(`SELECT count(*) AS n FROM scrape_sources WHERE id = 'api-bad'`)).toBe(0);
  });

  it('dry-fetch uses the same variable, prints the page and not the key', async () => {
    const { fetcher, calls } = fetcherFor(ok, { [VAR]: SECRET });
    const c = cliHarness({ fetcher });
    c.files.set('api.json', JSON.stringify(SOURCE_FILE));
    for (const flags of [[], ['--json']]) {
      const result = await c.run('dry-fetch', '--source-file', 'api.json', ...flags);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Arsenal');
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    }
    expect(calls.filter((x) => x.headers['x-apisports-key'] === SECRET)).toHaveLength(2);
  });

  it('dry-fetch without the variable exits 1, names it, and requests nothing', async () => {
    const { fetcher, calls } = fetcherFor(ok, {});
    const c = cliHarness({ fetcher });
    c.files.set('api.json', JSON.stringify(SOURCE_FILE));
    const result = await c.run('dry-fetch', '--source-file', 'api.json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('secret_missing');
    expect(result.stdout).toContain(VAR);
    expect(calls).toEqual([]);
  });

  it('dry-fetch redacts the key from a transport error', async () => {
    const { fetcher } = fetcherFor(
      (url, call) =>
        url.pathname === '/robots.txt' ? robots.clone() : new Error(JSON.stringify(call.headers)),
      { [VAR]: SECRET },
    );
    const c = cliHarness({ fetcher });
    c.files.set('api.json', JSON.stringify(SOURCE_FILE));
    const result = await c.run('dry-fetch', '--source-file', 'api.json', '--json');
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it('the API-Football draft source file is valid and uses the auth block', async () => {
    const draft = readFileSync(
      new URL('../../../docs/scraper-plan/data/source-api-football.json', import.meta.url),
      'utf8',
    );
    const c = cliHarness();
    c.files.set('draft.json', draft);
    const result = await c.run(
      'dry-parse',
      ...['--source-file', 'draft.json', '--document', 'doc.json'],
    );
    // The file loads (dry-parse reads the document after the source file); a missing document is the only complaint.
    expect(result.stderr).toContain('cannot read document doc.json');
    expect(JSON.parse(draft).config.auth).toEqual({
      header: 'x-apisports-key',
      secret: 'SCRAPER_SECRET_API_FOOTBALL',
    });
    expect(draft).not.toMatch(/api[-_ ]?key"?\s*:\s*"[0-9a-f]{16,}/i);
  });

  it('sources list shows the name, not a value', async () => {
    const result = await cli().run('sources', 'list', '--json');
    expect(result.stdout).not.toContain(SECRET);
  });
});
