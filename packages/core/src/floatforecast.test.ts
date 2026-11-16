import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOAT_FORECAST_RULES,
  floatIsLow,
  forecastPayoutFloat,
  type FloatForecastRules,
  type OpenBetExposure,
} from './floatforecast';

const NOW = new Date('2026-11-16T12:00:00Z');
const HOUR = 3_600_000;
const rules: FloatForecastRules = {
  eventDurationMs: 2 * HOUR,
  horizonMs: 6 * HOUR,
  withdrawnShareBps: 5000,
};
const bet = (payout: bigint, startHoursFromNow: number): OpenBetExposure => ({
  potentialNetPayout: payout,
  lastEventStart: new Date(NOW.getTime() + startHoursFromNow * HOUR),
});

describe('forecastPayoutFloat', () => {
  it('is zero with no open bets', () => {
    expect(forecastPayoutFloat([], NOW, rules)).toEqual({
      expectedWithdrawals: 0n,
      betsCounted: 0,
      possiblePayouts: 0n,
    });
  });

  it('takes the share of the possible payouts of bets that end within the horizon', () => {
    const out = forecastPayoutFloat([bet(10_000n, 1), bet(30_000n, -1)], NOW, rules);
    expect(out).toEqual({ expectedWithdrawals: 20_000n, betsCounted: 2, possiblePayouts: 40_000n });
  });

  it('counts a bet whose events ended but is not settled yet', () => {
    expect(forecastPayoutFloat([bet(1000n, -10)], NOW, rules).betsCounted).toBe(1);
  });

  it('leaves out bets that end after the horizon (start + duration > now + horizon)', () => {
    expect(forecastPayoutFloat([bet(1000n, 4)], NOW, rules).betsCounted).toBe(1); // ends at +6h
    expect(forecastPayoutFloat([bet(1000n, 4.01)], NOW, rules).betsCounted).toBe(0);
  });

  it('rounds down to a whole santim', () => {
    const out = forecastPayoutFloat([bet(3n, 0)], NOW, { ...rules, withdrawnShareBps: 3333 });
    expect(out.expectedWithdrawals).toBe(0n); // 3 * 0.3333 = 0.9999
    expect(
      forecastPayoutFloat([bet(10_001n, 0)], NOW, { ...rules, withdrawnShareBps: 3333 })
        .expectedWithdrawals,
    ).toBe(3333n);
  });

  it('clamps a share outside 0..10000', () => {
    expect(
      forecastPayoutFloat([bet(100n, 0)], NOW, { ...rules, withdrawnShareBps: 99_999 })
        .expectedWithdrawals,
    ).toBe(100n);
    expect(
      forecastPayoutFloat([bet(100n, 0)], NOW, { ...rules, withdrawnShareBps: -5 })
        .expectedWithdrawals,
    ).toBe(0n);
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_FLOAT_FORECAST_RULES.withdrawnShareBps).toBe(2000);
    expect(forecastPayoutFloat([bet(10_000n, 0)], NOW).expectedWithdrawals).toBe(2000n);
  });
});

describe('floatIsLow', () => {
  const forecast = forecastPayoutFloat([bet(10_000n, 0)], NOW, rules);
  it('is low only when the balance is below a positive forecast', () => {
    expect(floatIsLow(4999n, forecast)).toBe(true);
    expect(floatIsLow(5000n, forecast)).toBe(false);
    expect(floatIsLow(0n, forecastPayoutFloat([], NOW, rules))).toBe(false);
  });
});

const betArb = fc.record({
  potentialNetPayout: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  lastEventStart: fc
    .integer({ min: -48 * HOUR, max: 48 * HOUR })
    .map((offset) => new Date(NOW.getTime() + offset)),
});
const betsArb = fc.array(betArb, { maxLength: 30 });
const ruleArb = fc.record({
  eventDurationMs: fc.integer({ min: 0, max: 5 * HOUR }),
  horizonMs: fc.integer({ min: 0, max: 24 * HOUR }),
  withdrawnShareBps: fc.integer({ min: 0, max: 10_000 }),
});

describe('forecastPayoutFloat properties', () => {
  it('is never negative and never above the possible payouts', () => {
    fc.assert(
      fc.property(betsArb, ruleArb, (bets, r) => {
        const out = forecastPayoutFloat(bets, NOW, r);
        expect(out.expectedWithdrawals >= 0n).toBe(true);
        expect(out.expectedWithdrawals <= out.possiblePayouts).toBe(true);
      }),
    );
  });

  it('is monotone in the share assumed withdrawn', () => {
    fc.assert(
      fc.property(betsArb, ruleArb, fc.integer({ min: 0, max: 10_000 }), (bets, r, other) => {
        const low = Math.min(r.withdrawnShareBps, other);
        const high = Math.max(r.withdrawnShareBps, other);
        const a = forecastPayoutFloat(bets, NOW, { ...r, withdrawnShareBps: low });
        const b = forecastPayoutFloat(bets, NOW, { ...r, withdrawnShareBps: high });
        expect(a.expectedWithdrawals <= b.expectedWithdrawals).toBe(true);
      }),
    );
  });

  it('is monotone in the horizon and the number of bets', () => {
    fc.assert(
      fc.property(
        betsArb,
        betArb,
        ruleArb,
        fc.integer({ min: 0, max: 12 * HOUR }),
        (bets, extra, r, more) => {
          const base = forecastPayoutFloat(bets, NOW, r).expectedWithdrawals;
          const wider = forecastPayoutFloat(bets, NOW, { ...r, horizonMs: r.horizonMs + more });
          expect(wider.expectedWithdrawals >= base).toBe(true);
          const plus = forecastPayoutFloat([...bets, extra], NOW, r).expectedWithdrawals;
          expect(plus >= base).toBe(true);
        },
      ),
    );
  });

  it('is zero without bets or with a zero share, and the order of bets does not matter', () => {
    fc.assert(
      fc.property(betsArb, ruleArb, (bets, r) => {
        expect(forecastPayoutFloat([], NOW, r).expectedWithdrawals).toBe(0n);
        expect(
          forecastPayoutFloat(bets, NOW, { ...r, withdrawnShareBps: 0 }).expectedWithdrawals,
        ).toBe(0n);
        expect(forecastPayoutFloat([...bets].reverse(), NOW, r)).toEqual(
          forecastPayoutFloat(bets, NOW, r),
        );
      }),
    );
  });
});
