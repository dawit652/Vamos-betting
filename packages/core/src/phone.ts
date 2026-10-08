/**
 * Ethiopian mobile numbers (MSISDNs).
 *
 * - Ethio Telecom mobiles: 09XXXXXXXX locally, +2519XXXXXXXX in E.164.
 * - Safaricom Ethiopia mobiles: 07XXXXXXXX locally, +2517XXXXXXXX in E.164.
 *
 * The subscriber part (after the country code / trunk prefix) is always nine
 * digits starting with 9 or 7. Landlines (e.g. Addis Ababa 011…) are rejected:
 * accounts, SMS and mobile-money payouts all require a mobile number.
 */

export type MobileOperator = 'ethio_telecom' | 'safaricom';

const COUNTRY_CODE = '251';
const E164_PREFIX = `+${COUNTRY_CODE}`;

/** Separators people commonly type or paste: whitespace, dashes, dots and parentheses. */
// Includes Unicode dashes (U+2010–U+2015, U+2212) that chat apps substitute for "-".
const SEPARATORS = /[\s\-‐-―−.()]/g;

/** Nine-digit subscriber number, optionally preceded by a supported prefix. */
const MSISDN_PATTERN = /^(?:\+251|00251|251|0)?([79]\d{8})$/;

/**
 * Normalises an Ethiopian mobile number to E.164 (`+2519XXXXXXXX` or
 * `+2517XXXXXXXX`). Accepts the local form (`0911234567`), the bare subscriber
 * number (`911234567`), and international forms (`+251…`, `251…`, `00251…`),
 * with optional spaces, dashes, dots or parentheses.
 *
 * Returns `null` for anything else: landlines, wrong lengths, letters, other
 * country codes and empty input.
 */
export function normalizeEthiopianMsisdn(input: string): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.replace(SEPARATORS, '');
  const match = MSISDN_PATTERN.exec(compact);
  if (!match) return null;
  const [, subscriber] = match;
  return subscriber === undefined ? null : `${E164_PREFIX}${subscriber}`;
}

/** True when `input` is an Ethiopian mobile number in any accepted format. */
export function isEthiopianMobile(input: string): boolean {
  return normalizeEthiopianMsisdn(input) !== null;
}

/** The mobile operator for `input`, or `null` when it is not an Ethiopian mobile number. */
export function mobileOperator(input: string): MobileOperator | null {
  const subscriber = subscriberPart(input);
  if (subscriber === null) return null;
  return subscriber.startsWith('9') ? 'ethio_telecom' : 'safaricom';
}

/**
 * Masks a mobile number for display in logs, receipts and support tools:
 * `+251911234567` → `+251 91 *** 4567`. Throws `RangeError` when `input` is
 * not a valid Ethiopian mobile number.
 */
export function maskMsisdn(input: string): string {
  const subscriber = requireSubscriber(input);
  return `${E164_PREFIX} ${subscriber.slice(0, 2)} *** ${subscriber.slice(5)}`;
}

/**
 * Formats a mobile number the way Ethiopians write it locally:
 * `+251911234567` → `0911 234 567`. Throws `RangeError` when `input` is not a
 * valid Ethiopian mobile number.
 */
export function formatMsisdnLocal(input: string): string {
  const subscriber = requireSubscriber(input);
  return `0${subscriber.slice(0, 3)} ${subscriber.slice(3, 6)} ${subscriber.slice(6)}`;
}

/** The nine-digit subscriber part of a valid number, or `null`. */
function subscriberPart(input: string): string | null {
  const normalized = normalizeEthiopianMsisdn(input);
  return normalized === null ? null : normalized.slice(E164_PREFIX.length);
}

function requireSubscriber(input: string): string {
  const subscriber = subscriberPart(input);
  // The input is deliberately not echoed: error messages end up in logs and
  // phone numbers are personal data.
  if (subscriber === null) throw new RangeError('not an Ethiopian mobile number');
  return subscriber;
}
