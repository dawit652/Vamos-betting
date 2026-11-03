import { describe, expect, it, vi } from 'vitest';
import {
  OddsApiClient,
  OddsApiError,
  type OddsApiClientOptions,
  estimateOddsCost,
  estimateScoresCost,
} from './client';
import basketball from './fixtures/odds-basketball.json';
import soccer from './fixtures/odds-soccer.json';
import scores from './fixtures/scores-soccer.json';
import sports from './fixtures/sports.json';

const KEY = 'sekret-KEY_123';

interface Call {
  url: URL;
  init: RequestInit | undefined;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(
  responses: Array<Response | Error | (() => Promise<Response>)>,
  options: Partial<OddsApiClientOptions> = {},
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url: new URL(href), init });
    const next = queue.shift();
    if (next === undefined) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  const sleep = vi.fn(async () => {});
  const client = new OddsApiClient({
    apiKey: KEY,
    fetch: fetch,
    sleep,
    random: () => 0.5,
    ...options,
  });
  return { client, calls, fetch, sleep };
}

async function failure(promise: Promise<unknown>): Promise<OddsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OddsApiError);
    return error as OddsApiError;
  }
  throw new Error('expected a rejection');
}

describe('requests', () => {
  it('GET /sports sends the key, dateFormat and optionally all=true', async () => {
    const { client, calls } = setup([json(sports), json(sports)]);
    const result = await client.sports();
    expect(result.data).toHaveLength(sports.length);
    await client.sports({ all: true });
    const first = calls[0]!;
    expect(first.url.origin + first.url.pathname).toBe('https://api.the-odds-api.com/v4/sports');
    expect(first.url.searchParams.get('apiKey')).toBe(KEY);
    expect(first.url.searchParams.get('dateFormat')).toBe('iso');
    expect(first.url.searchParams.has('all')).toBe(false);
    expect(new Headers(first.init?.headers).get('accept')).toBe('application/json');
    expect(calls[1]!.url.searchParams.get('all')).toBe('true');
  });

  it('events() sends filters with whole-second dates and no odds params', async () => {
    const { client, calls } = setup([json([])]);
    await client.events('soccer_epl', {
      eventIds: ['a1', 'b-2'],
      commenceTimeFrom: new Date('2026-11-08T00:00:00.789Z'),
      commenceTimeTo: new Date('2026-11-09T12:30:00Z'),
    });
    const { url } = calls[0]!;
    expect(url.pathname).toBe('/v4/sports/soccer_epl/events');
    expect(url.searchParams.get('eventIds')).toBe('a1,b-2');
    expect(url.searchParams.get('commenceTimeFrom')).toBe('2026-11-08T00:00:00Z');
    expect(url.searchParams.get('commenceTimeTo')).toBe('2026-11-09T12:30:00Z');
    expect(url.searchParams.get('dateFormat')).toBe('iso');
    expect(url.searchParams.has('oddsFormat')).toBe(false);
  });

  it('odds() joins lists, sends oddsFormat=decimal and parses the fixture', async () => {
    const { client, calls } = setup([json(soccer)]);
    const result = await client.odds('soccer_epl', {
      markets: ['h2h', 'totals'],
      regions: ['eu', 'uk'],
    });
    expect(result.data).toHaveLength(2);
    const { url } = calls[0]!;
    expect(url.pathname).toBe('/v4/sports/soccer_epl/odds');
    expect(url.searchParams.get('markets')).toBe('h2h,totals');
    expect(url.searchParams.get('regions')).toBe('eu,uk');
    expect(url.searchParams.get('oddsFormat')).toBe('decimal');
    expect(url.searchParams.get('dateFormat')).toBe('iso');
    expect(url.searchParams.has('bookmakers')).toBe(false);
  });

  it('prefers bookmakers over regions', async () => {
    const { client, calls } = setup([json(basketball)]);
    await client.odds('basketball_nba', {
      markets: ['spreads'],
      regions: ['us'],
      bookmakers: ['pinnacle', 'fanduel'],
    });
    const { url } = calls[0]!;
    expect(url.searchParams.get('bookmakers')).toBe('pinnacle,fanduel');
    expect(url.searchParams.has('regions')).toBe(false);
  });

  it('eventOdds() encodes the path and returns one event or null', async () => {
    const one = soccer[0];
    const { client, calls } = setup([json(one), json({ nope: true })]);
    const result = await client.eventOdds('soccer_epl', 'a1b2-c_3', {
      markets: ['h2h'],
      regions: ['eu'],
    });
    expect(result.data?.id).toBe(one!.id);
    expect(calls[0]!.url.pathname).toBe('/v4/sports/soccer_epl/events/a1b2-c_3/odds');
    const empty = await client.eventOdds('soccer_epl', 'x', { markets: ['h2h'], regions: ['eu'] });
    expect(empty.data).toBeNull();
    expect(empty.dropped).toBe(1);
  });

  it('scores() sends daysFrom and eventIds; participants() hits its path', async () => {
    const { client, calls } = setup([json(scores), json([{ full_name: 'Arsenal', id: 'p1' }])]);
    const result = await client.scores('soccer_epl', { daysFrom: 2, eventIds: ['e1'] });
    expect(result.data).toHaveLength(3);
    expect(calls[0]!.url.pathname).toBe('/v4/sports/soccer_epl/scores');
    expect(calls[0]!.url.searchParams.get('daysFrom')).toBe('2');
    expect(calls[0]!.url.searchParams.get('eventIds')).toBe('e1');
    const people = await client.participants('soccer_epl');
    expect(people.data).toEqual([{ id: 'p1', fullName: 'Arsenal' }]);
    expect(calls[1]!.url.pathname).toBe('/v4/sports/soccer_epl/participants');
  });

  it('ignores a trailing slash on baseUrl', async () => {
    const { client, calls } = setup([json([])], { baseUrl: 'https://example.test/v4/' });
    await client.sports();
    expect(calls[0]!.url.href.startsWith('https://example.test/v4/sports?')).toBe(true);
  });

  it('rejects bad arguments before any request', async () => {
    const { client, fetch } = setup([]);
    const q = { markets: ['h2h'], regions: ['eu'] };
    await expect(client.odds('Soccer/EPL', q)).rejects.toThrow(RangeError);
    await expect(client.odds('x', q)).rejects.toThrow(RangeError);
    await expect(client.eventOdds('soccer_epl', 'a/b', q)).rejects.toThrow(RangeError);
    await expect(client.odds('soccer_epl', { markets: [], regions: ['eu'] })).rejects.toThrow(
      RangeError,
    );
    await expect(client.odds('soccer_epl', { markets: ['h2h'] })).rejects.toThrow(RangeError);
    await expect(client.events('soccer_epl', { eventIds: ['bad id'] })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new OddsApiClient({ apiKey: '' })).toThrow(RangeError);
  });
});

