import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from './throttle';

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first request at once', () => {
    const run = vi.fn();
    createThrottle(run, 2000).request();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one later run, at least the interval after the first', async () => {
    const run = vi.fn();
    const throttle = createThrottle(run, 2000);
    throttle.request();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 20; i++) throttle.request();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1990);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never starts two runs less than the interval apart', async () => {
    const starts: number[] = [];
    const throttle = createThrottle(() => starts.push(Date.now()), 2000);
    for (let i = 0; i < 100; i++) {
      throttle.request();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(starts.length).toBeGreaterThan(5);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(2000);
    }
  });

  it('waits for a run in flight before starting the next', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const throttle = createThrottle(run, 1000);
    throttle.request();
    await vi.advanceTimersByTimeAsync(5000);
    throttle.request();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failing run', async () => {
    const run = vi.fn(() => Promise.reject(new Error('boom')));
    const throttle = createThrottle(run, 1000);
    throttle.request();
    await vi.advanceTimersByTimeAsync(1500);
    throttle.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing after cancel', async () => {
    const run = vi.fn();
    const throttle = createThrottle(run, 1000);
    throttle.request();
    throttle.request();
    throttle.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    throttle.request();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
