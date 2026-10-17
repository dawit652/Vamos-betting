import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openResilientSource,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  STALL_MS,
  type ResilientSourceOptions,
} from './resilient';
import { fakeSse, type FakeSse } from './testing';

let sse: FakeSse;
let events: Array<[string, string]>;
let resyncs: number;
let stops: Array<() => void>;

function start(options: Partial<ResilientSourceOptions> = {}) {
  const stop = openResilientSource({
    env: sse.env,
    url: 'http://api.test/stream',
    events: ['odds', 'bet.settled'],
    onEvent: (type, data) => events.push([type, data]),
    onResync: () => {
      resyncs += 1;
    },
    ...options,
  });
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  sse = fakeSse();
  events = [];
  resyncs = 0;
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers();
});

describe('openResilientSource', () => {
  it('opens one source, relays the named events it was given, and resyncs only after a gap', () => {
    start({ withCredentials: true });
    expect(sse.sources).toHaveLength(1);
    const source = sse.last();
    expect(source).toMatchObject({ url: 'http://api.test/stream', withCredentials: true });
    expect(source.listenedTypes).toEqual(
      expect.arrayContaining(['odds', 'bet.settled', 'ping', 'resync']),
    );
    source.open();
    expect(resyncs).toBe(0); // the first connection missed nothing
    source.emit('odds', '{"s":"x"}');
    source.emit('ping');
    expect(events).toEqual([['odds', '{"s":"x"}']]);
  });

  it('can resync on the first open too (callers that load before they listen)', () => {
    start({ resyncOnFirstOpen: true });
    sse.last().open();
    expect(resyncs).toBe(1);
  });

  it('a network error leaves the reconnect to the browser, then resyncs once it is back', () => {
    start();
    const source = sse.last();
    source.open();
    source.fail('retrying');
    vi.advanceTimersByTime(STALL_MS - 1); // (a stall would replace it after STALL_MS)
    expect(sse.sources).toHaveLength(1); // no second EventSource
    expect(source.closed).toBe(false);
    source.open(); // the browser reconnected
    expect(resyncs).toBe(1);
  });

  it('a refusal (401, 503, 502) reopens with backoff: 3 s doubling to at most 60 s, reset once open', () => {
    start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const source = sse.last();
      source.fail('closed');
      expect(source.closed).toBe(true);
      const opened = sse.sources.length;
      let waited = 0;
      while (sse.sources.length === opened) {
        vi.advanceTimersByTime(1_000);
        waited += 1_000;
        if (waited > RECONNECT_MAX_MS) throw new Error('never reopened');
      }
      delays.push(waited);
    }
    // A logged-out player (401) keeps being retried, once a minute at most.
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);
    expect(RECONNECT_MIN_MS).toBe(3_000);

    sse.last().open();
    expect(resyncs).toBe(1);
    sse.last().fail('closed');
    vi.advanceTimersByTime(RECONNECT_MIN_MS - 1);
    const before = sse.sources.length;
    vi.advanceTimersByTime(1);
    expect(sse.sources.length).toBe(before + 1);
  });

  it('closes while the tab is hidden and resyncs when it is back in view', () => {
    start();
    const first = sse.last();
    first.open();
    sse.document.setVisibility('hidden');
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(10 * STALL_MS);
    expect(sse.sources).toHaveLength(1);
    sse.document.setVisibility('visible');
    expect(sse.sources).toHaveLength(2);
    sse.last().open();
    expect(resyncs).toBe(1);
  });

  it('a pending retry waits while hidden; nothing opens before the tab is visible', () => {
    sse.document.visibilityState = 'hidden';
    start();
    expect(sse.sources).toHaveLength(0);
    sse.document.setVisibility('visible');
    expect(sse.sources).toHaveLength(1);
    sse.last().open();
    expect(resyncs).toBe(1); // it was not listening while hidden
  });

  it('reconnects a stalled stream (no frame, not even a heartbeat, for STALL_MS) and resyncs', () => {
    start();
    const first = sse.last();
    first.open();
    // Heartbeats keep it alive.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(STALL_MS - 1_000);
      first.emit('ping');
    }
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(STALL_MS);
    expect(first.closed).toBe(true);
    expect(sse.sources).toHaveLength(2);
    sse.last().open();
    expect(resyncs).toBe(1);
  });

  it('resyncs when the server says pushes were lost', () => {
    start();
    sse.last().open();
    sse.last().emit('resync');
    expect(resyncs).toBe(1);
    expect(events).toEqual([]);
  });

  it('stop closes the source, cancels timers and unbinds the visibility listener', () => {
    const stop = start();
    sse.last().fail('closed');
    expect(sse.document.bound).toBe(1);
    stop();
    expect(sse.document.bound).toBe(0);
    vi.advanceTimersByTime(10 * RECONNECT_MAX_MS);
    expect(sse.sources).toHaveLength(1);
    sse.document.setVisibility('hidden');
    sse.document.setVisibility('visible');
    expect(sse.sources).toHaveLength(1);

    const again = start();
    const open = sse.last();
    again();
    expect(open.closed).toBe(true);
  });
});
