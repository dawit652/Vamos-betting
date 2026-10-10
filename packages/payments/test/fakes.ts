import type { ProviderDeps } from '../src/types';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeResponse = { status: number; body: unknown } | Error;

/** A fetch that answers from a queue (or a handler) and records each request. */
export function fakeFetch(responses: FakeResponse[] | ((call: RecordedCall) => FakeResponse)) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const next = typeof responses === 'function' ? responses(call) : responses.shift();
    if (next === undefined) throw new Error(`unexpected request to ${call.url}`);
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export function fakeDeps(
  fetch: typeof globalThis.fetch,
  now: { value: Date } = { value: new Date('2026-10-10T09:00:00Z') },
): ProviderDeps & { now: { value: Date } } {
  let counter = 0;
  return {
    fetch,
    clock: () => now.value,
    randomBytes: (size) => {
      counter += 1;
      return new Uint8Array(size).fill(counter % 256);
    },
    now,
  };
}
