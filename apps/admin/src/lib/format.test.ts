import { describe, expect, it } from 'vitest';
import {
  dayToIso,
  formatEtb,
  formatOdds,
  formatSantim,
  humanize,
  parseEtbToSantim,
  parseOddsToMilli,
} from './format';

describe('santim formatting', () => {
  it('formats with thousands separators and two decimals', () => {
    expect(formatSantim('0')).toBe('0.00');
    expect(formatSantim('5')).toBe('0.05');
    expect(formatSantim('123456')).toBe('1,234.56');
    expect(formatSantim('100000000000000000')).toBe('1,000,000,000,000,000.00');
    expect(formatSantim('-250')).toBe('-2.50');
    expect(formatEtb('150')).toBe('ETB 1.50');
  });

  it('shows a dash for missing or malformed values', () => {
    expect(formatSantim(null)).toBe('–');
    expect(formatSantim('1.5')).toBe('–');
    expect(formatEtb(undefined)).toBe('–');
  });

  it('parses ETB text exactly, without floating point', () => {
    expect(parseEtbToSantim('1,250')).toBe('125000');
    expect(parseEtbToSantim('12.5')).toBe('1250');
    expect(parseEtbToSantim('0.07')).toBe('7');
    expect(parseEtbToSantim('0')).toBe('0');
    expect(parseEtbToSantim('900719925474099.01')).toBe('90071992547409901');
    expect(parseEtbToSantim('1.234')).toBeNull();
    expect(parseEtbToSantim('-1')).toBeNull();
    expect(parseEtbToSantim('abc')).toBeNull();
    expect(parseEtbToSantim('')).toBeNull();
  });

  it('round-trips format and parse', () => {
    for (const santim of ['1', '99', '100', '123456', '5000000']) {
      expect(parseEtbToSantim(formatSantim(santim))).toBe(santim);
    }
  });
});

describe('odds', () => {
  it('formats milli odds', () => {
    expect(formatOdds(1850)).toBe('1.85');
    expect(formatOdds('12500')).toBe('12.50');
    expect(formatOdds(1001)).toBe('1.00');
    expect(formatOdds(null)).toBe('–');
  });

  it('parses prices within the valid range', () => {
    expect(parseOddsToMilli('1.85')).toBe(1850);
    expect(parseOddsToMilli('2')).toBe(2000);
    expect(parseOddsToMilli('1.001')).toBe(1001);
    expect(parseOddsToMilli('1000')).toBe(1_000_000);
    expect(parseOddsToMilli('1.0')).toBeNull();
    expect(parseOddsToMilli('1001')).toBeNull();
    expect(parseOddsToMilli('x')).toBeNull();
  });
});

describe('dates and labels', () => {
  it('builds ISO bounds from a local day, the end being the next midnight', () => {
    const start = dayToIso('2026-10-18');
    const end = dayToIso('2026-10-18', true);
    expect(start).not.toBeNull();
    expect(new Date(end ?? '').getTime() - new Date(start ?? '').getTime()).toBeGreaterThanOrEqual(
      23 * 3600_000,
    );
    expect(dayToIso('18/10/2026')).toBeNull();
  });

  it('humanizes codes', () => {
    expect(humanize('pending_acceptance')).toBe('pending acceptance');
    expect(humanize(null)).toBe('–');
  });
});
