import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryConditionalStore } from './conditional';
import { PoliteFetcher, type PoliteFetcherOptions } from './polite-fetcher';
import { START, fakeFetch, makeClock, res, type Handler } from './test-helpers';

const UA = 'VamosBot/1.0 (+mailto:ops@example.com)';
const H = 'data.example';
const CTX = { allowedHosts: [H], sourceKey: 'src' };
const item = (path = '/fixtures.json', host = H) => ({
  url: `https://${host}${path}`,
  purpose: 'fixtures' as const,
});

function setup(handler: Handler, options: Partial<PoliteFetcherOptions> = {}) {
  const clock = makeClock();
  const f = fakeFetch(handler);
  const fetcher = new PoliteFetcher({
    userAgent: UA,
    fetchImpl: f.impl,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    robots: 'off',
    minIntervalMs: 0,
    ...options,
  });
  return { fetcher, clock, f };
}

const json = (body = '{"a":1}', status = 200, headers: Record<string, string> = {}) =>
  res(body, status, { 'content-type': 'application/json', ...headers });

describe('PoliteFetcher: basics', () => {
  it('returns bytes, hash, headers and sends the user agent', async () => {
    const { fetcher, f } = setup(() => json('{"a":1}', 200, { etag: '"v1"', 'set-cookie': 'x=1' }));
    const r = await fetcher.fetch(item(), CTX);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(new TextDecoder().decode(r.body)).toBe('{"a":1}');
    expect(r.contentHash).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(r).toMatchObject({
      status: 200,
      url: `https://${H}/fixtures.json`,
      contentType: 'application/json',
      attempts: 1,
    });
    expect(r.headers.etag).toBe('"v1"');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.fetchedAt).toEqual(new Date(START));
    expect(f.calls[0]?.headers['user-agent']).toBe(UA);
  });

  it('requires a sane user agent', () => {
    expect(() => new PoliteFetcher({ userAgent: '' })).toThrow(TypeError);
    expect(() => new PoliteFetcher({ userAgent: 'Bot\r\nX: y' })).toThrow(TypeError);
  });

  it('does not let a plan item set credentials or the user agent', async () => {
    const { fetcher, f } = setup(() => json());
    await fetcher.fetch(
      {
        ...item(),
        headers: {
          Cookie: 'a=b',
          Authorization: 'Bearer x',
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'en',
        },
      },
      CTX,
    );
    const h = f.calls[0]?.headers ?? {};
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['user-agent']).toBe(UA);
    expect(h['accept-language']).toBe('en');
  });
});