describe('quota and leniency', () => {
  it('reads the quota headers, with garbled or absent values as null', async () => {
    const { client } = setup([
      json([], 200, {
        'x-requests-remaining': '488',
        'x-requests-used': '12',
        'x-requests-last': 'x',
      }),
      json([]),
    ]);
    expect((await client.sports()).quota).toEqual({ remaining: 488, used: 12, last: null });
    expect((await client.sports()).quota).toEqual({ remaining: null, used: null, last: null });
  });

  it('reports dropped entries without failing the call', async () => {
    const broken = [{ ...soccer[0], commence_time: 'bad' }, soccer[1]];
    const { client } = setup([json(broken)]);
    const result = await client.odds('soccer_epl', { markets: ['h2h'], regions: ['eu'] });
    expect(result.data).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });
});

describe('errors', () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { message: 'bad key', error_code: 'INVALID_KEY' }, 'auth', false],
    [401, { message: 'out', error_code: 'OUT_OF_USAGE_CREDITS' }, 'quota', false],
    [403, { message: 'no' }, 'auth', false],
    [404, { message: 'unknown sport', error_code: 'UNKNOWN_SPORT' }, 'not_found', false],
    [422, { message: 'bad market', error_code: 'INVALID_MARKET' }, 'invalid_request', false],
    [400, { message: 'bad' }, 'invalid_request', false],
    [429, { message: 'slow down', error_code: 'EXCEEDED_FREQ_LIMIT' }, 'rate_limited', true],
    [429, { message: 'out', error_code: 'OUT_OF_USAGE_CREDITS' }, 'quota', false],
    [500, { message: 'oops' }, 'server', true],
    [503, 'not json at all', 'server', true],
  ];

  it.each(cases)('maps %i %j to %s', async (status, body, kind, retryable) => {
    const response = () =>
      typeof body === 'string' ? new Response(body, { status }) : json(body, status);
    const { client } = setup([response(), response(), response()]);
    const error = await failure(client.sports());
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.path).toBe('/sports');
  });

  it('writes a readable message with code and server text', async () => {
    const body = { message: 'Markets not supported', error_code: 'INVALID_MARKET' };
    const { client } = setup([json(body, 422, { 'x-requests-remaining': '9' })]);
    const error = await failure(client.odds('soccer_epl', { markets: ['nope'], regions: ['eu'] }));
    expect(error.message).toBe(
      'The Odds API GET /sports/soccer_epl/odds failed: 422 INVALID_MARKET (Markets not supported)',
    );
    expect(error.code).toBe('INVALID_MARKET');
    expect(error.quota?.remaining).toBe(9);
    expect(error.path).not.toContain('?');
  });

  it('flags a 2xx with a non-JSON body as bad_response', async () => {
    const { client, fetch } = setup([new Response('<html>', { status: 200 })]);
    const error = await failure(client.sports());
    expect(error.kind).toBe('bad_response');
    expect(error.retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps a rejecting fetch to network', async () => {
    const { client } = setup([new TypeError('fetch failed'), new TypeError('fetch failed')], {
      retries: 1,
    });
    const error = await failure(client.sports());
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
    expect(error.message).toContain('fetch failed');
  });

  it('maps an abort from the timeout to timeout', async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const { client, sleep } = setup([], {
      fetch: hang,
      timeoutMs: 10,
      retries: 0,
    });
    const error = await failure(client.sports());
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('retries', () => {
  it('retries a 429 then succeeds, backing off 500 ms then 1000 ms', async () => {
    const limited = () => json({ message: 'slow', error_code: 'EXCEEDED_FREQ_LIMIT' }, 429);
    const { client, sleep, fetch } = setup([limited(), limited(), json(sports)]);
    const result = await client.sports();
    expect(result.data).toHaveLength(sports.length);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c as unknown[])).toEqual([[500], [1000]]);
  });

  it('retries a 5xx then succeeds, applying jitter within 20%', async () => {
    const low = setup([json({ message: 'x' }, 502), json([])], { random: () => 0 });
    await low.client.sports();
    expect(low.sleep).toHaveBeenCalledWith(400);
    const high = setup([json({ message: 'x' }, 502), json([])], { random: () => 1 });
    await high.client.sports();
    expect(high.sleep).toHaveBeenCalledWith(600);
  });

  it('honours Retry-After when longer than the backoff and caps at 30 s', async () => {
    const a = setup([json({ message: 'x' }, 429, { 'retry-after': '7' }), json([])]);
    await a.client.sports();
    expect(a.sleep).toHaveBeenCalledWith(7000);
    const b = setup([json({ message: 'x' }, 429, { 'retry-after': '120' }), json([])]);
    await b.client.sports();
    expect(b.sleep).toHaveBeenCalledWith(30_000);
    const c = setup([json({ message: 'x' }, 429, { 'retry-after': '0' }), json([])]);
    await c.client.sports();
    expect(c.sleep).toHaveBeenCalledWith(500);
  });

  it('gives up after the configured retries with the last error', async () => {
    const down = () => json({ message: 'down' }, 500);
    const { client, fetch } = setup([down(), down(), down(), down()], { retries: 2 });
    const error = await failure(client.sports());
    expect(error.kind).toBe('server');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([401, 404, 422])('does not retry a %i', async (status) => {
    const { client, fetch, sleep } = setup([json({ message: 'no' }, status), json([])]);
    await failure(client.sports());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('API key secrecy', () => {
  function expectNoKey(error: OddsApiError) {
    const surfaces = [
      String(error),
      error.message,
      JSON.stringify(error),
      error.stack ?? '',
      error.path,
    ];
    for (const text of surfaces) expect(text).not.toContain(KEY);
    expect(Object.values(error)).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  }

  it('is absent from a network error that echoes the URL', async () => {
    const leaky = new TypeError(`fetch failed for https://x/v4/sports?apiKey=${KEY}&a=1`);
    const { client } = setup([leaky], { retries: 0 });
    const error = await failure(client.sports());
    expectNoKey(error);
    expect(error.message).toContain('apiKey=***');
  });

  it('is absent from errors that echo the key in the response body', async () => {
    const body = { message: `Invalid key ${KEY}`, error_code: 'INVALID_KEY' };
    const { client } = setup([json(body, 401)]);
    const error = await failure(client.sports());
    expectNoKey(error);
    expect(error.message).toContain('***');
  });

  it('is absent from timeout and bad_response errors', async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(`aborted ${KEY}`)));
      });
    const timed = setup([], {
      fetch: hang,
      timeoutMs: 5,
      retries: 0,
    });
    expectNoKey(await failure(timed.client.sports()));
    const bad = setup([new Response('nope', { status: 200 })]);
    expectNoKey(await failure(bad.client.sports()));
  });
});

describe('cost estimates', () => {
  it('multiplies markets by regions', () => {
    expect(estimateOddsCost({ markets: ['h2h', 'totals'], regions: ['eu'] })).toBe(2);
    expect(estimateOddsCost({ markets: ['h2h'], regions: ['eu', 'uk', 'us'] })).toBe(3);
  });

  it('counts one region per 10 bookmakers and prefers bookmakers', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `b${i}`);
    expect(estimateOddsCost({ markets: ['h2h', 'totals'], bookmakers: twelve })).toBe(4);
    expect(
      estimateOddsCost({ markets: ['h2h'], regions: ['eu', 'uk', 'us'], bookmakers: ['pinnacle'] }),
    ).toBe(1);
  });

  it('requires markets and a scope', () => {
    expect(() => estimateOddsCost({ markets: [], regions: ['eu'] })).toThrow(RangeError);
    expect(() => estimateOddsCost({ markets: ['h2h'] })).toThrow(RangeError);
  });

  it('prices scores at 1, or 2 with daysFrom', () => {
    expect(estimateScoresCost()).toBe(1);
    expect(estimateScoresCost(1)).toBe(2);
    expect(estimateScoresCost(3)).toBe(2);
  });
});
