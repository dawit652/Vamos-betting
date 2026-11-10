import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../constants';
import { marketOddsPollIntervalMs } from './cadence';
import {
  CREDIT_GUARD_MODES,
  creditGuardMode,
  creditProjection,
  daysLeftInMonthUtc,
  utcMonthStart,
  type CreditGuardMode,
  type CreditStatus,
} from './credit-guard';

const base = {
  quota: 20_000,
  remaining: 15_000,
  spentLast24h: 500,
  daysLeftInMonth: 20,
  keyRefused: false,
};

describe('creditGuardMode (rules G)', () => {
  it('stays normal in an ordinary month, and with no reading yet', () => {
    expect(creditGuardMode(base)).toBe('normal');
    expect(creditGuardMode({ ...base, quota: null, remaining: null })).toBe('normal');
    // Under 20% but with a week or less left: spending the rest is the plan.
    expect(creditGuardMode({ ...base, remaining: 3_000, daysLeftInMonth: 6 })).toBe('normal');
  });

  it('goes to economy under 20% with more than 7 days left, or after a fast 24 h', () => {
    expect(creditGuardMode({ ...base, remaining: 3_999, daysLeftInMonth: 10 })).toBe('economy');
    expect(creditGuardMode({ ...base, remaining: 4_000, daysLeftInMonth: 10 })).toBe('normal');
    expect(creditGuardMode({ ...base, spentLast24h: 1_501 })).toBe('economy'); // > 7.5%
    expect(creditGuardMode({ ...base, spentLast24h: 1_500 })).toBe('normal');
  });

  it('goes to minimal under 10% and stops under 1% or when the key is refused', () => {
    expect(creditGuardMode({ ...base, remaining: 1_999 })).toBe('minimal');
    expect(creditGuardMode({ ...base, remaining: 199 })).toBe('stop');
    expect(creditGuardMode({ ...base, remaining: 0 })).toBe('stop');
    expect(creditGuardMode({ ...base, keyRefused: true })).toBe('stop');
    // The free plan's 500 credits scale the same way.
    expect(creditGuardMode({ ...base, quota: 500, remaining: 4, spentLast24h: 0 })).toBe('stop');
  });

  it('fewer credits remaining never gives a faster mode (property)', () => {
    const rank = (m: CreditGuardMode) => CREDIT_GUARD_MODES.indexOf(m);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.double({ min: 0, max: 31, noNaN: true }),
        (quota, a, b, spent, days) => {
          const [more, fewer] = [Math.max(a, b), Math.min(a, b)].map((f) => Math.floor(f * quota));
          const at = (remaining: number) =>
            creditGuardMode({
              quota,
              remaining,
              spentLast24h: spent,
              daysLeftInMonth: days,
              keyRefused: false,
            });
          expect(rank(at(fewer!))).toBeGreaterThanOrEqual(rank(at(more!)));
        },
      ),
    );
  });
});

describe('month helpers', () => {
  it('counts to the 1st of next month, UTC', () => {
    expect(utcMonthStart(new Date('2026-11-17T23:00:00Z'))).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(daysLeftInMonthUtc(new Date('2026-11-30T12:00:00Z'))).toBe(0.5);
    expect(daysLeftInMonthUtc(new Date('2026-12-01T00:00:00Z'))).toBe(31);
  });
});

