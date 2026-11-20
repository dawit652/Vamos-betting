import { describe, expect, it, vi } from 'vitest';
import { AnswerReuse, catalogReuseMs, DEFAULT_REUSE_MS, MAX_REUSED_ANSWERS } from './reuse';

/** A clock and a fetcher the tests drive by hand. */
function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const clock = { at: 1_000 };
  const reuse = new AnswerReuse({ ttlMs: 2_000, ...options, now: () => clock.at });
  let calls = 0;
  const fetcher = (value: string) => () => {
    calls += 1;
    return Promise.resolve(`${value}#${calls}`);
  };
  return { clock, reuse, fetcher, calls: () => calls };
}

describe('AnswerReuse', () => {
  it('reuses the answer inside the window and asks again after it', async () => {
    const { clock, reuse, fetcher, calls } = setup();
    expect(await reuse.get('/events', fetcher('a'))).toBe('a#1');
    clock.at += 1_999;
    expect(await reuse.get('/events', fetcher('a'))).toBe('a#1');
    expect(calls()).toBe(1);
    clock.at += 1;
    expect(await reuse.get('/events', fetcher('a'))).toBe('a#2');
    expect(calls()).toBe(2);
  });

  it('shares one request between 50 concurrent callers of the same URL', async () => {
    const { reuse } = setup();
    let release: (value: string) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const callers = Array.from({ length: 50 }, () => reuse.get('/sports', fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    release('answer');
    expect(await Promise.all(callers)).toEqual(Array.from({ length: 50 }, () => 'answer'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares a failure with the callers already waiting, then tries again', async () => {
    const { reuse } = setup();
    let fail: (error: Error) => void = () => undefined;
    const failing = vi.fn(() => new Promise<string>((_resolve, reject) => (fail = reject)));
    const waiting = [reuse.get('/events', failing), reuse.get('/events', failing)];
    const settled = Promise.allSettled(waiting);
    fail(new Error('api down'));
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(failing).toHaveBeenCalledTimes(1);

    // Nothing was kept: the next call asks the API again, inside the window.
    expect(reuse.size).toBe(0);
    expect(await reuse.get('/events', () => Promise.resolve('back'))).toBe('back');
  });

  it('treats a fetcher that throws at once as a rejection that is not kept', async () => {
    const { reuse } = setup();
    await expect(
      reuse.get('/events', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(reuse.size).toBe(0);
  });

  it('keeps at most maxEntries answers, dropping expired ones before live ones', async () => {
    const { clock, reuse, fetcher } = setup({ maxEntries: 3 });
    await reuse.get('/a', fetcher('a'));
    clock.at += 1_500;
    await reuse.get('/b', fetcher('b'));
    await reuse.get('/c', fetcher('c'));
    expect(reuse.size).toBe(3);

    // /a is the only expired entry: it goes, the younger two stay.
    clock.at += 600;
    await reuse.get('/d', fetcher('d'));
    expect(reuse.size).toBe(3);
    const refetch = vi.fn(() => Promise.resolve('again'));
    await reuse.get('/b', refetch);
    await reuse.get('/c', refetch);
    expect(refetch).not.toHaveBeenCalled();

    // Nothing is expired and the map is full: the oldest live entry (/b) makes room.
    await reuse.get('/e', fetcher('e'));
    expect(reuse.size).toBe(3);
    await reuse.get('/b', refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('holds at most MAX_REUSED_ANSWERS under a flood of distinct URLs', async () => {
    const reuse = new AnswerReuse({ ttlMs: 2_000, now: () => 0 });
    for (let i = 0; i < MAX_REUSED_ANSWERS * 2; i += 1) {
      await reuse.get(`/events?cursor=${i}`, () => Promise.resolve(i));
    }
    expect(reuse.size).toBe(MAX_REUSED_ANSWERS);
  });

  it('never shares an answer between different URLs or queries', async () => {
    const { reuse, fetcher } = setup();
    const a = await reuse.get('http://api/events?sport=football&filter=live', fetcher('live'));
    const b = await reuse.get('http://api/events?sport=football&filter=upcoming', fetcher('up'));
    const c = await reuse.get('http://api/events?sport=basketball&filter=live', fetcher('bb'));
    const d = await reuse.get('http://api/events', fetcher('all'));
    expect([a, b, c, d]).toEqual(['live#1', 'up#2', 'bb#3', 'all#4']);
  });

  it('does not reuse anything when the window is 0', async () => {
    const { reuse, fetcher, calls } = setup({ ttlMs: 0 });
    await reuse.get('/events', fetcher('a'));
    await reuse.get('/events', fetcher('a'));
    expect(calls()).toBe(2);
    expect(reuse.size).toBe(0);
  });
});

describe('catalogReuseMs', () => {
  it('defaults to 2000 and reads whole milliseconds, 0 included', () => {
    expect(catalogReuseMs(undefined)).toBe(DEFAULT_REUSE_MS);
    expect(DEFAULT_REUSE_MS).toBe(2_000);
    expect(catalogReuseMs('0')).toBe(0);
    expect(catalogReuseMs(' 500 ')).toBe(500);
  });

  it('falls back to the default for anything else', () => {
    for (const bad of ['', 'abc', '-1', '1.5', '1e3', '60001', '9999999']) {
      expect(catalogReuseMs(bad)).toBe(DEFAULT_REUSE_MS);
    }
  });
});
