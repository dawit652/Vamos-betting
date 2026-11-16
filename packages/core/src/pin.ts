/**
 * The easy-PIN rule of the 4-digit player PIN, shared by the API (which refuses) and the web form
 * (which warns before the round trip). Pure: no I/O, no messages; each side words the reason.
 */

export const PIN_LENGTH = 4;

/**
 * Frequent PINs that no rule below refuses (published PIN frequency studies): keypad columns and
 * diagonals (2580, 0852, 7410, 3690, 1470, 1590, 3570), step patterns (2468, 1357, 1379, 1230) and a
 * few favourites (1004, 5683 "love"). Repeats, runs, pair patterns and years are refused by their
 * rules, so they are not listed. Each one taken off the table matters, because the login limits
 * leave an attacker only a handful of guesses a day on one number.
 */
export const COMMON_PINS: ReadonlySet<string> = new Set([
  '1004',
  '2580',
  '0852',
  '7410',
  '0147',
  '3690',
  '0963',
  '1470',
  '1590',
  '3570',
  '2468',
  '8642',
  '1357',
  '7531',
  '1379',
  '1230',
  '5683',
]);

export type PinWeakness = 'repeated' | 'sequence' | 'pattern' | 'common' | 'phone';

/** The subscriber digits of a typed phone (+2519XXXXXXXX, 2519XXXXXXXX, 09XXXXXXXX → 9XXXXXXXX). */
function subscriberDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('251')) return digits.slice(3);
  return digits.startsWith('0') ? digits.slice(1) : digits;
}

/** Whether `pin` is four digits in a row of the phone, as people write it (09…, 2519…). */
function partOfPhone(pin: string, phone: string): boolean {
  const subscriber = subscriberDigits(phone);
  if (subscriber.length < PIN_LENGTH) return false;
  return `0${subscriber}`.includes(pin) || `251${subscriber}`.includes(pin);
}

/**
 * Why a well-formed 4-digit `pin` is too easy to guess, or null. `phone` is the number in any typed
 * form (null skips the phone check). Refused:
 * - `repeated`: one digit four times (0000);
 * - `sequence`: digits in a row up or down, also round the keypad's 0 (1234, 9876, 7890, 0987);
 * - `pattern`: a pair twice (1212), two pairs (1122), a mirror (1221), three of a digit (1112);
 * - `common`: the frequent PINs of COMMON_PINS;
 * - `phone`: four digits in a row of the player's own number (its last four, its 09.. start…).
 *
 * Years (1990, 2016) are allowed: the owner's decision of 16 Nov 2026, after players kept picking
 * their birth year and the form refused it. The login limits per number still hold guessing back.
 */
export function pinWeaknessReason(pin: string, phone: string | null): PinWeakness | null {
  const [a, b, c, d] = pin;
  if (a === b && b === c && c === d) return 'repeated';
  const steps = Array.from(pin.slice(1), (digit, i) => (Number(digit) - Number(pin[i]) + 10) % 10);
  if (steps.every((step) => step === 1) || steps.every((step) => step === 9)) return 'sequence';
  if (
    (a === c && b === d) ||
    (a === b && c === d) ||
    (a === d && b === c) ||
    (a === b && b === c) ||
    (b === c && c === d)
  ) {
    return 'pattern';
  }
  if (COMMON_PINS.has(pin)) return 'common';
  if (phone !== null && partOfPhone(pin, phone)) return 'phone';
  return null;
}
