import { describe, expect, it } from 'vitest';
import {
  describeMismatch,
  diffSantim,
  isBusinessDate,
  reconciliationRequestMessage,
  reviewDecisions,
  validateStatementUpload,
} from './compliance';

describe('dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isBusinessDate('2026-02-28')).toBe(true);
    expect(isBusinessDate('2026-02-30')).toBe(false);
    expect(isBusinessDate('26-02-01')).toBe(false);
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

describe('Run now (requested reconciliation)', () => {
  it('describes each request state and the finished run', () => {
    expect(reconciliationRequestMessage({ status: 'queued', error: null }).kind).toBe('pending');
    expect(reconciliationRequestMessage({ status: 'running', error: null }).kind).toBe('pending');
    expect(reconciliationRequestMessage({ status: 'done', error: null }).kind).toBe('pending');
    expect(
      reconciliationRequestMessage(
        { status: 'done', error: null },
        { status: 'clean', mismatchCount: 0 },
      ),
    ).toEqual({ kind: 'ok', text: 'Run clean: 0 mismatches.' });
    expect(
      reconciliationRequestMessage(
        { status: 'done', error: null },
        { status: 'mismatches', mismatchCount: 3 },
      ),
    ).toEqual({ kind: 'error', text: 'Run mismatches: 3 mismatches.' });
    expect(reconciliationRequestMessage({ status: 'failed', error: 'abandoned' })).toEqual({
      kind: 'error',
      text: 'Run failed: abandoned',
    });
  });
});
