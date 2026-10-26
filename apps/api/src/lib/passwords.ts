import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { effectivePasswordLength, MIN_PASSWORD_LENGTH } from '@vamos/contracts';
import { isCommonPassword } from '@vamos/core/common-passwords';
import { badRequest } from './errors';

/**
 * Argon2id (the library default algorithm) with the OWASP-recommended
 * baseline: 19 MiB memory, 2 passes, 1 lane.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** True when `password` matches the stored hash. A malformed hash never matches. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a verification against a throwaway hash so that a login for an
 * unknown phone takes about as long as one with a wrong password.
 */
export async function dummyVerifyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomUUID());
  await verifyPassword(await dummyHash, password);
}

/** Computes the dummy hash ahead of the first login so its cost is not observable. */
export async function warmUpPasswordHashing(): Promise<void> {
  dummyHash ??= hashPassword(randomUUID());
  await dummyHash;
}

/**
 * Why `password` is unacceptable for the account with E.164 `phone`, or null:
 * one of the 10,000 most common passwords (@vamos/core/common-passwords,
 * ASVS 2.1.7) or the phone number itself. Length limits are enforced by the
 * request contracts.
 */
export function passwordWeakness(password: string, phone: string): string | null {
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
 * Whether a password that just signed in still meets today's rules for a new
 * one (MIN_PASSWORD_LENGTH, not common, not the phone number). Accounts made
 * under an older rule must replace it before they can sign in (ASVS 2.1.7).
 */
export function meetsPasswordPolicy(password: string, phone: string): boolean {
  return (
    effectivePasswordLength(password) >= MIN_PASSWORD_LENGTH &&
    passwordWeakness(password, phone) === null
  );
}
