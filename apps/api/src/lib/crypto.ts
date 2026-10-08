import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** SHA-256 of a UTF-8 string, hex encoded. Used to store bearer and CSRF tokens. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** HMAC-SHA256 of a UTF-8 string under `secret`, hex encoded. */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Returns false (without
 * leaking where they differ) for different lengths or non-hex input.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  // Buffer.from(…, 'hex') stops at the first invalid character.
  if (left.length * 2 !== a.length || right.length * 2 !== b.length) return false;
  return timingSafeEqual(left, right);
}

/** A URL-safe random token (base64url) from `size` random bytes. */
export function randomToken(randomBytes: (size: number) => Buffer, size = 32): string {
  return randomBytes(size).toString('base64url');
}
