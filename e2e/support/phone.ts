import { randomInt } from 'node:crypto';

/**
 * A random Ethio Telecom number in E.164 form (`+2519` and 8 digits), so each
 * run registers a new player and never collides with an earlier one.
 */
export function randomPhone(): string {
  return `+2519${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

/** A date of birth comfortably over the minimum age (21). */
export const ADULT_DATE_OF_BIRTH = '1990-05-17';
