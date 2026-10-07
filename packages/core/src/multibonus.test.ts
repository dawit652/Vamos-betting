import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyBps, birr } from './money';
import { computeMultiBonus, multiBonusPercentBps, qualifyingLegCount } from './multibonus';
import { grossReturn } from './odds';
import { DEFAULT_MULTI_BONUS, type MultiBonusConfig } from './rules';

const config = DEFAULT_MULTI_BONUS;

const oddsArb = fc.integer({ min: 1001, max: 20_000 });
const stakeArb = fc.bigInt({ min: 1n, max: birr(100_000) });

function withConfig(overrides: Partial<MultiBonusConfig>): MultiBonusConfig {
  return { ...config, tiers: [...config.tiers], ...overrides };
}

describe('qualifyingLegCount', () => {
  it('counts legs with odds at or above the minimum', () => {
    expect(qualifyingLegCount([1300, 1299, 2000, 1010], config)).toBe(2);
    expect(qualifyingLegCount([1300, 1300, 1300], config)).toBe(3);
  });

  it('returns 0 for no legs or no qualifying legs', () => {
    expect(qualifyingLegCount([], config)).toBe(0);
    expect(qualifyingLegCount([1010, 1200, 1299], config)).toBe(0);
  });

  it('respects the configured minimum', () => {
    expect(qualifyingLegCount([1100, 1200, 1300], withConfig({ minLegOddsMilli: 1100 }))).toBe(3);
    expect(qualifyingLegCount([1100, 1200, 1300], withConfig({ minLegOddsMilli: 1250 }))).toBe(1);
  });

  it('is between 0 and the number of legs', () => {
    fc.assert(
      fc.property(fc.array(oddsArb, { maxLength: 40 }), (legs) => {
        const count = qualifyingLegCount(legs, config);
        return count >= 0 && count <= legs.length;
      }),
    );
  });
});

describe('multiBonusPercentBps', () => {
  it('is 0 below the lowest tier', () => {
    expect(multiBonusPercentBps(0, config)).toBe(0);
    expect(multiBonusPercentBps(1, config)).toBe(0);
    expect(multiBonusPercentBps(2, config)).toBe(0);
  });

  it('picks the highest reached tier', () => {
    expect(multiBonusPercentBps(3, config)).toBe(300);
    expect(multiBonusPercentBps(4, config)).toBe(500);
    expect(multiBonusPercentBps(10, config)).toBe(3_000);
    expect(multiBonusPercentBps(11, config)).toBe(3_000);
    expect(multiBonusPercentBps(12, config)).toBe(4_000);
    expect(multiBonusPercentBps(14, config)).toBe(4_000);
    expect(multiBonusPercentBps(20, config)).toBe(10_000);
    expect(multiBonusPercentBps(30, config)).toBe(20_000);
    expect(multiBonusPercentBps(40, config)).toBe(20_000);
  });

  it('is 0 when the bonus is disabled', () => {
    const disabled = withConfig({ enabled: false });
    expect(multiBonusPercentBps(3, disabled)).toBe(0);
    expect(multiBonusPercentBps(30, disabled)).toBe(0);
  });

  it('is 0 when there are no tiers', () => {
    expect(multiBonusPercentBps(10, withConfig({ tiers: [] }))).toBe(0);
  });

  it('handles unsorted tiers without mutating the config', () => {
    const tiers = Object.freeze([...config.tiers].reverse());
    const unsorted = { ...config, tiers: tiers as MultiBonusConfig['tiers'] };
    const snapshot = structuredClone(unsorted);
    expect(multiBonusPercentBps(3, unsorted)).toBe(300);
    expect(multiBonusPercentBps(13, unsorted)).toBe(4_000);
    expect(multiBonusPercentBps(2, unsorted)).toBe(0);
    expect(unsorted).toEqual(snapshot);
  });

  it('prefers the higher rate when two tiers share minLegs', () => {
    const tied = withConfig({
      tiers: [
        { minLegs: 3, percentBps: 700 },
        { minLegs: 3, percentBps: 500 },
      ],
    });
    expect(multiBonusPercentBps(3, tied)).toBe(700);
  });

  it('rejects malformed tiers', () => {
    expect(() =>
      multiBonusPercentBps(3, withConfig({ tiers: [{ minLegs: 3, percentBps: -1 }] })),
    ).toThrow(RangeError);
    expect(() =>
      multiBonusPercentBps(3, withConfig({ tiers: [{ minLegs: 3, percentBps: 2.5 }] })),
    ).toThrow(RangeError);
    expect(() =>
      multiBonusPercentBps(3, withConfig({ tiers: [{ minLegs: -1, percentBps: 100 }] })),
    ).toThrow(RangeError);
  });

  it('never decreases when one more qualifying leg is added (default ladder)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (legs) => {
        return multiBonusPercentBps(legs + 1, config) >= multiBonusPercentBps(legs, config);
      }),
    );
  });

  it('adding a qualifying leg to a slip never decreases the rate (default ladder)', () => {
    fc.assert(
      fc.property(
        fc.array(oddsArb, { maxLength: 40 }),
        fc.integer({ min: config.minLegOddsMilli, max: 20_000 }),
        (legs, extra) => {
          const before = multiBonusPercentBps(qualifyingLegCount(legs, config), config);
          const after = multiBonusPercentBps(qualifyingLegCount([...legs, extra], config), config);
          return after >= before;
        },
      ),
    );
  });

  it('does not depend on tier order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(config.tiers, {
          minLength: config.tiers.length,
          maxLength: config.tiers.length,
        }),
        fc.integer({ min: 0, max: 40 }),
        (tiers, legs) => {
          return (
            multiBonusPercentBps(legs, withConfig({ tiers })) === multiBonusPercentBps(legs, config)
          );
        },
      ),
    );
  });
});

