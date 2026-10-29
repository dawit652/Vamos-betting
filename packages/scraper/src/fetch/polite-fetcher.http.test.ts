import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoliteFetcher } from './polite-fetcher';

/** Real sockets on 127.0.0.1 only: redirects, streaming limits, timeouts, gzip. */

let server: Server;
let base = '';
const hits: string[] = [];

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  hits.push(path);
  const text = { 'content-type': 'text/plain; charset=utf-8' };
  if (path === '/robots.txt') {
    res.writeHead(200, text).end('User-agent: *\nDisallow: /private\n');
  } else if (path === '/hello') {
    res.writeHead(200, { ...text, etag: '"h1"' }).end('hello');
  } else if (path === '/redirect-in') {
    res.writeHead(302, { location: '/hello' }).end();
  } else if (path === '/redirect-out') {
    res.writeHead(302, { location: base.replace('127.0.0.1', 'localhost') + '/hello' }).end();
  } else if (path === '/loop') {
    res.writeHead(302, { location: '/loop' }).end();
  } else if (path === '/endless') {
    res.writeHead(200, text);
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 97)), 1);
    res.on('close', () => clearInterval(timer));
  } else if (path === '/hang') {
    // never answers
  } else if (path === '/gzip') {
    res.writeHead(200, { ...text, 'content-encoding': 'gzip' }).end(gzipSync('compressed hello'));
  } else if (path === '/bomb') {
    res
      .writeHead(200, { ...text, 'content-encoding': 'gzip' })
      .end(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
  } else if (path === '/badgzip') {
    res.writeHead(200, { ...text, 'content-encoding': 'gzip' }).end('this is not gzip data');
  } else if (path === '/cond') {
    if (req.headers['if-none-match'] === '"h1"') res.writeHead(304).end();
    else res.writeHead(200, { ...text, etag: '"h1"' }).end('fresh');
  } else if (path === '/limited') {
    res.writeHead(429, { 'retry-after': '1' }).end('slow down');
  } else {
    res.writeHead(404, text).end('nope');
  }
}

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function make(options: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {}) {
  return new PoliteFetcher({
    userAgent: 'VamosBot/1.0 (+mailto:ops@example.com)',
    allowInsecure: true,
    robots: 'off',
    minIntervalMs: 0,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...options,
  });
}
const ctx = () => ({ allowedHosts: ['127.0.0.1'], sourceKey: 'local' });
const get = (path: string) => ({ url: `${base}${path}`, purpose: 'both' as const });

describe('PoliteFetcher against a local server', () => {
  it('fetches a document', async () => {
    const r = await make().fetch(get('/hello'), ctx());
    expect(r).toMatchObject({ kind: 'ok', status: 200, contentType: 'text/plain; charset=utf-8' });
    if (r.kind === 'ok') expect(new TextDecoder().decode(r.body)).toBe('hello');
  });

  it('refuses http when allowInsecure is off', async () => {
    expect(await make({ allowInsecure: false }).fetch(get('/hello'), ctx())).toEqual({
      kind: 'refused',
      reason: 'scheme_not_allowed',
    });
  });

  it('follows a redirect inside the allow-list', async () => {
    const r = await make().fetch(get('/redirect-in'), ctx());
    expect(r).toMatchObject({ kind: 'ok', url: `${base}/hello`, attempts: 2 });
  });

  it('refuses a redirect to a host outside the allow-list and never requests it', async () => {
    hits.length = 0;
    const r = await make().fetch(get('/redirect-out'), ctx());
    expect(r).toEqual({ kind: 'refused', reason: 'host_not_allowed' });
    expect(hits).toEqual(['/redirect-out']);
  });

  it('stops a redirect loop', async () => {
    expect(await make().fetch(get('/loop'), ctx())).toEqual({
      kind: 'refused',
      reason: 'too_many_redirects',
    });
  });

  it('cuts off an endless body at maxBytes', async () => {
    const r = await make({ maxBytes: 200_000, timeoutMs: 10_000 }).fetch(get('/endless'), ctx());
    expect(r).toEqual({ kind: 'refused', reason: 'too_large' });
  });

  it('times out a server that never answers', async () => {
    const r = await make({ timeoutMs: 100, maxAttempts: 2 }).fetch(get('/hang'), ctx());
    expect(r).toMatchObject({ kind: 'error', code: 'timeout', retryable: true, attempts: 2 });
  });

  it('decodes gzip, caps the decompressed size, and reports corrupt gzip as a decode error', async () => {
    const ok = await make().fetch(get('/gzip'), ctx());
    expect(ok.kind === 'ok' && new TextDecoder().decode(ok.body)).toBe('compressed hello');
    expect(await make({ maxBytes: 1_000_000 }).fetch(get('/bomb'), ctx())).toEqual({
      kind: 'refused',
      reason: 'too_large',
    });
    expect(await make().fetch(get('/badgzip'), ctx())).toMatchObject({
      kind: 'error',
      code: 'decode',
      retryable: false,
    });
  });

  it('sends conditional requests and gets 304', async () => {
    const fetcher = make();
    expect((await fetcher.fetch(get('/cond'), ctx())).kind).toBe('ok');
    expect(await fetcher.fetch(get('/cond'), ctx())).toMatchObject({ kind: 'not_modified' });
  });

  it('reports 404 as a non-retryable error and a refused connection as a retryable network error', async () => {
    expect(await make().fetch(get('/missing'), ctx())).toMatchObject({
      kind: 'error',
      code: 'http_error',
      status: 404,
      retryable: false,
    });
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const r = await make({ maxAttempts: 2 }).fetch(
      { url: `http://127.0.0.1:${port}/x`, purpose: 'both' },
      ctx(),
    );
    expect(r).toMatchObject({ kind: 'error', code: 'network', retryable: true, attempts: 2 });
  });

  it('enforces robots.txt served by the real server', async () => {
    const fetcher = make({ robots: 'enforce' });
    expect(await fetcher.fetch(get('/private/x'), ctx())).toMatchObject({
      kind: 'blocked',
      reason: 'robots',
    });
    expect((await fetcher.fetch(get('/hello'), ctx())).kind).toBe('ok');
  });

  it('retries a 429 with a short Retry-After and then reports it as rate limited', async () => {
    const sleeps: number[] = [];
    const r = await make({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).fetch(get('/limited'), ctx());
    expect(r).toMatchObject({ kind: 'blocked', reason: 'rate_limited', status: 429 });
    expect(sleeps).toEqual([1000, 1000]);
  });
});
