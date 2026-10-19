import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { safeEqualHex } from '../../lib/crypto';

/**
 * Authentication of the SMS / USSD aggregators (Phase 11).
 *
 * - SMS: `x-sms-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 *   "<t>.<raw body>">` under SMS_WEBHOOK_SECRET, like the mock payment
 *   provider's webhooks, refused when the timestamp is more than
 *   SMS_SIGNATURE_TOLERANCE_MS away from the clock. The real aggregator's
 *   scheme is TBD; its adapter goes here.
 * - USSD: the shared secret (USSD_SHARED_SECRET) in `x-ussd-secret`,
 *   compared in constant time.
 */

export const SMS_SIGNATURE_HEADER = 'x-sms-signature';
export const USSD_SECRET_HEADER = 'x-ussd-secret';
export const SMS_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type SmsSignatureFailure = 'missing_signature' | 'bad_signature' | 'stale_timestamp';

/** Hex HMAC-SHA256 of "<t>." followed by the raw body bytes. */
function smsDigest(secret: string, t: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${t}.`, 'utf8').update(rawBody).digest('hex');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

/** The signature header of `rawBody`, signed at `at` (for the dev simulator and tests). */
export function signSmsBody(secret: string, rawBody: string | Buffer, at: Date): string {
  const t = Math.floor(at.getTime() / 1000).toString();
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `t=${t},v1=${smsDigest(secret, t, body)}`;
}

/**
 * Checks the SMS signature over the exact bytes received. Returns null when
 * it is valid, otherwise why not.
 */
export function verifySmsSignature(
  secret: string,
  header: string | string[] | undefined,
  rawBody: Buffer,
  now: Date,
): SmsSignatureFailure | null {
  const value = headerValue(header);
  if (value === undefined) return 'missing_signature';
  const parts = new Map<string, string>();
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (t === undefined || v1 === undefined || !/^\d{1,12}$/.test(t)) return 'missing_signature';
  const expected = smsDigest(secret, t, rawBody);
  if (!safeEqualHex(expected, v1.toLowerCase())) return 'bad_signature';
  // Checked after the signature, so the timestamp is known to be genuine.
  if (Math.abs(now.getTime() - Number(t) * 1000) > SMS_SIGNATURE_TOLERANCE_MS) {
    return 'stale_timestamp';
  }
  return null;
}

/** Constant-time check of the USSD shared secret (both sides hashed, so lengths never leak). */
export function verifyUssdSecret(secret: string, header: string | string[] | undefined): boolean {
  const value = headerValue(header);
  if (value === undefined || value.length === 0) return false;
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  const given = createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(expected, given);
}
