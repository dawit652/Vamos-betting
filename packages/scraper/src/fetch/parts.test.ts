import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../constants';
import { backoffCeilingMs, backoffDelayMs, parseRetryAfter } from './backoff';
import { detectBlockPage } from './blockpage';
import { backoffAfterFailures, fixturesPollIntervalMs, isDue, resultsPollIntervalMs } from './cadence';
import { CircuitBreaker } from './circuit-breaker';
import { InMemoryConditionalStore } from './conditional';
import { decodeBody, decodeBodyDetailed, toRawDocument } from './decode';
import { HostRateLimiter } from './rate-limiter';
import { START, makeClock } from './test-helpers';
import type { FetchOk } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

describe('backoff', () => {
  const o = { baseMs: 1000, capMs: 30_000 };
  it('doubles up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((a) => backoffCeilingMs(a, o))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });
  it('property: delay in [0, cap]; ceiling non-decreasing in the attempt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (attempt, r) => {
        const d = backoffDelayMs(attempt, o, () => r);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(o.capMs);
        expect(backoffCeilingMs(attempt + 1, o)).toBeGreaterThanOrEqual(backoffCeilingMs(attempt, o));
      }),
    );
  });
  it('clamps a misbehaving random', () => {
    expect(backoffDelayMs(2, o, () => 7)).toBe(2000);
    expect(backoffDelayMs(2, o, () => -1)).toBe(0);
  });
  it('parses Retry-After seconds and dates, rejects junk', () => {
    expect(parseRetryAfter('120', START)).toBe(120_000);
    expect(parseRetryAfter(new Date(START + 5000).toUTCString(), START)).toBe(5000);
    expect(parseRetryAfter(new Date(START - 5000).toUTCString(), START)).toBe(0);
    expect(parseRetryAfter('soon', START)).toBeNull();
    expect(parseRetryAfter('-5', START)).toBeNull();
    expect(parseRetryAfter('', START)).toBeNull();
    expect(parseRetryAfter(null, START)).toBeNull();
    expect(parseRetryAfter('99999999999', START)).toBeLessThanOrEqual(365 * 24 * HOUR_MS);
  });
});

describe('decodeBody', () => {
  it('uses the header charset first', () => {
    expect(decodeBody(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=ISO-8859-1')).toBe('café');
  });
  it('falls back to the BOM, then <meta charset>, then UTF-8', () => {
    expect(decodeBody(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]), 'text/plain')).toBe('a');
    const meta = Uint8Array.from([...enc('<meta charset="windows-1252">caf'), 0xe9]);
    expect(decodeBodyDetailed(meta, 'text/html').source).toBe('meta');
    expect(decodeBody(meta, 'text/html')).toContain('café');
    expect(decodeBodyDetailed(enc('plain'), null)).toMatchObject({ charset: 'utf-8', source: 'default', fallback: false });
  });
  it('strips a UTF-8 BOM', () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), null)).toBe('hi');
  });
  it('flags an unknown label and falls back to UTF-8', () => {
    const d = decodeBodyDetailed(enc('ok'), 'text/plain; charset=klingon-9');
    expect(d).toMatchObject({ text: 'ok', charset: 'utf-8', fallback: true });
  });
  it('replaces invalid sequences instead of throwing', () => {
    expect(decodeBody(Uint8Array.from([0x61, 0xff, 0xfe, 0x62]), 'text/plain; charset=utf-8')).toBe('a��b');
  });
  it('property: never throws', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), fc.option(fc.string({ maxLength: 40 }), { nil: null }), (bytes, ct) => {
      expect(typeof decodeBody(bytes, ct)).toBe('string');
    }));
  });
  it('toRawDocument carries the fetch metadata', () => {
    const ok: FetchOk = {
      kind: 'ok', status: 200, url: 'https://a.example/x', headers: {}, body: enc('{"a":1}'),
      contentType: 'application/json', fetchedAt: new Date(START), durationMs: 5, attempts: 1, contentHash: 'h'.repeat(64),
    };
    expect(toRawDocument('src', ok)).toEqual({
      sourceId: 'src', url: ok.url, status: 200, contentType: 'application/json', body: '{"a":1}', fetchedAt: ok.fetchedAt, contentHash: ok.contentHash,
    });
  });
});

