import { CSRF_COOKIE, CSRF_HEADER, readBrowserCookie } from '../cookies';
import { buildUrl, PUBLIC_API_URL, type Query } from './config';
import { ApiClientError, errorFromBody, networkError } from './errors';

/**
 * Browser-side API calls (client components only). Sends the session cookie
 * (`credentials: 'include'`), sends the session's CSRF token in
 * `x-csrf-token` on unsafe methods, and rejects with ApiClientError on any
 * failure.
 *
 * The CSRF token comes from the API (GET /auth/session, see SessionProvider):
 * in production the API is on another host, whose cookies this page cannot
 * read. On one host (local development) the readable `vamos_csrf` cookie is the
 * fallback.
 *
 * Import response/request TYPES from @vamos/contracts with `import type` only:
 * a value import would pull zod into the browser bundle.
 */

export const UNAUTHORIZED_EVENT = 'vamos:unauthorized';

/** The session's CSRF token, kept in memory only (null without a session). */
let csrfToken: string | null = null;

/** Sets the CSRF token sent on unsafe requests (SessionProvider, after GET /auth/session). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as the `idempotency-key` header; see newIdempotencyKey(). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) {
    const csrf = csrfToken ?? readBrowserCookie(CSRF_COOKIE);
    if (csrf !== null) headers[CSRF_HEADER] = csrf;
  }
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  // AbortSignal.any is too new for the oldest supported browsers: combine by hand.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(buildUrl(PUBLIC_API_URL, path, options.query), {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    // A caller's own abort is re-thrown untouched so it can be ignored.
    if (options.signal?.aborted === true) throw error;
    throw networkError(error, timedOut);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const body = await readBody(response);
  if (!response.ok) {
    const error = errorFromBody(response.status, body, response.headers.get('x-request-id'));
    if (error.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw error;
  }
  return body as T;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

type BodyOptions = Omit<ApiRequestOptions, 'method' | 'body'>;

/** Shorthands: `api.get<MeResponse>('/me')`, `api.post<BetView>('/bets', body, { idempotencyKey })`. */
export const api = {
  get: <T>(path: string, options?: BodyOptions) => apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: BodyOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: BodyOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: BodyOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: BodyOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

export { ApiClientError };
