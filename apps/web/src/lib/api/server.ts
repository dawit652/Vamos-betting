import 'server-only';
import { buildUrl, serverApiUrl, type Query } from './config';
import { errorFromBody, isApiClientError, networkError } from './errors';

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

export interface ServerGetOptions {
  query?: Query;
  timeoutMs?: number;
}

/** GET a public endpoint; rejects with ApiClientError. */
export async function serverGet<T>(path: string, options: ServerGetOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? SERVER_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(buildUrl(serverApiUrl(), path, options.query), {
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
