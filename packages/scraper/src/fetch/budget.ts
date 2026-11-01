import { DAY_MS } from '../constants';

/**
 * The budget governor (rule A3 of docs/therundown-plan/README.md), pure: what
 * the usage headers of a response say, how much of the monthly quota may be
 * spent today, and how that changes how often events are polled. No I/O and no
 * clock (`now` is always an argument): the poller in apps/scraper keeps the
 * running totals and calls these.
 *
 * Data points are whole counts, never money. A header that is missing or makes
 * no sense is "unknown", never a guess.
 */

/** What the usage headers of one response say about the quota (null for what they did not say). */
export interface BudgetSnapshot {
  /** Data points used this period (`X-Datapoints-Used`). */
  used: number | null;
  /** Data points left this period (`X-Datapoints-Remaining`); below 0 when the quota is overspent. */
  remaining: number | null;
  /** When the period resets (`X-Datapoints-Reset`). */
  resetAt: Date | null;
  /** When the response was read. */
  observedAt: Date;
}

/** The headers a TheRundown response carries about its cost, the quota, the rate and the delay. */
export interface ResponseMeters {
  /** What this response cost, in data points (`X-Datapoints`). */
  cost: number | null;
  /** The quota as of this response; null when it says neither `used` nor `remaining`. */
  snapshot: BudgetSnapshot | null;
  /** Requests a second the plan allows (`X-Rate-Limit`). */
  rateLimit: number | null;
  /** `X-Data-Delay-Seconds` as it came, for `effectiveDelaySeconds`; null when absent. */
  delayHeader: string | null;
}

