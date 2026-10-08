/**
 * Age checks for KYC and responsible gambling.
 *
 * Dates of birth are Gregorian ISO calendar dates (`YYYY-MM-DD`), as supplied
 * by the Fayda national ID. Ages are computed against the UTC calendar date of
 * the reference instant, so results do not depend on the server's time zone.
 */

export interface CalendarDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31, valid for the month and year. */
  day: number;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a strict `YYYY-MM-DD` Gregorian date. Returns `null` unless the
 * string has exactly that shape and names a real calendar day (leap years
 * included), so `2023-02-29`, `2024-13-01` and `2024-1-01` are all rejected.
 */
export function parseIsoDate(value: string): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, y = '', m = '', d = ''] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/**
 * Completed years of age on the UTC calendar date of `on`. A birthday that
 * falls on that date counts. Someone born on 29 February becomes a year older
 * on 1 March in non-leap years.
 *
 * Throws `RangeError` when `dateOfBirth` is not a valid ISO date, when `on`
 * is an invalid `Date`, or when the date of birth is after `on`.
 */
export function ageOn(dateOfBirth: string, on: Date): number {
  const dob = parseIsoDate(dateOfBirth);
  if (dob === null) throw new RangeError('invalid date of birth');
  const today = utcCalendarDate(on);
  if (today === null) throw new RangeError('invalid reference date');
  if (compareCalendarDates(dob, today) > 0) {
    throw new RangeError('date of birth is after the reference date');
  }
  // Comparing (month, day) pairs handles 29 February without special cases:
  // in a non-leap year 28 Feb < 29 Feb (not yet) and 1 Mar > 29 Feb (done).
  const birthdayReached =
    today.month > dob.month || (today.month === dob.month && today.day >= dob.day);
  return today.year - dob.year - (birthdayReached ? 0 : 1);
}

/**
 * True when the person born on `dateOfBirth` is at least `minAge` years old
 * on the UTC calendar date of `now`. Fails closed: returns `false` (rather
 * than throwing) for an invalid or future date of birth, or an invalid `now`.
 *
 * Throws `RangeError` when `minAge` is not a non-negative integer, since that
 * is a configuration error rather than bad user input.
 */
export function isOfAge(dateOfBirth: string, minAge: number, now: Date): boolean {
  if (!Number.isSafeInteger(minAge) || minAge < 0) {
    throw new RangeError(`minAge must be a non-negative integer, got ${minAge}`);
  }
  const dob = parseIsoDate(dateOfBirth);
  const today = utcCalendarDate(now);
  if (dob === null || today === null || compareCalendarDates(dob, today) > 0) return false;
  return ageOn(dateOfBirth, now) >= minAge;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function utcCalendarDate(instant: Date): CalendarDate | null {
  if (Number.isNaN(instant.getTime())) return null;
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}
