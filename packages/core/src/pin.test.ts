import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COMMON_PINS, PIN_LENGTH, PIN_YEARS, pinWeaknessReason, type PinWeakness } from './pin';

const ALL_PINS = Array.from({ length: 10 ** PIN_LENGTH }, (_, n) =>
  String(n).padStart(PIN_LENGTH, '0'),
);

/**
 * Brute-force reference, written differently from the implementation: every refused PIN is
 * GENERATED from its class, and a PIN gets the first class (in the rule's order) that holds it.
 */
const REFERENCE: ReadonlyMap<string, PinWeakness> = (() => {
  const classes: [PinWeakness, string[]][] = [];
  const digits = [...'0123456789'];
  classes.push(['repeated', digits.map((d) => d.repeat(4))]);
  const runs: string[] = [];
  for (let start = 0; start < 10; start += 1) {
    runs.push([0, 1, 2, 3].map((k) => (start + k) % 10).join(''));
    runs.push([0, 1, 2, 3].map((k) => (start - k + 10) % 10).join(''));
  }
  classes.push(['sequence', runs]);
  const patterns: string[] = [];
  for (const x of digits) {
    for (const y of digits) {
      patterns.push(`${x}${y}${x}${y}`, `${x}${x}${y}${y}`, `${x}${y}${y}${x}`);
      patterns.push(`${x}${x}${x}${y}`, `${y}${x}${x}${x}`);
    }
  }
  classes.push(['pattern', patterns]);
  const years: string[] = [];
  for (let year = 1940; year <= 2030; year += 1) years.push(String(year));
  classes.push(['year', years]);
  classes.push(['common', [...COMMON_PINS]]);
  const out = new Map<string, PinWeakness>();
  for (const [kind, pins] of classes) for (const pin of pins) if (!out.has(pin)) out.set(pin, kind);
  return out;
})();

/** Every four digits in a row of `text`. */
const windows = (text: string) =>
  Array.from({ length: Math.max(0, text.length - 3) }, (_, i) => text.slice(i, i + 4));

const digitPin = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 4, maxLength: 4 })
  .map((d) => d.join(''));
const subscriber = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 })
  .map((d) => `9${d.join('')}`);

describe('pinWeaknessReason', () => {
  it('examples of every rule', () => {
    expect(pinWeaknessReason('0000', null)).toBe('repeated');
    for (const pin of ['1234', '9876', '7890', '8901', '9012', '0987', '1098', '2109']) {
      expect(pinWeaknessReason(pin, null), pin).toBe('sequence');
    }
    for (const pin of ['1212', '1414', '1122', '5566', '1221', '2002', '1110', '0001', '2111']) {
      expect(pinWeaknessReason(pin, null), pin).toBe('pattern');
    }
    for (const pin of ['1940', '1984', '1987', '2016', '2026', '2030']) {
      expect(pinWeaknessReason(pin, null), pin).toBe('year');
    }
    expect(pinWeaknessReason('2580', null)).toBe('common');
    for (const pin of ['1939', '2031', '4827', '7031']) {
      expect(pinWeaknessReason(pin, null), pin).toBeNull();
    }
  });

  it('allows the PINs the API and e2e tests sign in with', () => {
    expect(pinWeaknessReason('4826', null)).toBeNull();
    expect(pinWeaknessReason('7031', null)).toBeNull();
  });

  it('refuses four digits in a row of the phone, in every typed form', () => {
    for (const phone of ['+251911234827', '0911234827', '251911234827', '911234827']) {
      // The last four, the start as dialled (09..) and as written internationally (2519..).
      for (const pin of ['4827', '0911', '9112', '2348', '2519']) {
        expect(pinWeaknessReason(pin, phone), `${pin} ${phone}`).toBe('phone');
      }
      expect(pinWeaknessReason('4828', phone)).toBeNull();
    }
    expect(pinWeaknessReason('4827', null)).toBeNull();
    expect(pinWeaknessReason('4827', '12')).toBeNull();
  });

  it('matches the generated reference over all 10,000 PINs', () => {
    for (const pin of ALL_PINS) {
      expect(pinWeaknessReason(pin, null), pin).toBe(REFERENCE.get(pin) ?? null);
    }
  });

  it('leaves at least 94% of the PINs to choose from', () => {
    const refused = ALL_PINS.filter((pin) => pinWeaknessReason(pin, null) !== null).length;
    expect(refused).toBe(REFERENCE.size);
    expect(refused).toBeLessThanOrEqual(600);
  });

  it('keeps the common list to four-digit PINs no other rule refuses', () => {
    for (const pin of COMMON_PINS) {
      expect(pin).toMatch(/^\d{4}$/);
      expect(REFERENCE.get(pin), pin).toBe('common');
    }
    expect(PIN_YEARS).toEqual({ from: 1940, to: 2030 });
  });

  it('property: the phone rule refuses exactly the four-digit windows of the number', () => {
    fc.assert(
      fc.property(
        digitPin,
        subscriber,
        fc.constantFrom('+251', '251', '0', ''),
        (pin, sub, prefix) => {
          const withPhone = pinWeaknessReason(pin, `${prefix}${sub}`);
          const without = pinWeaknessReason(pin, null);
          if (without !== null) {
            expect(withPhone).toBe(without);
          } else {
            const inNumber = [...windows(`0${sub}`), ...windows(`251${sub}`)].includes(pin);
            expect(withPhone === 'phone').toBe(inNumber);
            expect(withPhone === null).toBe(!inNumber);
          }
        },
      ),
    );
  });

  it('property: no four digits in a row of the number are ever accepted', () => {
    fc.assert(
      fc.property(subscriber, fc.integer({ min: 0, max: 6 }), (sub, at) => {
        const pin = `0${sub}`.slice(at, at + 4);
        expect(pinWeaknessReason(pin, `+251${sub}`)).not.toBeNull();
      }),
    );
  });
});
