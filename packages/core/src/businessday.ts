/**
 * Business days for regulator reporting. A business day is a calendar day in
 * Ethiopia (time zone Africa/Addis_Ababa, UTC+3 all year: Ethiopia has no
 * daylight saving time), written `YYYY-MM-DD` on the Gregorian calendar.
 * Day `D` covers the instants [D 00:00 +03:00, D+1 00:00 +03:00), i.e.
 * [D-1 21:00Z, D 21:00Z).
 */

export const BUSINESS_TIME_ZONE = 'Africa/Addis_Ababa';
/** UTC offset of the business time zone (fixed: no DST). */
export const BUSINESS_UTC_OFFSET_MS = 3 * 3_600_000;
export const BUSINESS_DAY_MS = 24 * 3_600_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a valid `YYYY-MM-DD`, or null. */
function epochDay(text: string): number | null {
  const match = DATE_RE.exec(text);
  if (match === null) return null;
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms);
  // Reject 2026-02-30 and friends (Date.UTC rolls them over).
  if (
    back.getUTCFullYear() !== Number(y) ||
    back.getUTCMonth() !== Number(m) - 1 ||
    back.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return ms / BUSINESS_DAY_MS;
}

function dateOfEpochDay(day: number): string {
  return new Date(day * BUSINESS_DAY_MS).toISOString().slice(0, 10);
}

function assertInstant(instant: Date): number {
  const ms = instant instanceof Date ? instant.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new RangeError('expected a valid Date');
  return ms;
}

/** True for a real calendar date written `YYYY-MM-DD` (years 1970 to 9999). */
export function isBusinessDate(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const day = epochDay(text);
  return day !== null && day >= 0;
}

function assertBusinessDate(text: string): number {
  const day = epochDay(text);
  if (day === null || day < 0) throw new RangeError(`not a business date (YYYY-MM-DD): ${text}`);
  return day;
}

/** The business day (Addis Ababa calendar date) an instant falls on. */
export function businessDateOf(instant: Date): string {
  const ms = assertInstant(instant);
  return dateOfEpochDay(Math.floor((ms + BUSINESS_UTC_OFFSET_MS) / BUSINESS_DAY_MS));
}

/** The instants of a business day: [start, end), 24 hours. */
export function businessDayWindow(date: string): { start: Date; end: Date } {
  const day = assertBusinessDate(date);
  const start = day * BUSINESS_DAY_MS - BUSINESS_UTC_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + BUSINESS_DAY_MS) };
}

/** `date` moved by a whole number of days (negative goes back). */
export function addBusinessDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be an integer');
  return dateOfEpochDay(assertBusinessDate(date) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function businessDaysBetween(from: string, to: string): number {
  return assertBusinessDate(to) - assertBusinessDate(from);
}

/**
 * Every business date from `from` to `to`, both included, oldest first
 * ([] when `to` is before `from`). Throws past `maxDays` dates.
 */
export function businessDatesBetween(from: string, to: string, maxDays = 3660): string[] {
  const first = assertBusinessDate(from);
  const last = assertBusinessDate(to);
  if (last < first) return [];
  if (last - first + 1 > maxDays) {
    throw new RangeError(`at most ${maxDays} business days can be listed`);
  }
  const dates: string[] = [];
  for (let day = first; day <= last; day += 1) dates.push(dateOfEpochDay(day));
  return dates;
}
