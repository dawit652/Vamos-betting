import { API_URL, buildUrl, type Query } from './config';
import { ApiClientError, errorFromBody } from './errors';

/**
 * Browser-side calls to /admin/*. The staff session cookie goes along (`credentials: 'include'`);
 * unsafe methods carry the session's CSRF token in `x-staff-csrf-token`. There are no bearer
 * tokens. Import contract TYPES with `import type` only so zod stays out of the bundle.
 */

export const STAFF_CSRF_HEADER = 'x-staff-csrf-token';
export const UNAUTHORIZED_EVENT = 'vamos:staff-unauthorized';

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
  if (!SAFE_METHODS.has(method) && csrfToken !== null) headers[STAFF_CSRF_HEADER] = csrfToken;

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
    if (error.status === 401 && error.code === 'unauthorized' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw error;
  }
  return body as T;
}
