/**
 * SMS and USSD text lengths.
 *
 * An SMS is sent in the GSM 03.38 7-bit alphabet when every character is in
 * it (160 septets per message, 153 per part of a concatenated message;
 * characters of the extension table such as `€ [ ] { }` take two septets),
 * and in UCS-2 otherwise (70 UTF-16 code units, 67 per part). Ethiopic
 * (Amharic) text is always UCS-2. Replies aim for one message and must fit
 * in MAX_SMS_SEGMENTS parts.
 */

/** Most parts a reply may be split into. */
export const MAX_SMS_SEGMENTS = 3;
/** Longest USSD response (CON/END prefix included) most networks deliver. */
export const USSD_MAX_LENGTH = 182;

export type SmsEncoding = 'gsm7' | 'ucs2';

const GSM7_SINGLE_PART = 160;
const GSM7_MULTI_PART = 153;
const UCS2_SINGLE_PART = 70;
const UCS2_MULTI_PART = 67;

/** The GSM 03.38 basic character set (the escape code 0x1B left out). */
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** The extension table: each takes two septets (escape + code). */
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

/** Septets of one character in GSM-7, or null when it cannot be sent in GSM-7. */
function gsm7Septets(char: string): 1 | 2 | null {
  if (GSM7_BASIC.has(char)) return 1;
  if (GSM7_EXTENDED.has(char)) return 2;
  return null;
}

/** True when every character of `text` is in the GSM 03.38 alphabet. */
export function isGsm7(text: string): boolean {
  for (const char of text) {
    if (gsm7Septets(char) === null) return false;
  }
  return true;
}

/** The encoding an SMS of `text` is sent in. */
export function smsEncoding(text: string): SmsEncoding {
  return isGsm7(text) ? 'gsm7' : 'ucs2';
}

/** Length in the units of its encoding: septets (GSM-7) or UTF-16 code units (UCS-2). */
export function smsUnits(text: string): number {
  if (!isGsm7(text)) return text.length;
  let septets = 0;
  for (const char of text) septets += gsm7Septets(char) ?? 2;
  return septets;
}

/**
 * Parts needed to send `text` (0 for an empty text). Concatenated parts never
 * split a GSM-7 escape sequence or a UTF-16 surrogate pair, as handsets and
 * gateways do.
 */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;
  const gsm7 = isGsm7(text);
  const sizes: number[] = [];
  for (const char of text) {
    sizes.push(gsm7 ? (gsm7Septets(char) ?? 2) : char.length);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= (gsm7 ? GSM7_SINGLE_PART : UCS2_SINGLE_PART)) return 1;
  const perPart = gsm7 ? GSM7_MULTI_PART : UCS2_MULTI_PART;
  let parts = 1;
  let used = 0;
  for (const size of sizes) {
    if (used + size > perPart) {
      parts += 1;
      used = 0;
    }
    used += size;
  }
  return parts;
}

/** The parts and encoding of `text`. */
export function smsInfo(text: string): { encoding: SmsEncoding; units: number; segments: number } {
  return { encoding: smsEncoding(text), units: smsUnits(text), segments: smsSegments(text) };
}

/** Removes control characters (other than line feeds) and trims. */
export function cleanSmsText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ').trim();
}

/**
 * `text` if it fits in `maxSegments` SMS parts, else its longest prefix (whole
 * code points) that fits with an ellipsis: "..." in GSM-7 text, "…" in UCS-2.
 */
export function fitSms(text: string, maxSegments: number = MAX_SMS_SEGMENTS): string {
  if (!Number.isInteger(maxSegments) || maxSegments < 1) {
    throw new RangeError(`maxSegments must be a positive integer, got ${maxSegments}`);
  }
  if (smsSegments(text) <= maxSegments) return text;
  const chars = Array.from(text);
  const candidate = (kept: number): string => {
    const prefix = chars.slice(0, kept).join('').trimEnd();
    return prefix + (isGsm7(prefix) ? '...' : '…');
  };
  let low = 0;
  let high = chars.length;
  // The largest `kept` whose candidate fits; candidate(0) ("..." alone) always does.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (smsSegments(candidate(mid)) <= maxSegments) low = mid;
    else high = mid - 1;
  }
  let kept = low;
  while (kept > 0 && smsSegments(candidate(kept)) > maxSegments) kept -= 1;
  return candidate(kept);
}

/**
 * `text` if it is at most `max` UTF-16 code units long, else its longest
 * prefix (whole code points) that fits with "…".
 */
export function fitLength(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`max must be a positive integer, got ${max}`);
  }
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length + 1 > max) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}
