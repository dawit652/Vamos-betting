import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoliteFetcher } from './polite-fetcher';

/** Real sockets on 127.0.0.1 and localhost (two origins of one machine): what a redirect carries. */

const SECRET = 'real-socket-K3Y-0123456789';
const VAR = 'SCRAPER_SECRET_LOCAL';
let server: Server;
let port = 0;
const seen: Array<{ host: string; path: string; key: string | undefined }> = [];

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  const key = req.headers['x-apisports-key'];
  seen.push({
    host: (req.headers.host ?? '').split(':')[0] ?? '',
    path,
    key: typeof key === 'string' ? key : undefined,
  });
  const json = { 'content-type': 'application/json' };
  if (path === '/data') res.writeHead(200, json).end('{"response":[]}');
  else if (path === '/same-origin') res.writeHead(302, { location: '/data' }).end();
  else if (path === '/other-host') {
    res.writeHead(302, { location: `http://localhost:${port}/data` }).end();
  } else res.writeHead(404, json).end('{}');
}

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const fetcher = () =>
  new PoliteFetcher({
    userAgent: 'NahubetBot/1.0 (+mailto:ops@example.com)',
    allowInsecure: true,
    robots: 'off',
    minIntervalMs: 0,
    sleep: () => Promise.resolve(),
    random: () => 0,
    secrets: (name) => (name === VAR ? SECRET : undefined),
  });
const ctx = { allowedHosts: ['127.0.0.1', 'localhost'], sourceKey: 'local' };
const get = (path: string) => ({
  url: `http://127.0.0.1:${port}${path}`,
  purpose: 'both' as const,
  auth: { header: 'x-apisports-key', secret: VAR },
});

describe('request authentication over real sockets', () => {
  it('sends the header on the wire to the allowed host', async () => {
    seen.length = 0;
    expect((await fetcher().fetch(get('/data'), ctx)).kind).toBe('ok');
    expect(seen).toEqual([{ host: '127.0.0.1', path: '/data', key: SECRET }]);
  });

  it('keeps it through a redirect inside the origin', async () => {
    seen.length = 0;
    expect((await fetcher().fetch(get('/same-origin'), ctx)).kind).toBe('ok');
    expect(seen.map((s) => s.key)).toEqual([SECRET, SECRET]);
  });

  it('drops it when the redirect goes to another allowed host', async () => {
    seen.length = 0;
    const r = await fetcher().fetch(get('/other-host'), ctx);
    expect(r).toMatchObject({ kind: 'ok', attempts: 2 });
    expect(seen).toEqual([
      { host: '127.0.0.1', path: '/other-host', key: SECRET },
      { host: 'localhost', path: '/data', key: undefined },
    ]);
  });

  it('sends nothing when the key is missing', async () => {
    seen.length = 0;
    const bare = new PoliteFetcher({
      userAgent: 'NahubetBot/1.0 (+mailto:ops@example.com)',
      allowInsecure: true,
      robots: 'enforce',
      minIntervalMs: 0,
    });
    expect(await bare.fetch(get('/data'), ctx)).toEqual({
      kind: 'refused',
      reason: 'secret_missing',
    });
    expect(seen).toEqual([]);
  });
});
