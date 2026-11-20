/**
 * The phone's half of "Reset at a shop" (cashier phase "assisted PIN reset", the review of
 * 18 Nov 2026): a random secret made and kept in this browser. The start sends only its SHA-256;
 * the status and the new PIN prove the secret itself, so nobody at the desk can set the PIN.
 */

const STORAGE_KEY = 'vamos.shopPinReset';

/** What this phone keeps between the start and the new PIN (localStorage, this browser only). */
export interface ShopResetRecord {
  secret: string;
  /** The normalised number the reset was started for (the PIN rule checks its last digits). */
  phone: string;
  deskCode: string;
  expiresAt: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url (43 characters). */
export function newShopResetSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** SHA-256 (hex) of the secret's UTF-8 text, as the API computes it. */
export async function shopResetSecretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** "12345678" → "1234 5678". */
export function formatDeskCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function isRecord(value: unknown): value is ShopResetRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.secret === 'string' &&
    /^[A-Za-z0-9_-]{32,128}$/.test(record.secret) &&
    typeof record.phone === 'string' &&
    typeof record.deskCode === 'string' &&
    typeof record.expiresAt === 'string'
  );
}

/** The kept record, or null (none, unreadable storage, or not of this shape). */
export function loadShopReset(): ShopResetRecord | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keeps the record; without storage the page must simply stay open. */
export function saveShopReset(record: ShopResetRecord): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode or blocked storage: the record lives in the page's memory only.
  }
}

export function clearShopReset(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept, nothing to clear.
  }
}
