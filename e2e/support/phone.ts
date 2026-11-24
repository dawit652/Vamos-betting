import { randomInt } from 'node:crypto';

/** The e2e PIN (PASSWORD in ui.ts, kept here to avoid an import cycle). */
const E2E_PIN = '4826';

/**
 * A random Ethio Telecom number in E.164 form (`+2519` and 8 digits), so each
 * run registers a new player and never collides with an earlier one. It never
 * holds the e2e PIN: the API refuses a PIN that is four digits in a row of the phone.
 */
export function randomPhone(): string {
  for (;;) {
    const phone = `+2519${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    // A PIN may not be four digits in a row of the phone.
    if (!phone.includes(E2E_PIN)) return phone;
  }
}

/** A date of birth comfortably over the minimum age (21). */
export const ADULT_DATE_OF_BIRTH = '1990-05-17';
