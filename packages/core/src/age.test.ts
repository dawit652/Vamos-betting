import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ageOn, isOfAge, parseIsoDate } from './age';

const DAY_MS = 86_400_000;

/** A UTC instant at the given time of day on a calendar date. */
function utc(date: string, time = '12:00:00'): Date {
  return new Date(`${date}T${time}Z`);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The ISO date (UTC) of an instant, for years 0–9999. */
function isoOf(instant: Date): string {
  return isoDate(instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate());
}

/** Reference validity check using the platform's proleptic Gregorian calendar. */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

// 1900-01-01 .. 2100-12-31, as UTC milliseconds.
const MIN_MS = Date.UTC(1900, 0, 1);
const MAX_MS = Date.UTC(2100, 11, 31, 23, 59, 59, 999);
const instantArb = fc.integer({ min: MIN_MS, max: MAX_MS }).map((ms) => new Date(ms));
const dobArb = instantArb.map(isoOf);

describe('parseIsoDate', () => {
  it('parses valid dates', () => {
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseIsoDate('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseIsoDate('1990-12-31')).toEqual({ year: 1990, month: 12, day: 31 });
    expect(parseIsoDate('2006-01-01')).toEqual({ year: 2006, month: 1, day: 1 });
    expect(parseIsoDate('2023-04-30')).toEqual({ year: 2023, month: 4, day: 30 });
    expect(parseIsoDate('0001-01-01')).toEqual({ year: 1, month: 1, day: 1 });
    expect(parseIsoDate('9999-12-31')).toEqual({ year: 9999, month: 12, day: 31 });
  });

  it.each([
    // impossible days
    '2023-02-29',
    '1900-02-29',
    '2100-02-29',
    '2024-02-30',
    '2024-04-31',
    '2024-06-31',
    '2024-09-31',
    '2024-11-31',
    '2024-01-32',
    '2024-01-00',
    // impossible months
    '2024-13-01',
    '2024-00-10',
    // wrong shape
    '2024-1-01',
    '2024-01-1',
    '24-01-01',
    '20240101',
    '2024/01/01',
    '01-01-2024',
    ' 2024-01-01',
    '2024-01-01 ',
    '2024-01-01T00:00:00Z',
    '2024-01-01\n',
    '+002024-01-01',
    '-2024-01-01',
    '2024-W01-1',
    '٢٠٢٤-٠١-٠١',
    '',
  ])('rejects %j', (value) => {
    expect(parseIsoDate(value)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseIsoDate(undefined as unknown as string)).toBeNull();
    expect(parseIsoDate(20240101 as unknown as string)).toBeNull();
  });

  it('accepts exactly the real calendar dates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 0, max: 13 }),
        fc.integer({ min: 0, max: 32 }),
        (year, month, day) => {
          const parsed = parseIsoDate(isoDate(year, month, day));
          if (isRealDate(year, month, day)) {
            return (
              parsed !== null &&
              parsed.year === year &&
              parsed.month === month &&
              parsed.day === day
            );
          }
          return parsed === null;
        },
      ),
    );
  });

  it('round-trips the ISO date of any instant', () => {
    fc.assert(
      fc.property(instantArb, (instant) => {
        const iso = isoOf(instant);
        const parsed = parseIsoDate(iso);
        return parsed !== null && isoDate(parsed.year, parsed.month, parsed.day) === iso;
      }),
    );
  });
});

