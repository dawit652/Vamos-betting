/** Browser-visible API base URL, inlined at build time (see next.config.ts). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(
  /\/$/,
  '',
);

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

/** Joins a base URL, a path and a query; null, undefined and empty values are dropped. */
export function buildUrl(base: string, path: string, query?: Query): string {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') params.append(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? url : `${url}?${qs}`;
}
