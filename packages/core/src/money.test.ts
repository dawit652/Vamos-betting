import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyBps,
  birr,
  floorDiv,
  formatBirr,
  mulDivFloor,
  parseBirr,
  parseSantim,
  santimToBirrString,
  sumSantim,
  toWire,
} from './money';

describe('floorDiv', () => {
  it('rounds toward negative infinity', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, -2n)).toBe(-4n);
    expect(floorDiv(-7n, -2n)).toBe(3n);
    expect(floorDiv(6n, 3n)).toBe(2n);
    expect(floorDiv(-6n, 3n)).toBe(-2n);
  });

  it('throws on division by zero', () => {
    expect(() => floorDiv(1n, 0n)).toThrow(RangeError);
  });

  it('satisfies q*b + r = a with 0 <= r < b for positive b', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt({ min: 1n, max: 10n ** 30n }), (a, b) => {
        const q = floorDiv(a, b);
        const r = a - q * b;
        return r >= 0n && r < b;
      }),
    );
  });
});

describe('parseBirr / birr', () => {
  it('parses whole and fractional birr', () => {
    expect(parseBirr('5')).toBe(500n);
    expect(parseBirr('12.5')).toBe(1250n);
    expect(parseBirr('12.50')).toBe(1250n);
    expect(parseBirr('0.05')).toBe(5n);
    expect(parseBirr(' 1,250.75 ')).toBe(125075n);
    expect(birr(5)).toBe(500n);
    expect(birr(0.1)).toBe(10n);
    expect(birr(-2.5)).toBe(-250n);
  });

  it('rejects more than two decimals, junk and negatives by default', () => {
    expect(() => parseBirr('1.005')).toThrow(RangeError);
    expect(() => parseBirr('abc')).toThrow(RangeError);
    expect(() => parseBirr('')).toThrow(RangeError);
    expect(() => parseBirr('-5')).toThrow(RangeError);
    expect(parseBirr('-5', { allowNegative: true })).toBe(-500n);
    expect(() => birr(1.005)).toThrow(RangeError);
  });

  it('accepts commas only as thousands grouping', () => {
    expect(parseBirr('1,250.75')).toBe(125075n);
    expect(parseBirr('12,345,678')).toBe(1234567800n);
    // At most 15 whole digits, with or without grouping commas.
    expect(parseBirr('100,000,000,000,000')).toBe(10n ** 16n); // 15 whole digits
    expect(parseBirr('999,999,999,999,999.99')).toBe(10n ** 17n - 1n);
    expect(() => parseBirr('1,000,000,000,000,000')).toThrow(RangeError); // 16 digits via grouping
    expect(() => parseBirr('1000000000000000')).toThrow(RangeError); // 16 digits ungrouped
    for (const bad of ['12,34', '1,5', '1,,000', ',5', '5,', '1,2345', '12,34.5']) {
      expect(() => parseBirr(bad), bad).toThrow(RangeError);
    }
    expect(() => birr(Number.NaN)).toThrow(RangeError);
  });

  it('round-trips with santimToBirrString', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (santim) => {
        return parseBirr(santimToBirrString(santim)) === santim;
      }),
    );
  });
});

describe('formatting and wire format', () => {
  it('formats with grouping and currency', () => {
    expect(santimToBirrString(125050n)).toBe('1250.50');
    expect(santimToBirrString(5n)).toBe('0.05');
    expect(santimToBirrString(-5n)).toBe('-0.05');
    expect(formatBirr(123456789n)).toBe('1,234,567.89');
    expect(formatBirr(-123456789n, { currency: true })).toBe('ETB -1,234,567.89');
    expect(formatBirr(99n, { grouping: false })).toBe('0.99');
  });

  it('round-trips the wire format', () => {
    expect(toWire(12550n)).toBe('12550');
    expect(parseSantim('12550')).toBe(12550n);
    expect(parseSantim('-1')).toBe(-1n);
    expect(() => parseSantim('12.5')).toThrow(RangeError);
    expect(() => parseSantim('1e5')).toThrow(RangeError);
  });
});

describe('arithmetic helpers', () => {
  it('applies basis points rounding down', () => {
    expect(applyBps(1000n, 2000)).toBe(200n);
    expect(applyBps(999n, 2000)).toBe(199n);
    expect(applyBps(1n, 1)).toBe(0n);
    expect(() => applyBps(100n, 1.5)).toThrow(RangeError);
  });

  it('never exceeds the exact product for non-negative inputs', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 100_000 }),
        (amount, bps) => {
          const result = applyBps(amount, bps);
          return (
            result * 10_000n <= amount * BigInt(bps) &&
            (result + 1n) * 10_000n > amount * BigInt(bps)
          );
        },
      ),
    );
  });

  it('computes mulDivFloor and sums', () => {
    expect(mulDivFloor(10n, 3n, 4n)).toBe(7n);
    expect(sumSantim([1n, 2n, 3n])).toBe(6n);
    expect(sumSantim([])).toBe(0n);
  });
});
