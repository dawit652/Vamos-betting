/**
 * The easy-PIN rule of the 4-digit player PIN, shared by the API (which refuses) and the web form
 * (which warns before the round trip). Pure: no I/O, no messages; each side words the reason.
 */

export const PIN_LENGTH = 4;

export type PinWeakness = 'repeated' | 'sequence' | 'phone';

/** The last four digits of a phone in any typed form (+251 911 234 827, 0911234827…), or null. */
function lastFourDigits(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length < PIN_LENGTH ? null : digits.slice(-PIN_LENGTH);
}

/**
 * Why a well-formed 4-digit `pin` is too easy to guess, or null. `phone` is the number in any typed
 * form (null skips the phone check). Refused, 31 of the 10,000 PINs for a given number:
 * - `repeated`: one digit four times (0000, 1111…);
 * - `sequence`: digits in a row up or down, also round the keypad's 0 (1234, 9876, 7890, 0987);
 * - `phone`: the last four digits of the player's own number, the first guess of anyone who knows
 *   it (the number is the login).
 *
 * Everything else is a valid PIN: pairs and mirrors (1212, 1122, 1221), years (1990, 2016) and keypad
 * shapes (2580). The owner's decisions of 16 Nov 2026, after the registration form kept refusing the
 * PINs players typed. The login limits per number (6 checks per 15 minutes, 15 a day) hold guessing
 * back.
 */
export function pinWeaknessReason(pin: string, phone: string | null): PinWeakness | null {
  const [a, b, c, d] = pin;
  if (a === b && b === c && c === d) return 'repeated';
  const steps = Array.from(pin.slice(1), (digit, i) => (Number(digit) - Number(pin[i]) + 10) % 10);
  if (steps.every((step) => step === 1) || steps.every((step) => step === 9)) return 'sequence';
  if (phone !== null && lastFourDigits(phone) === pin) return 'phone';
  return null;
}
