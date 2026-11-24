import 'server-only';
import { buildUrl, serverApiUrl, type Query } from './config';
import { errorFromBody, isApiClientError, networkError } from './errors';
import { AnswerReuse, catalogReuseMs } from './reuse';

/**
 * Server-side fetch for PUBLIC data (catalogue, events). Server components call
 * this while rendering; responses are never cached by Next (odds move), and a
 * slow API fails fast instead of hanging the page.
 *
 * Authenticated data (wallet, bets, profile) is fetched in the browser with
 * `api` from ./client: the session cookie belongs to the API's host and does not
 * reliably reach this server.
 */

const SERVER_TIMEOUT_MS = 5_000;

/**
 * Public catalogue answers (CATALOG_REUSE_MS, default 2 s; 0 = off) are shared per full URL inside
 * this process. Kept on globalThis so the copies of this module that Next may bundle for different
 * routes (and dev reloads) share one store.
 */
const REUSE_KEY = Symbol.for('vamos.web.catalogReuse');

function reuseStore(): AnswerReuse {
  const holder = globalThis as { [REUSE_KEY]?: AnswerReuse };
  holder[REUSE_KEY] ??= new AnswerReuse({ ttlMs: catalogReuseMs(process.env.CATALOG_REUSE_MS) });
  return holder[REUSE_KEY];
}

export interface ServerGetOptions {
  query?: Query;
  timeoutMs?: number;
  /**
   * Share the answer between renders for a moment (see reuse.ts). Only for public catalogue lists
   * that are the same for every visitor: the callers (and their cached object) must not mutate it.
   */
  reuse?: boolean;
}

/** GET a public endpoint; rejects with ApiClientError. */
export function serverGet<T>(path: string, options: ServerGetOptions = {}): Promise<T> {
  const url = buildUrl(serverApiUrl(), path, options.query);
  const timeoutMs = options.timeoutMs ?? SERVER_TIMEOUT_MS;
  if (options.reuse !== true) return fetchJson<T>(url, timeoutMs);
  return reuseStore().get(url, () => fetchJson<T>(url, timeoutMs));
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw networkError(error, timedOut);
  }
  const text = await response.text();
  let body: unknown = undefined;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw errorFromBody(response.status, body, response.headers.get('x-request-id'));
  }
  return body as T;
}

/** Like serverGet, but a 404 resolves to null (pair with `notFound()` from next/navigation). */
export async function serverGetOrNull<T>(
  path: string,
  options: ServerGetOptions = {},
): Promise<T | null> {
  try {
    return await serverGet<T>(path, options);
  } catch (error) {
    if (isApiClientError(error) && error.status === 404) return null;
    throw error;
  }
}
