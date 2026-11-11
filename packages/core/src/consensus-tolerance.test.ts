import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  consensusDeviation,
  OPEN_TOLERANCE_BPS,
  withinConsensusTolerance,
} from './consensus-tolerance';

describe('consensus tolerance', () => {
  it('the default tolerance is 3%', () => {
    expect(OPEN_TOLERANCE_BPS).toBe(300);
  });

  it('a price made from the consensus with our margin has no deviation', () => {
    const exact = 1000 / (0.5 * 1.06);
    expect(consensusDeviation({ oddsMilli: exact, probability: 0.5, marginBps: 600 })).toBeCloseTo(
      0,
      9,
    );
    expect(withinConsensusTolerance({ oddsMilli: 1887, probability: 0.5, marginBps: 600 })).toBe(
      true,
    );
  });

  it('accepts about 1.83 to 1.94 around a fair 2.00 at 6% margin and 3%', () => {
    const base = { probability: 0.5, marginBps: 600 };
    expect(withinConsensusTolerance({ ...base, oddsMilli: 1835 })).toBe(true);
    expect(withinConsensusTolerance({ ...base, oddsMilli: 1940 })).toBe(true);
    expect(withinConsensusTolerance({ ...base, oddsMilli: 1825 })).toBe(false);
    expect(withinConsensusTolerance({ ...base, oddsMilli: 1950 })).toBe(false);
    // No margin at all is too generous for a 6% book.
    expect(withinConsensusTolerance({ ...base, oddsMilli: 2000 })).toBe(false);
  });

  it('the boundary belongs to the tolerance', () => {
    const p = 0.4;
    const odds = 1000 / (p * 1.06 * 1.03);
    expect(withinConsensusTolerance({ oddsMilli: odds, probability: p, marginBps: 600 })).toBe(
      true,
    );
    expect(
      withinConsensusTolerance({ oddsMilli: odds * 0.999, probability: p, marginBps: 600 }),
    ).toBe(false);
  });

  it('refuses unusable inputs', () => {
    const ok = { oddsMilli: 1900, probability: 0.5, marginBps: 600 };
    for (const bad of [
      { oddsMilli: 0 },
      { oddsMilli: Number.NaN },
      { probability: 0 },
      { probability: 1 },
      { probability: Number.NaN },
      { marginBps: -1 },
      { toleranceBps: -1 },
      { toleranceBps: Number.NaN },
    ]) {
      expect(withinConsensusTolerance({ ...ok, ...bad })).toBe(false);
    }
  });
});

const prob = fc.double({ min: 0.02, max: 0.95, noNaN: true });
const margin = fc.integer({ min: 0, max: 2000 });
const tol = fc.integer({ min: 0, max: 2000 });
const odds = fc.double({ min: 1010, max: 50_000, noNaN: true });

describe('consensus tolerance (properties)', () => {
  it('a price at the exact margin-adjusted consensus is always within, at any tolerance', () => {
    fc.assert(
      fc.property(prob, margin, tol, (probability, marginBps, toleranceBps) => {
        const oddsMilli = 1000 / (probability * (1 + marginBps / 10_000));
        expect(withinConsensusTolerance({ oddsMilli, probability, marginBps, toleranceBps })).toBe(
          true,
        );
      }),
    );
  });

  it('is monotone in the tolerance: within at t implies within at any larger t', () => {
    fc.assert(
      fc.property(
        odds,
        prob,
        margin,
        tol,
        fc.integer({ min: 0, max: 500 }),
        (oddsMilli, probability, marginBps, toleranceBps, extra) => {
          const small = withinConsensusTolerance({
            oddsMilli,
            probability,
            marginBps,
            toleranceBps,
          });
          const large = withinConsensusTolerance({
            oddsMilli,
            probability,
            marginBps,
            toleranceBps: toleranceBps + extra,
          });
          expect(!small || large).toBe(true);
        },
      ),
    );
  });

  it('is equivalent to the odds interval fair/(1+m)/(1±tol)', () => {
    fc.assert(
      fc.property(
        odds,
        prob,
        margin,
        fc.integer({ min: 0, max: 1500 }),
        (oddsMilli, probability, marginBps, toleranceBps) => {
          const centre = 1000 / probability / (1 + marginBps / 10_000);
          const lo = centre / (1 + toleranceBps / 10_000);
          const hi = centre / (1 - toleranceBps / 10_000);
          const eps = centre * 1e-9;
          const got = withinConsensusTolerance({ oddsMilli, probability, marginBps, toleranceBps });
          if (oddsMilli > lo + eps && oddsMilli < hi - eps) expect(got).toBe(true);
          if (oddsMilli < lo - eps || oddsMilli > hi + eps) expect(got).toBe(false);
        },
      ),
    );
  });

  it('shorter odds never have a lower deviation than longer ones', () => {
    fc.assert(
      fc.property(
        odds,
        fc.double({ min: 1.001, max: 3, noNaN: true }),
        prob,
        margin,
        (oddsMilli, factor, probability, marginBps) => {
          const short = consensusDeviation({ oddsMilli, probability, marginBps });
          const long = consensusDeviation({
            oddsMilli: oddsMilli * factor,
            probability,
            marginBps,
          });
          expect(short).toBeGreaterThanOrEqual(long);
        },
      ),
    );
  });
});
