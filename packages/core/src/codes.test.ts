import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BET_SHORT_ID_LENGTH,
  BOOKING_CODE_LENGTH,
  BOOKING_NUMBER_BYTES,
  BOOKING_NUMBER_MAX,
  BOOKING_NUMBER_MIN,
  CODE_ALPHABET,
  encodeBookingNumber,
  encodeCode,
  formatBookingCode,
  formatGameId,
  isBookingCode,
  isBookingNumber,
  isValidCode,
  normalizeCode,
  parseGameId,
} from './codes';

describe('CODE_ALPHABET', () => {
  it('has 32 distinct symbols', () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(new Set(CODE_ALPHABET).size).toBe(32);
  });

  it('excludes the confusable 0, 1, I and O', () => {
    for (const symbol of ['0', '1', 'I', 'O']) {
      expect(CODE_ALPHABET).not.toContain(symbol);
    }
  });

  it('contains only upper-case ASCII letters and digits', () => {
    expect(CODE_ALPHABET).toMatch(/^[0-9A-Z]+$/);
  });

  it('has the documented code lengths', () => {
    expect(BOOKING_CODE_LENGTH).toBe(6);
    expect(BET_SHORT_ID_LENGTH).toBe(8);
  });
});

describe('encodeCode', () => {
  it('maps each byte to CODE_ALPHABET[byte & 31]', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(encodeCode(bytes, 32)).toBe(CODE_ALPHABET);
    expect(encodeCode(Uint8Array.from([32, 63, 255, 224, 0, 31]), 6)).toBe('2ZZ22Z');
    expect(encodeCode(Uint8Array.from([0x41, 0x42, 0x43]), 3)).toBe('345');
  });

  it('uses only the first `length` bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(encodeCode(bytes, BOOKING_CODE_LENGTH)).toBe('234567');
    expect(encodeCode(bytes, 1)).toBe('2');
  });

  it('produces booking codes and bet short IDs of the configured lengths', () => {
    const bytes = new Uint8Array(16).fill(200);
    expect(encodeCode(bytes, BOOKING_CODE_LENGTH)).toHaveLength(BOOKING_CODE_LENGTH);
    expect(encodeCode(bytes, BET_SHORT_ID_LENGTH)).toHaveLength(BET_SHORT_ID_LENGTH);
  });

  it('maps every symbol from exactly 8 of the 256 byte values (no modulo bias)', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const counts = new Map<string, number>();
    for (const symbol of encodeCode(all, 256)) {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
  });

  it('throws RangeError when too few bytes are supplied', () => {
    expect(() => encodeCode(new Uint8Array(5), 6)).toThrow(RangeError);
    expect(() => encodeCode(new Uint8Array(0), 1)).toThrow(RangeError);
  });

  it('throws RangeError for a length below 1 or not an integer', () => {
    const bytes = new Uint8Array(8);
    expect(() => encodeCode(bytes, 0)).toThrow(RangeError);
    expect(() => encodeCode(bytes, -1)).toThrow(RangeError);
    expect(() => encodeCode(bytes, 1.5)).toThrow(RangeError);
    expect(() => encodeCode(bytes, Number.NaN)).toThrow(RangeError);
    expect(() => encodeCode(bytes, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('always produces a valid code of the requested length', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 32 })
          .chain((length) =>
            fc.tuple(fc.constant(length), fc.uint8Array({ minLength: length, maxLength: 64 })),
          ),
        ([length, bytes]) => {
          const code = encodeCode(bytes, length);
          return code.length === length && isValidCode(code) && isValidCode(code, length);
        },
      ),
    );
  });

  it('is injective on the low five bits of each byte', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 8, maxLength: 8 }),
        fc.uint8Array({ minLength: 8, maxLength: 8 }),
        (a, b) => {
          const sameLowBits = a.every((byte, i) => (byte & 31) === ((b[i] ?? 0) & 31));
          return (encodeCode(a, 8) === encodeCode(b, 8)) === sameLowBits;
        },
      ),
    );
  });
});

