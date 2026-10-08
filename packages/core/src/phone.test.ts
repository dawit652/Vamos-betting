import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatMsisdnLocal,
  isEthiopianMobile,
  maskMsisdn,
  mobileOperator,
  normalizeEthiopianMsisdn,
} from './phone';

/** Nine-digit subscriber numbers: 9XXXXXXXX (Ethio Telecom) or 7XXXXXXXX (Safaricom). */
const subscriberArb = fc
  .tuple(fc.constantFrom('9', '7'), fc.stringMatching(/^\d{8}$/))
  .map(([first, rest]) => `${first}${rest}`);

/** Nine digits whose first digit is not a mobile prefix (landlines, unallocated ranges). */
const nonMobileSubscriberArb = fc
  .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '8'), fc.stringMatching(/^\d{8}$/))
  .map(([first, rest]) => `${first}${rest}`);

const prefixArb = fc.constantFrom('', '0', '251', '+251', '00251');

/** Inserts random separators (spaces, dashes, dots, parentheses) between characters. */
function withSeparators(value: string): fc.Arbitrary<string> {
  const separatorArb = fc.stringMatching(/^[ \-.()]{0,2}$/);
  return fc
    .array(separatorArb, { minLength: value.length + 1, maxLength: value.length + 1 })
    .map((separators) =>
      separators.map((separator, i) => `${separator}${value.charAt(i)}`).join(''),
    );
}

