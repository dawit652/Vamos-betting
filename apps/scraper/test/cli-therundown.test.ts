import { recordReferenceBudget } from '@vamos/db';
import { PoliteFetcher, therundownDayUrl } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT, T0 } from './helpers';
import { dayBody } from './therundown-bodies';

/** `therundown check` and `therundown budget`: a fake network, no real key, nothing written. */

const KEY = 'tr-cli-k3y-4d1e8a2b-DO-NOT-LEAK';
const SOURCE = {
  id: 'therundown',
  name: 'TheRundown (cli test)',
  adapter: 'therundown',
  upstream: 'TheRundown',
  config: {
    allowedHosts: ['therundown.io'],
    auth: { header: 'x-therundown-key', secret: 'SCRAPER_SECRET_THERUNDOWN' },
    competitions: [
      { sportId: 11, competition: 'TheRundown EPL' },
      { sportId: 14, competition: 'TheRundown La Liga' },
    ],
    markets: [1, 3],
    books: { anchors: [3, 32], others: [7] },
  },
};
const filters = { marketIds: [1, 3], bookIds: [3, 32, 7] };
const today = '2026-10-29';
const urlOf = (sportId: number) =>
  therundownDayUrl('https://therundown.io', sportId, today, filters);

type Call = { url: string; headers: Record<string, string> };
type Answer = { status: number; body: string; headers?: Record<string, string> };

function fetcherFor(answers: Map<string, Answer>, secrets: Record<string, string | undefined>) {
  const calls: Call[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: 'VamosTest/1.0',
    robots: 'off',
    minIntervalMs: 0,
    jitterFraction: 0,
    maxAttempts: 1,
    now: () => T0.getTime(),
    sleep: () => Promise.resolve(),
    secrets: (name) => secrets[name],
    fetchImpl: (input, init) => {
      calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
      const hit = answers.get(input) ?? { status: 404, body: 'not found' };
      return Promise.resolve(
        new Response(hit.body, {
          status: hit.status,
          headers: { 'content-type': 'application/json', ...hit.headers },
        }),
      );
    },
  });
  return { fetcher, calls };
}

const goodAnswers = () =>
  new Map<string, Answer>([
    [
      urlOf(11),
      {
        status: 200,
        body: dayBody([{ id: 'e1', kickoff: new Date('2026-10-30T15:00:00Z') }]),
        headers: {
          'x-data-delay-seconds': '60',
          'x-rate-limit': '2',
          'x-datapoints': '27',
          'x-datapoints-used': '1000',
          'x-datapoints-remaining': '24999000',
          'x-datapoints-reset': '2026-11-30T00:00:00Z',
        },
      },
    ],
    [urlOf(14), { status: 200, body: JSON.stringify({ events: [] }) }],
  ]);