describe('normalizeCode', () => {
  it('trims, upper-cases and removes spaces and dashes', () => {
    expect(normalizeCode('  ab-cd ef ')).toBe('ABCDEF');
    expect(normalizeCode('k7m-x9p')).toBe('K7MX9P');
    expect(normalizeCode('K7M X9P')).toBe('K7MX9P');
    expect(normalizeCode('\tk7m x9p\n')).toBe('K7MX9P');
    expect(normalizeCode('K7M–X9P')).toBe('K7MX9P'); // en dash, as chat apps autocorrect
    expect(normalizeCode('K7M—X9P')).toBe('K7MX9P'); // em dash
  });

  it('leaves other characters alone', () => {
    expect(normalizeCode('a.b_c/0')).toBe('A.B_C/0');
    expect(normalizeCode('')).toBe('');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: 'binary' }),
          fc.string({ unit: 'grapheme' }),
          fc.stringMatching(/^[ a-zA-Z0-9\-–]{0,16}$/),
        ),
        (input) => normalizeCode(normalizeCode(input)) === normalizeCode(input),
      ),
    );
  });

  it('is idempotent when removing a dash joins lone surrogates', () => {
    const input = '\uD801-\uDC28';
    expect(normalizeCode(normalizeCode(input))).toBe(normalizeCode(input));
  });
});

describe('isValidCode', () => {
  it('accepts codes made of alphabet symbols', () => {
    expect(isValidCode('K7MX9P')).toBe(true);
    expect(isValidCode(CODE_ALPHABET)).toBe(true);
    expect(isValidCode('2')).toBe(true);
  });

  it('accepts lower case, spaces and dashes via normalizeCode', () => {
    expect(isValidCode('k7m-x9p')).toBe(true);
    expect(isValidCode(' k7m x9p ', BOOKING_CODE_LENGTH)).toBe(true);
  });

  it('rejects confusable and non-alphabet characters', () => {
    expect(isValidCode('K7MX90')).toBe(false);
    expect(isValidCode('K7MX91')).toBe(false);
    expect(isValidCode('K7MX9I')).toBe(false);
    expect(isValidCode('K7MX9O')).toBe(false);
    expect(isValidCode('k7mx9o')).toBe(false);
    expect(isValidCode('K7M.X9P')).toBe(false);
    expect(isValidCode('K7M_X9P')).toBe(false);
    expect(isValidCode('K7MÄX9P')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isValidCode('')).toBe(false);
    expect(isValidCode('   ')).toBe(false);
    expect(isValidCode('- -')).toBe(false);
  });

  it('checks the exact length when one is given', () => {
    expect(isValidCode('K7MX9P', 6)).toBe(true);
    expect(isValidCode('K7MX9P', 8)).toBe(false);
    expect(isValidCode('K7MX9', 6)).toBe(false);
    expect(isValidCode('K7MX9PQ', 6)).toBe(false);
    expect(isValidCode('K7M-X9P', 6)).toBe(true);
    expect(isValidCode('ABCD2345', BET_SHORT_ID_LENGTH)).toBe(true);
  });

  it('returns false for non-string input', () => {
    expect(isValidCode(undefined as unknown as string)).toBe(false);
    expect(isValidCode(123456 as unknown as string)).toBe(false);
  });

  it('accepts any code re-typed in lower case with spaces and dashes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 6, maxLength: 6 }),
        fc.constantFrom('', ' ', '-', ' - '),
        (bytes, separator) => {
          const code = encodeCode(bytes, BOOKING_CODE_LENGTH);
          const retyped = ` ${code.slice(0, 3).toLowerCase()}${separator}${code.slice(3)} `;
          return isValidCode(retyped, BOOKING_CODE_LENGTH) && normalizeCode(retyped) === code;
        },
      ),
    );
  });

  it('only accepts strings that normalise to alphabet symbols', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const code = normalizeCode(input);
        const expected = code.length > 0 && [...code].every((c) => CODE_ALPHABET.includes(c));
        return isValidCode(input) === expected;
      }),
    );
  });
});

describe('formatGameId', () => {
  it('pads to at least four digits', () => {
    expect(formatGameId(100)).toBe('0100');
    expect(formatGameId(123)).toBe('0123');
    expect(formatGameId(999)).toBe('0999');
    expect(formatGameId(1000)).toBe('1000');
    expect(formatGameId(4567)).toBe('4567');
    expect(formatGameId(98765)).toBe('98765');
    expect(formatGameId(999_999)).toBe('999999');
  });

  it.each([0, 1, 99, -123, 1_000_000, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError for %d',
    (gameId) => {
      expect(() => formatGameId(gameId)).toThrow(RangeError);
    },
  );

  it('always produces 4–6 ASCII digits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 999_999 }), (gameId) =>
        /^\d{4,6}$/.test(formatGameId(gameId)),
      ),
    );
  });
});