describe('normalizeEthiopianMsisdn', () => {
  it('accepts Unicode dashes that chat apps substitute for "-" (regression)', () => {
    expect(normalizeEthiopianMsisdn('0911–234–567')).toBe('+251911234567'); // en dash
    expect(normalizeEthiopianMsisdn('0911‐234‐567')).toBe('+251911234567'); // hyphen U+2010
    expect(normalizeEthiopianMsisdn('+251‑911‑234‑567')).toBe('+251911234567'); // non-breaking hyphen
    expect(normalizeEthiopianMsisdn('0711−234−567')).toBe('+251711234567'); // minus sign
  });

  it.each([
    '0911234567',
    '911234567',
    '+251911234567',
    '251911234567',
    '00251911234567',
    '+251 (91) 123-4567',
    '+251 91 123 4567',
    '0911 234 567',
    '0911-234-567',
    '091.123.4567',
    '(091) 123 4567',
    '(+251) 911 234 567',
    '+251-911-234-567',
    '  0911234567  ',
    '\t0911 234\n567',
  ])('normalises Ethio Telecom number %j', (input) => {
    expect(normalizeEthiopianMsisdn(input)).toBe('+251911234567');
  });

  it.each([
    '0712345678',
    '712345678',
    '+251712345678',
    '251712345678',
    '00251712345678',
    '+251 (71) 234-5678',
    '0712 345 678',
  ])('normalises Safaricom number %j', (input) => {
    expect(normalizeEthiopianMsisdn(input)).toBe('+251712345678');
  });

  it.each([
    // landlines
    '0111234567',
    '+251111234567',
    '251111234567',
    '00251111234567',
    '111234567',
    '0461234567',
    '0581234567',
    // unallocated first digits
    '0811234567',
    '+251811234567',
    // wrong lengths
    '091123456',
    '09112345678',
    '91123456',
    '9112345678',
    '+25191123456',
    '+2519112345678',
    '0025191123456',
    // trunk zero after the country code is not accepted
    '+2510911234567',
    '2510911234567',
    // letters and stray symbols
    '09112345a7',
    'O911234567',
    'abcdefghij',
    '0911234567x',
    '0911/234/567',
    '0911_234_567',
    '#0911234567',
    // other country codes
    '+254711234567',
    '254711234567',
    '+1 911 234 5678',
    '+44 7911 123456',
    '00254711234567',
    // misplaced or doubled plus
    '++251911234567',
    '0911+234567',
    '251+911234567',
    '+0911234567',
    '+911234567',
    // non-ASCII digits
    '٠٩١١٢٣٤٥٦٧',
    '０９１１２３４５６７',
    // empty
    '',
    '   ',
    '--()..',
    '+',
  ])('rejects %j', (input) => {
    expect(normalizeEthiopianMsisdn(input)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(normalizeEthiopianMsisdn(911234567 as unknown as string)).toBeNull();
    expect(normalizeEthiopianMsisdn(undefined as unknown as string)).toBeNull();
    expect(normalizeEthiopianMsisdn(null as unknown as string)).toBeNull();
  });

  it('normalises every valid number in every prefix form to 13-char E.164', () => {
    fc.assert(
      fc.property(subscriberArb, prefixArb, (subscriber, prefix) => {
        const normalized = normalizeEthiopianMsisdn(`${prefix}${subscriber}`);
        expect(normalized).toBe(`+251${subscriber}`);
        expect(normalized).toHaveLength(13);
        expect(normalized?.startsWith('+2519') || normalized?.startsWith('+2517')).toBe(true);
      }),
    );
  });

  it('ignores separators anywhere in the number', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(subscriberArb, prefixArb)
          .chain(([subscriber, prefix]) =>
            withSeparators(`${prefix}${subscriber}`).map((input) => ({ subscriber, input })),
          ),
        ({ subscriber, input }) => normalizeEthiopianMsisdn(input) === `+251${subscriber}`,
      ),
    );
  });

  it('rejects numbers whose subscriber part does not start with 9 or 7', () => {
    fc.assert(
      fc.property(nonMobileSubscriberArb, prefixArb, (subscriber, prefix) => {
        return normalizeEthiopianMsisdn(`${prefix}${subscriber}`) === null;
      }),
    );
  });

  it('rejects valid numbers with a digit added or removed', () => {
    fc.assert(
      fc.property(
        subscriberArb,
        prefixArb,
        fc.boolean(),
        fc.integer({ min: 0, max: 9 }),
        (subscriber, prefix, add, digit) => {
          const mangled = add ? `${subscriber}${digit}` : subscriber.slice(0, -1);
          return normalizeEthiopianMsisdn(`${prefix}${mangled}`) === null;
        },
      ),
    );
  });

  it('is idempotent on arbitrary input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (input) => {
        const once = normalizeEthiopianMsisdn(input);
        return once === null || normalizeEthiopianMsisdn(once) === once;
      }),
    );
  });

  it('is idempotent on valid input', () => {
    fc.assert(
      fc.property(subscriberArb, prefixArb, (subscriber, prefix) => {
        const once = normalizeEthiopianMsisdn(`${prefix}${subscriber}`);
        return once !== null && normalizeEthiopianMsisdn(once) === once;
      }),
    );
  });

  it('only ever returns +2519/+2517 followed by eight digits', () => {
    // Half the inputs are valid numbers with random separators, so the format check runs
    // (random digit strings alone essentially never normalise).
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^[+0-9 \-.()]{0,20}$/),
          fc
            .tuple(subscriberArb, prefixArb)
            .chain(([subscriber, prefix]) => withSeparators(`${prefix}${subscriber}`)),
        ),
        (input) => {
          const normalized = normalizeEthiopianMsisdn(input);
          return normalized === null || /^\+251[79]\d{8}$/.test(normalized);
        },
      ),
    );
  });
});

describe('isEthiopianMobile', () => {
  it('accepts mobile numbers in any supported format', () => {
    expect(isEthiopianMobile('0911234567')).toBe(true);
    expect(isEthiopianMobile('+251 71 234 5678')).toBe(true);
    expect(isEthiopianMobile('00251911234567')).toBe(true);
  });

  it('rejects landlines, foreign numbers and junk', () => {
    expect(isEthiopianMobile('0111234567')).toBe(false);
    expect(isEthiopianMobile('+254711234567')).toBe(false);
    expect(isEthiopianMobile('hello')).toBe(false);
    expect(isEthiopianMobile('')).toBe(false);
  });

  it('agrees with normalizeEthiopianMsisdn', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.tuple(prefixArb, subscriberArb).map(([p, s]) => `${p}${s}`),
          fc.tuple(prefixArb, nonMobileSubscriberArb).map(([p, s]) => `${p}${s}`),
        ),
        (input) => isEthiopianMobile(input) === (normalizeEthiopianMsisdn(input) !== null),
      ),
    );
  });
});

