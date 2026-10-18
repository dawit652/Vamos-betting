import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from 'node:crypto';

/**
 * Encryption at rest of the staff TOTP secrets (admin_users.totp_secret_enc):
 * AES-256-GCM under ADMIN_TOTP_KEY with a fresh 96-bit IV per secret. The
 * additional authenticated data binds a ciphertext to its staff account, so
 * a secret copied onto another row does not decrypt.
 *
 * Stored form: `v1.<iv>.<ciphertext>.<tag>`, each part base64url.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The stored secret cannot be decrypted: wrong key, tampered with, or not ours. */
export class TotpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretError';
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new RangeError(`the TOTP encryption key must be ${KEY_BYTES} bytes`);
  }
}

function aadFor(adminUserId: string): Buffer {
  if (typeof adminUserId !== 'string' || adminUserId.length === 0) {
    throw new RangeError('a TOTP secret must be bound to a staff account id');
  }
  return Buffer.from(`vamos:admin-totp:${VERSION}:${adminUserId}`, 'utf8');
}

/** Encrypts a TOTP secret for the staff account `adminUserId`. */
export function encryptTotpSecret(
  key: Buffer,
  secret: Buffer,
  adminUserId: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): string {
  assertKey(key);
  if (secret.length === 0) throw new RangeError('the TOTP secret is empty');
  const iv = randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new RangeError('randomBytes returned the wrong size');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(adminUserId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

const PART_RE = /^[A-Za-z0-9_-]+$/;

/** Decrypts what encryptTotpSecret stored for `adminUserId`; throws TotpSecretError otherwise. */
export function decryptTotpSecret(key: Buffer, stored: string, adminUserId: string): Buffer {
  assertKey(key);
  const parts = typeof stored === 'string' ? stored.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART_RE.test(p))) {
    throw new TotpSecretError('the stored TOTP secret is not in a known format');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const ciphertext = Buffer.from(parts[2]!, 'base64url');
  const tag = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new TotpSecretError('the stored TOTP secret is malformed');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(adminUserId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new TotpSecretError('the stored TOTP secret does not decrypt with this key and account');
  }
}
