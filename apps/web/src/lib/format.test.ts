import { describe, expect, it } from 'vitest';
import { formatMoney, formatOddsMilli, formatSantim, formatTime, formatTotalOdds } from './format';

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
});