/** A number written in plain decimal: digits with an optional sign and fraction. No exponent, hex or separators. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
/** A date, or a date and time that says its zone (Z or an offset): a time without a zone is not read as anyone's. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null || !Object.hasOwn(headers, name)) {
    return undefined;
  }
  const value: unknown = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed === 0 ? 0 : parsed;
}

/** A count or a rate cannot be below 0: such a value is not read. */
function atLeastZero(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

function parseIsoDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!ISO_8601.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Reads the meters of a response from its headers (lower-case names, as the
 * fetcher gives them): `x-datapoints` (this response's cost),
 * `x-datapoints-used`, `x-datapoints-remaining`, `x-datapoints-reset` (ISO
 * 8601 with a zone), `x-rate-limit` and `x-data-delay-seconds` (returned as it
 * came). A value that is not a plain number gives null, and so does a negative
 * cost, use or rate; a negative `remaining` is kept, because it says the quota
 * is overspent. The snapshot is null unless `used` or `remaining` was read.
 */
export function readResponseMeters(
  headers: Readonly<Record<string, string>>,
  now: Date,
): ResponseMeters {
  const used = atLeastZero(parseNumber(headerValue(headers, 'x-datapoints-used')));
  const remaining = parseNumber(headerValue(headers, 'x-datapoints-remaining'));
  const resetAt = parseIsoDate(headerValue(headers, 'x-datapoints-reset'));
  return {
    cost: atLeastZero(parseNumber(headerValue(headers, 'x-datapoints'))),
    snapshot:
      used === null && remaining === null
        ? null
        : { used, remaining, resetAt, observedAt: new Date(now.getTime()) },
    rateLimit: atLeastZero(parseNumber(headerValue(headers, 'x-rate-limit'))),
    delayHeader: headerValue(headers, 'x-data-delay-seconds') ?? null,
  };
}

/**
 * unknown: no usable reading of the quota; green: on pace; amber: today has
 * spent its allowance; red: the reserve is all that is left.
 */
export type BudgetLevel = 'unknown' | 'green' | 'amber' | 'red';

/** The share of the monthly quota kept back for scores when prices run out. */
export const BUDGET_RESERVE_FRACTION = 0.05;
/** The days to spread what is left over when the reset time is unknown or already past. */
const FALLBACK_DAYS_TO_RESET = 30;

/**
 * How the budget stands: the reserve is `floor(quota × reserveFraction)`.
 *
 * - No snapshot, or one without `remaining`: `unknown` (no allowance).
 * - `remaining` at or under the reserve: `red`, with an allowance of 0.
 * - Else the daily allowance is `(remaining − reserve)` over the days to the
 *   reset (rounded up, at least 1); 30 when the reset is unknown or not in the
 *   future. `spentToday` at or over the allowance is `amber`, under it `green`.
 *
 * @throws RangeError for a `quota` or `spentToday` that is not a finite number
 * of at least 0, a `reserveFraction` outside 0..1, or an invalid `now`: those
 * are the caller's own numbers, not data.
 */
export function budgetLevel(input: {
  snapshot: BudgetSnapshot | null;
  quota: number;
  spentToday: number;
  now: Date;
  reserveFraction?: number;
}): { level: BudgetLevel; dailyAllowance: number | null; reserve: number } {
  const { snapshot, quota, spentToday, now, reserveFraction = BUDGET_RESERVE_FRACTION } = input;
  if (!Number.isFinite(quota) || quota < 0) {
    throw new RangeError(`quota must be a finite number of at least 0, got ${quota}`);
  }
  if (!Number.isFinite(spentToday) || spentToday < 0) {
    throw new RangeError(`spentToday must be a finite number of at least 0, got ${spentToday}`);
  }
  if (!Number.isFinite(reserveFraction) || reserveFraction < 0 || reserveFraction > 1) {
    throw new RangeError(`reserveFraction must be between 0 and 1, got ${reserveFraction}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('now must be a valid Date');
  }

  const reserve = Math.floor(quota * reserveFraction);
  if (snapshot === null || snapshot.remaining === null || !Number.isFinite(snapshot.remaining)) {
    return { level: 'unknown', dailyAllowance: null, reserve };
  }
  const { remaining } = snapshot;
  if (remaining <= reserve) return { level: 'red', dailyAllowance: 0, reserve };

  const resetMs = snapshot.resetAt instanceof Date ? snapshot.resetAt.getTime() : Number.NaN;
  const untilReset = resetMs - now.getTime();
  // Written so that an unreadable reset (NaN) falls back too: NaN is never > 0.
  const days =
    untilReset > 0 ? Math.max(1, Math.ceil(untilReset / DAY_MS)) : FALLBACK_DAYS_TO_RESET;
  const dailyAllowance = (remaining - reserve) / days;
  return { level: spentToday >= dailyAllowance ? 'amber' : 'green', dailyAllowance, reserve };
}

/** On amber, this many of the slowest tiers poll half as often. */
const AMBER_SLOWED_TIERS = 2;

/**
 * How often to poll the events of one tier at a budget level, in ms, or null
 * for "do not poll prices". `tierIndex` counts from the fastest tier (0) to
 * the slowest (`tierCount - 1`), the order of REFERENCE_TIERS.
 *
 * - green and unknown: the base interval.
 * - amber: the two slowest tiers (`tierIndex >= tierCount - 2`) poll half as
 *   often (twice the interval); the others as at green.
 * - red: null. Price polling stops; scores go on elsewhere.
 *
 * @throws RangeError for a tier outside the count, a count under 1, a base
 * interval that is not a finite number above 0, or an unknown level.
 */
export function pollIntervalFor(
  tierIndex: number,
  tierCount: number,
  basePollMs: number,
  level: BudgetLevel,
): number | null {
  if (!Number.isSafeInteger(tierCount) || tierCount < 1) {
    throw new RangeError(`tierCount must be an integer of at least 1, got ${tierCount}`);
  }
  if (!Number.isSafeInteger(tierIndex) || tierIndex < 0 || tierIndex >= tierCount) {
    throw new RangeError(`tierIndex must be an integer 0..${tierCount - 1}, got ${tierIndex}`);
  }
  if (!Number.isFinite(basePollMs) || basePollMs <= 0) {
    throw new RangeError(`basePollMs must be a finite number above 0, got ${basePollMs}`);
  }
  switch (level) {
    case 'green':
    case 'unknown':
      return basePollMs;
    case 'amber':
      return tierIndex >= tierCount - AMBER_SLOWED_TIERS ? basePollMs * 2 : basePollMs;
    case 'red':
      return null;
    default: {
      const unknown: never = level;
      throw new RangeError(`unknown budget level: "${String(unknown)}"`);
    }
  }
}

/**
 * A 429 that says to retry later than this is not a burst limit but the
 * quota: wait for the reset, never retry sooner.
 */
export const QUOTA_RETRY_THRESHOLD_MS = 60_000;

/**
 * Whether a blocked request (`FetchBlocked` of the fetcher) is the data point
 * quota rather than a burst limit (A2): a `rate_limited` block whose retry
 * time is unknown, unreadable or more than QUOTA_RETRY_THRESHOLD_MS away.
 * Every other reason is not. When in doubt it says the quota is gone.
 */
export function isQuotaExhausted(
  blocked: { reason: string; retryAt: Date | null },
  now: Date,
): boolean {
  if (blocked.reason !== 'rate_limited') return false;
  if (!(blocked.retryAt instanceof Date)) return true;
  const waitMs = blocked.retryAt.getTime() - now.getTime();
  // Written so that an unreadable time (NaN) counts as the long wait: NaN is never <=.
  return !(waitMs <= QUOTA_RETRY_THRESHOLD_MS);
}

/**
 * What a response should cost in data points: each event costs 2 (the event
 * and its score) and each price of each book 1.
 *
 * @throws RangeError for a count that is not a finite number of at least 0.
 */
export function expectedCost(events: number, books: number, pricesPerBook: number): number {
  for (const [name, count] of [
    ['events', events],
    ['books', books],
    ['pricesPerBook', pricesPerBook],
  ] as const) {
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError(`${name} must be a finite number of at least 0, got ${count}`);
    }
  }
  return 2 * events + events * books * pricesPerBook;
}

/**
 * Whether a response cost far more than expected, so that a filter was
 * ignored or a default changed: more than twice as much, and more than 50
 * points more (so a small response does not alert). A number that is not a
 * finite one of at least 0 cannot be vouched for and counts as a spike.
 */
export function isCostSpike(expected: number, actual: number): boolean {
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected < 0 || actual < 0) {
    return true;
  }
  return actual > 2 * expected && actual - expected > 50;
}
