/**
 * API base URLs. `NEXT_PUBLIC_API_URL` is inlined into the browser bundle at build
 * time (next.config.ts derives it from PUBLIC_API_URL when unset). Server code may
 * use a private address instead through `API_INTERNAL_URL`.
 */
export const DEFAULT_API_URL = 'http://localhost:4000';

function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Base URL the browser calls (credentials: 'include', CORS). */
export const PUBLIC_API_URL = withoutTrailingSlash(
  process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL,
);

/** Base URL for server-side rendering. */
export function serverApiUrl(): string {
  return withoutTrailingSlash(
    process.env.API_INTERNAL_URL ||
      process.env.PUBLIC_API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      DEFAULT_API_URL,
  );
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

/** Joins a base URL, a path ("/events") and a query; null/undefined values are dropped. */
export function buildUrl(base: string, path: string, query?: Query): string {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