describe('S3 host allow-list, scheme and redirects', () => {
  it('refuses hosts that are not allowed, without touching the network', async () => {
    const { fetcher, f } = setup(() => json());
    for (const url of [
      'https://evil.example/x',
      'https://sub.data.example/x',
      'https://data.example.evil.example/x',
      'https://data.example@evil.example/x',
    ]) {
      expect(await fetcher.fetch({ url, purpose: 'both' }, CTX)).toEqual({
        kind: 'refused',
        reason: 'host_not_allowed',
      });
    }
    expect(await fetcher.fetch(item(), { allowedHosts: [], sourceKey: 's' })).toEqual({
      kind: 'refused',
      reason: 'host_not_allowed',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('matches hosts case-insensitively and ignores a trailing dot', async () => {
    const { fetcher } = setup(() => json());
    expect(
      (await fetcher.fetch({ url: 'https://DATA.example./x', purpose: 'both' }, CTX)).kind,
    ).toBe('ok');
  });

  it('refuses credentials in the URL, non-default ports, plain http and garbage', async () => {
    const { fetcher, f } = setup(() => json());
    expect(
      await fetcher.fetch({ url: 'https://user:pw@data.example/x', purpose: 'both' }, CTX),
    ).toMatchObject({ reason: 'host_not_allowed' });
    expect(
      await fetcher.fetch({ url: 'https://data.example:8443/x', purpose: 'both' }, CTX),
    ).toMatchObject({ reason: 'host_not_allowed' });
    expect(await fetcher.fetch({ url: 'http://data.example/x', purpose: 'both' }, CTX)).toEqual({
      kind: 'refused',
      reason: 'scheme_not_allowed',
    });
    expect(
      await fetcher.fetch({ url: 'ftp://data.example/x', purpose: 'both' }, CTX),
    ).toMatchObject({ reason: 'scheme_not_allowed' });
    expect(await fetcher.fetch({ url: 'not a url', purpose: 'both' }, CTX)).toMatchObject({
      reason: 'scheme_not_allowed',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('follows redirects manually and reports the final URL', async () => {
    const { fetcher, f } = setup((u) =>
      u.pathname === '/a'
        ? res(null, 301, { location: '/b' })
        : u.pathname === '/b'
          ? res(null, 302, { location: `https://${H}/c` })
          : json(),
    );
    const r = await fetcher.fetch(item('/a'), CTX);
    expect(r).toMatchObject({ kind: 'ok', url: `https://${H}/c`, attempts: 3 });
    expect(f.paths()).toEqual(['/a', '/b', '/c']);
  });

  it('re-checks the allow-list after every redirect', async () => {
    const { fetcher, f } = setup((u) =>
      u.hostname === H ? res(null, 302, { location: 'https://other.example/x' }) : json(),
    );
    expect(await fetcher.fetch(item('/a'), CTX)).toEqual({
      kind: 'refused',
      reason: 'host_not_allowed',
    });
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual([H]);
  });

  it('allows a redirect to another allowed host', async () => {
    const { fetcher } = setup((u) =>
      u.hostname === H ? res(null, 302, { location: 'https://cdn.example/x' }) : json(),
    );
    const r = await fetcher.fetch(item('/a'), { allowedHosts: [H, 'cdn.example'], sourceKey: 's' });
    expect(r).toMatchObject({ kind: 'ok', url: 'https://cdn.example/x' });
  });

  it('refuses a redirect downgrade to http', async () => {
    const { fetcher } = setup(() => res(null, 302, { location: `http://${H}/x` }));
    expect(await fetcher.fetch(item('/a'), CTX)).toEqual({
      kind: 'refused',
      reason: 'scheme_not_allowed',
    });
  });

  it('allows 5 redirects and refuses the 6th', async () => {
    const chain =
      (n: number): Handler =>
      (u) => {
        const i = Number(u.pathname.slice(1));
        return i < n ? res(null, 302, { location: `/${i + 1}` }) : json();
      };
    expect((await setup(chain(5)).fetcher.fetch(item('/0'), CTX)).kind).toBe('ok');
    expect(await setup(chain(6)).fetcher.fetch(item('/0'), CTX)).toEqual({
      kind: 'refused',
      reason: 'too_many_redirects',
    });
    expect(
      await setup(() => res(null, 302, { location: '/0' })).fetcher.fetch(item('/0'), CTX),
    ).toEqual({ kind: 'refused', reason: 'too_many_redirects' });
  });

  it('treats a redirect without a usable Location as a non-retryable error', async () => {
    const { fetcher, f } = setup(() => res(null, 302));
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'http_error',
      retryable: false,
    });
    expect(f.calls).toHaveLength(1);
  });
});

describe('robots.txt (6.6)', () => {
  const robotsText =
    (text: string, status = 200): Handler =>
    (u) =>
      u.pathname === '/robots.txt' ? res(text, status, { 'content-type': 'text/plain' }) : json();

  it('blocks disallowed paths without requesting them, and sends the user agent to robots.txt', async () => {
    const { fetcher, f } = setup(robotsText('User-agent: *\nDisallow: /private'), {
      robots: 'enforce',
    });
    const r = await fetcher.fetch(item('/private/x'), CTX);
    expect(r).toMatchObject({ kind: 'blocked', reason: 'robots' });
    expect(f.paths()).toEqual(['/robots.txt']);
    expect(f.calls[0]?.headers['user-agent']).toBe(UA);
    expect((await fetcher.fetch(item('/public'), CTX)).kind).toBe('ok');
  });

  it('uses the group for our product token', async () => {
    const { fetcher } = setup(
      robotsText('User-agent: *\nDisallow: /\n\nUser-agent: vamosbot\nAllow: /'),
      { robots: 'enforce' },
    );
    expect((await fetcher.fetch(item('/x'), CTX)).kind).toBe('ok');
  });

  it('caches for an hour per origin, then fetches again', async () => {
    const { fetcher, f, clock } = setup(robotsText('User-agent: *\nDisallow:'), {
      robots: 'enforce',
    });
    await fetcher.fetch(item('/a'), CTX);
    await fetcher.fetch(item('/b'), CTX);
    expect(f.paths().filter((p) => p === '/robots.txt')).toHaveLength(1);
    clock.advance(3_600_001);
    await fetcher.fetch(item('/c'), CTX);
    expect(f.paths().filter((p) => p === '/robots.txt')).toHaveLength(2);
  });

  it('fetches robots.txt once for concurrent requests', async () => {
    const { fetcher, f } = setup(robotsText(''), { robots: 'enforce' });
    await Promise.all([
      fetcher.fetch(item('/a'), CTX),
      fetcher.fetch(item('/b'), CTX),
      fetcher.fetch(item('/c'), CTX),
    ]);
    expect(f.paths().filter((p) => p === '/robots.txt')).toHaveLength(1);
  });

  it('treats 4xx as no restrictions', async () => {
    for (const status of [404, 403, 410]) {
      const { fetcher } = setup(robotsText('User-agent: *\nDisallow: /', status), {
        robots: 'enforce',
      });
      expect((await fetcher.fetch(item('/x'), CTX)).kind).toBe('ok');
    }
  });

  it('treats 5xx and unreachable as disallow-all, and looks again after the failure TTL', async () => {
    let up = false;
    const { fetcher, clock } = setup(
      (u) =>
        u.pathname === '/robots.txt'
          ? up
            ? res('', 200, { 'content-type': 'text/plain' })
            : res('oops', 503)
          : json(),
      { robots: 'enforce' },
    );
    const r = await fetcher.fetch(item('/x'), CTX);
    expect(r).toMatchObject({ kind: 'blocked', reason: 'robots' });
    if (r.kind === 'blocked') expect(r.retryAt).toEqual(new Date(clock.now() + 300_000));
    up = true;
    expect((await fetcher.fetch(item('/x'), CTX)).kind).toBe('blocked'); // still remembered
    clock.advance(300_001);
    expect((await fetcher.fetch(item('/x'), CTX)).kind).toBe('ok');
    const down = setup((u) => (u.pathname === '/robots.txt' ? new Error('ECONNRESET') : json()), {
      robots: 'enforce',
    });
    expect(await down.fetcher.fetch(item('/x'), CTX)).toMatchObject({
      kind: 'blocked',
      reason: 'robots',
    });
  });

  it('checks robots.txt of the redirect target origin too', async () => {
    const { fetcher, f } = setup(
      (u) =>
        u.pathname === '/robots.txt'
          ? res(u.hostname === 'b.example' ? 'User-agent: *\nDisallow: /' : '', 200, {
              'content-type': 'text/plain',
            })
          : u.hostname === 'a.example'
            ? res(null, 302, { location: 'https://b.example/y' })
            : json(),
      { robots: 'enforce' },
    );
    const r = await fetcher.fetch(
      { url: 'https://a.example/x', purpose: 'both' },
      { allowedHosts: ['a.example', 'b.example'], sourceKey: 's' },
    );
    expect(r).toMatchObject({ kind: 'blocked', reason: 'robots' });
    expect(f.calls.map((c) => c.url)).not.toContain('https://b.example/y');
  });

  it('does not follow a robots.txt redirect to a host outside the allow-list (fails closed)', async () => {
    const { fetcher, f } = setup(
      (u) =>
        u.pathname === '/robots.txt'
          ? res(null, 302, { location: 'https://other.example/robots.txt' })
          : json(),
      { robots: 'enforce' },
    );
    expect(await fetcher.fetch(item('/x'), CTX)).toMatchObject({
      kind: 'blocked',
      reason: 'robots',
    });
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual([H]);
  });

  it('robots "off" does not request robots.txt', async () => {
    const { fetcher, f } = setup(() => json(), { robots: 'off' });
    await fetcher.fetch(item('/private'), CTX);
    expect(f.paths()).toEqual(['/private']);
  });

  it('honours Crawl-delay as the minimum interval (capped at 60 s)', async () => {
    const { fetcher, clock } = setup(robotsText('User-agent: *\nCrawl-delay: 10'), {
      robots: 'enforce',
      random: () => 0,
    });
    await fetcher.fetch(item('/a'), CTX);
    clock.sleeps.length = 0;
    await fetcher.fetch(item('/b'), CTX);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(10_000);
    const big = setup(robotsText('User-agent: *\nCrawl-delay: 5000'), {
      robots: 'enforce',
      random: () => 0,
    });
    await big.fetcher.fetch(item('/a'), CTX);
    big.clock.sleeps.length = 0;
    await big.fetcher.fetch(item('/b'), CTX);
    expect(Math.max(...big.clock.sleeps)).toBeLessThanOrEqual(60_000);
  });
});

describe('rate limiting', () => {
  it('waits the minimum interval plus bounded jitter between requests to a host', async () => {
    const { fetcher, clock } = setup(() => json(), { minIntervalMs: 2000, random: () => 0.8 });
    await fetcher.fetch(item('/a'), CTX);
    expect(clock.sleeps).toEqual([]);
    await fetcher.fetch(item('/b'), CTX);
    expect(clock.sleeps).toEqual([2400]);
  });

  it('does not make different hosts wait for each other', async () => {
    const { fetcher, clock } = setup(() => json(), { minIntervalMs: 2000 });
    const ctx = { allowedHosts: ['a.example', 'b.example'], sourceKey: 's' };
    await fetcher.fetch({ url: 'https://a.example/x', purpose: 'both' }, ctx);
    await fetcher.fetch({ url: 'https://b.example/x', purpose: 'both' }, ctx);
    expect(clock.sleeps).toEqual([]);
  });

  it('caps parallel requests across hosts', async () => {
    let active = 0;
    let peak = 0;
    const { fetcher } = setup(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return json();
      },
      { maxConcurrency: 2 },
    );
    const hosts = ['a', 'b', 'c', 'd', 'e'].map((h) => `${h}.example`);
    await Promise.all(
      hosts.map((h) =>
        fetcher.fetch(
          { url: `https://${h}/x`, purpose: 'both' },
          { allowedHosts: hosts, sourceKey: 's' },
        ),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('conditional requests', () => {
  it('sends If-None-Match / If-Modified-Since and maps 304 to not_modified', async () => {
    const store = new InMemoryConditionalStore();
    const { fetcher, f } = setup(
      (_u, call) =>
        call.headers['if-none-match'] === '"v1"'
          ? res(null, 304)
          : json('{}', 200, { etag: '"v1"', 'last-modified': 'Mon, 01 Jun 2026 10:00:00 GMT' }),
      { conditionalStore: store },
    );
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(f.calls[0]?.headers['if-none-match']).toBeUndefined();
    const second = await fetcher.fetch(item(), CTX);
    expect(second).toEqual({
      kind: 'not_modified',
      url: `https://${H}/fixtures.json`,
      fetchedAt: new Date(START),
    });
    expect(f.calls[1]?.headers['if-modified-since']).toBe('Mon, 01 Jun 2026 10:00:00 GMT');
  });

  it('forgets validators when the server stops sending them, and never stores them for block pages', async () => {
    const store = new InMemoryConditionalStore();
    let n = 0;
    const { fetcher } = setup(
      () =>
        n++ === 0
          ? json('{}', 200, { etag: '"v1"' })
          : n === 2
            ? json('{}')
            : json('<html>captcha</html>', 200, { etag: '"evil"' }),
      { conditionalStore: store },
    );
    await fetcher.fetch(item(), CTX);
    expect(store.get(`https://${H}/fixtures.json`)).toEqual({ etag: '"v1"', lastModified: null });
    await fetcher.fetch(item(), CTX);
    expect(store.get(`https://${H}/fixtures.json`)).toBeUndefined();
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'blocked',
      reason: 'block_page',
    });
    expect(store.get(`https://${H}/fixtures.json`)).toBeUndefined();
  });

  it('forgetValidators makes the next request unconditional (a page that was not accepted)', async () => {
    const store = new InMemoryConditionalStore();
    const { fetcher, f } = setup(
      (_u, call) =>
        call.headers['if-none-match'] === '"v1"'
          ? res(null, 304)
          : json('{}', 200, { etag: '"v1"' }),
      { conditionalStore: store },
    );
    await fetcher.fetch(item(), CTX);
    await fetcher.forgetValidators(`https://${H}/fixtures.json`);
    expect(store.get(`https://${H}/fixtures.json`)).toBeUndefined();
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(f.calls[1]?.headers['if-none-match']).toBeUndefined();
    await expect(fetcher.forgetValidators('not a url')).resolves.toBeUndefined();
  });

  it('treats a 304 to an unconditional request as an error, not as success', async () => {
    const { fetcher } = setup(() => res(null, 304));
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'http_error',
      retryable: false,
      status: 304,
    });
  });

  it('survives a failing store', async () => {
    const store = {
      get: () => Promise.reject(new Error('db down')),
      set: () => Promise.reject(new Error('db down')),
    };
    const { fetcher } = setup(() => json('{}', 200, { etag: '"a"' }), { conditionalStore: store });
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
  });
});

describe('retries (S2)', () => {
  it('retries 5xx and network errors with backoff, then succeeds', async () => {
    let n = 0;
    const { fetcher, clock } = setup(
      () => (++n === 1 ? res('x', 503) : n === 2 ? new Error('ECONNRESET') : json()),
      { random: () => 0.5 },
    );
    const r = await fetcher.fetch(item(), CTX);
    expect(r).toMatchObject({ kind: 'ok', attempts: 3 });
    expect(clock.sleeps).toEqual([500, 1000]); // full jitter: 0.5 * ceiling(1000, 2000)
  });

  it('gives up after maxAttempts with a retryable error', async () => {
    const { fetcher, f } = setup(() => res('x', 502));
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'http_error',
      retryable: true,
      status: 502,
      attempts: 3,
    });
    expect(f.calls).toHaveLength(3);
    const net = setup(() => new Error('ENOTFOUND'), { maxAttempts: 2 });
    expect(await net.fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'network',
      retryable: true,
      attempts: 2,
    });
  });

  it('retries 408/429/500/504 but never other 4xx', async () => {
    for (const status of [408, 500, 504]) {
      const { f, fetcher } = setup(() => res('x', status));
      await fetcher.fetch(item(), CTX);
      expect(f.calls).toHaveLength(3);
    }
    for (const status of [400, 404, 410, 501]) {
      const { f, fetcher } = setup(() => res('x', status));
      expect(await fetcher.fetch(item(), CTX)).toMatchObject({
        kind: 'error',
        code: 'http_error',
        retryable: false,
        status,
      });
      expect(f.calls).toHaveLength(1);
    }
  });

  it('never retries 403 and never works around it', async () => {
    const { fetcher, f } = setup(() => res('<html>no</html>', 403));
    expect(await fetcher.fetch(item(), CTX)).toEqual({
      kind: 'blocked',
      reason: 'forbidden',
      retryAt: null,
      status: 403,
    });
    expect(f.calls).toHaveLength(1);
    expect(await setup(() => res('', 401)).fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      retryable: false,
      status: 401,
    });
  });

  it('honours Retry-After in seconds and as an HTTP date', async () => {
    let n = 0;
    const a = setup(() => (n++ === 0 ? res('x', 429, { 'retry-after': '7' }) : json()));
    expect((await a.fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect(a.clock.sleeps).toEqual([7000]);
    let m = 0;
    const b = setup(() =>
      m++ === 0 ? res('x', 503, { 'retry-after': new Date(START + 4000).toUTCString() }) : json(),
    );
    await b.fetcher.fetch(item(), CTX);
    expect(b.clock.sleeps).toEqual([4000]);
  });

  it('does not wait for a Retry-After beyond the maximum: blocked rate_limited with retryAt', async () => {
    const { fetcher, f, clock } = setup(() => res('x', 429, { 'retry-after': '3600' }));
    expect(await fetcher.fetch(item(), CTX)).toEqual({
      kind: 'blocked',
      reason: 'rate_limited',
      retryAt: new Date(START + 3_600_000),
      status: 429,
    });
    expect(f.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    const s = setup(() => res('x', 503, { 'retry-after': '99999' }));
    expect(await s.fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'blocked',
      reason: 'rate_limited',
    });
  });

  it('turns a 429 that persists into blocked rate_limited', async () => {
    const { fetcher } = setup(() => res('x', 429));
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'blocked',
      reason: 'rate_limited',
      status: 429,
    });
  });
});

describe('block pages', () => {
  it('never returns a challenge page as ok, whatever the status', async () => {
    for (const [status, body] of [
      [200, '<html><div class="g-recaptcha">Please solve the CAPTCHA</div></html>'],
      [200, '<title>Just a moment...</title><div id="cf-chl-widget"></div>'],
      [403, '<title>Attention Required! | Cloudflare</title>'],
      [429, 'Are you a robot?'],
      [503, 'DDoS protection by Example'],
      [200, 'Access Denied'],
    ] as const) {
      const { fetcher, f } = setup(() => res(body, status));
      expect(await fetcher.fetch(item(), CTX)).toMatchObject({
        kind: 'blocked',
        reason: 'block_page',
        status,
      });
      expect(f.calls).toHaveLength(1); // a block is not retried
    }
  });

  it('only inspects the first 4 KB', async () => {
    const { fetcher } = setup(() => res(`${'x'.repeat(5000)} captcha`, 200));
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
  });
});

describe('limits', () => {
  it('allows text, JSON, +json, xml and calendar; refuses the rest, and a missing type', async () => {
    for (const ct of [
      'text/html; charset=utf-8',
      'application/json',
      'application/vnd.api+json',
      'application/xml',
      'text/xml',
      'text/calendar',
    ]) {
      expect(
        (await setup(() => res('x', 200, { 'content-type': ct })).fetcher.fetch(item(), CTX)).kind,
      ).toBe('ok');
    }
    for (const ct of [
      'image/png',
      'application/pdf',
      'application/octet-stream',
      'application/javascript',
    ]) {
      expect(
        await setup(() => res('x', 200, { 'content-type': ct })).fetcher.fetch(item(), CTX),
      ).toEqual({ kind: 'refused', reason: 'content_type_not_allowed' });
    }
    const none = new Response('x', { status: 200 });
    none.headers.delete('content-type');
    expect(await setup(() => none).fetcher.fetch(item(), CTX)).toEqual({
      kind: 'refused',
      reason: 'content_type_not_allowed',
    });
  });

  it('refuses on a declared Content-Length above the cap, before reading', async () => {
    const { fetcher } = setup(() => res('abc', 200, { 'content-length': '100000000' }), {
      maxBytes: 1000,
    });
    expect(await fetcher.fetch(item(), CTX)).toEqual({ kind: 'refused', reason: 'too_large' });
  });

  it('aborts a stream past the cap without reading it all', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetcher } = setup(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      { maxBytes: 10_000 },
    );
    expect(await fetcher.fetch(item(), CTX)).toEqual({ kind: 'refused', reason: 'too_large' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(50);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const { fetcher } = setup(() => res('x'.repeat(100), 200, { 'content-type': 'text/plain' }), {
      maxBytes: 100,
    });
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
  });

  it('times out a request that never answers, retrying and then reporting a retryable timeout', async () => {
    const hang: Handler = () => new Promise<Response>(() => undefined);
    const f = fakeFetch(hang);
    const impl: typeof f.impl = (input, init) =>
      new Promise((_resolve, reject) => {
        void f.impl(input, init);
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const clock = makeClock();
    const fetcher = new PoliteFetcher({
      userAgent: UA,
      fetchImpl: impl,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      robots: 'off',
      minIntervalMs: 0,
      timeoutMs: 20,
      maxAttempts: 2,
    });
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'timeout',
      retryable: true,
      attempts: 2,
    });
  });

  it('times out a body that trickles in too slowly', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
    }); // never closes
    const impl = (_u: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => void stream.cancel().catch(() => undefined));
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    };
    const fetcher = new PoliteFetcher({
      userAgent: UA,
      fetchImpl: impl,
      robots: 'off',
      minIntervalMs: 0,
      timeoutMs: 30,
      maxAttempts: 1,
    });
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({ kind: 'error', code: 'timeout' });
  });

  it('reports a corrupt compressed body as a non-retryable decode error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(Object.assign(new Error('incorrect header check'), { code: 'Z_DATA_ERROR' }));
      },
    });
    const { fetcher, f } = setup(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({
      kind: 'error',
      code: 'decode',
      retryable: false,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('retries a body cut off mid-stream as a network error', async () => {
    let n = 0;
    const { fetcher } = setup(() =>
      ++n === 1
        ? new Response(
            new ReadableStream<Uint8Array>({ pull: (c) => c.error(new TypeError('terminated')) }),
            { status: 200, headers: { 'content-type': 'text/plain' } },
          )
        : json(),
    );
    expect(await fetcher.fetch(item(), CTX)).toMatchObject({ kind: 'ok', attempts: 2 });
  });
});

describe('circuit breaker per source', () => {
  it('opens after 5 consecutive failures and reports when to retry', async () => {
    let healthy = false;
    const { fetcher, f, clock } = setup(() => (healthy ? json() : res('x', 500)), {
      maxAttempts: 1,
    });
    for (let i = 0; i < 5; i += 1) expect((await fetcher.fetch(item(), CTX)).kind).toBe('error');
    const opened = clock.now();
    const callsBefore = f.calls.length;
    expect(await fetcher.fetch(item(), CTX)).toEqual({
      kind: 'circuit_open',
      retryAt: new Date(opened + 300_000),
    });
    expect(f.calls).toHaveLength(callsBefore);
    // another source is unaffected
    expect((await fetcher.fetch(item(), { ...CTX, sourceKey: 'other' })).kind).toBe('error');
    // after the cooldown one probe goes through; success closes the circuit
    clock.advance(300_000);
    healthy = true;
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
  });

  it('a failed probe re-opens it', async () => {
    const { fetcher, clock } = setup(() => res('x', 500), {
      maxAttempts: 1,
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
    });
    await fetcher.fetch(item(), CTX);
    await fetcher.fetch(item(), CTX);
    clock.advance(1000);
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('error');
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('circuit_open');
  });

  it('counts blocks but not robots refusals, policy refusals or plain 4xx', async () => {
    const opts = { maxAttempts: 1, breaker: { failureThreshold: 2, cooldownMs: 1000 } };
    const blocked = setup(() => res('', 403), opts);
    await blocked.fetcher.fetch(item(), CTX);
    await blocked.fetcher.fetch(item(), CTX);
    expect((await blocked.fetcher.fetch(item(), CTX)).kind).toBe('circuit_open');

    const robots = setup(
      (u) =>
        u.pathname === '/robots.txt'
          ? res('User-agent: *\nDisallow: /', 200, { 'content-type': 'text/plain' })
          : json(),
      { ...opts, robots: 'enforce' },
    );
    for (let i = 0; i < 5; i += 1)
      expect((await robots.fetcher.fetch(item(), CTX)).kind).toBe('blocked');

    const policy = setup(() => json(), opts);
    for (let i = 0; i < 5; i += 1)
      expect((await policy.fetcher.fetch(item('/x', 'evil.example'), CTX)).kind).toBe('refused');
    const type = setup(() => res('x', 200, { 'content-type': 'image/png' }), opts);
    for (let i = 0; i < 5; i += 1)
      expect((await type.fetcher.fetch(item(), CTX)).kind).toBe('refused');
    const notFound = setup(() => res('x', 404), opts);
    for (let i = 0; i < 5; i += 1)
      expect((await notFound.fetcher.fetch(item(), CTX)).kind).toBe('error');
  });

  it('a refused probe does not wedge the half-open state', async () => {
    let mode: 'fail' | 'png' | 'ok' = 'fail';
    const { fetcher, clock } = setup(
      () =>
        mode === 'fail'
          ? res('x', 500)
          : mode === 'png'
            ? res('x', 200, { 'content-type': 'image/png' })
            : json(),
      { maxAttempts: 1, breaker: { failureThreshold: 1, cooldownMs: 1000 } },
    );
    await fetcher.fetch(item(), CTX);
    clock.advance(1000);
    mode = 'png';
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('refused');
    mode = 'ok';
    expect((await fetcher.fetch(item(), CTX)).kind).toBe('ok');
  });
});

describe('robustness', () => {
  it('never throws, even if the injected fetch returns garbage', async () => {
    const { fetcher } = setup(() => undefined as unknown as Response);
    const r = await fetcher.fetch(item(), CTX);
    expect(r.kind).toBe('error');
  });
});