describe('detectBlockPage', () => {
  it('spots challenge markers in 200/403/429/503 only, in the first 4 KB only', () => {
    const page = enc('<html><title>Attention Required! | Cloudflare</title></html>');
    for (const s of [200, 403, 429, 503]) expect(detectBlockPage(s, page)).toBe(true);
    expect(detectBlockPage(404, page)).toBe(false);
    expect(detectBlockPage(200, enc('<div class="g-recaptcha">captcha</div>'))).toBe(true);
    expect(detectBlockPage(200, enc(`${' '.repeat(5000)}captcha`))).toBe(false);
    expect(detectBlockPage(200, enc('{"matches":[]}'))).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures, probes once after the cooldown, closes on success', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });
    for (let i = 0; i < 2; i += 1) {
      expect(b.tryAcquire().allowed).toBe(true);
      b.recordFailure();
    }
    b.recordSuccess(); // resets the streak
    for (let i = 0; i < 3; i += 1) b.recordFailure();
    expect(b.state).toBe('open');
    const denied = b.tryAcquire();
    expect(denied).toEqual({ allowed: false, retryAt: new Date(START + 1000) });
    clock.advance(1000);
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire().allowed).toBe(true); // the probe
    expect(b.tryAcquire().allowed).toBe(false); // nobody else
    b.recordFailure(); // probe failed: open again, fresh cooldown
    expect(b.state).toBe('open');
    clock.advance(1000);
    expect(b.tryAcquire().allowed).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe('closed');
    expect(b.tryAcquire().allowed).toBe(true);
  });
  it('a neutral outcome frees the probe without closing', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: clock.now });
    b.recordFailure();
    clock.advance(10);
    expect(b.tryAcquire().allowed).toBe(true);
    b.recordNeutral();
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire().allowed).toBe(true);
  });
  it('an unsettled probe lease expires', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: clock.now });
    b.recordFailure();
    clock.advance(10);
    expect(b.tryAcquire().allowed).toBe(true);
    clock.advance(10);
    expect(b.tryAcquire().allowed).toBe(true);
  });
});

describe('InMemoryConditionalStore', () => {
  it('stores, replaces and forgets validators', () => {
    const s = new InMemoryConditionalStore();
    expect(s.get('u')).toBeUndefined();
    s.set('u', { etag: '"a"', lastModified: null });
    expect(s.get('u')).toEqual({ etag: '"a"', lastModified: null });
    s.set('u', { etag: null, lastModified: null });
    expect(s.get('u')).toBeUndefined();
  });
});

