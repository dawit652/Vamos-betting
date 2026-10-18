import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  BUSINESS_DAY_MS,
  businessDateOf,
  businessDatesBetween,
  businessDaysBetween,
  businessDayWindow,
  isBusinessDate,
} from './businessday';

describe('business days (Africa/Addis_Ababa, UTC+3)', () => {
  it('starts the day at 21:00 UTC of the previous calendar day', () => {
    expect(businessDateOf(new Date('2026-10-17T20:59:59.999Z'))).toBe('2026-10-17');
    expect(businessDateOf(new Date('2026-10-17T21:00:00.000Z'))).toBe('2026-10-18');
    expect(businessDateOf(new Date('2026-10-18T20:59:59.999Z'))).toBe('2026-10-18');
    expect(businessDayWindow('2026-10-18')).toEqual({
      start: new Date('2026-10-17T21:00:00.000Z'),
      end: new Date('2026-10-18T21:00:00.000Z'),
    });
  });

  it('crosses months, years and leap days', () => {
    expect(addBusinessDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addBusinessDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addBusinessDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(businessDaysBetween('2026-10-01', '2026-10-18')).toBe(17);
    expect(businessDatesBetween('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(businessDatesBetween('2026-10-02', '2026-10-01')).toEqual([]);
  });

  it('accepts only real dates written YYYY-MM-DD', () => {
    expect(isBusinessDate('2026-10-18')).toBe(true);
    expect(isBusinessDate('2028-02-29')).toBe(true);
    for (const text of ['2026-02-29', '2026-13-01', '2026-10-32', '26-10-18', '2026-1-18', '']) {
      expect(isBusinessDate(text), text).toBe(false);
    }
    expect(isBusinessDate(20261018)).toBe(false);
    expect(() => businessDayWindow('2026-02-30')).toThrow(RangeError);
    expect(() => businessDateOf(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => businessDatesBetween('2020-01-01', '2030-01-01', 10)).toThrow(RangeError);
  });

  it('puts every instant in the window of its own business date', () => {
    const instant = fc.date({
      min: new Date('1971-01-01T00:00:00Z'),
      max: new Date('2099-12-31T00:00:00Z'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(instant, (at) => {
        const date = businessDateOf(at);
        const { start, end } = businessDayWindow(date);
        expect(start.getTime() <= at.getTime() && at.getTime() < end.getTime()).toBe(true);
        expect(end.getTime() - start.getTime()).toBe(BUSINESS_DAY_MS);
        expect(businessDateOf(end)).toBe(addBusinessDays(date, 1));
        expect(isBusinessDate(date)).toBe(true);
      }),
    );
  });
});
