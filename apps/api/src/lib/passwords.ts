import { randomUUID } from 'node:crypto';
import { effectivePasswordLength, MIN_PASSWORD_LENGTH, PIN_LENGTH } from '@vamos/contracts';
import { isCommonPassword } from '@vamos/core/common-passwords';
import { createPasswordHasher, type PepperedPasswordHasher } from '@vamos/db/passwords';
import { badRequest } from './errors';

/**
 * Player and staff passwords: argon2id with the OWASP baseline (19 MiB, 2
 * passes, 1 lane) and PASSWORD_PEPPER as argon2's secret key when it is set
 * (createPasswordHasher of @vamos/db/passwords, ASVS 2.4.1, 2.4.5). Every
 * function takes the pepper (`config.passwordPepper`).
 */
const hashers = new Map<string, PepperedPasswordHasher>();

/** The hasher of a pepper (one per value; undefined: no pepper). */
export function passwordHasher(pepper: string | undefined): PepperedPasswordHasher {
  const key = pepper ?? '';
  let hasher = hashers.get(key);
  if (hasher === undefined) {
    hasher = createPasswordHasher(pepper);
    hashers.set(key, hasher);
  }
  return hasher;
}

export async function hashPassword(password: string, pepper?: string): Promise<string> {
  return passwordHasher(pepper).hash(password);
}

/** True when `password` matches the stored hash. A malformed hash never matches. */
export async function verifyPassword(
  storedHash: string,
  password: string,
  pepper?: string,
): Promise<boolean> {
  return passwordHasher(pepper).verify(storedHash, password);
}

/** True when the stored hash was made without the configured pepper (replace it at sign-in). */
export function passwordNeedsRehash(storedHash: string, pepper?: string): boolean {
  return passwordHasher(pepper).needsRehash(storedHash);
}

const dummyHashes = new Map<string, Promise<string>>();

function dummyHash(pepper: string | undefined): Promise<string> {
  const key = pepper ?? '';
  let dummy = dummyHashes.get(key);
  if (dummy === undefined) {
    dummy = hashPassword(randomUUID(), pepper);
    dummyHashes.set(key, dummy);
  }
  return dummy;
}

/**
 * Runs a verification against a throwaway hash so that a login for an
 * unknown phone takes about as long as one with a wrong password.
 */
export async function dummyVerifyPassword(password: string, pepper?: string): Promise<void> {
  await verifyPassword(await dummyHash(pepper), password, pepper);
}

/** Computes the dummy hash ahead of the first login so its cost is not observable. */
export async function warmUpPasswordHashing(pepper?: string): Promise<void> {
  await dummyHash(pepper);
}

/**
 * PINs nobody may choose, besides one digit four times and straight runs: the most common 4-digit
 * PINs that are not runs (published PIN frequency studies), the keypad column 2580 and a few
 * patterns. Each one taken off the table matters, because the login limits leave an attacker only
 * a handful of guesses a day on one number.
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '1212',
  '1004',
  '2000',
  '6969',
  '1122',
  '1313',
  '2580',
  '0852',
  '1010',
  '2001',
  '1984',
  '2020',
  '2468',
  '1357',
  '1379',
  '7410',
  '0007',
  '5683',
  '1221',
  '2112',
  '1230',
  '0101',
  '2525',
  '1100',
  '0011',
  '1001',
  '2002',
  '1999',
]);

const PIN_RE = new RegExp(`^\\d{${PIN_LENGTH}}$`);

/** The subscriber digits of an E.164 Ethiopian number (+2519XXXXXXXX → 9XXXXXXXX). */
function subscriberDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('251') ? digits.slice(3) : digits;
}

/** Why a 4-digit PIN is too easy to guess for the account with `phone`, or null. */
export function pinWeakness(pin: string, phone: string): string | null {
  if (/^(\d)\1+$/.test(pin)) return 'Do not use the same digit four times.';
  const steps = Array.from(pin.slice(1), (digit, i) => Number(digit) - Number(pin[i]));
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) {
    return 'Do not use digits in a row (like 1234 or 9876).';
  }
  if (COMMON_PINS.has(pin)) return 'This PIN is too common. Choose another one.';
  if (subscriberDigits(phone).endsWith(pin)) {
    return 'Do not use the last digits of your phone number as your PIN.';
  }
  return null;
}

/**
 * Why `password` is unacceptable for the account with E.164 `phone`, or null.
 * A 4-digit PIN (the rule for new passwords) is checked by pinWeakness; a
 * longer password (made under the older rule) must not be one of the 10,000
 * most common passwords (@vamos/core/common-passwords) nor the phone number.
 * The format itself is enforced by the request contracts.
 */
export function passwordWeakness(password: string, phone: string): string | null {
  if (PIN_RE.test(password)) return pinWeakness(password, phone);
  if (isCommonPassword(password)) {
    return 'This password is too common. Choose one that is harder to guess.';
  }
  const digits = phone.replace(/\D/g, '');
  const subscriber = digits.startsWith('251') ? digits.slice(3) : digits;
  const phoneForms = new Set([digits, `+${digits}`, `00${digits}`, `0${subscriber}`, subscriber]);
  if (phoneForms.has(password.replace(/[\s\-.()]/g, ''))) {
    return 'Do not use your phone number as your password.';
  }
  return null;
}

/** Throws 400 `weak_password` when the password is unacceptable. */
export function assertPasswordAcceptable(password: string, phone: string): void {
  const problem = passwordWeakness(password, phone);
  if (problem !== null) {
    throw badRequest('weak_password', problem);
  }
}

/**
 * Whether a password that just signed in may keep signing in: a 4-digit PIN that is not too easy
 * (today's rule), or a password made under the older rule (MIN_PASSWORD_LENGTH characters or
 * more, not common, not the phone number), so nobody is forced to change a long password. Anything
 * else (a short password from before the 12-character rule) must be replaced through the SMS reset
 * first.
 */
export function meetsPasswordPolicy(password: string, phone: string): boolean {
  if (PIN_RE.test(password)) return pinWeakness(password, phone) === null;
  return (
    effectivePasswordLength(password) >= MIN_PASSWORD_LENGTH &&
    passwordWeakness(password, phone) === null
  );
}