describe('ageOn', () => {
  it('counts a birthday that falls on the reference date', () => {
    expect(ageOn('2006-10-07', utc('2024-10-07'))).toBe(18);
    expect(ageOn('2006-10-07', utc('2024-10-07', '00:00:00'))).toBe(18);
  });

  it('does not count a birthday that is still tomorrow', () => {
    expect(ageOn('2006-10-07', utc('2024-10-06'))).toBe(17);
    expect(ageOn('2006-10-07', utc('2024-10-06', '23:59:59.999'))).toBe(17);
  });

  it('counts completed years across month boundaries', () => {
    expect(ageOn('1990-12-31', utc('2024-01-01'))).toBe(33);
    expect(ageOn('1990-12-31', utc('2024-12-30'))).toBe(33);
    expect(ageOn('1990-12-31', utc('2024-12-31'))).toBe(34);
    expect(ageOn('1990-01-01', utc('2024-12-31'))).toBe(34);
  });

  it('is zero on the day of birth and the days after', () => {
    expect(ageOn('2024-05-10', utc('2024-05-10', '00:00:00'))).toBe(0);
    expect(ageOn('2024-05-10', utc('2025-05-09'))).toBe(0);
    expect(ageOn('2024-05-10', utc('2025-05-10'))).toBe(1);
  });

  it('ages someone born on 29 February on 1 March in non-leap years', () => {
    expect(ageOn('2004-02-29', utc('2005-02-28'))).toBe(0);
    expect(ageOn('2004-02-29', utc('2005-03-01'))).toBe(1);
    expect(ageOn('2004-02-29', utc('2008-02-28'))).toBe(3);
    expect(ageOn('2004-02-29', utc('2008-02-29'))).toBe(4);
    expect(ageOn('2004-02-29', utc('2022-02-28'))).toBe(17);
    expect(ageOn('2004-02-29', utc('2022-03-01'))).toBe(18);
    expect(ageOn('2004-02-29', utc('2024-02-28'))).toBe(19);
    expect(ageOn('2004-02-29', utc('2024-02-29'))).toBe(20);
    // 2100 is not a leap year.
    expect(ageOn('2096-02-29', utc('2100-02-28'))).toBe(3);
    expect(ageOn('2096-02-29', utc('2100-03-01'))).toBe(4);
  });

  it('uses the UTC calendar date of the reference instant', () => {
    // 2024-06-16 00:30 in Addis Ababa (UTC+3) is still 2024-06-15 in UTC.
    expect(ageOn('2006-06-16', new Date('2024-06-16T00:30:00+03:00'))).toBe(17);
    // 2024-06-15 23:30 at UTC−5 is already 2024-06-16 in UTC.
    expect(ageOn('2006-06-16', new Date('2024-06-15T23:30:00-05:00'))).toBe(18);
  });

  it('throws RangeError for an invalid date of birth', () => {
    expect(() => ageOn('2023-02-29', utc('2024-01-01'))).toThrow(RangeError);
    expect(() => ageOn('1990-1-01', utc('2024-01-01'))).toThrow(RangeError);
    expect(() => ageOn('', utc('2024-01-01'))).toThrow(RangeError);
  });

  it('throws RangeError for a date of birth after the reference date', () => {
    expect(() => ageOn('2024-01-02', utc('2024-01-01'))).toThrow(RangeError);
    expect(() => ageOn('2024-01-02', utc('2024-01-01', '23:59:59.999'))).toThrow(RangeError);
    expect(() => ageOn('2025-01-01', utc('2024-12-31'))).toThrow(RangeError);
  });

  it('throws RangeError for an invalid reference date', () => {
    expect(() => ageOn('2000-01-01', new Date(Number.NaN))).toThrow(RangeError);
  });

  it('is non-decreasing in the reference date', () => {
    fc.assert(
      fc.property(dobArb, instantArb, instantArb, (dob, a, b) => {
        const [earlier, later] = a <= b ? [a, b] : [b, a];
        if (isoOf(earlier) < dob) return true;
        return ageOn(dob, earlier) <= ageOn(dob, later);
      }),
    );
  });

  it('is never negative and grows by at most one per day', () => {
    fc.assert(
      fc.property(dobArb, instantArb, (dob, on) => {
        fc.pre(isoOf(on) >= dob);
        const age = ageOn(dob, on);
        const nextDay = new Date(on.getTime() + DAY_MS);
        const nextAge = ageOn(dob, nextDay);
        return age >= 0 && (nextAge === age || nextAge === age + 1);
      }),
    );
  });

  it('is exactly n on the n-th birthday and n − 1 the day before', () => {
    fc.assert(
      fc.property(dobArb, fc.integer({ min: 1, max: 120 }), (dob, n) => {
        const birth = parseIsoDate(dob)!;
        const year = birth.year + n;
        // A 29 February birthday falls on 1 March when that year has no 29 February.
        const birthday = isRealDate(year, birth.month, birth.day)
          ? isoDate(year, birth.month, birth.day)
          : isoDate(year, 3, 1);
        const birthdayInstant = utc(birthday, '00:00:00');
        const dayBefore = new Date(birthdayInstant.getTime() - 1);
        return ageOn(dob, birthdayInstant) === n && ageOn(dob, dayBefore) === n - 1;
      }),
    );
  });
});

