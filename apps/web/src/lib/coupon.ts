import { isBookingCode, normalizeCode } from '@vamos/core';

/**
 * What Check coupon was given (docs/plans/guest-slips-and-staff.md, GS4): a slip ID (6 digits, or
 * an older 6-letter booking code) or a shop ticket's number (8 symbols under its barcode). null for
 * anything that can be neither.
 */
export type Coupon = { kind: 'slip'; code: string } | { kind: 'ticket'; number: string };

export function parseCoupon(input: string): Coupon | null {
  const code = normalizeCode(input);
  if (isBookingCode(code)) return { kind: 'slip', code };
  const number = input.replace(/\s+/g, '').toUpperCase();
  return number.length >= 4 && number.length <= 20 ? { kind: 'ticket', number } : null;
}
