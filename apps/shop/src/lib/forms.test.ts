import { describe, expect, it } from 'vitest';
import { cashToSantim, passwordChangeProblem, receiptClass } from './forms';
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
