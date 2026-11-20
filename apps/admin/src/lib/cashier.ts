/** Pure helpers for the cashier desk pages. Money is a decimal string of santim. */

/** The heading a receipt carries. */
export function receiptTitle(kind: 'deposit' | 'withdrawal'): string {
  return kind === 'withdrawal' ? 'CASH WITHDRAWAL' : 'CASH DEPOSIT';
}

/** The print class (and so the named @page) for a shop's paper width. */
export function receiptClass(widthMm: 58 | 80): string {
  return widthMm === 58 ? 'receipt receipt-58' : 'receipt receipt-80';
}

/** "short 5.00" / "over 2.50" are shown by the sign: negative means cash is missing. */
export function varianceLabel(variance: string | null): string {
  if (variance === null) return '–';
  if (/^-?0+$/.test(variance)) return 'balanced';
  return variance.startsWith('-') ? 'short' : 'over';
}

/** Whether a closed shift's count differs from the expected cash. */
export function hasVariance(variance: string | null): boolean {
  return variance !== null && !/^-?0+$/.test(variance);
}

/** The path of the printable receipt: a first print, or a copy of an earlier one. */
export function receiptPath(id: string, mode: 'print' | 'copy' | 'view' = 'view'): string {
  const base = `/cashier/receipt/${id}`;
  return mode === 'print' ? `${base}?print=1` : mode === 'copy' ? `${base}?copy=1` : base;
}

const REVIEW_REASONS: Readonly<Record<string, string>> = {
  above_auto_approve_threshold: 'above the automatic approval limit',
  aml_review: 'anti-money-laundering review',
  active_exclusion: 'the player is self-excluded',
};

/** A reviewer-readable reason a cash withdrawal waits for the back office. */
export function reviewReasonLabel(reason: string | null): string {
  if (reason === null) return 'needs review';
  return REVIEW_REASONS[reason] ?? reason.replace(/_/g, ' ');
}
