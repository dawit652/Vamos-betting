import { describe, expect, it } from 'vitest';
import {
  cashToSantim,
  passwordChangeProblem,
  playerServable,
  positiveCashToSantim,
  receiptClass,
  receiptPath,
  receiptTitle,
  reviewReasonLabel,
} from './forms';
import { TEXT } from './text';

describe('passwordChangeProblem', () => {
  it('needs 12 characters and two equal entries', () => {
    expect(passwordChangeProblem('short', 'short')).toBe(TEXT.passwordTooShort);
    expect(passwordChangeProblem('a'.repeat(11), 'a'.repeat(11))).toBe(TEXT.passwordTooShort);
    expect(passwordChangeProblem('a'.repeat(12), 'b'.repeat(12))).toBe(TEXT.passwordMismatch);
    expect(passwordChangeProblem('a'.repeat(12), 'a'.repeat(12))).toBeNull();
  });
});

describe('cashToSantim', () => {
  it('accepts zero and amounts with at most two decimals', () => {
    expect(cashToSantim('0')).toBe('0');
    expect(cashToSantim('1,500.5')).toBe('150050');
    expect(cashToSantim('')).toBeNull();
    expect(cashToSantim('1.999')).toBeNull();
  });
});

describe('receiptClass', () => {
  it('names the print page of each paper width', () => {
    expect(receiptClass(58)).toBe('receipt receipt-58');
    expect(receiptClass(80)).toBe('receipt receipt-80');
  });
});

describe('receipt and desk helpers', () => {
  it('titles receipts and builds their paths', () => {
    expect(receiptTitle('deposit')).toBe('CASH DEPOSIT');
    expect(receiptTitle('withdrawal')).toBe('CASH WITHDRAWAL');
    expect(receiptPath('abc')).toBe('/receipt/abc');
    expect(receiptPath('abc', 'print')).toBe('/receipt/abc?print=1');
    expect(receiptPath('abc', 'copy')).toBe('/receipt/abc?copy=1');
  });

  it('words the review reasons', () => {
    expect(reviewReasonLabel(null)).toBe('needs review');
    expect(reviewReasonLabel('aml_review')).toBe('anti-money-laundering review');
    expect(reviewReasonLabel('some_new_reason')).toBe('some new reason');
  });

  it('wants a positive amount', () => {
    expect(positiveCashToSantim('100')).toBe('10000');
    expect(positiveCashToSantim('0')).toBeNull();
    expect(positiveCashToSantim('0.00')).toBeNull();
    expect(positiveCashToSantim('x')).toBeNull();
  });

  it('serves only active players that are not self-excluded', () => {
    expect(playerServable({ status: 'active', exclusion: null })).toBe(true);
    expect(playerServable({ status: 'blocked', exclusion: null })).toBe(false);
    expect(playerServable({ status: 'active', exclusion: { kind: 'temporary' } })).toBe(false);
  });
});