describe('computeMultiBonus', () => {
  it('pays the tier percentage on winnings, not on stake', () => {
    const stake = birr(100);
    const legOdds = [2000, 2000, 2000];
    const gross = grossReturn(stake, legOdds); // 800 ETB
    expect(gross).toBe(birr(800));
    expect(computeMultiBonus({ stake, grossReturn: gross, legOdds, config })).toEqual({
      percentBps: 300,
      qualifyingLegs: 3,
      amount: birr(21), // 3% of 700 ETB winnings
    });
  });

  it('gives singles no bonus, whatever the ladder says', () => {
    const generous = withConfig({ tiers: [{ minLegs: 1, percentBps: 5_000 }] });
    expect(
      computeMultiBonus({
        stake: birr(10),
        grossReturn: birr(50),
        legOdds: [5000],
        config: generous,
      }),
    ).toEqual({ percentBps: 0, qualifyingLegs: 1, amount: 0n });
    expect(
      computeMultiBonus({ stake: birr(10), grossReturn: birr(10), legOdds: [], config: generous }),
    ).toEqual({ percentBps: 0, qualifyingLegs: 0, amount: 0n });
  });

  it('gives no bonus below the lowest tier or with non-qualifying legs', () => {
    const stake = birr(100);
    const twoLegs = [2000, 2000];
    expect(
      computeMultiBonus({
        stake,
        grossReturn: grossReturn(stake, twoLegs),
        legOdds: twoLegs,
        config,
      }),
    ).toEqual({ percentBps: 0, qualifyingLegs: 2, amount: 0n });

    const lowOdds = [2000, 2000, 1200];
    expect(
      computeMultiBonus({
        stake,
        grossReturn: grossReturn(stake, lowOdds),
        legOdds: lowOdds,
        config,
      }),
    ).toEqual({ percentBps: 0, qualifyingLegs: 2, amount: 0n });
  });

  it('gives no bonus when disabled', () => {
    const legOdds = [2000, 2000, 2000, 2000, 2000];
    const result = computeMultiBonus({
      stake: birr(100),
      grossReturn: grossReturn(birr(100), legOdds),
      legOdds,
      config: withConfig({ enabled: false }),
    });
    expect(result).toEqual({ percentBps: 0, qualifyingLegs: 5, amount: 0n });
  });

  it('rounds the bonus down', () => {
    const stake = 333n;
    const legOdds = [1500, 1500, 1500];
    const gross = grossReturn(stake, legOdds);
    expect(gross).toBe(1123n); // floor(333 × 3.375)
    // 3% of 790 = 23.7 → 23
    expect(computeMultiBonus({ stake, grossReturn: gross, legOdds, config }).amount).toBe(23n);
    // 3% of 1 santim rounds to 0
    expect(
      computeMultiBonus({ stake: 1n, grossReturn: 2n, legOdds: [1300, 1300, 1300], config }).amount,
    ).toBe(0n);
  });

  it('caps the bonus at maxBonus', () => {
    const stake = birr(100_000);
    const legOdds = Array.from({ length: 30 }, () => 3000);
    const result = computeMultiBonus({
      stake,
      grossReturn: grossReturn(stake, legOdds),
      legOdds,
      config,
    });
    expect(result.percentBps).toBe(20_000);
    expect(result.amount).toBe(config.maxBonus);
    expect(result.amount).toBe(birr(50_000));
  });

  it('gives no bonus when there are no winnings', () => {
    const legOdds = [2000, 2000, 2000];
    expect(
      computeMultiBonus({ stake: birr(100), grossReturn: birr(100), legOdds, config }).amount,
    ).toBe(0n);
    expect(
      computeMultiBonus({ stake: birr(100), grossReturn: birr(50), legOdds, config }).amount,
    ).toBe(0n);
  });

  it('rejects a negative maxBonus', () => {
    const legOdds = [2000, 2000, 2000];
    expect(() =>
      computeMultiBonus({
        stake: birr(100),
        grossReturn: birr(800),
        legOdds,
        config: withConfig({ maxBonus: -1n }),
      }),
    ).toThrow(RangeError);
  });

  it('stays within [0, maxBonus] and never exceeds the rate applied to winnings', () => {
    fc.assert(
      fc.property(
        stakeArb,
        fc.array(oddsArb, { maxLength: 40 }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        fc.boolean(),
        (stake, legOdds, maxBonus, enabled) => {
          const cfg = withConfig({ maxBonus, enabled });
          const gross = grossReturn(stake, legOdds);
          const result = computeMultiBonus({ stake, grossReturn: gross, legOdds, config: cfg });
          const winnings = gross > stake ? gross - stake : 0n;
          return (
            result.amount >= 0n &&
            result.amount <= maxBonus &&
            result.amount <= applyBps(winnings, result.percentBps) &&
            result.qualifyingLegs === qualifyingLegCount(legOdds, cfg) &&
            (legOdds.length >= 2 || result.amount === 0n)
          );
        },
      ),
    );
  });
});
