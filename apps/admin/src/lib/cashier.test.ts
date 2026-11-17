import { describe, expect, it } from 'vitest';
import { hasVariance, receiptClass, receiptPath, receiptTitle, varianceLabel } from './cashier';

describe('cashier helpers', () => {
  it('titles a receipt by kind', () => {
    expect(receiptTitle('deposit')).toBe('CASH DEPOSIT');
    expect(receiptTitle('withdrawal')).toBe('CASH WITHDRAWAL');
  });

  it('picks the print class by paper width', () => {
    expect(receiptClass(80)).toContain('receipt-80');
    expect(receiptClass(58)).toContain('receipt-58');
  });

  it('labels the variance', () => {
    expect(varianceLabel(null)).toBe('–');
    expect(varianceLabel('0')).toBe('balanced');
    expect(varianceLabel('-500')).toBe('short');
    expect(varianceLabel('250')).toBe('over');
    expect(hasVariance('0')).toBe(false);
    expect(hasVariance('-1')).toBe(true);
    expect(hasVariance(null)).toBe(false);
  });

  it('builds receipt paths', () => {
    expect(receiptPath('a')).toBe('/cashier/receipt/a');
    expect(receiptPath('a', 'print')).toBe('/cashier/receipt/a?print=1');
    expect(receiptPath('a', 'copy')).toBe('/cashier/receipt/a?copy=1');
  });
});
