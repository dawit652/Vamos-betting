import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COMMON_PINS, PIN_LENGTH, pinWeaknessReason } from './pin';

const ALL_PINS = Array.from({ length: 10 ** PIN_LENGTH }, (_, n) =>
  String(n).padStart(PIN_LENGTH, '0'),
);

/** Brute-force reference, written differently from the implementation. */
function referenceKind(pin: string): 'repeated' | 'sequence' | null {
  const ups = ['0123', '1234', '2345', '3456', '4567', '5678', '6789'];
  const downs = ups.map((run) => [...run].reverse().join(''));
  if (new Set(pin).size === 1) return 'repeated';
  if (ups.includes(pin) || downs.includes(pin)) return 'sequence';
  return null;
}

const digitPin = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 4, maxLength: 4 })
  .map((d) => d.join(''));
const subscriber = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 })
  .map((d) => `9${d.join('')}`);

describe('pinWeaknessReason', () => {
  it('examples', () => {
    expect(pinWeaknessReason('0000', null)).toBe('repeated');
    expect(pinWeaknessReason('1234', null)).toBe('sequence');
    expect(pinWeaknessReason('9876', null)).toBe('sequence');
    expect(pinWeaknessReason('2580', null)).toBe('common');
    expect(pinWeaknessReason('4827', null)).toBeNull();
  });

  it('refuses the last four digits of the phone in every typed form', () => {
    for (const phone of ['+251911234827', '0911234827', '251911234827', '911234827']) {
      expect(pinWeaknessReason('4827', phone)).toBe('phone');
      expect(pinWeaknessReason('4828', phone)).toBeNull();
    }
    expect(pinWeaknessReason('4827', null)).toBeNull();
    expect(pinWeaknessReason('4827', '12')).toBeNull();
  });

  it('matches a brute-force reference over all 10,000 PINs', () => {
    for (const pin of ALL_PINS) {
      const kind = referenceKind(pin);
      const expected = kind ?? (COMMON_PINS.has(pin) ? 'common' : null);
      expect(pinWeaknessReason(pin, null)).toBe(expected);
    }
  });

  it('keeps the list to four-digit PINs that are not runs or repeats', () => {
    for (const pin of COMMON_PINS) {
      expect(pin).toMatch(/^\d{4}$/);
      expect(referenceKind(pin)).toBeNull();
    }
  });

  it('property: without a phone the result is the reference for any PIN', () => {
    fc.assert(
      fc.property(digitPin, (pin) => {
        const result = pinWeaknessReason(pin, null);
        const kind = referenceKind(pin);
        expect(result).toBe(kind ?? (COMMON_PINS.has(pin) ? 'common' : null));
      }),
    );
  });

  it('property: the phone rule fires only on the last four digits of the subscriber number', () => {
    fc.assert(
      fc.property(
        digitPin,
        subscriber,
        fc.constantFrom('+251', '251', '0', ''),
        (pin, sub, prefix) => {
          const phone = `${prefix === '0' || prefix === '' ? prefix : prefix}${sub}`;
          const withPhone = pinWeaknessReason(pin, phone);
          const without = pinWeaknessReason(pin, null);
          if (without !== null) expect(withPhone).toBe(without);
          else expect(withPhone === 'phone').toBe(sub.endsWith(pin));
        },
      ),
    );
  });

  it('property: a PIN that is the phone tail is never accepted', () => {
    fc.assert(
      fc.property(subscriber, (sub) => {
        expect(pinWeaknessReason(sub.slice(-4), `+251${sub}`)).not.toBeNull();
      }),
    );
  });
});
