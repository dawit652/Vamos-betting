import { describe, expect, it } from 'vitest';
import { parseCoupon } from './coupon';

describe('parseCoupon (GS4 Check coupon)', () => {
  it('reads a slip ID as typed or read out, with spaces or a dash', () => {
    expect(parseCoupon('482913')).toEqual({ kind: 'slip', code: '482913' });
    expect(parseCoupon(' 482 913 ')).toEqual({ kind: 'slip', code: '482913' });
    expect(parseCoupon('482-913')).toEqual({ kind: 'slip', code: '482913' });
  });

  it('reads a ticket number under the barcode, upper case', () => {
    expect(parseCoupon('k7m2 q9xa')).toEqual({ kind: 'ticket', number: 'K7M2Q9XA' });
  });

  it('refuses what can be neither', () => {
    expect(parseCoupon('')).toBeNull();
    expect(parseCoupon('12')).toBeNull();
    expect(parseCoupon('x'.repeat(21))).toBeNull();
  });
});
