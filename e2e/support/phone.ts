import { randomInt } from 'node:crypto';

/** The e2e PIN (PASSWORD in ui.ts, kept here to avoid an import cycle). */
const E2E_PIN = '4826';

/**
 * A random Ethio Telecom number in E.164 form (`+2519` and 8 digits), so each
 * run registers a new player and never collides with an earlier one. It never
 * ends in the e2e PIN: the API refuses a PIN equal to the last 4 digits of the phone.
 */
export function randomPhone(): string {
  for (;;) {
    const phone = `+2519${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    if (!phone.endsWith(E2E_PIN)) return phone;
  }
}

/** A date of birth comfortably over the minimum age (21). */
export const ADULT_DATE_OF_BIRTH = '1990-05-17';
