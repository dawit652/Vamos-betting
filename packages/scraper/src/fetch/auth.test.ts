import { describe, expect, it } from 'vitest';
import { REDACTED, authHeaderProblem, redactSecret } from './auth';
import { PoliteFetcher, type PoliteFetcherOptions } from './polite-fetcher';
import { fakeFetch, makeClock, res, ROBOTS_OK, type Handler } from './test-helpers';
import type { FetchPlanItem } from '../types';

const UA = 'NahubetBot/1.0 (+mailto:ops@example.com)';
const API = 'v3.football.api-sports.io';
const CDN = 'cdn.api-sports.io';
const SECRET = 's3cr3t-K3Y-0123456789abcdef';
const VAR = 'SCRAPER_SECRET_API_FOOTBALL';
const CTX = { allowedHosts: [API, CDN], sourceKey: 'api-football' };

const item = (path = '/fixtures?league=162', host = API): FetchPlanItem => ({
  url: `https://${host}${path}`,
  purpose: 'both',
  auth: { header: 'x-apisports-key', secret: VAR },
});
const json = (body = '{"response":[]}', status = 200, headers: Record<string, string> = {}) =>
  res(body, status, { 'content-type': 'application/json', ...headers });

function setup(
  handler: Handler,
  env: Record<string, string | undefined> = { [VAR]: SECRET },
  options: Partial<PoliteFetcherOptions> = {},
) {
  const clock = makeClock();
  const f = fakeFetch(handler);
  const reads: string[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: UA,
    fetchImpl: f.impl,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    robots: 'off',
    minIntervalMs: 0,
    secrets: (name) => {
      reads.push(name);
      return env[name];
    },
    ...options,
  });
  return { fetcher, f, reads, clock };
}

