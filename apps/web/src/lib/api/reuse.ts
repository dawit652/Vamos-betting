/**
 * Short-lived reuse of public catalogue answers inside one Node process: the web server asks the
 * API for `/events?...` on every render, and under load many visitors ask for the same URL within
 * the same moment. The answer of one request is shared for a short window instead.
 *
 * Pure (no `server-only`, no I/O of its own): the clock and the fetcher are passed in, so it is
 * unit tested without a server. Never use it for anything tied to a person (the key is the URL
 * alone) or for data that must be current (bets read the real price in the API).
 */

export const DEFAULT_REUSE_MS = 2_000;
/** Most answers kept at once; one per distinct URL, so a flood of odd queries cannot grow memory. */
export const MAX_REUSED_ANSWERS = 500;
/** An upper bound on CATALOG_REUSE_MS: odds older than a minute are never wanted. */
const MAX_REUSE_MS = 60_000;

/** CATALOG_REUSE_MS: whole milliseconds, 0 turns the reuse off; unset or invalid means the default. */
export function catalogReuseMs(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  // Plain digits only (no sign, decimal point or exponent): a typo falls back to the default.
  if (!/^\d{1,6}$/.test(text)) return DEFAULT_REUSE_MS;
  const ms = Number(text);
  return ms > MAX_REUSE_MS ? DEFAULT_REUSE_MS : ms;
}

export interface ReuseOptions {
  /** How long an answer is reused, counted from when its request started; 0 turns reuse off. */
  ttlMs: number;
  /** Bound on the entries kept (default MAX_REUSED_ANSWERS). */
  maxEntries?: number;
  /** Monotonic milliseconds (default `performance.now`). */
  now?: () => number;
}

interface Entry {
  answer: Promise<unknown>;
  expiresAt: number;
}

/** Calls `fetcher` at once; one that throws synchronously is a rejection like any other. */
function start<T>(fetcher: () => Promise<T>): Promise<T> {
  try {
    return fetcher();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export class AnswerReuse {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: ReuseOptions) {
    this.maxEntries = options.maxEntries ?? MAX_REUSED_ANSWERS;
    this.now = options.now ?? (() => performance.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The answer for `key`: the one kept (or still in flight) when it is younger than the window,
   * else the result of a new `fetcher()` call. Callers share one in-flight request per key. A
   * rejection is passed to the callers already waiting for it and then forgotten, so the next
   * call tries again.
   */
  get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.options.ttlMs <= 0) return fetcher();
    const at = this.now();
    const kept = this.entries.get(key);
    if (kept !== undefined && at < kept.expiresAt) return kept.answer as Promise<T>;

    // An expired entry leaves the map first, so the new one is also the newest in its order.
    this.entries.delete(key);
    this.makeRoom(at);
    const answer = start(fetcher);
    const entry: Entry = { answer, expiresAt: at + this.options.ttlMs };
    this.entries.set(key, entry);
    answer.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return answer;
  }

  /** Expired entries go first; if the map is still full, the oldest one goes. */
  private makeRoom(at: number): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (at >= entry.expiresAt) this.entries.delete(key);
    }
    // A Map iterates in insertion order: the oldest first.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}
