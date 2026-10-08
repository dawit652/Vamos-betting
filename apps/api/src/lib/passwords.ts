import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { badRequest } from './errors';

/**
 * Argon2id (the library default algorithm) with the OWASP-recommended
 * baseline: 19 MiB memory, 2 passes, 1 lane.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Passwords people pick first. Compared case-insensitively. */
const COMMON_PASSWORDS = new Set([
  '123456',
  'password',
  '12345678',
  '111111',
  '000000',
  '123123',
  'qwerty',
]);

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
 * Why `password` is unacceptable for the account with E.164 `phone`, or null.
 * Length limits are enforced by the request contracts.
 */
export function passwordWeakness(password: string, phone: string): string | null {
  if (COMMON_PASSWORDS.has(password.trim().toLowerCase())) {
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
