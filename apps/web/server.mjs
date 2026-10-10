/**
 * Production server of the player app: `next start` plus brotli.
 *
 * Next.js compresses with gzip only. Most of a first home-page load is the
 * framework's JavaScript, and brotli makes it about 15 % smaller, which is
 * what keeps the page near the 150 KB target on 2G/3G. So:
 * - `/_next/static/*.js|css` (content-hashed, immutable) is compressed once
 *   with brotli at maximum quality, kept in memory and served directly to
 *   browsers that accept `br`;
 * - everything else goes to Next.js through the `compression` middleware
 *   (brotli at a fast level, gzip for older browsers), with Next's own gzip
 *   turned off (see `compress` in next.config.ts).
 * A CDN or reverse proxy that does brotli itself can keep using `next start`.
 *
 * Usage: `PORT=3000 node server.mjs` after `next build` (`pnpm start`); `HOST` sets the
 * listen address.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import compression from 'compression';

process.env.NODE_ENV ??= 'production';
// Read by next.config.ts: this server compresses, Next.js must not gzip first.
process.env.VAMOS_WEB_COMPRESSION = 'server';

const { default: next } = await import('next');

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
/** Listen address; unset listens on every interface, like `next start`. */
const host = process.env.HOST || undefined;

const STATIC_PREFIX = '/_next/static/';
const STATIC_DIR = path.join(dir, '.next', 'static');
/** @type {Record<string, string>} */
const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const brotli = promisify(zlib.brotliCompress);
/** Compressed static files by absolute path (a build has a fixed, small set). */
const staticCache = new Map();

/** True when the request's Accept-Encoding allows `br` (and not with q=0). */
function acceptsBrotli(header) {
  if (typeof header !== 'string') return false;
  return header.split(',').some((part) => {
    const [name = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (name !== 'br') return false;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** The brotli body of a static JS/CSS file, or null when it is not one (Next.js answers then). */
async function staticBrotli(pathname) {
  const type = STATIC_TYPES[path.extname(pathname)];
  if (type === undefined) return null;
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(STATIC_PREFIX.length));
  } catch {
    return null;
  }
  const file = path.resolve(STATIC_DIR, relative);
  if (!file.startsWith(STATIC_DIR + path.sep)) return null;
  let body = staticCache.get(file);
  if (body === undefined) {
    body = readFile(file).then((raw) =>
      brotli(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      }),
    );
    staticCache.set(file, body);
    // Only real files stay cached (unknown paths must not grow the map).
    body.catch(() => staticCache.delete(file));
  }
  try {
    return { body: await body, type };
  } catch {
    return null;
  }
}

const app = next({ dev: false, dir, port, ...(host === undefined ? {} : { hostname: host }) });
const handle = app.getRequestHandler();
const compress = compression({
  // Pages are rendered per request: a fast level (about 15 % under gzip at similar cost).
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
});
const toNext = (req, res) => compress(req, res, () => void handle(req, res));

await app.prepare();

createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const isStatic =
    (req.method === 'GET' || req.method === 'HEAD') &&
    pathname.startsWith(STATIC_PREFIX) &&
    acceptsBrotli(req.headers['accept-encoding']);
  if (!isStatic) {
    toNext(req, res);
    return;
  }
  void staticBrotli(pathname).then((found) => {
    if (found === null) {
      toNext(req, res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': found.type,
      'Content-Encoding': 'br',
      'Content-Length': found.body.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : found.body);
  });
}).listen({ port, host }, () => {
  process.stdout.write(`vamos web: ready on http://${host ?? 'localhost'}:${port} (brotli)\n`);
});
