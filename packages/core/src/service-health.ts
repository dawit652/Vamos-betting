/**
 * Whether a service Nahubet depends on is up (docs/plans/counter-codes-and-deposit-recovery.md, G7;
 * owner, 21 Nov 2026). Each service reports its calls: the last success and, while it fails, since
 * when. Pure: no I/O.
 *
 * - **down** once it has failed without a success for SERVICE_DOWN_AFTER_MS (one failed call is not
 *   an outage), or when a service that reports on a schedule has not succeeded for `staleAfterMs`;
 * - **up** after a success;
 * - **unknown** while it has never reported.
 */

/** Failing this long without a success is an outage. */
export const SERVICE_DOWN_AFTER_MS = 3 * 60_000;

export interface ServiceReport {
  lastOkAt: Date | null;
  /** The first failure since the last success; null while it works. */
  failingSince: Date | null;
}

export type ServiceHealth =
  { status: 'up' } | { status: 'unknown' } | { status: 'down'; since: Date };

export function serviceHealth(
  report: ServiceReport,
  now: Date,
  options: { staleAfterMs?: number } = {},
): ServiceHealth {
  const { lastOkAt, failingSince } = report;
  if (failingSince !== null && now.getTime() - failingSince.getTime() >= SERVICE_DOWN_AFTER_MS) {
    return { status: 'down', since: failingSince };
  }
  if (
    options.staleAfterMs !== undefined &&
    lastOkAt !== null &&
    now.getTime() - lastOkAt.getTime() > options.staleAfterMs
  ) {
    return { status: 'down', since: new Date(lastOkAt.getTime() + options.staleAfterMs) };
  }
  if (lastOkAt === null && failingSince === null) return { status: 'unknown' };
  return { status: 'up' };
}

/** Whole minutes from `since` to `now`, at least 1. */
export function minutesSince(since: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - since.getTime()) / 60_000));
}

/** How each service is named in the owner's alerts (a feed source is named after the source). */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'payments:chapa': 'Chapa payments',
  'payments:telebirr': 'telebirr payments',
  mrx: 'mr-x (Hulusport board)',
  mrz: 'mr-z (Narobet board)',
  'api-football': 'API-Football results',
};

/**
 * Services read on a schedule: not succeeding for this long is an outage too (the reader stopped,
 * e.g. the scraper is down). mr-x and mr-z are read every few minutes.
 */
export const SERVICE_STALE_AFTER_MS: Readonly<Record<string, number>> = {
  mrx: 30 * 60_000,
  mrz: 30 * 60_000,
};

/** A service's name for people: its known name, or its id (a feed source is `source:<id>`). */
export function serviceName(service: string): string {
  return SERVICE_NAMES[service] ?? service;
}
