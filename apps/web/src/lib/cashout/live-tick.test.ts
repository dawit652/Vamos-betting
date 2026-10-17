import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STALL_MS } from '@/lib/sse/resilient';
import { fakeSse, type FakeSse } from '@/lib/sse/testing';
import { liveTickUrl, openLiveTick } from './live-tick';
import { OFFER_REFRESH_MS } from './offer';

let sse: FakeSse;
let ticks: number;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  sse = fakeSse();
  ticks = 0;
  stop = openLiveTick(sse.env, 'http://api.test/live/stream?events=e1', () => {
    ticks += 1;
  });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

/** Lets the throttle's promise chain settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('openLiveTick (cash-out offers follow the live odds)', () => {
  it('builds the filtered public stream URL', () => {
    expect(liveTickUrl('http://api.test', ['e1', 'e 2'])).toBe(
      'http://api.test/live/stream?events=e1%2Ce%202',
    );
    expect(sse.last()).toMatchObject({
      url: 'http://api.test/live/stream?events=e1',
      withCredentials: false,
    });
  });

  it('ticks once the stream is open (offers may have moved since they were loaded)', async () => {
    sse.last().open();
    await settle();
    expect(ticks).toBe(1);
  });

  it('coalesces a burst of deltas into at most one tick per OFFER_REFRESH_MS', async () => {
    sse.last().open();
    await settle();
    for (const type of ['odds', 'match', 'market', 'odds']) sse.last().emit(type);
    sse.last().emit('ping'); // a heartbeat is no delta
    await settle();
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(OFFER_REFRESH_MS);
    expect(ticks).toBe(2);
    sse.last().emit('ping');
    await vi.advanceTimersByTimeAsync(OFFER_REFRESH_MS);
    expect(ticks).toBe(2);
  });

  it('ticks again after the tab comes back into view, and after a stalled stream reconnects', async () => {
    sse.last().open();
    await settle();
    sse.document.setVisibility('hidden');
    expect(sse.last().closed).toBe(true);
    sse.document.setVisibility('visible');
    sse.last().open();
    await vi.advanceTimersByTimeAsync(OFFER_REFRESH_MS);
    expect(ticks).toBe(2);

    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(sse.sources).toHaveLength(3);
    sse.last().open();
    await vi.advanceTimersByTimeAsync(OFFER_REFRESH_MS);
    expect(ticks).toBe(3);
  });

  it('stops: the source closes and no tick runs any more', async () => {
    sse.last().open();
    sse.last().emit('odds');
    stop();
    expect(sse.last().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * OFFER_REFRESH_MS);
    expect(ticks).toBe(1);
    expect(sse.document.bound).toBe(0);
  });
});
