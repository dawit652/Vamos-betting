import { API_URL, buildUrl, type Query } from './config';
import { ApiClientError, errorFromBody } from './errors';

/**
 * Browser-side calls to /shop/*. The shop session cookie (and the device cookie) go along
 * (`credentials: 'include'`); unsafe methods carry the session's CSRF token in
 * `x-shop-csrf-token`. The token lives in memory only, never in storage. Import contract TYPES
 * with `import type` only so zod stays out of the bundle.
 */

export const SHOP_CSRF_HEADER = 'x-shop-csrf-token';
export const UNAUTHORIZED_EVENT = 'vamos:shop-unauthorized';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE_METHODS.has(method) && csrfToken !== null) headers[SHOP_CSRF_HEADER] = csrfToken;

  let response: Response;
  try {
    response = await fetch(buildUrl(API_URL, path, options.query), {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw new ApiClientError(0, 'network_error', 'The API could not be reached');
  }

  let body: unknown = null;
  const text = await response.text();
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = errorFromBody(response.status, body);
    // A 401 on a call made while signed in ends the session (the sign-in call itself answers 401
    // for a wrong password and must not trigger this: it is sent while anonymous).
    if (error.status === 401 && path !== '/shop/auth/login' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw error;
  }
  return body as T;
}
