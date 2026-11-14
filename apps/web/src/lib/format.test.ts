import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  formatOddsMilli,
  formatSantim,
  formatTime,
  formatTotalOdds,
  relativeDay,
} from './format';

describe('format', () => {
  it('formats santim wire strings without floats', () => {
    expect(formatSantim('12550')).toBe('125.50');
    expect(formatSantim('123456789')).toBe('1,234,567.89');
    expect(formatSantim('-5')).toBe('-0.05');
    expect(formatSantim('900719925474099312')).toBe('9,007,199,254,740,993.12');
    expect(formatMoney('100000')).toBe('ETB 1,000.00');
  });

  it('shows a dash for missing or malformed amounts', () => {
    expect(formatSantim(null)).toBe('–');
    expect(formatSantim(undefined)).toBe('–');
    expect(formatSantim('12.5')).toBe('–');
    expect(formatSantim('abc')).toBe('–');
  });

  it('formats milli odds', () => {
    expect(formatOddsMilli(1850)).toBe('1.85');
    expect(formatOddsMilli(1855)).toBe('1.855');
    expect(formatOddsMilli(12000)).toBe('12.00');
    expect(formatOddsMilli(Number.NaN)).toBe('–');
  });

  it('formats accumulator total odds beyond 2^53, truncated to hundredths', () => {
    expect(formatTotalOdds('1859')).toBe('1.85');
    expect(formatTotalOdds('123456789012345678901')).toBe('123,456,789,012,345,678.90');
    expect(formatTotalOdds('x')).toBe('–');
  });

  it('shows kick-off in East Africa Time', () => {
    expect(formatTime('2026-10-10T15:30:00Z', 'en')).toBe('18:30');
  });

  it('names today and tomorrow by the East Africa Time calendar', () => {
    // 22:30 EAT on 14 Nov (19:30 UTC).
    const now = new Date('2026-11-14T19:30:00Z');
    expect(relativeDay('2026-11-14T20:00:00Z', now)).toBe('today'); // 23:00 EAT, same day
    expect(relativeDay('2026-11-14T21:00:00Z', now)).toBe('tomorrow'); // 00:00 EAT on the 15th
    expect(relativeDay('2026-11-15T20:59:00Z', now)).toBe('tomorrow');
    expect(relativeDay('2026-11-15T21:00:00Z', now)).toBeNull(); // the 16th in EAT
    expect(relativeDay('2026-11-13T21:00:00Z', now)).toBe('today'); // 00:00 EAT on the 14th
    expect(relativeDay('2026-11-13T20:59:00Z', now)).toBeNull(); // yesterday
    expect(relativeDay('not a date', now)).toBeNull();
  });
});