describe('parseGameId', () => {
  it('parses padded and unpadded IDs', () => {
    expect(parseGameId('0123')).toBe(123);
    expect(parseGameId('123')).toBe(123);
    expect(parseGameId(' 4567 ')).toBe(4567);
    expect(parseGameId('\t98765\n')).toBe(98765);
    expect(parseGameId('999999')).toBe(999_999);
    expect(parseGameId('100')).toBe(100);
  });

  it.each([
    '',
    '   ',
    '12',
    '1234567',
    '0099',
    '000',
    '12a4',
    '-123',
    '+123',
    '12.3',
    '1e3',
    '1 234',
    '0x1F',
    '١٢٣٤',
    '１２３４',
  ])('returns null for %j', (input) => {
    expect(parseGameId(input)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseGameId(123 as unknown as string)).toBeNull();
  });

  it('round-trips formatGameId', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 999_999 }), (gameId) => {
        return parseGameId(formatGameId(gameId)) === gameId;
      }),
    );
  });

  it('only returns IDs that formatGameId accepts', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^ ?\d{1,7} ?$/)), (input) => {
        const gameId = parseGameId(input);
        return gameId === null || formatGameId(gameId) === String(gameId).padStart(4, '0');
      }),
    );
  });
});

describe('6-digit booking codes (owner, 21 Nov 2026)', () => {
  const bytesArb = fc.uint8Array({ minLength: BOOKING_NUMBER_BYTES, maxLength: 12 });

  it('maps the random bytes into 100000-999999', () => {
    expect(encodeBookingNumber(new Uint8Array(BOOKING_NUMBER_BYTES))).toBe('100000');
    // 2^48 - 1 = 281474976710655; mod 900000 = 110655.
    expect(encodeBookingNumber(new Uint8Array(BOOKING_NUMBER_BYTES).fill(255))).toBe('210655');
    expect(encodeBookingNumber(Uint8Array.from([0, 0, 0, 0, 3, 232]))).toBe('101000');
    expect(() => encodeBookingNumber(new Uint8Array(BOOKING_NUMBER_BYTES - 1))).toThrow(RangeError);
  });

  it('always gives a valid 6-digit code in range, read only from the first six bytes', () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const code = encodeBookingNumber(bytes);
        const n = Number(code);
        expect(code).toMatch(/^[1-9]\d{5}$/);
        expect(n >= BOOKING_NUMBER_MIN && n <= BOOKING_NUMBER_MAX).toBe(true);
        expect(isBookingNumber(code)).toBe(true);
        expect(isBookingCode(code)).toBe(true);
        expect(encodeBookingNumber(bytes.slice(0, BOOKING_NUMBER_BYTES))).toBe(code);
      }),
    );
  });

  it('accepts a number as typed or said, and older letter codes', () => {
    for (const typed of ['482913', ' 482 913 ', '482-913']) {
      expect(isBookingNumber(typed)).toBe(true);
      expect(isBookingCode(typed)).toBe(true);
    }
    for (const bad of ['082913', '48291', '4829130', '48A913', '']) {
      expect(isBookingNumber(bad)).toBe(false);
    }
    // Older codes keep loading until they expire; 0, 1, I and O were never in them.
    expect(isBookingCode('k7m x9p')).toBe(true);
    expect(isBookingNumber('K7MX9P')).toBe(false);
    expect(isBookingCode('0O1I23')).toBe(false);
  });

  it('groups a number in threes for the betslip and the ticket; an older code stays as it is', () => {
    expect(formatBookingCode('482913')).toBe('482 913');
    expect(formatBookingCode(' 482-913 ')).toBe('482 913');
    expect(formatBookingCode('k7mx9p')).toBe('K7MX9P');
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const code = encodeBookingNumber(bytes);
        expect(normalizeCode(formatBookingCode(code))).toBe(code);
      }),
    );
  });
});
