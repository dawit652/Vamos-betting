import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidTimeZone, localDateOf, zonedToUtc } from './time';

const ok = (date: string, time: string, timeZone: string): string => {
  const r = zonedToUtc({ date, time, timeZone });
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.instant.toISOString();
};
const fail = (date: string, time: string, timeZone: string): string => {
  const r = zonedToUtc({ date, time, timeZone });
  return r.ok ? `ok ${r.instant.toISOString()}` : r.reason;
};

describe('T1 zonedToUtc', () => {
  it('T1 fixed-offset zones', () => {
    expect(ok('2025-08-16', '15:00', 'Africa/Addis_Ababa')).toBe('2025-08-16T12:00:00.000Z');
    expect(ok('2025-08-16', '00:30', 'Africa/Addis_Ababa')).toBe('2025-08-15T21:30:00.000Z');
    expect(ok('2025-01-10', '19:45:30', 'Asia/Kolkata')).toBe('2025-01-10T14:15:30.000Z');
    expect(ok('2025-01-10', '12:00', 'UTC')).toBe('2025-01-10T12:00:00.000Z');
    expect(ok('2025-06-10', '12:00', 'America/Costa_Rica')).toBe('2025-06-10T18:00:00.000Z');
  });

  it('T1 Europe/London: BST and GMT', () => {
    expect(ok('2025-03-29', '12:00', 'Europe/London')).toBe('2025-03-29T12:00:00.000Z');
    expect(ok('2025-03-30', '00:59', 'Europe/London')).toBe('2025-03-30T00:59:00.000Z');
    expect(ok('2025-03-30', '02:00', 'Europe/London')).toBe('2025-03-30T01:00:00.000Z');
    expect(ok('2025-07-01', '15:00', 'Europe/London')).toBe('2025-07-01T14:00:00.000Z');
    expect(ok('2025-10-26', '02:00', 'Europe/London')).toBe('2025-10-26T02:00:00.000Z');
  });

  it('T1 Europe/London: the skipped hour is a gap', () => {
    expect(fail('2025-03-30', '01:00', 'Europe/London')).toBe('dst_gap');
    expect(fail('2025-03-30', '01:30', 'Europe/London')).toBe('dst_gap');
    expect(fail('2025-03-30', '01:59:59', 'Europe/London')).toBe('dst_gap');
  });

  it('T1 Europe/London: the repeated hour is ambiguous', () => {
    expect(fail('2025-10-26', '01:00', 'Europe/London')).toBe('dst_ambiguous');
    expect(fail('2025-10-26', '01:30', 'Europe/London')).toBe('dst_ambiguous');
    expect(fail('2025-10-26', '01:59:59', 'Europe/London')).toBe('dst_ambiguous');
    expect(ok('2025-10-26', '00:59', 'Europe/London')).toBe('2025-10-25T23:59:00.000Z');
  });

  it('T1 America/New_York', () => {
    expect(ok('2025-03-09', '01:59', 'America/New_York')).toBe('2025-03-09T06:59:00.000Z');
    expect(fail('2025-03-09', '02:30', 'America/New_York')).toBe('dst_gap');
    expect(ok('2025-03-09', '03:00', 'America/New_York')).toBe('2025-03-09T07:00:00.000Z');
    expect(fail('2025-11-02', '01:30', 'America/New_York')).toBe('dst_ambiguous');
    expect(ok('2025-11-02', '02:00', 'America/New_York')).toBe('2025-11-02T07:00:00.000Z');
    expect(ok('2025-07-04', '12:00', 'America/New_York')).toBe('2025-07-04T16:00:00.000Z');
  });

  it('T1 Pacific/Chatham (+12:45 / +13:45)', () => {
    expect(ok('2025-07-01', '12:00', 'Pacific/Chatham')).toBe('2025-06-30T23:15:00.000Z');
    expect(ok('2025-01-15', '12:00', 'Pacific/Chatham')).toBe('2025-01-14T22:15:00.000Z');
  });

  it('T1 Australia/Lord_Howe (30-minute DST)', () => {
    // DST starts 2025-10-05 02:00 (+10:30 -> +11:00): 02:00..02:29 does not exist.
    expect(fail('2025-10-05', '02:15', 'Australia/Lord_Howe')).toBe('dst_gap');
    expect(ok('2025-10-05', '02:30', 'Australia/Lord_Howe')).toBe('2025-10-04T15:30:00.000Z');
    expect(ok('2025-10-05', '01:59', 'Australia/Lord_Howe')).toBe('2025-10-04T15:29:00.000Z');
    // DST ends 2025-04-06 02:00 (+11:00 -> +10:30): 01:30..01:59 happens twice.
    expect(fail('2025-04-06', '01:45', 'Australia/Lord_Howe')).toBe('dst_ambiguous');
    expect(ok('2025-04-06', '01:29', 'Australia/Lord_Howe')).toBe('2025-04-05T14:29:00.000Z');
    expect(ok('2025-04-06', '02:00', 'Australia/Lord_Howe')).toBe('2025-04-05T15:30:00.000Z');
  });

  it('T1 historical dates', () => {
    // UK was on GMT+1 all year in 1970 (British Standard Time).
    expect(ok('1970-01-15', '12:00', 'Europe/London')).toBe('1970-01-15T11:00:00.000Z');
    expect(ok('1990-07-01', '12:00', 'Europe/London')).toBe('1990-07-01T11:00:00.000Z');
    expect(ok('2000-01-01', '00:00', 'Africa/Addis_Ababa')).toBe('1999-12-31T21:00:00.000Z');
  });

  it('T1 leap days', () => {
    expect(ok('2024-02-29', '20:00', 'Africa/Addis_Ababa')).toBe('2024-02-29T17:00:00.000Z');
    expect(ok('2000-02-29', '12:00', 'UTC')).toBe('2000-02-29T12:00:00.000Z');
    expect(fail('2025-02-29', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('1900-02-29', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2100-02-29', '12:00', 'UTC')).toBe('invalid_date');
  });

  it('T1 strict calendar and clock validation', () => {
    expect(fail('2025-02-30', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-13-01', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-00-10', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-04-31', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-8-1', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-08-01T00:00', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('', '12:00', 'UTC')).toBe('invalid_date');
    expect(fail('2025-08-01', '24:00', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '12:60', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '12:00:60', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '9:00', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '12', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '12:00 PM', 'UTC')).toBe('invalid_time');
    expect(fail('2025-08-01', '', 'UTC')).toBe('invalid_time');
  });

  it('T1 unknown zones', () => {
    expect(fail('2025-08-01', '12:00', 'Mars/Olympus')).toBe('unknown_zone');
    expect(fail('2025-08-01', '12:00', '')).toBe('unknown_zone');
    expect(fail('2025-08-01', '12:00', '+03:00')).toBe('unknown_zone');
  });

  it('T1 isValidTimeZone', () => {
    expect(isValidTimeZone('Africa/Addis_Ababa')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Nowhere/City')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('x'.repeat(100))).toBe(false);
  });

  it('T1 localDateOf', () => {
    const instant = new Date('2025-08-15T21:30:00Z');
    expect(localDateOf(instant, 'Africa/Addis_Ababa')).toBe('2025-08-16');
    expect(localDateOf(instant, 'UTC')).toBe('2025-08-15');
    expect(localDateOf(instant, 'America/Costa_Rica')).toBe('2025-08-15');
    expect(localDateOf(new Date('2025-03-30T00:30:00Z'), 'Europe/London')).toBe('2025-03-30');
    expect(() => localDateOf(new Date(Number.NaN), 'UTC')).toThrow(RangeError);
    expect(() => localDateOf(instant, 'Nowhere/City')).toThrow(RangeError);
  });

  const zones = [
    'Europe/London',
    'America/New_York',
    'Africa/Addis_Ababa',
    'Asia/Kolkata',
    'Pacific/Chatham',
    'Australia/Lord_Howe',
    'America/Costa_Rica',
  ];
  const local = fc.record({
    zone: fc.constantFrom(...zones),
    day: fc.integer({ min: 0, max: 365 * 6 }),
    minutes: fc.integer({ min: 0, max: 24 * 60 - 1 }),
  });
  const toLocal = (day: number, minutes: number): { date: string; time: string } => {
    const d = new Date(Date.UTC(2022, 0, 1) + day * 86_400_000);
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return { date: d.toISOString().slice(0, 10), time: `${hh}:${mm}` };
  };

  it('T1 property: the local date round-trips whenever a time resolves', () => {
    fc.assert(
      fc.property(local, ({ zone, day, minutes }) => {
        const { date, time } = toLocal(day, minutes);
        const r = zonedToUtc({ date, time, timeZone: zone });
        if (!r.ok) {
          expect(['dst_gap', 'dst_ambiguous']).toContain(r.reason);
          return;
        }
        expect(localDateOf(r.instant, zone)).toBe(date);
      }),
      { numRuns: 500 },
    );
  });

  it('T1 property: monotonic in the local time within one offset period', () => {
    fc.assert(
      fc.property(local, fc.integer({ min: 1, max: 600 }), ({ zone, day, minutes }, delta) => {
        const a = toLocal(day, minutes);
        const b = toLocal(day, Math.min(24 * 60 - 1, minutes + delta));
        const ra = zonedToUtc({ ...a, timeZone: zone });
        const rb = zonedToUtc({ ...b, timeZone: zone });
        if (!ra.ok || !rb.ok) return;
        const wallGap = (Math.min(24 * 60 - 1, minutes + delta) - minutes) * 60_000;
        const realGap = rb.instant.getTime() - ra.instant.getTime();
        // Later local time -> later instant, unless a transition lies between
        // (then the real gap differs by the offset change, at most 1 hour).
        expect(realGap).toBeGreaterThanOrEqual(0);
        expect(Math.abs(realGap - wallGap)).toBeLessThanOrEqual(3_600_000);
      }),
      { numRuns: 500 },
    );
  });

  it('T1 property: invalid calendar days are rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2200 }),
        fc.integer({ min: 1, max: 12 }),
        (year, month) => {
          const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
          const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(days + 1).padStart(2, '0')}`;
          expect(zonedToUtc({ date, time: '12:00', timeZone: 'UTC' })).toEqual({
            ok: false,
            reason: 'invalid_date',
          });
        },
      ),
    );
  });
});