describe('therundown check', () => {
  it('prints status, delay, rate, data points, events, prices and issues; writes nothing; never prints the key', async () => {
    const { fetcher, calls } = fetcherFor(goodAnswers(), { SCRAPER_SECRET_THERUNDOWN: KEY });
    // No database: a command that opened it would fail loudly.
    const cli = cliHarness({ fetcher });
    cli.files.set('source.json', JSON.stringify(SOURCE));
    const result = await cli.run('therundown', 'check', '--source-file', 'source.json');
    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([urlOf(11), urlOf(14)]);
    expect(calls[0]!.headers['x-therundown-key']).toBe(KEY);
    expect(calls.some((c) => c.url.includes(KEY))).toBe(false);

    expect(result.stdout).toContain(`GET ${urlOf(11)}`);
    expect(result.stdout).toContain('HTTP 200, data delay 60 s, rate limit 2/s');
    expect(result.stdout).toContain(
      'data points: cost 27, used 1000, remaining 24999000, reset 2026-11-30T00:00:00.000Z',
    );
    // One event, three books: 3 x (3 + 2) prices.
    expect(result.stdout).toContain('events 1, prices kept 15, issues none');
    expect(result.stdout).toContain('events 0, prices kept 0');
    expect(result.stdout).toContain('nothing was written to the database or the archive');
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it('--json is machine readable', async () => {
    const { fetcher } = fetcherFor(goodAnswers(), { SCRAPER_SECRET_THERUNDOWN: KEY });
    const cli = cliHarness({ fetcher });
    cli.files.set('source.json', JSON.stringify(SOURCE));
    const result = await cli.run('therundown', 'check', '--source-file', 'source.json', '--json');
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as {
      written: boolean;
      date: string;
      requests: Array<Record<string, unknown>>;
    };
    expect(json).toMatchObject({ written: false, date: today });
    expect(json.requests[0]).toMatchObject({
      sportId: 11,
      ok: true,
      status: 200,
      delaySeconds: '60',
      rateLimit: 2,
      dataPoints: { cost: 27, used: 1000, remaining: 24_999_000 },
      events: 1,
      pricesKept: 15,
    });
    expect(result.stdout).not.toContain(KEY);
  });

  it('exits 1 for a refused key (401), a missing key and a body that is not TheRundown, naming no key', async () => {
    const unauthorized = new Map<string, Answer>([
      [urlOf(11), { status: 401, body: 'nope' }],
      [urlOf(14), { status: 401, body: 'nope' }],
    ]);
    const first = fetcherFor(unauthorized, { SCRAPER_SECRET_THERUNDOWN: KEY });
    const cli = cliHarness({ fetcher: first.fetcher });
    cli.files.set('source.json', JSON.stringify(SOURCE));
    const refused = await cli.run('therundown', 'check', '--source-file', 'source.json');
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('HTTP 401');
    expect(refused.stdout + refused.stderr).not.toContain(KEY);

    const none = fetcherFor(goodAnswers(), {});
    const noKey = cliHarness({ fetcher: none.fetcher });
    noKey.files.set('source.json', JSON.stringify(SOURCE));
    const missing = await noKey.run('therundown', 'check', '--source-file', 'source.json');
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('SCRAPER_SECRET_THERUNDOWN');
    expect(none.calls).toHaveLength(0);

    const junk = fetcherFor(
      new Map([
        [urlOf(11), { status: 200, body: '<html>maintenance</html>' }],
        [urlOf(14), { status: 200, body: '{"events": []}' }],
      ]),
      { SCRAPER_SECRET_THERUNDOWN: KEY },
    );
    const bad = cliHarness({ fetcher: junk.fetcher });
    bad.files.set('source.json', JSON.stringify(SOURCE));
    const broken = await bad.run('therundown', 'check', '--source-file', 'source.json');
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain('the body did not parse');
  });

  it('exits 1 for a file that is not a valid TheRundown source, 2 for a wrong command line', async () => {
    const { fetcher } = fetcherFor(goodAnswers(), { SCRAPER_SECRET_THERUNDOWN: KEY });
    const cli = cliHarness({ fetcher });
    cli.files.set('other.json', JSON.stringify({ ...SOURCE, adapter: 'openfootball' }));
    const wrongAdapter = await cli.run('therundown', 'check', '--source-file', 'other.json');
    expect(wrongAdapter.code).toBe(1);
    cli.files.set('invalid.json', JSON.stringify({ ...SOURCE, config: { competitions: [] } }));
    const invalid = await cli.run('therundown', 'check', '--source-file', 'invalid.json');
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('not valid');

    expect((await cli.run('therundown')).code).toBe(2);
    expect((await cli.run('therundown', 'frobnicate')).code).toBe(2);
    expect((await cli.run('therundown', 'check', '--bogus')).code).toBe(2);
    expect((await cli.run('therundown', 'check', 'extra')).stderr).toContain('unexpected argument');
  });
});

describe('therundown check (source from the database) and budget', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  beforeAll(async () => {
    db = await catalogDatabase();
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  it('says so when there is no TheRundown source, then checks the one the database has', async () => {
    const { fetcher } = fetcherFor(goodAnswers(), { SCRAPER_SECRET_THERUNDOWN: KEY });
    const cli = cliHarness({ db: db.db, fetcher });
    const none = await cli.run('therundown', 'check');
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no source with the adapter "therundown"');

    cli.files.set('source.json', JSON.stringify(SOURCE));
    expect((await cli.run('sources', 'upsert', '--file', 'source.json')).code).toBe(0);
    const checked = await cli.run('therundown', 'check');
    expect(checked.code, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('events 1, prices kept 15');
  });

  it('budget: no row yet, then the row the poller keeps', async () => {
    const cli = cliHarness({ db: db.db });
    const empty = await cli.run('therundown', 'budget');
    expect(empty).toMatchObject({ code: 0 });
    expect(empty.stdout).toContain('no budget row yet');

    await db.db.transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: 'therundown',
        now: T0,
        cost: 27,
        snapshot: {
          used: 27,
          remaining: 24_999_973,
          resetAt: new Date('2026-11-30T00:00:00Z'),
          observedAt: T0,
        },
        delaySeconds: 60,
        rateLimit: 2,
      }),
    );
    const shown = await cli.run('therundown', 'budget');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('remaining    24999973');
    expect(shown.stdout).toContain('spent today  27 (UTC day 2026-10-29)');
    expect(shown.stdout).toContain('data delay   60 s');
    const json = await cli.run('therundown', 'budget', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({
      budget: { provider: 'therundown', used: 27, remaining: 24_999_973, level: 'unknown' },
    });
  });
});