describe('marketOddsPollIntervalMs (4.5)', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  const at = (h: number) => new Date(now.getTime() + h * HOUR_MS);

  it('reads more often as the next kickoff nears', () => {
    expect(marketOddsPollIntervalMs(now, at(2), 'normal')).toBe(10 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(3), 'normal')).toBe(10 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'normal')).toBe(30 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(24 * 10), 'normal')).toBe(2 * HOUR_MS);
    expect(marketOddsPollIntervalMs(now, at(24 * 20), 'normal')).toBe(6 * HOUR_MS);
    expect(marketOddsPollIntervalMs(now, null, 'normal')).toBe(6 * HOUR_MS);
  });

  it('stretches in economy, reads only near kickoffs in minimal, and never in stop', () => {
    expect(marketOddsPollIntervalMs(now, at(2), 'economy')).toBe(15 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'economy')).toBe(60 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(24 * 10), 'economy')).toBe(150 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(2), 'minimal')).toBe(30 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'minimal')).toBeNull();
    expect(marketOddsPollIntervalMs(now, null, 'minimal')).toBeNull();
    expect(marketOddsPollIntervalMs(now, at(1), 'stop')).toBeNull();
  });

  const kickoffArb = fc.option(fc.integer({ min: -2 * 3600, max: 40 * 24 * 3600 }), { nil: null });
  const modeArb = fc.constantFrom<CreditGuardMode>(...CREDIT_GUARD_MODES);
  const kick = (s: number | null) => (s === null ? null : new Date(now.getTime() + s * 1000));
  const inf = (v: number | null) => v ?? Number.POSITIVE_INFINITY;

  it('never reads more often than every 10 minutes (property)', () => {
    fc.assert(
      fc.property(kickoffArb, modeArb, (s, mode) => {
        const v = marketOddsPollIntervalMs(now, kick(s), mode);
        if (v !== null) expect(v).toBeGreaterThanOrEqual(10 * MINUTE_MS);
      }),
    );
  });

  it('never reads less often as the kickoff gets closer (property)', () => {
    fc.assert(
      fc.property(kickoffArb, kickoffArb, modeArb, (a, b, mode) => {
        const near = a === null ? b : b === null ? a : Math.min(a, b);
        const far = a === null || b === null ? null : Math.max(a, b);
        expect(inf(marketOddsPollIntervalMs(now, kick(near), mode))).toBeLessThanOrEqual(
          inf(marketOddsPollIntervalMs(now, kick(far), mode)),
        );
      }),
    );
  });

  it('a stricter mode never reads more often, and stop never reads (property)', () => {
    fc.assert(
      fc.property(kickoffArb, (s) => {
        const values = CREDIT_GUARD_MODES.map((m) =>
          inf(marketOddsPollIntervalMs(now, kick(s), m)),
        );
        for (let i = 1; i < values.length; i += 1)
          expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
        expect(marketOddsPollIntervalMs(now, kick(s), 'stop')).toBeNull();
      }),
    );
  });
});

describe('creditProjection', () => {
  // 2026-11-10 12:00 UTC: 20.5 days to the 1st.
  const at = new Date('2026-11-10T12:00:00Z');
  const status = (remaining: number | null, spentLast24h: number): CreditStatus => ({
    mode: 'normal',
    keyRefused: false,
    quota: remaining === null ? null : 20_000,
    remaining,
    spentLast24h,
    lastReadAt: remaining === null ? null : at,
  });

  it('projects the last 24 hours over the days left', () => {
    expect(creditProjection(status(5_000, 400), at)).toEqual({
      dailyRate: 400,
      projectedToReset: 8_200,
      daysUntilEmpty: 12.5,
      daysLeftInMonth: 20.5,
      overruns: true,
    });
  });

  it('fits when the remaining credits cover the rest of the month', () => {
    expect(creditProjection(status(8_200, 400), at).overruns).toBe(false);
    expect(creditProjection(status(8_199, 400), at).overruns).toBe(true);
  });

  it('never overruns without a rate or without a reading', () => {
    expect(creditProjection(status(5_000, 0), at)).toMatchObject({
      daysUntilEmpty: null,
      overruns: false,
    });
    expect(creditProjection(status(null, 400), at)).toMatchObject({
      daysUntilEmpty: null,
      overruns: false,
    });
  });

  it('overruns exactly when the credits run out before the reset (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.date({ min: new Date('2026-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }),
        (remaining, rate, now) => {
          const p = creditProjection(status(remaining, rate), now);
          expect(p.daysUntilEmpty).not.toBeNull();
          expect(p.overruns).toBe(p.daysUntilEmpty! < p.daysLeftInMonth);
        },
      ),
    );
  });
});
