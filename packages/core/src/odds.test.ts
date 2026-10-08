import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_ODDS_MILLI,
  formatOdds,
  grossReturn,
  impliedProbability,
  isValidOddsMilli,
  oddsFromProbability,
  parseOdds,
  productOddsMilli,
} from './odds';

const oddsArb = fc.integer({ min: 1001, max: 50_000 });

describe('parseOdds / formatOdds', () => {
  it('parses decimal odds into milli', () => {
    expect(parseOdds('1.85')).toBe(1850);
    expect(parseOdds('2')).toBe(2000);
    expect(parseOdds(3.5)).toBe(3500);
    expect(parseOdds('1.855')).toBe(1855);
  });

  it('rejects invalid odds', () => {
    expect(() => parseOdds('1.0')).toThrow(RangeError);
    expect(() => parseOdds('0.5')).toThrow(RangeError);
    expect(() => parseOdds('1.8555')).toThrow(RangeError);
    expect(() => parseOdds('x')).toThrow(RangeError);
    expect(() => parseOdds('1001')).toThrow(RangeError);
  });

  it('formats with two or three decimals', () => {
    expect(formatOdds(1850)).toBe('1.85');
    expect(formatOdds(2000)).toBe('2.00');
    expect(formatOdds(1855)).toBe('1.855');
    expect(formatOdds(1005)).toBe('1.005');
    expect(formatOdds(12_500)).toBe('12.50');
  });

  it('round-trips through format and parse', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: MAX_ODDS_MILLI }),
        (odds) => parseOdds(formatOdds(odds)) === odds,
      ),
    );
  });

  it('validates the range', () => {
    expect(isValidOddsMilli(1000)).toBe(false);
    expect(isValidOddsMilli(1001)).toBe(true);
    expect(isValidOddsMilli(1850.5)).toBe(false);
    expect(isValidOddsMilli(MAX_ODDS_MILLI + 1)).toBe(false);
  });
});

describe('combined odds and returns', () => {
  it('multiplies legs', () => {
    expect(productOddsMilli([])).toBe(1000n);
    expect(productOddsMilli([1850])).toBe(1850n);
    expect(productOddsMilli([1500, 2000])).toBe(3000n);
    expect(productOddsMilli([1333, 1333, 1333])).toBe(2368n); // 2.368…
  });

  it('computes stake × odds rounded down', () => {
    expect(grossReturn(1000n, [1850])).toBe(1850n);
    expect(grossReturn(500n, [1500, 2000])).toBe(1500n);
    expect(grossReturn(1n, [1999])).toBe(1n);
    expect(grossReturn(1000n, [])).toBe(1000n);
  });

  it('is never above the exact value and within 1 santim of it', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(oddsArb, { minLength: 1, maxLength: 12 }),
        (stake, legs) => {
          const result = grossReturn(stake, legs);
          const numerator = legs.reduce((acc, o) => acc * BigInt(o), stake);
          const denominator = 1000n ** BigInt(legs.length);
          return result * denominator <= numerator && (result + 1n) * denominator > numerator;
        },
      ),
    );
  });

  it('never returns less than the stake when every leg is above 1.00', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(oddsArb, { maxLength: 10 }),
        (stake, legs) => grossReturn(stake, legs) >= stake,
      ),
    );
  });
});

describe('impliedProbability', () => {
  it('is 1 / decimal odds', () => {
    expect(impliedProbability(2000)).toBe(0.5);
    expect(impliedProbability(4000)).toBe(0.25);
    expect(impliedProbability(1000)).toBe(1);
    expect(impliedProbability(MAX_ODDS_MILLI)).toBe(0.001);
    expect(impliedProbability(1850)).toBeCloseTo(0.540_540_54, 8);
  });

  it('is in (0, 1) for valid odds and strictly decreasing in the odds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: MAX_ODDS_MILLI - 1 }),
        fc.integer({ min: 1, max: 1000 }),
        (odds, step) => {
          const p = impliedProbability(odds);
          const higher = impliedProbability(Math.min(MAX_ODDS_MILLI, odds + step));
          return p > 0 && p < 1 && higher < p && Math.abs((p * odds) / 1000 - 1) < 1e-12;
        },
      ),
    );
  });
});

describe('oddsFromProbability', () => {
  it('prices fair odds rounded down to hundredths', () => {
    expect(oddsFromProbability(0.5)).toBe(2000);
    expect(oddsFromProbability(1 / 3)).toBe(3000);
    expect(oddsFromProbability(0.5, 500)).toBe(1900); // 2 / 1.05 = 1.9047…
  });

  it('clamps to the valid range', () => {
    expect(oddsFromProbability(1)).toBe(1010);
    expect(oddsFromProbability(1e-9)).toBe(MAX_ODDS_MILLI);
    expect(() => oddsFromProbability(0)).toThrow(RangeError);
    expect(() => oddsFromProbability(1.2)).toThrow(RangeError);
  });

  it('round-trips every hundredth price through its implied probability', () => {
    // Without the float-noise epsilon 1000 / (1000 / 1510) = 1509.9999999999998 → 1.50.
    expect(oddsFromProbability(1000 / 1510)).toBe(1510);
    // Exhaustive over 1.01 … 1000.00 (99 900 prices).
    const failures: number[] = [];
    for (let h = 101; h <= MAX_ODDS_MILLI / 10; h += 1) {
      if (oddsFromProbability(impliedProbability(h * 10)) !== h * 10) failures.push(h * 10);
    }
    expect(failures).toEqual([]);
  });

  it('prices any odds back down to the hundredth from its implied probability', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1001, max: MAX_ODDS_MILLI }), (odds) => {
        const expected = Math.max(1010, Math.floor(odds / 10) * 10);
        return oddsFromProbability(impliedProbability(odds)) === expected;
      }),
    );
  });

  it('adding margin never increases the price', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.integer({ min: 0, max: 2000 }),
        (p, margin) => oddsFromProbability(p, margin) <= oddsFromProbability(p),
      ),
    );
  });
});
