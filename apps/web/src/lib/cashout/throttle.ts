/**
 * Runs `run` at most once per `minIntervalMs`, however often `request()` is
 * called (cash-out offers are re-fetched when live deltas arrive, and a goal
 * can send a burst of them). The first request runs at once; requests that
 * arrive sooner, or while `run` is still in flight, are coalesced into one
 * run as soon as the interval has passed and the previous run has settled.
 * `run` may return a promise; its failures are ignored (the caller handles
 * them). After `cancel()` nothing runs again.
 */

export interface Throttle {
  request(): void;
  cancel(): void;
}

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Resolved at call time so fake timers (tests) are honoured.
const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createThrottle(
  run: () => unknown,
  minIntervalMs: number,
  clock: ThrottleClock = realClock,
): Throttle {
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let inFlight = false;
  let dirty = false;
  let stopped = false;

  const start = () => {
    dirty = false;
    lastStart = clock.now();
    inFlight = true;
    let result: unknown;
    try {
      result = run();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        schedule();
      });
  };

  function schedule(): void {
    if (stopped || !dirty || inFlight || timer !== null) return;
    const wait = Math.max(0, lastStart + minIntervalMs - clock.now());
    if (wait === 0) {
      start();
      return;
    }
    timer = clock.setTimeout(() => {
      timer = null;
      if (!stopped) schedule();
    }, wait);
  }

  return {
    request() {
      if (stopped) return;
      dirty = true;
      schedule();
    },
    cancel() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
