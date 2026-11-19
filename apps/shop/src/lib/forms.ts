import { parseEtbToSantim } from './format';
import { TEXT } from './text';

/** The shortest password the API accepts (ShopPasswordChangeRequest). */
export const MIN_PASSWORD_LENGTH = 12;

/** The first problem of a password change form, or null when it can be sent. */
export function passwordChangeProblem(newPassword: string, repeat: string): string | null {
  if (newPassword.length < MIN_PASSWORD_LENGTH) return TEXT.passwordTooShort;
  if (newPassword !== repeat) return TEXT.passwordMismatch;
  return null;
}

/** The drawer cash typed as ETB → santim string, or null (an amount of zero is fine). */
export function cashToSantim(input: string): string | null {
  return parseEtbToSantim(input);
}

/** The receipt print class (and so the named @page) for a shop's paper width. */
export function receiptClass(widthMm: 58 | 80): string {
  return widthMm === 58 ? 'receipt receipt-58' : 'receipt receipt-80';
}
