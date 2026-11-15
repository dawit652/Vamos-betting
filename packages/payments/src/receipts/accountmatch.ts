/**
 * Comparing a (possibly masked) account number on a receipt with one of our
 * collection accounts: the part of receipt verification that establishes the
 * money reached us. Wrong in the permissive direction, it credits players
 * for money they sent to someone else, so it errs strict.
 */

/** Characters institutions use to hide digits: 251911***426, 100•••8086378. */
const MASK = /[*x×•·#]/i;

/**
 * A masked value must reveal at least four digits, including the last
 * three: `251*********` would otherwise match every telebirr account.
 */
const MIN_REVEALED = 4;
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

function compareMasked(masked: string, plain: string): boolean {
  if (masked.length === 0 || masked.length !== plain.length) return false;
  let revealed = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (MASK.test(ch)) continue;
    if (ch !== plain[i]) return false;
    revealed++;
  }
  if (revealed < MIN_REVEALED) return false;
  const tail = masked.slice(-TAIL_REVEALED);
  if (tail.length < TAIL_REVEALED) return false;
  for (const ch of tail) if (MASK.test(ch)) return false;
  return true;
}

/** True when the receipt value can only be this account. Never true for an absent value. */
export function receiptAccountMatches(
  receiptValue: string | null | undefined,
  ours: string | null | undefined,
): boolean {
  if (!receiptValue || !ours) return false;
  for (const a of forms(receiptValue)) {
    for (const b of forms(ours)) {
      if (compareMasked(a, b)) return true;
    }
  }
  return false;
}

/** True when the receipt value matches one of our collection accounts. */
export function receiptMatchesAnyAccount(
  receiptValue: string | null | undefined,
  ours: readonly string[],
): boolean {
  return ours.some((account) => receiptAccountMatches(receiptValue, account));
}
