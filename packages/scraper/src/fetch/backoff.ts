/** Retry timing (docs/scraper.md 6.3 S2): exponential backoff with full jitter, and Retry-After. */

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

const MAX_EXPONENT = 30;
/** A Retry-After beyond a year is clamped, so dates stay representable. */
const MAX_RETRY_AFTER_MS = 365 * 24 * 3_600_000;

/**
 * The upper bound of the wait after failed attempt number `attempt` (1-based):
 * min(cap, base * 2^(attempt-1)). Non-decreasing in `attempt`, never above the cap.
 */
export function backoffCeilingMs(attempt: number, { baseMs, capMs }: BackoffOptions): number {
  const exponent = Math.min(MAX_EXPONENT, Math.max(0, Math.floor(attempt) - 1));
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** Full jitter: a uniform wait in [0, ceiling]. `random` is in [0, 1); out-of-range values are clamped. */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number,
): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.floor(r * backoffCeilingMs(attempt, options));
}

/**
 * Parses a Retry-After header (delay-seconds or HTTP-date) into a wait in ms,
 * or null when absent or unintelligible. Past dates give 0.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d{1,12}$/.test(v)) return Math.min(MAX_RETRY_AFTER_MS, Number(v) * 1000);
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - nowMs));
}
