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

/** The heading a receipt carries. */
export function receiptTitle(kind: 'deposit' | 'withdrawal'): string {
  return kind === 'withdrawal' ? 'CASH WITHDRAWAL' : 'CASH DEPOSIT';
}

/** The path of the printable receipt: a first print, a copy of an earlier one, or a plain view. */
export function receiptPath(id: string, mode: 'print' | 'copy' | 'view' = 'view'): string {
  const base = `/receipt/${id}`;
  return mode === 'print' ? `${base}?print=1` : mode === 'copy' ? `${base}?copy=1` : base;
}

const REVIEW_REASONS: Readonly<Record<string, string>> = {
  above_auto_approve_threshold: 'above the automatic approval limit',
  aml_review: 'anti-money-laundering review',
  active_exclusion: 'the player is self-excluded',
};

/** Why a cash withdrawal waits for the back office, in words for the counter. */
export function reviewReasonLabel(reason: string | null): string {
  if (reason === null) return 'needs review';
  return REVIEW_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

/** The amount typed at the desk as santim; null for nothing, a bad amount or zero. */
export function positiveCashToSantim(input: string): string | null {
  const santim = parseEtbToSantim(input);
  return santim === null || santim === '0' ? null : santim;
}

/** Whether a player may be served cash: active and not self-excluded. */
export function playerServable(player: { status: string; exclusion: unknown }): boolean {
  return player.status === 'active' && player.exclusion === null;
}
