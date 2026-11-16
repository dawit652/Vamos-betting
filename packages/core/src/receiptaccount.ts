/**
 * Comparing a (possibly masked) account number on a receipt with an account
 * we know: one of our collection accounts (credit audit: the money reached
 * us; double proof: the money left from us) or a payout's destination
 * (double proof: the money reached the player). Wrong in the permissive
 * direction, it credits players for money they sent to someone else or
 * settles payouts that went elsewhere, so it errs strict.
 *
 * Moved here from `@vamos/payments` (receipts/accountmatch.ts, which now
 * re-exports it) so the pure double-proof rule can use it. The behaviour of
 * `receiptAccountMatches` and `receiptMatchesAnyAccount` is unchanged.
 */

/** Characters institutions use to hide digits: 251911***426, 100•••8086378. */
const MASK = /[*x×•·#]/i;
/** A value made only of digits and mask characters (after separators are removed). */
const ACCOUNT_SHAPED = /^[\d*x×•·#]+$/i;
/** A plain Ethiopian mobile number in one of the forms `forms` produces. */
const PLAIN_MOBILE = /^(?:251|0)?[79]\d{8}$/;
/** The subscriber part of an Ethiopian mobile number: the last nine digits. */
const SUBSCRIBER_DIGITS = 9;

/**
 * A masked value must reveal at least four digits, including the last
 * three: `251*********` would otherwise match every telebirr account.
 */
export const RECEIPT_ACCOUNT_MIN_REVEALED = 4;
const TAIL_REVEALED = 3;

function canonical(value: string): string {
  return value.replace(/[\s\-()+]/g, '').trim();
}

/** The forms an Ethiopian mobile number is written in: 2519…, 09…, 9…. */
function forms(value: string): string[] {
  const c = canonical(value);
  const out = new Set([c]);
  if (/^251\d{9}$/.test(c)) {
    out.add(`0${c.slice(3)}`);
    out.add(c.slice(3));
  } else if (/^0[79]\d{8}$/.test(c)) {
    out.add(`251${c.slice(1)}`);
    out.add(c.slice(1));
  } else if (/^[79]\d{8}$/.test(c)) {
    out.add(`251${c}`);
    out.add(`0${c}`);
  }
  // Masked forms keep their digits where they are; try the other prefix too.
  if (/^251[\d*x×•·#]{9}$/i.test(c)) out.add(`0${c.slice(3)}`);
  if (/^0[\d*x×•·#]{9}$/i.test(c)) out.add(`251${c.slice(1)}`);
  return [...out];
}

type PairResult = 'match' | 'consistent' | 'differs';

/**
 * One masked form against one plain form. `consistent`: no revealed
 * character contradicts the plain value, but too few are revealed (or the
 * tail is hidden) to say it can only be this account.
 */
function comparePair(
  masked: string,
  plain: string,
  minRevealed: number,
  subscriberDigitsOnly: boolean,
): PairResult {
  if (masked.length === 0 || masked.length !== plain.length) return 'differs';
  const countFrom =
    subscriberDigitsOnly && PLAIN_MOBILE.test(plain) ? plain.length - SUBSCRIBER_DIGITS : 0;
  let revealed = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (MASK.test(ch)) continue;
    if (ch !== plain[i]) return 'differs';
    if (i >= countFrom) revealed++;
  }
  if (revealed < minRevealed) return 'consistent';
  const tail = masked.slice(-TAIL_REVEALED);
  if (tail.length < TAIL_REVEALED) return 'consistent';
  for (const ch of tail) if (MASK.test(ch)) return 'consistent';
  return 'match';
}

export type ReceiptAccountComparison =
  /** The receipt value can only be this account. */
  | 'match'
  /** A revealed digit, or the length, shows it is another account. */
  | 'differs'
  /** Absent, not an account number, or too masked to tell. */
  | 'unreadable';

export interface ReceiptAccountRule {
  /**
   * Unmasked characters the receipt value must reveal, the last three
   * included. Never below `RECEIPT_ACCOUNT_MIN_REVEALED`; a value that is not
   * an integer makes every value too masked (strict).
   */
  minRevealed?: number;
  /**
   * Count revealed digits in the nine-digit subscriber part only, when our
   * account is a mobile number: the country code or trunk prefix (`251`,
   * `0`) is the same for every number and reveals nothing about which one.
   */
  subscriberDigitsOnly?: boolean;
}

/**
 * Three-way comparison of a receipt value with an account we know. `match`
 * is the only answer that may count as proof; `unreadable` never means
 * `differs` (a page whose shape changed must not look like fraud), and
 * neither ever means `match`.
 */
export function compareReceiptAccount(
  receiptValue: unknown,
  ours: unknown,
  rule: ReceiptAccountRule = {},
): ReceiptAccountComparison {
  if (typeof receiptValue !== 'string' || typeof ours !== 'string') return 'unreadable';
  if (canonical(receiptValue) === '' || canonical(ours) === '') return 'unreadable';
  const requested = rule.minRevealed ?? RECEIPT_ACCOUNT_MIN_REVEALED;
  const minRevealed = Number.isInteger(requested)
    ? Math.max(requested, RECEIPT_ACCOUNT_MIN_REVEALED)
    : Number.POSITIVE_INFINITY;
  const subscriberDigitsOnly = rule.subscriberDigitsOnly === true;
  let consistent = false;
  for (const a of forms(receiptValue)) {
    for (const b of forms(ours)) {
      const result = comparePair(a, b, minRevealed, subscriberDigitsOnly);
      if (result === 'match') return 'match';
      if (result === 'consistent') consistent = true;
    }
  }
  if (consistent || !ACCOUNT_SHAPED.test(canonical(receiptValue))) return 'unreadable';
  return 'differs';
}

/** True when the receipt value can only be this account. Never true for an absent value. */
export function receiptAccountMatches(
  receiptValue: string | null | undefined,
  ours: string | null | undefined,
): boolean {
  if (!receiptValue || !ours) return false;
  return compareReceiptAccount(receiptValue, ours) === 'match';
}

/** True when the receipt value matches one of our collection accounts. */
export function receiptMatchesAnyAccount(
  receiptValue: string | null | undefined,
  ours: readonly string[],
): boolean {
  return ours.some((account) => receiptAccountMatches(receiptValue, account));
}
