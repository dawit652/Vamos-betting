import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyBps, birr } from './money';
import { DEFAULT_TAX, type TaxConfig } from './rules';
import { computeWinningsTax } from './tax';

const netConfig = DEFAULT_TAX; // 20% on net winnings, exempt below 100 ETB
const grossConfig: TaxConfig = { ...DEFAULT_TAX, base: 'gross_payout' };

const taxConfigArb: fc.Arbitrary<TaxConfig> = fc.record({
  rateBps: fc.integer({ min: 0, max: 10_000 }),
  base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
  exemptBelow: fc.bigInt({ min: 0n, max: birr(10_000) }),
});

describe('computeWinningsTax – net winnings base', () => {
  it('taxes the winnings at the configured rate', () => {
    expect(
      computeWinningsTax({ stake: birr(10), grossPayout: birr(1_000), config: netConfig }),
    ).toEqual({ base: birr(990), amount: birr(198) });
  });

  it('exempts winnings strictly below the threshold', () => {
    expect(computeWinningsTax({ stake: 1_000n, grossPayout: 10_999n, config: netConfig })).toEqual({
      base: 9_999n,
      amount: 0n,
    });
  });

  it('taxes winnings exactly at the threshold', () => {
    expect(computeWinningsTax({ stake: 1_000n, grossPayout: 11_000n, config: netConfig })).toEqual({
      base: 10_000n,
      amount: 2_000n,
    });
  });

  it('rounds the tax down', () => {
    // 20% of 10 003 santim = 2000.6 → 2000
    expect(computeWinningsTax({ stake: 1n, grossPayout: 10_004n, config: netConfig }).amount).toBe(
      2_000n,
    );
  });

  it('charges nothing on a lost bet, a refund or a payout below the stake', () => {
    expect(computeWinningsTax({ stake: birr(50), grossPayout: 0n, config: netConfig })).toEqual({
      base: 0n,
      amount: 0n,
    });
    expect(
      computeWinningsTax({ stake: birr(500), grossPayout: birr(500), config: netConfig }),
    ).toEqual({ base: 0n, amount: 0n });
    expect(
      computeWinningsTax({ stake: birr(500), grossPayout: birr(400), config: netConfig }),
    ).toEqual({ base: 0n, amount: 0n });
  });

  it('supports 0% and 100% rates', () => {
    const args = { stake: birr(10), grossPayout: birr(1_000) };
    expect(computeWinningsTax({ ...args, config: { ...netConfig, rateBps: 0 } }).amount).toBe(0n);
    expect(computeWinningsTax({ ...args, config: { ...netConfig, rateBps: 10_000 } }).amount).toBe(
      birr(990),
    );
  });
});

describe('computeWinningsTax – gross payout base', () => {
  it('applies the rate to the whole payout', () => {
    expect(
      computeWinningsTax({ stake: birr(10), grossPayout: birr(1_000), config: grossConfig }),
    ).toEqual({ base: birr(1_000), amount: birr(200) });
  });

  it('never takes more than the winnings', () => {
    // 20% of 120 ETB = 24 ETB, but the winnings are only 20 ETB.
    expect(
      computeWinningsTax({ stake: birr(100), grossPayout: birr(120), config: grossConfig }),
    ).toEqual({ base: birr(120), amount: birr(20) });
  });

  it('applies the exemption to the gross payout', () => {
    expect(
      computeWinningsTax({ stake: birr(10), grossPayout: birr(99.99), config: grossConfig }),
    ).toEqual({ base: birr(99.99), amount: 0n });
    expect(
      computeWinningsTax({ stake: birr(10), grossPayout: birr(100), config: grossConfig }),
    ).toEqual({ base: birr(100), amount: birr(20) });
  });

  it('charges nothing without winnings even when the payout is above the threshold', () => {
    expect(
      computeWinningsTax({ stake: birr(500), grossPayout: birr(500), config: grossConfig }),
    ).toEqual({ base: birr(500), amount: 0n });
  });
});

describe('computeWinningsTax – validation', () => {
  it('rejects rates outside 0..10000 or non-integer rates', () => {
    for (const rateBps of [-1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeWinningsTax({ stake: 1n, grossPayout: 2n, config: { ...netConfig, rateBps } }),
      ).toThrow(RangeError);
    }
  });

  it('rejects an unknown base', () => {
    const config = { ...netConfig, base: 'stake' } as unknown as TaxConfig;
    expect(() => computeWinningsTax({ stake: 1n, grossPayout: 2n, config })).toThrow(RangeError);
  });
});

describe('computeWinningsTax – properties', () => {
  const stakeArb = fc.bigInt({ min: 0n, max: birr(100_000) });
  const payoutArb = fc.bigInt({ min: 0n, max: birr(10_000_000) });

  it('never exceeds the winnings and is never negative', () => {
    fc.assert(
      fc.property(stakeArb, payoutArb, taxConfigArb, (stake, grossPayout, config) => {
        const { amount } = computeWinningsTax({ stake, grossPayout, config });
        const winnings = grossPayout > stake ? grossPayout - stake : 0n;
        return amount >= 0n && amount <= winnings;
      }),
    );
  });

  it('a winning bet always pays back at least its stake', () => {
    fc.assert(
      fc.property(stakeArb, payoutArb, taxConfigArb, (stake, grossPayout, config) => {
        fc.pre(grossPayout >= stake);
        const { amount } = computeWinningsTax({ stake, grossPayout, config });
        return grossPayout - amount >= stake;
      }),
    );
  });

  it('equals floor(rate × winnings) for net winnings above the threshold', () => {
    fc.assert(
      fc.property(stakeArb, payoutArb, taxConfigArb, (stake, grossPayout, cfg) => {
        const config: TaxConfig = { ...cfg, base: 'net_winnings' };
        const winnings = grossPayout > stake ? grossPayout - stake : 0n;
        const { base, amount } = computeWinningsTax({ stake, grossPayout, config });
        const expected =
          winnings === 0n || winnings < config.exemptBelow
            ? 0n
            : applyBps(winnings, config.rateBps);
        return base === winnings && amount === expected;
      }),
    );
  });

  it('never decreases when the rate goes up', () => {
    fc.assert(
      fc.property(
        stakeArb,
        payoutArb,
        taxConfigArb,
        fc.integer({ min: 0, max: 10_000 }),
        (stake, grossPayout, config, otherRate) => {
          const low = Math.min(config.rateBps, otherRate);
          const high = Math.max(config.rateBps, otherRate);
          const a = computeWinningsTax({ stake, grossPayout, config: { ...config, rateBps: low } });
          const b = computeWinningsTax({
            stake,
            grossPayout,
            config: { ...config, rateBps: high },
          });
          return a.amount <= b.amount;
        },
      ),
    );
  });
});