describe('isOfAge', () => {
  const now = utc('2024-10-07', '09:00:00');

  it('is true from the 18th birthday on', () => {
    expect(isOfAge('2006-10-07', 18, now)).toBe(true);
    expect(isOfAge('2006-10-06', 18, now)).toBe(true);
    expect(isOfAge('1950-01-01', 18, now)).toBe(true);
  });

  it('is false the day before the 18th birthday', () => {
    expect(isOfAge('2006-10-08', 18, now)).toBe(false);
    expect(isOfAge('2010-01-01', 18, now)).toBe(false);
  });

  it('handles 29 February birthdays', () => {
    expect(isOfAge('2006-02-29', 18, now)).toBe(false); // not a real date
    expect(isOfAge('2004-02-29', 18, utc('2022-02-28'))).toBe(false);
    expect(isOfAge('2004-02-29', 18, utc('2022-03-01'))).toBe(true);
    expect(isOfAge('2004-02-29', 20, utc('2024-02-28'))).toBe(false);
    expect(isOfAge('2004-02-29', 20, utc('2024-02-29'))).toBe(true);
  });

  it('returns false instead of throwing for invalid or future dates', () => {
    expect(isOfAge('not-a-date', 18, now)).toBe(false);
    expect(isOfAge('2006-13-01', 18, now)).toBe(false);
    expect(isOfAge('', 18, now)).toBe(false);
    expect(isOfAge('2024-10-08', 0, now)).toBe(false);
    expect(isOfAge('2030-01-01', 18, now)).toBe(false);
    expect(isOfAge('2000-01-01', 18, new Date(Number.NaN))).toBe(false);
  });

  it('treats a minimum age of zero as "born on or before today"', () => {
    expect(isOfAge('2024-10-07', 0, now)).toBe(true);
    expect(isOfAge('2024-10-08', 0, now)).toBe(false);
  });

  it('throws RangeError for an invalid minimum age', () => {
    expect(() => isOfAge('2000-01-01', -1, now)).toThrow(RangeError);
    expect(() => isOfAge('2000-01-01', 17.5, now)).toThrow(RangeError);
    expect(() => isOfAge('2000-01-01', Number.NaN, now)).toThrow(RangeError);
    expect(() => isOfAge('2000-01-01', Number.POSITIVE_INFINITY, now)).toThrow(RangeError);
  });

  it('agrees with ageOn for valid past dates of birth', () => {
    fc.assert(
      fc.property(dobArb, instantArb, fc.integer({ min: 0, max: 130 }), (dob, on, minAge) => {
        if (isoOf(on) < dob) return !isOfAge(dob, minAge, on);
        return isOfAge(dob, minAge, on) === ageOn(dob, on) >= minAge;
      }),
    );
  });

  it('never throws for arbitrary date-of-birth strings', () => {
    fc.assert(
      fc.property(fc.string(), instantArb, (dob, on) => {
        expect(typeof isOfAge(dob, 18, on)).toBe('boolean');
      }),
    );
  });
});