describe('mobileOperator', () => {
  it('identifies Ethio Telecom (09…) numbers', () => {
    expect(mobileOperator('0911234567')).toBe('ethio_telecom');
    expect(mobileOperator('+251 94 123 4567')).toBe('ethio_telecom');
    expect(mobileOperator('251991234567')).toBe('ethio_telecom');
  });

  it('identifies Safaricom (07…) numbers', () => {
    expect(mobileOperator('0712345678')).toBe('safaricom');
    expect(mobileOperator('+251 70 000 0000')).toBe('safaricom');
    expect(mobileOperator('00251799999999')).toBe('safaricom');
  });

  it('returns null for invalid numbers', () => {
    expect(mobileOperator('0111234567')).toBeNull();
    expect(mobileOperator('+254711234567')).toBeNull();
    expect(mobileOperator('')).toBeNull();
  });

  it('follows the first subscriber digit', () => {
    fc.assert(
      fc.property(subscriberArb, prefixArb, (subscriber, prefix) => {
        const expected = subscriber.startsWith('9') ? 'ethio_telecom' : 'safaricom';
        return mobileOperator(`${prefix}${subscriber}`) === expected;
      }),
    );
  });
});

describe('maskMsisdn', () => {
  it('masks the middle of the subscriber number', () => {
    expect(maskMsisdn('+251911234567')).toBe('+251 91 *** 4567');
    expect(maskMsisdn('0911234567')).toBe('+251 91 *** 4567');
    expect(maskMsisdn('0712 345 678')).toBe('+251 71 *** 5678');
  });

  it('throws RangeError for invalid numbers', () => {
    expect(() => maskMsisdn('0111234567')).toThrow(RangeError);
    expect(() => maskMsisdn('')).toThrow(RangeError);
    expect(() => maskMsisdn('+254711234567')).toThrow(RangeError);
  });

  it('does not echo the invalid input in the error message', () => {
    expect(() => maskMsisdn('0111234567')).toThrow(/^not an Ethiopian mobile number$/);
  });

  it('keeps the prefix and last four digits and hides the rest', () => {
    fc.assert(
      fc.property(subscriberArb, prefixArb, (subscriber, prefix) => {
        const masked = maskMsisdn(`${prefix}${subscriber}`);
        expect(masked).toMatch(/^\+251 [79]\d \*\*\* \d{4}$/);
        expect(masked).toBe(`+251 ${subscriber.slice(0, 2)} *** ${subscriber.slice(5)}`);
        // A masked number must never be usable as a number again.
        expect(normalizeEthiopianMsisdn(masked)).toBeNull();
      }),
    );
  });
});

describe('formatMsisdnLocal', () => {
  it('formats as 0XXX XXX XXX', () => {
    expect(formatMsisdnLocal('+251911234567')).toBe('0911 234 567');
    expect(formatMsisdnLocal('911234567')).toBe('0911 234 567');
    expect(formatMsisdnLocal('00251712345678')).toBe('0712 345 678');
  });

  it('throws RangeError for invalid numbers', () => {
    expect(() => formatMsisdnLocal('0111234567')).toThrow(RangeError);
    expect(() => formatMsisdnLocal('not a number')).toThrow(RangeError);
    expect(() => formatMsisdnLocal('')).toThrow(RangeError);
  });

  it('round-trips through normalizeEthiopianMsisdn', () => {
    fc.assert(
      fc.property(subscriberArb, prefixArb, (subscriber, prefix) => {
        const local = formatMsisdnLocal(`${prefix}${subscriber}`);
        expect(local).toMatch(/^0[79]\d{2} \d{3} \d{3}$/);
        expect(normalizeEthiopianMsisdn(local)).toBe(`+251${subscriber}`);
      }),
    );
  });
});
