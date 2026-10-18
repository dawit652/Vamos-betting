import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * One-time passwords for the staff sign-in: HOTP (RFC 4226) and TOTP
 * (RFC 6238) with node:crypto only. Pure: the time and the secret come from
 * the caller. Staff codes use the authenticator-app defaults: HMAC-SHA1,
 * 6 digits, 30-second steps, accepted one step either side of now.
 */

export type OtpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** Seconds per TOTP time step. */
export const TOTP_PERIOD_SECONDS = 30;
/** Digits of a staff code. */
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of the current one (clock drift, typing time). */
export const TOTP_WINDOW_STEPS = 1;
/** Size of a new secret: 160 bits, as RFC 4226 recommends. */
export const TOTP_SECRET_BYTES = 20;

export interface OtpOptions {
  /** Default 6 (RFC 4226 allows 6 to 8; 8 is used by the RFC 6238 test vectors). */
  digits?: number;
  /** Default 'sha1'. */
  algorithm?: OtpAlgorithm;
}

export interface TotpOptions extends OtpOptions {
  /** Default 30 seconds. */
  periodSeconds?: number;
}

function digitsOf(options: OtpOptions): number {
  const digits = options.digits ?? TOTP_DIGITS;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError(`OTP digits must be 6, 7 or 8 (got ${String(digits)})`);
  }
  return digits;
}

function periodOf(options: TotpOptions): number {
  const period = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`TOTP period must be a positive whole number of seconds (got ${period})`);
  }
  return period;
}

/** RFC 4226 HOTP value of `counter` (dynamic truncation of the HMAC), zero-padded. */
export function hotp(secret: Buffer, counter: number | bigint, options: OtpOptions = {}): string {
  const digits = digitsOf(options);
  const value = BigInt(counter);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`HOTP counter out of range: ${value}`);
  }
  if (secret.length === 0) throw new RangeError('HOTP secret is empty');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(value);
  const mac = createHmac(options.algorithm ?? 'sha1', secret)
    .update(message)
    .digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step (counter) at `timeMs`: floor(unix seconds / period). */
export function totpStep(timeMs: number, options: TotpOptions = {}): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new RangeError(`invalid time: ${timeMs}`);
  return Math.floor(timeMs / 1000 / periodOf(options));
}

/** The TOTP code at `timeMs` (RFC 6238). */
export function totpCode(secret: Buffer, timeMs: number, options: TotpOptions = {}): string {
  return hotp(secret, totpStep(timeMs, options), options);
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Steps accepted on either side of the current one (default 1). */
  window?: number;
  /**
   * The step of the last code accepted for this secret: only a later step is
   * accepted, so a code (or an older one still inside the window) cannot be
   * used twice.
   */
  afterStep?: number | null;
}

/**
 * The time step `code` belongs to when it is valid at `timeMs` (within the
 * window, after `afterStep`), else null. A code that is not exactly `digits`
 * decimal digits never matches. Codes are compared in constant time.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  timeMs: number,
  options: VerifyTotpOptions = {},
): number | null {
  const digits = digitsOf(options);
  const window = options.window ?? TOTP_WINDOW_STEPS;
  if (!Number.isInteger(window) || window < 0 || window > 10) {
    throw new RangeError(`TOTP window must be 0 to 10 steps (got ${String(window)})`);
  }
  if (typeof code !== 'string' || code.length !== digits || !/^\d+$/.test(code)) return null;
  const given = Buffer.from(code, 'utf8');
  const current = totpStep(timeMs, options);
  const after = options.afterStep ?? null;
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step, options), 'utf8');
    // Every step in the window is computed and compared, matched or not.
    const same = timingSafeEqual(expected, given);
    if (same && matched === null && (after === null || step > after)) matched = step;
  }
  return matched;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (the form authenticator apps take). */
export function base32Encode(bytes: Buffer): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Decodes RFC 4648 base32 (case-insensitive; spaces, hyphens and `=` padding
 * ignored). Throws RangeError for any other character or impossible length.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  if (clean.length === 0) throw new RangeError('base32 text is empty');
  if ([1, 3, 6].includes(clean.length % 8)) {
    throw new RangeError('base32 text has an impossible length');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) throw new RangeError(`invalid base32 character "${char}"`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

/**
 * The otpauth:// URI authenticator apps scan (Key Uri Format): label
 * "issuer:account", the base32 secret and the code parameters.
 */
export function totpUri(input: {
  secret: Buffer;
  account: string;
  issuer: string;
  digits?: number;
  periodSeconds?: number;
}): string {
  const digits = digitsOf({ digits: input.digits ?? TOTP_DIGITS });
  const period = periodOf({ periodSeconds: input.periodSeconds ?? TOTP_PERIOD_SECONDS });
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}
