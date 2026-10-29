/**
 * Per-host politeness plus a global concurrency cap (docs/scraper.md 6.3, 6.6).
 *
 * Requests to one host run one at a time (a queue per host); the next one
 * starts at least `intervalMs` (plus up to `jitterFraction` of it, from the
 * injected random) after the previous one FINISHED, so two starts are never
 * closer than the interval. The global cap is taken only around the request
 * itself, not while waiting, so a slow host cannot starve the others.
 */

class Semaphore {
  readonly #max: number;
  #active = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    } else {
      this.#active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiters.shift();
      if (next)
        next(); // hand the slot over directly
      else this.#active -= 1;
    }
  }
}

export interface HostRateLimiterOptions {
  /** Default minimum gap between requests to one host. */
  minIntervalMs: number;
  /** Extra random wait, up to this share of the interval (0.25 = 25%). */
  jitterFraction: number;
  maxConcurrency: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export class HostRateLimiter {
  readonly #o: HostRateLimiterOptions;
  readonly #semaphore: Semaphore;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #lastEnd = new Map<string, number>();

  constructor(options: HostRateLimiterOptions) {
    this.#o = options;
    this.#semaphore = new Semaphore(options.maxConcurrency);
  }

  /** Runs `fn` as the next request to `host`, waiting as long as politeness requires. */
  async run<T>(host: string, fn: () => Promise<T>, intervalMs?: number): Promise<T> {
    const prev = this.#tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => mine);
    this.#tails.set(host, tail);
    await prev;
    try {
      const interval = Math.max(this.#o.minIntervalMs, intervalMs ?? 0);
      const last = this.#lastEnd.get(host);
      if (last !== undefined) {
        const jitter = Math.floor(interval * this.#o.jitterFraction * clamp01(this.#o.random()));
        const wait = last + interval + jitter - this.#o.now();
        if (wait > 0) await this.#o.sleep(Math.ceil(wait));
      }
      return await this.#semaphore.run(async () => {
        try {
          return await fn();
        } finally {
          this.#lastEnd.set(host, this.#o.now());
        }
      });
    } finally {
      release();
      if (this.#tails.get(host) === tail) this.#tails.delete(host);
    }
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
