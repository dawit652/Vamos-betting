import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PIN_LENGTH, pinWeaknessReason, type PinWeakness } from './pin';

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
  const out = new Map<string, PinWeakness>();
  for (const [kind, pins] of classes) for (const pin of pins) if (!out.has(pin)) out.set(pin, kind);
  return out;
})();

const digitPin = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 4, maxLength: 4 })
  .map((d) => d.join(''));
const subscriber = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 })
  .map((d) => `9${d.join('')}`);

describe('pinWeaknessReason', () => {
  it('examples of every rule', () => {
    expect(pinWeaknessReason('0000', null)).toBe('repeated');
    expect(pinWeaknessReason('7777', null)).toBe('repeated');
    for (const pin of ['1234', '9876', '7890', '8901', '9012', '0987', '1098', '2109']) {
      expect(pinWeaknessReason(pin, null), pin).toBe('sequence');
    }
  });

  it('allows the PINs players kept typing (owner, 16 Nov 2026): pairs, mirrors, years, shapes', () => {
    const allowed = [
      ...['1212', '1414', '1122', '5566', '1221', '2002', '1110', '0001', '2111', '6969'],
      ...['1940', '1984', '1990', '2000', '2016', '2026'],
      ...['2580', '1004', '1470', '1357', '2468', '1230', '5683'],
      ...['4826', '7031', '4827', '0911', '2519'],
    ];
    for (const pin of allowed) expect(pinWeaknessReason(pin, null), pin).toBeNull();
  });

  it('refuses the last four digits of the phone, in every typed form, and nothing else of it', () => {
    for (const phone of ['+251911234827', '0911234827', '251911234827', '911234827']) {
      expect(pinWeaknessReason('4827', phone), phone).toBe('phone');
      // Other digits of the number are allowed: its start as dialled (09..), as written
      // internationally (2519..), its middle.
      for (const pin of ['0911', '9112', '2348', '2519', '4828']) {
        expect(pinWeaknessReason(pin, phone), `${pin} ${phone}`).toBeNull();
      }
    }
    expect(pinWeaknessReason('4827', '+251 911 23 48 27')).toBe('phone');
    expect(pinWeaknessReason('4827', null)).toBeNull();
    expect(pinWeaknessReason('4827', '12')).toBeNull();
    // A number ending in an easy PIN keeps that PIN's reason.
    expect(pinWeaknessReason('4567', '+251911234567')).toBe('sequence');
  });

  it('matches the generated reference over all 10,000 PINs', () => {
    for (const pin of ALL_PINS) {
      expect(pinWeaknessReason(pin, null), pin).toBe(REFERENCE.get(pin) ?? null);
    }
  });

  it('refuses only 30 of the 10,000 PINs, 31 with the phone', () => {
    const refused = ALL_PINS.filter((pin) => pinWeaknessReason(pin, null) !== null).length;
    expect(refused).toBe(REFERENCE.size);
    expect(refused).toBe(30);
    const withPhone = ALL_PINS.filter((pin) => pinWeaknessReason(pin, '+251911234827') !== null);
    expect(withPhone).toHaveLength(31);
  });

  it('property: the phone rule refuses exactly the last four digits of the number', () => {
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
            const isLastFour = sub.endsWith(pin);
            expect(withPhone === 'phone').toBe(isLastFour);
            expect(withPhone === null).toBe(!isLastFour);
          }
        },
      ),
    );
  });

  it('property: the last four digits of the number are never accepted', () => {
    fc.assert(
      fc.property(subscriber, (sub) => {
        expect(pinWeaknessReason(sub.slice(-4), `+251${sub}`)).not.toBeNull();
      }),
    );
  });
});
