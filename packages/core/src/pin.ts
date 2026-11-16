/**
 * The easy-PIN rule of the 4-digit player PIN, shared by the API (which refuses) and the web form
 * (which warns before the round trip). Pure: no I/O, no messages; each side words the reason.
 */

export const PIN_LENGTH = 4;

/**
 * PINs nobody may choose, besides one digit four times and straight runs: the most common 4-digit
 * PINs that are not runs (published PIN frequency studies), the keypad column 2580 and a few
 * patterns. Each one taken off the table matters, because the login limits leave an attacker only
 * a handful of guesses a day on one number.
 */
export const COMMON_PINS: ReadonlySet<string> = new Set([
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

export type PinWeakness = 'repeated' | 'sequence' | 'common' | 'phone';

/** The subscriber digits of a typed phone (+2519XXXXXXXX, 2519XXXXXXXX, 09XXXXXXXX → 9XXXXXXXX). */
function subscriberDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('251')) return digits.slice(3);
  return digits.startsWith('0') ? digits.slice(1) : digits;
}

/**
 * Why a well-formed 4-digit `pin` is too easy to guess, or null. `phone` is the number in any typed
 * form (null skips the phone check): the last four digits of its subscriber number are refused.
 */
export function pinWeaknessReason(pin: string, phone: string | null): PinWeakness | null {
  if (/^(\d)\1+$/.test(pin)) return 'repeated';
  const steps = Array.from(pin.slice(1), (digit, i) => Number(digit) - Number(pin[i]));
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) return 'sequence';
  if (COMMON_PINS.has(pin)) return 'common';
  if (phone !== null) {
    const subscriber = subscriberDigits(phone);
    if (subscriber.length >= PIN_LENGTH && subscriber.endsWith(pin)) return 'phone';
  }
  return null;
}
