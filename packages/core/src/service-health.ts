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
