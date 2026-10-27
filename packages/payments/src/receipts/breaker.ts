/**
 * A circuit breaker around an institution's receipt page: during an outage
 * every check answers `indeterminate` at once instead of waiting out its
 * timeout, and the institution is probed once per cooldown.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Consecutive transport failures before the circuit opens. */
  threshold: number;
  /** How long it stays open before one probe is allowed. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, cooldownMs: 60_000 };

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
}

export const initialBreaker = (): BreakerSnapshot => ({
  state: 'closed',
  consecutiveFailures: 0,
  openedAt: null,
});

/** Whether a call may proceed (an open circuit past its cooldown allows one probe). */
export function breakerAllows(
  snapshot: BreakerSnapshot,
  config: BreakerConfig,
  now: number,
): boolean {
  if (snapshot.state === 'closed') return true;
  if (snapshot.state === 'half_open') return false;
  return snapshot.openedAt !== null && now - snapshot.openedAt >= config.cooldownMs;
}

/** Transport failures only; a clean rejection is a working service. */
export function breakerFailure(
  snapshot: BreakerSnapshot,
  config: BreakerConfig,
  now: number,
): BreakerSnapshot {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;
  if (snapshot.state === 'half_open' || consecutiveFailures >= config.threshold) {
    return { state: 'open', consecutiveFailures, openedAt: now };
  }
  return { state: 'closed', consecutiveFailures, openedAt: null };
}

export class Breaker {
  #snapshot = initialBreaker();
  readonly #config: BreakerConfig;
  readonly #now: () => number;

  constructor(config: BreakerConfig, now: () => number) {
    this.#config = config;
    this.#now = now;
  }

  get snapshot(): BreakerSnapshot {
    return this.#snapshot;
  }

  /** True when the caller may try; claims the half-open probe slot. */
  tryAcquire(): boolean {
    if (!breakerAllows(this.#snapshot, this.#config, this.#now())) return false;
    if (this.#snapshot.state === 'open') this.#snapshot = { ...this.#snapshot, state: 'half_open' };
    return true;
  }

  success(): void {
    this.#snapshot = initialBreaker();
  }

  failure(): void {
    this.#snapshot = breakerFailure(this.#snapshot, this.#config, this.#now());
  }
}
