import { describe, expect, it } from 'vitest';
import {
  daysInRange,
  describeMismatch,
  diffSantim,
  formatBps,
  isBusinessDate,
  reviewDecisions,
  summaryCsvName,
  validateReportRange,
  validateStatementUpload,
} from './compliance';

describe('dates and ranges', () => {
  it('accepts only real calendar dates', () => {
    expect(isBusinessDate('2026-02-28')).toBe(true);
    expect(isBusinessDate('2026-02-30')).toBe(false);
    expect(isBusinessDate('26-02-01')).toBe(false);
  });
  it('counts days inclusively', () => {
    expect(daysInRange('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysInRange('2026-10-01', '2026-10-31')).toBe(31);
    expect(daysInRange('x', '2026-10-31')).toBeNull();
  });
  it('validates the CSV range', () => {
    expect(validateReportRange('2026-10-01', '2026-10-31')).toBeNull();
    expect(validateReportRange('2026-10-05', '2026-10-01')).toMatch(/before/);
    expect(validateReportRange('2025-01-01', '2026-10-01')).toMatch(/366/);
    expect(validateReportRange('', '2026-10-01')).toMatch(/YYYY-MM-DD/);
  });
  it('names the file', () => {
    expect(summaryCsvName('2026-10-01', '2026-10-31')).toBe(
      'daily-summaries-2026-10-01-to-2026-10-31.csv',
    );
  });
});

describe('santim differences', () => {
  it('uses exact integer arithmetic', () => {
    expect(diffSantim('100', '250')).toBe('150');
    expect(diffSantim('9007199254740993', '9007199254740992')).toBe('-1');
    expect(diffSantim(null, '1')).toBeNull();
    expect(diffSantim('1.5', '2')).toBeNull();
  });
  it('describes a mismatch', () => {
    const text = describeMismatch({
      id: '1',
      check: 'psp_records',
      subjectType: 'payout',
      subjectId: 'p1',
      expected: '1000',
      actual: '900',
      details: null,
    });
    expect(text).toContain('expected 1000, found 900 (difference -100)');
  });
});

describe('formatting and forms', () => {
  it('formats basis points', () => {
    expect(formatBps(1500)).toBe('15.00%');
    expect(formatBps(5)).toBe('0.05%');
    expect(formatBps(0)).toBe('0.00%');
  });
  it('validates a statement upload', () => {
    expect(validateStatementUpload({ csv: '', provider: '' })).not.toBeNull();
    expect(validateStatementUpload({ csv: 'a,b', provider: 'Telebirr!' })).not.toBeNull();
    expect(validateStatementUpload({ csv: 'a,b', provider: 'telebirr' })).toBeNull();
    expect(validateStatementUpload({ csv: 'a,b', provider: '' })).toBeNull();
  });
  it('limits review decisions to the state machine', () => {
    expect(reviewDecisions('open')).toEqual(['reviewed', 'dismissed', 'escalated']);
    expect(reviewDecisions('escalated')).toEqual(['reviewed', 'dismissed']);
    expect(reviewDecisions('reviewed')).toEqual([]);
  });
});