describe('HostRateLimiter', () => {
  it('property: starts to one host are never closer than the minimum interval (simulated clock)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 3000 })), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.array(fc.double({ min: 0, max: 0.999, noNaN: true }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 4 }),
        async (jobs, interval, randoms, cap) => {
          const clock = makeClock();
          let i = 0;
          const limiter = new HostRateLimiter({
            minIntervalMs: interval, jitterFraction: 0.25, maxConcurrency: cap,
            now: clock.now, sleep: clock.sleep, random: () => randoms[i++ % randoms.length] ?? 0,
          });
          const starts = new Map<string, number[]>();
          await Promise.all(
            jobs.map(([h, duration]) =>
              limiter.run(`h${h}`, async () => {
                const list = starts.get(`h${h}`) ?? [];
                list.push(clock.now());
                starts.set(`h${h}`, list);
                clock.advance(duration);
                await Promise.resolve();
              }),
            ),
          );
          for (const list of starts.values()) {
            for (let k = 1; k < list.length; k += 1) {
              expect((list[k] ?? 0) - (list[k - 1] ?? 0)).toBeGreaterThanOrEqual(interval);
            }
          }
        },
      ),
    );
  });

  it('adds at most 25% jitter and honours a larger per-call interval', async () => {
    const clock = makeClock();
    const limiter = new HostRateLimiter({ minIntervalMs: 2000, jitterFraction: 0.25, maxConcurrency: 4, now: clock.now, sleep: clock.sleep, random: () => 0.999 });
    await limiter.run('h', () => Promise.resolve());
    await limiter.run('h', () => Promise.resolve());
    expect(clock.sleeps).toEqual([2499]);
    await limiter.run('h', () => Promise.resolve(), 10_000);
    expect(clock.sleeps[1]).toBe(12_497);
  });

  it('never exceeds the global concurrency cap', async () => {
    const clock = makeClock();
    const limiter = new HostRateLimiter({ minIntervalMs: 0, jitterFraction: 0, maxConcurrency: 2, now: clock.now, sleep: clock.sleep, random: () => 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((h) =>
        limiter.run(h, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('keeps a host serial even when a task throws', async () => {
    const clock = makeClock();
    const limiter = new HostRateLimiter({ minIntervalMs: 0, jitterFraction: 0, maxConcurrency: 4, now: clock.now, sleep: clock.sleep, random: () => 0 });
    await expect(limiter.run('h', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run('h', () => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('cadence', () => {
  const kickoff = new Date(START);
  it('fixtures every 15 minutes', () => expect(fixturesPollIntervalMs()).toBe(15 * MINUTE_MS));
  it('results: 5 minutes inside [k+90min, k+6h], else 60', () => {
    const at = (offsetMin: number) => new Date(START + offsetMin * MINUTE_MS);
    expect(resultsPollIntervalMs(at(89), [kickoff])).toBe(60 * MINUTE_MS);
    expect(resultsPollIntervalMs(at(90), [kickoff])).toBe(5 * MINUTE_MS);
    expect(resultsPollIntervalMs(at(360), [kickoff])).toBe(5 * MINUTE_MS);
    expect(resultsPollIntervalMs(at(361), [kickoff])).toBe(60 * MINUTE_MS);
    expect(resultsPollIntervalMs(at(0), [])).toBe(60 * MINUTE_MS);
    expect(resultsPollIntervalMs(at(100), [new Date('x'), kickoff])).toBe(5 * MINUTE_MS);
    expect(resultsPollIntervalMs(new Date('x'), [kickoff])).toBe(60 * MINUTE_MS);
  });
  it('isDue', () => {
    const now = new Date(START + 10 * MINUTE_MS);
    expect(isDue({ lastRunAt: null, intervalMs: 1, now })).toBe(true);
    expect(isDue({ lastRunAt: new Date(START), intervalMs: 10 * MINUTE_MS, now })).toBe(true);
    expect(isDue({ lastRunAt: new Date(START + 1), intervalMs: 10 * MINUTE_MS, now })).toBe(false);
    expect(isDue({ lastRunAt: new Date(START + 1), intervalMs: 10 * MINUTE_MS, now, jitterFraction: 0.1 })).toBe(true);
    expect(isDue({ lastRunAt: new Date(START + 20 * MINUTE_MS), intervalMs: HOUR_MS, now })).toBe(true); // clock skew
  });
  it('property: jitter only makes a run earlier; due is monotonic in time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e7 }), fc.integer({ min: 0, max: 1e7 }), fc.integer({ min: 0, max: 1e7 }), fc.double({ min: 0, max: 1, noNaN: true }), (interval, elapsed, extra, j) => {
        const last = new Date(START);
        const t1 = new Date(START + elapsed);
        const t2 = new Date(START + elapsed + extra);
        if (isDue({ lastRunAt: last, intervalMs: interval, now: t1 })) expect(isDue({ lastRunAt: last, intervalMs: interval, now: t1, jitterFraction: j })).toBe(true);
        if (isDue({ lastRunAt: last, intervalMs: interval, now: t1, jitterFraction: j })) expect(isDue({ lastRunAt: last, intervalMs: interval, now: t2, jitterFraction: j })).toBe(true);
      }),
    );
  });
  it('backoffAfterFailures doubles up to 6 h and never goes below normal', () => {
    const n = 15 * MINUTE_MS;
    expect([0, 1, 2, 3, 4, 5, 99].map((f) => backoffAfterFailures(f, n))).toEqual([n, 2 * n, 4 * n, 8 * n, 16 * n, 6 * HOUR_MS, 6 * HOUR_MS]);
    expect(backoffAfterFailures(3, 12 * HOUR_MS)).toBe(12 * HOUR_MS);
    expect(backoffAfterFailures(-4, n)).toBe(n);
    expect(backoffAfterFailures(Number.NaN, n)).toBe(n);
  });
  it('property: backoff is non-decreasing in failures and within [normal, max(normal, 6h)]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 24 * HOUR_MS }), fc.integer({ min: 0, max: 100 }), (normal, f) => {
        const a = backoffAfterFailures(f, normal);
        expect(backoffAfterFailures(f + 1, normal)).toBeGreaterThanOrEqual(a);
        expect(a).toBeGreaterThanOrEqual(normal);
        expect(a).toBeLessThanOrEqual(Math.max(normal, 6 * HOUR_MS));
      }),
    );
  });
});
