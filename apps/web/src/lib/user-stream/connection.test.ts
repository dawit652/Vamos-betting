import type { UserMessage } from '@vamos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_MAX_MS, STALL_MS } from '@/lib/sse/resilient';
import { fakeSse, type FakeSse } from '@/lib/sse/testing';
import { createUserStreamConnection } from './connection';
import { USER_MESSAGE_TYPES } from './messages';

let sse: FakeSse;

beforeEach(() => {
  vi.useFakeTimers();
  sse = fakeSse();
});

afterEach(() => {
  vi.useRealTimers();
});

const URL = 'http://api.test/me/stream';
const settled = {
  betId: '00000000-0000-4000-8000-000000000001',
  shortId: 'AB12CD34',
  status: 'won',
  gross: '2000',
  tax: '0',
  net: '2000',
  corrected: false,
};

function listener() {
  const messages: UserMessage[] = [];
  let resyncs = 0;
  return {
    messages,
    resyncs: () => resyncs,
    handlers: {
      onMessage: (message: UserMessage) => messages.push(message),
      onResync: () => {
        resyncs += 1;
      },
    },
  };
}

describe('the shared /me/stream connection', () => {
  it('opens one credentialed EventSource for every listener and closes it with the last', () => {
    const connection = createUserStreamConnection(() => sse.env, URL);
    const a = listener();
    const b = listener();
    const stopA = connection.subscribe(a.handlers);
    const stopB = connection.subscribe(b.handlers);
    expect(sse.sources).toHaveLength(1);
    expect(sse.last()).toMatchObject({ url: URL, withCredentials: true });
    expect(sse.last().listenedTypes).toEqual(expect.arrayContaining([...USER_MESSAGE_TYPES]));

    sse.last().open();
    sse.last().emit('bet.settled', JSON.stringify(settled));
    sse.last().emit('bet.settled', 'not json');
    sse.last().emit('ping');
    expect(a.messages).toEqual([{ type: 'bet.settled', data: settled }]);
    expect(b.messages).toEqual(a.messages);

    stopA();
    expect(sse.last().closed).toBe(false);
    stopB();
    expect(sse.last().closed).toBe(true);
    expect(sse.document.bound).toBe(0);
    vi.advanceTimersByTime(10 * STALL_MS);
    expect(sse.sources).toHaveLength(1);

    // A new listener starts afresh.
    const c = listener();
    const stopC = connection.subscribe(c.handlers);
    expect(sse.sources).toHaveLength(2);
    sse.last().open();
    expect(c.resyncs()).toBe(0);
    stopC();
  });

  it('tells every listener to resync after a gap: reconnect, tab back in view, stall, server resync', () => {
    const connection = createUserStreamConnection(() => sse.env, URL);
    const a = listener();
    const b = listener();
    const stops = [connection.subscribe(a.handlers), connection.subscribe(b.handlers)];
    sse.last().open();
    expect(a.resyncs()).toBe(0);

    sse.last().fail('retrying');
    sse.last().open();
    expect([a.resyncs(), b.resyncs()]).toEqual([1, 1]);

    sse.document.setVisibility('hidden');
    sse.document.setVisibility('visible');
    sse.last().open();
    expect(a.resyncs()).toBe(2);

    vi.advanceTimersByTime(STALL_MS);
    sse.last().open();
    expect(a.resyncs()).toBe(3);

    sse.last().emit('resync');
    expect([a.resyncs(), b.resyncs()]).toEqual([4, 4]);
    for (const stop of stops) stop();
  });

  it('keeps retrying a refused stream (a 401 after log out) at most once a minute', () => {
    const connection = createUserStreamConnection(() => sse.env, URL);
    const stop = connection.subscribe(listener().handlers);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      sse.last().fail('closed');
      const failedAt = Date.now();
      vi.advanceTimersToNextTimer(); // the retry is the only timer left
      waits.push(Date.now() - failedAt);
    }
    expect(waits).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
    expect(Math.max(...waits)).toBe(RECONNECT_MAX_MS);
    expect(sse.sources).toHaveLength(9);
    expect(sse.open()).toHaveLength(1);
    stop();
    expect(sse.open()).toHaveLength(0);
  });

  it('does nothing where there is no EventSource (server rendering, old browsers)', () => {
    const connection = createUserStreamConnection(() => null, URL);
    const stop = connection.subscribe(listener().handlers);
    expect(sse.sources).toHaveLength(0);
    stop();
  });
});