describe('request authentication: sending the key', () => {
  it('sends the value of the named variable in the configured header, lower-cased', async () => {
    const { fetcher, f, reads } = setup(() => json());
    const r = await fetcher.fetch(
      { ...item(), auth: { header: 'X-ApiSports-Key', secret: VAR } },
      CTX,
    );
    expect(r.kind).toBe('ok');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.headers['x-apisports-key']).toBe(SECRET);
    expect(f.calls[0]?.headers['user-agent']).toBe(UA);
    expect(reads).toEqual([VAR]);
  });

  it('sends no key header for an item without auth, and never reads a secret', async () => {
    const { fetcher, f, reads } = setup(() => json());
    await fetcher.fetch({ url: `https://${API}/x`, purpose: 'both' }, CTX);
    expect(Object.keys(f.calls[0]?.headers ?? {})).not.toContain('x-apisports-key');
    expect(reads).toEqual([]);
  });

  it('trims the blanks and the line break an env file or a mounted secret leaves', async () => {
    const { fetcher, f } = setup(() => json(), { [VAR]: `  ${SECRET}\n` });
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(f.calls[0]?.headers['x-apisports-key']).toBe(SECRET);
  });

  it('wins over a plan header of the same name', async () => {
    const { fetcher, f } = setup(() => json());
    await fetcher.fetch({ ...item(), headers: { 'X-ApiSports-Key': 'from-the-plan' } }, CTX);
    expect(f.calls[0]?.headers['x-apisports-key']).toBe(SECRET);
  });

  it('sends it on every attempt of a retried request', async () => {
    let n = 0;
    const { fetcher, f } = setup(() => (++n < 3 ? json('busy', 503) : json()));
    const r = await fetcher.fetch(item(), CTX);
    expect(r).toMatchObject({ kind: 'ok', attempts: 3 });
    expect(f.calls.map((c) => c.headers['x-apisports-key'])).toEqual([SECRET, SECRET, SECRET]);
  });

  it('keeps the allow-list: an item for another host is refused before the secret is read', async () => {
    const { fetcher, f, reads } = setup(() => json());
    const r = await fetcher.fetch(item('/x', 'evil.example'), CTX);
    expect(r).toEqual({ kind: 'refused', reason: 'host_not_allowed' });
    expect(f.calls).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  it('keeps the scheme rule: http is refused and the key is not read', async () => {
    const { fetcher, f, reads } = setup(() => json());
    const r = await fetcher.fetch({ ...item(), url: `http://${API}/x` }, CTX);
    expect(r).toEqual({ kind: 'refused', reason: 'scheme_not_allowed' });
    expect(f.calls).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  it('keeps robots.txt: it is read without the key, the document with it', async () => {
    const { fetcher, f } = setup(
      (url) => (url.pathname === '/robots.txt' ? ROBOTS_OK : json()),
      undefined,
      { robots: 'enforce' },
    );
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(f.paths()).toEqual(['/robots.txt', '/fixtures']);
    expect(f.calls[0]?.headers['x-apisports-key']).toBeUndefined();
    expect(f.calls[1]?.headers['x-apisports-key']).toBe(SECRET);
  });

  it('keeps robots.txt: a disallowed path is not requested at all', async () => {
    const { fetcher, f } = setup(
      (url) =>
        url.pathname === '/robots.txt'
          ? res('User-agent: *\nDisallow: /fixtures\n', 200, { 'content-type': 'text/plain' })
          : json(),
      undefined,
      { robots: 'enforce' },
    );
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({ kind: 'blocked', reason: 'robots' });
    expect(f.paths()).toEqual(['/robots.txt']);
    expect(f.calls[0]?.headers['x-apisports-key']).toBeUndefined();
  });

  it('keeps the rate limit: a second request to the host waits for the minimum interval', async () => {
    const { fetcher, f, clock } = setup(() => json(), undefined, { minIntervalMs: 2000 });
    await fetcher.fetch(item('/a'), CTX);
    expect(clock.sleeps).toEqual([]);
    await fetcher.fetch(item('/b'), CTX);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
    expect(f.calls.map((c) => c.headers['x-apisports-key'])).toEqual([SECRET, SECRET]);
  });
});

describe('request authentication: redirects', () => {
  it('follows a redirect inside the origin with the key', async () => {
    const { fetcher, f } = setup((url) =>
      url.pathname === '/old' ? res(null, 302, { location: '/fixtures?league=162' }) : json(),
    );
    const r = await fetcher.fetch(item('/old'), CTX);
    expect(r).toMatchObject({ kind: 'ok', attempts: 2 });
    expect(f.calls.map((c) => c.headers['x-apisports-key'])).toEqual([SECRET, SECRET]);
  });

  it('drops the key on a redirect to another host of the allow-list', async () => {
    const { fetcher, f } = setup((url) =>
      url.host === API ? res(null, 302, { location: `https://${CDN}/data.json` }) : json(),
    );
    const r = await fetcher.fetch(item('/fixtures'), CTX);
    expect(r).toMatchObject({ kind: 'ok', url: `https://${CDN}/data.json`, attempts: 2 });
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual([API, CDN]);
    expect(f.calls[0]?.headers['x-apisports-key']).toBe(SECRET);
    expect(f.calls[1]?.headers['x-apisports-key']).toBeUndefined();
    expect(JSON.stringify(f.calls[1]?.headers)).not.toContain(SECRET);
  });

  it('drops the key on a redirect to the same host on another port or scheme', async () => {
    const { fetcher, f } = setup(
      (url) =>
        url.port === '' ? res(null, 302, { location: `http://${API}:8080/data.json` }) : json(),
      undefined,
      { allowInsecure: true },
    );
    const r = await fetcher.fetch(item('/fixtures'), CTX);
    expect(r.kind).toBe('ok');
    expect(f.calls[0]?.headers['x-apisports-key']).toBe(SECRET);
    expect(f.calls[1]?.headers['x-apisports-key']).toBeUndefined();
  });

  it('sends the key only to the origin it belongs to, also on the way back from a detour', async () => {
    const { fetcher, f } = setup((url, call) => {
      if (url.pathname === '/a') return res(null, 302, { location: `https://${CDN}/b` });
      if (url.pathname === '/b') return res(null, 302, { location: `https://${API}/c` });
      return call.headers['x-apisports-key'] === SECRET ? json() : json('denied', 200);
    });
    const r = await fetcher.fetch(item('/a'), CTX);
    expect(r.kind).toBe('ok');
    expect(f.calls.map((c) => c.headers['x-apisports-key'] === SECRET)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('still refuses a redirect to a host outside the allow-list, without the key', async () => {
    const { fetcher, f } = setup(() => res(null, 302, { location: 'https://evil.example/x' }));
    const r = await fetcher.fetch(item('/fixtures'), CTX);
    expect(r).toEqual({ kind: 'refused', reason: 'host_not_allowed' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('request authentication: failing closed', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '  \n'],
  ])(
    'refuses as secret_missing when the variable is %s, and requests nothing',
    async (_n, value) => {
      const { fetcher, f } = setup(() => json(), { [VAR]: value }, { robots: 'enforce' });
      const r = await fetcher.fetch(item(), CTX);
      expect(r).toEqual({ kind: 'refused', reason: 'secret_missing' });
      expect(f.calls).toHaveLength(0); // no document, no robots.txt
    },
  );

  it('refuses as secret_missing when the fetcher has no secret reader at all', async () => {
    const f = fakeFetch(() => json());
    const fetcher = new PoliteFetcher({ userAgent: UA, fetchImpl: f.impl, robots: 'off' });
    expect(await fetcher.fetch(item(), CTX)).toEqual({ kind: 'refused', reason: 'secret_missing' });
    expect(f.calls).toHaveLength(0);
  });

  it('treats a throwing reader as a missing secret', async () => {
    const f = fakeFetch(() => json());
    const fetcher = new PoliteFetcher({
      userAgent: UA,
      fetchImpl: f.impl,
      robots: 'off',
      secrets: () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const r = await fetcher.fetch(item(), CTX);
    expect(r).toEqual({ kind: 'refused', reason: 'secret_missing' });
    expect(f.calls).toHaveLength(0);
  });

  it('does not use up the circuit breaker', async () => {
    const env: Record<string, string | undefined> = {};
    const { fetcher, f } = setup(() => json(), env, { breaker: { failureThreshold: 1 } });
    for (let i = 0; i < 3; i += 1) {
      expect(await fetcher.fetch(item(), CTX)).toEqual({
        kind: 'refused',
        reason: 'secret_missing',
      });
    }
    env[VAR] = SECRET;
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ['a line break inside', 'abc\ndef'],
    ['a control character', 'abc\u0001def'],
    ['non-ASCII text', 'clé-секрет'],
  ])('refuses as secret_invalid when the value has %s', async (_n, value) => {
    const { fetcher, f } = setup(() => json(), { [VAR]: value });
    expect(await fetcher.fetch(item(), CTX)).toEqual({ kind: 'refused', reason: 'secret_invalid' });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ['a variable outside SCRAPER_SECRET_', { header: 'x-key', secret: 'DATABASE_URL' }],
    ['a forbidden header', { header: 'cookie', secret: VAR }],
    ['a malformed header', { header: 'x key', secret: VAR }],
  ])(
    'does not trust the plan item: %s is secret_invalid, and nothing is read',
    async (_n, auth) => {
      const { fetcher, f, reads } = setup(() => json(), {
        DATABASE_URL: 'postgres://x',
        [VAR]: SECRET,
      });
      const r = await fetcher.fetch({ ...item(), auth }, CTX);
      expect(r).toEqual({ kind: 'refused', reason: 'secret_invalid' });
      expect(f.calls).toHaveLength(0);
      expect(reads).toEqual([]);
    },
  );
});

describe('request authentication: the value stays out of results', () => {
  it('redacts the key in a transport error that quotes the request', async () => {
    const { fetcher } = setup(
      (_url, call) => new Error(`connect failed, request ${JSON.stringify(call)}`),
    );
    const r = await fetcher.fetch(item(), CTX);
    expect(r).toMatchObject({ kind: 'error', code: 'network' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.kind === 'error' && r.message).toContain(REDACTED);
  });

  it('redacts the key in an error nobody expected', async () => {
    const f = fakeFetch(() => json());
    const fetcher = new PoliteFetcher({
      userAgent: UA,
      fetchImpl: f.impl,
      robots: 'off',
      secrets: () => SECRET,
      // A conditional store that throws is swallowed; a clock that throws is not.
      now: () => {
        throw new Error(`clock exploded while sending ${SECRET}`);
      },
    });
    const r = await fetcher.fetch(item(), CTX);
    expect(r.kind).toBe('error');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('drops a response that contains the key (it would reach the archive)', async () => {
    const { fetcher } = setup((_url, call) => json(JSON.stringify({ echo: call.headers })));
    const r = await fetcher.fetch(item(), CTX);
    expect(r).toEqual({ kind: 'refused', reason: 'secret_echoed' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('returns a normal result that holds no trace of the key', async () => {
    const { fetcher } = setup(() => json('{"response":[]}', 200, { etag: '"v1"' }));
    const r = await fetcher.fetch(item(), CTX);
    expect(r.kind).toBe('ok');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('auth helpers', () => {
  it('redactSecret replaces every occurrence and ignores an empty secret', () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(redactSecret('abc', '')).toBe('abc');
    expect(redactSecret('abc', null)).toBe('abc');
  });

  it('authHeaderProblem accepts ordinary API key headers', () => {
    for (const h of ['x-apisports-key', 'X-API-KEY', 'api_key', 'apikey', 'x-rapidapi-key']) {
      expect(authHeaderProblem(h)).toBeNull();
    }
  });
});
