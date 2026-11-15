import type { FetchLike } from './polite-fetcher';

/** Test-only helpers (not exported from the package index). */

export const START = Date.UTC(2026, 5, 1, 12, 0, 0);

/** A manual clock: `sleep` advances it instantly and records the request. */
export function makeClock(start = START) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number): void => {
      t += ms;
    },
    sleeps,
  };
}

export interface Call {
  url: string;
  headers: Record<string, string>;
}

export type Handler = (url: URL, call: Call) => Response | Promise<Response> | Error;

/** A fake fetch driven by a handler; records every call. An Error return is thrown as a network failure. */
export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl: FetchLike = async (input, init) => {
    const call: Call = { url: input, headers: { ...(init.headers as Record<string, string>) } };
    calls.push(call);
    const out = await handler(new URL(input), call);
    if (out instanceof Error) throw out;
    return out;
  };
  return { impl, calls, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

export function res(
  body: string | Uint8Array | null,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
  const h = { 'content-type': 'text/html; charset=utf-8', ...headers };
  return new Response(noBody ? null : body, { status, headers: h });
}

export const ROBOTS_OK = res('User-agent: *\nDisallow: /private\n', 200, {
  'content-type': 'text/plain',
});
