/**
 * Human-friendly identifiers.
 *
 * - Booking codes (shared betslips, e.g. on Telegram) and bet short IDs use a
 *   32-symbol alphabet without the easily confused 0/O and 1/I.
 * - Game IDs are the Betika-style numeric IDs printed on every fixture so
 *   customers can bet over SMS/USSD (e.g. "0123#1#50").
 *
 * Randomness is supplied by the caller (e.g. `crypto.getRandomValues`), which
 * keeps this module pure and deterministic under test.
 */

/** 32 symbols: digits 2–9 and A–Z without I and O. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const BOOKING_CODE_LENGTH = 6;
export const BET_SHORT_ID_LENGTH = 8;

/** CODE_ALPHABET.length − 1; masking with it maps each byte uniformly (256 % 32 === 0). */
const SYMBOL_MASK = 31;
const CODE_PATTERN = /^[2-9A-HJ-NP-Z]+$/;
/** Whitespace plus ASCII and common Unicode dashes (chat apps often auto-replace "-"). */
const CODE_SEPARATORS = /[\s\-‐-―−]/g;

const MIN_GAME_ID = 100;
const MAX_GAME_ID = 999_999;
const GAME_ID_PATTERN = /^\d{3,6}$/;

/**
 * Encodes the first `length` bytes of `randomBytes` as a code, one symbol per
 * byte (`byte & 31`). Throws `RangeError` when `length` is not a positive
 * integer or fewer than `length` bytes are supplied.
 */
export function encodeCode(randomBytes: Uint8Array, length: number): string {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError(`code length must be a positive integer, got ${length}`);
  }
  if (randomBytes.length < length) {
    throw new RangeError(`need ${length} random bytes, got ${randomBytes.length}`);
  }
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET.charAt((randomBytes[i] ?? 0) & SYMBOL_MASK);
  }
  return code;
}

/** Canonical form of a typed or pasted code: trimmed, upper-cased, spaces and dashes removed. */
export function normalizeCode(input: string): string {
  // Separators are removed before upper-casing so the result is idempotent even
  // when removing a dash joins two lone surrogates into a cased character.
  return input.trim().replace(CODE_SEPARATORS, '').toUpperCase();
}

/**
 * True when `input`, after {@link normalizeCode}, is a non-empty string of
 * {@link CODE_ALPHABET} symbols (of exactly `length` symbols, when given).
 */
export function isValidCode(input: string, length?: number): boolean {
  if (typeof input !== 'string') return false;
  const code = normalizeCode(input);
  if (length !== undefined && code.length !== length) return false;
  return CODE_PATTERN.test(code);
}

/**
 * Formats a Game ID (an integer 100–999999) as digits, zero-padded to at
 * least four: `123` → `'0123'`, `98765` → `'98765'`. Throws `RangeError`
 * otherwise.
 */
export function formatGameId(gameId: number): string {
  if (!Number.isInteger(gameId) || gameId < MIN_GAME_ID || gameId > MAX_GAME_ID) {
    throw new RangeError(`game id must be an integer ${MIN_GAME_ID}–${MAX_GAME_ID}, got ${gameId}`);
  }
  return String(gameId).padStart(4, '0');
}

/**
 * Parses a Game ID typed by a customer (`'0123'`, `' 4567 '`). Returns `null`
 * unless the trimmed input is 3–6 ASCII digits naming an ID in 100–999999.
 */
export function parseGameId(input: string): number | null {
  if (typeof input !== 'string') return null;
  const digits = input.trim();
  if (!GAME_ID_PATTERN.test(digits)) return null;
  const gameId = Number(digits);
  return gameId >= MIN_GAME_ID && gameId <= MAX_GAME_ID ? gameId : null;
}
