/**
 * Whole minutes between `iso` and `now` (floored, never negative); null when
 * `iso` is not a valid time. 0 means "just now".
 */
export function minutesAgo(iso: string, now: number): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 60_000));
}
