/**
 * A circuit breaker per source (docs/scraper.md 6.3 S2). After `failureThreshold`
 * consecutive failures it opens for `cooldownMs`; then it lets exactly one probe
 * through (half-open). A successful probe closes it, a failed one re-opens it.
 *
 * Callers must settle every permitted request with `recordSuccess`,
 * `recordFailure` or `recordNeutral` (an outcome that says nothing about the
 * server's health, such as a policy refusal); otherwise a half-open probe would
 * hold the only permit until its lease expires.
 */

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export type CircuitDecision = { allowed: true } | { allowed: false; retryAt: Date };

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #failures = 0;
  #openedAt: number | null = null;
  #probeStartedAt: number | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#threshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#threshold) || this.#threshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(this.#cooldownMs) || this.#cooldownMs < 0) {
      throw new RangeError('cooldownMs must be a non-negative number');
    }
  }

  get state(): CircuitState {
    if (this.#openedAt === null) return 'closed';
    return this.#now() - this.#openedAt >= this.#cooldownMs ? 'half_open' : 'open';
  }

  /** Asks permission for one request. In half-open state only the first caller gets it. */
  tryAcquire(): CircuitDecision {
    if (this.#openedAt === null) return { allowed: true };
    const now = this.#now();
    const reopenAt = this.#openedAt + this.#cooldownMs;
    if (now < reopenAt) return { allowed: false, retryAt: new Date(reopenAt) };
    // Half-open: one probe at a time; a lease that was never settled expires after a cooldown.
    if (this.#probeStartedAt !== null && now - this.#probeStartedAt < this.#cooldownMs) {
      return { allowed: false, retryAt: new Date(this.#probeStartedAt + this.#cooldownMs) };
    }
    this.#probeStartedAt = now;
    return { allowed: true };
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openedAt = null;
    this.#probeStartedAt = null;
  }

  recordFailure(): void {
    const probing = this.#probeStartedAt !== null;
    this.#probeStartedAt = null;
    this.#failures += 1;
    if (probing || this.#failures >= this.#threshold) this.#openedAt = this.#now();
  }

  /** The request ended in a way that says nothing about the server: keep the counters, free a probe. */
  recordNeutral(): void {
    this.#probeStartedAt = null;
  }
}
