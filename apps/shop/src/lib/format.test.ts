import { describe, expect, it } from 'vitest';
import { formatDateTime, formatEtb, formatSantim, parseEtbToSantim } from './format';

describe('money formatting', () => {
  it('formats santim with thousands separators and two decimals', () => {
    expect(formatSantim('0')).toBe('0.00');
    expect(formatSantim('5')).toBe('0.05');
    expect(formatSantim('123456')).toBe('1,234.56');
    expect(formatSantim('-250')).toBe('-2.50');
    expect(formatSantim('123456789012345678901234567890')).toBe(
      '1,234,567,890,123,456,789,012,345,678.90',
    );
  });

  it('shows a dash for anything that is not a santim string', () => {
    expect(formatSantim(null)).toBe('–');
    expect(formatSantim(undefined)).toBe('–');
    expect(formatSantim('12.5')).toBe('–');
    expect(formatEtb('abc')).toBe('–');
    expect(formatEtb('150000')).toBe('ETB 1,500.00');
  });
});

describe('parseEtbToSantim', () => {
  it('turns typed ETB into santim without floating point', () => {
    expect(parseEtbToSantim('1,250')).toBe('125000');
    expect(parseEtbToSantim('12.5')).toBe('1250');
    expect(parseEtbToSantim(' 0.07 ')).toBe('7');
    expect(parseEtbToSantim('0')).toBe('0');
    expect(parseEtbToSantim('0.10')).toBe('10');
    expect(parseEtbToSantim('999999999999999.99')).toBe('99999999999999999');
  });

  it('rejects text, signs, more than two decimals and nothing', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1.', '.5', '1e3', '1 000', '9999999999999999']) {
      expect(parseEtbToSantim(bad), bad).toBeNull();
    }
  });
});

describe('formatDateTime', () => {
  it('handles missing and invalid values', () => {
    expect(formatDateTime(null)).toBe('–');
    expect(formatDateTime('not a date')).toBe('–');
    expect(formatDateTime('2026-10-18T09:05:00Z')).toMatch(/^2026-10-1[78] \d{2}:\d{2}$/);
  });
});
