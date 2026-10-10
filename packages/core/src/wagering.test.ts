import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { birr } from './money';
import { DEFAULT_PAYMENT_RULES } from './rules';
import {
  applyWageringEvent,
  remainingWagering,
  wageringRequirementOf,
  type WageringEvent,
} from './wagering';

const fund = (amount: bigint): WageringEvent => ({ kind: 'funding', amount });
const stake = (amount: bigint): WageringEvent => ({ kind: 'stake', amount });

const amountArb = fc.bigInt({ min: 0n, max: 10_000_000_00n });
const eventArb: fc.Arbitrary<WageringEvent> = fc.oneof(amountArb.map(fund), amountArb.map(stake));
const multiplierArb = fc.integer({ min: 0, max: 100_000 });

describe('wageringRequirementOf', () => {
  it('is the amount itself at 1x and rounds up otherwise', () => {
    expect(wageringRequirementOf(birr(100), 10_000)).toBe(birr(100));
    expect(wageringRequirementOf(birr(100), 15_000)).toBe(birr(150));
    expect(wageringRequirementOf(1n, 5_000)).toBe(1n); // 0.5 santim -> 1
    expect(wageringRequirementOf(3n, 3_333)).toBe(1n); // 0.9999 -> 1
    expect(wageringRequirementOf(birr(100), 0)).toBe(0n);
  });

  it('rejects negative amounts and invalid multipliers', () => {
    expect(() => wageringRequirementOf(-1n, 10_000)).toThrow(RangeError);
    expect(() => wageringRequirementOf(1n, -1)).toThrow(RangeError);
    expect(() => wageringRequirementOf(1n, 1.5)).toThrow(RangeError);
  });

  it('is the exact ceiling of amount x bps / 10000', () => {
    fc.assert(
      fc.property(amountArb, multiplierArb, (amount, bps) => {
        const req = wageringRequirementOf(amount, bps);
        const exact = amount * BigInt(bps);
        // req is the smallest integer with req * 10000 >= amount * bps.
        expect(req * 10_000n >= exact).toBe(true);
        expect(req === 0n || (req - 1n) * 10_000n < exact).toBe(true);
      }),
    );
  });
});

describe('remainingWagering', () => {
  it('is zero with no history', () => {
    expect(remainingWagering([], 10_000)).toBe(0n);
  });

  it('requires each deposit to be staked once at the default multiplier', () => {
    const bps = DEFAULT_PAYMENT_RULES.wageringMultiplierBps;
    expect(remainingWagering([fund(birr(100))], bps)).toBe(birr(100));
    expect(remainingWagering([fund(birr(100)), stake(birr(60))], bps)).toBe(birr(40));
    expect(remainingWagering([fund(birr(100)), stake(birr(60)), stake(birr(40))], bps)).toBe(0n);
  });

  it('does not let turnover from before a deposit pre-pay it', () => {
    const events = [fund(birr(100)), stake(birr(500)), fund(birr(200))];
    expect(remainingWagering(events, 10_000)).toBe(birr(200));
  });

  it('carries unmet requirements across deposits', () => {
    const events = [fund(birr(100)), stake(birr(30)), fund(birr(50)), stake(birr(100))];
    expect(remainingWagering(events, 10_000)).toBe(birr(20));
  });

  it('never goes negative and stakes never raise it', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), multiplierArb, (events, bps) => {
        let remaining = 0n;
        for (const event of events) {
          const next = applyWageringEvent(remaining, event, bps);
          expect(next >= 0n).toBe(true);
          if (event.kind === 'stake') {
            expect(next <= remaining).toBe(true);
            expect(next).toBe(remaining > event.amount ? remaining - event.amount : 0n);
          } else {
            expect(next - remaining).toBe(wageringRequirementOf(event.amount, bps));
          }
          remaining = next;
        }
        expect(remainingWagering(events, bps)).toBe(remaining);
      }),
    );
  });

  it('equals max(0, total requirement - total stakes) when every stake follows every deposit', () => {
    fc.assert(
      fc.property(
        fc.array(amountArb, { maxLength: 10 }),
        fc.array(amountArb, { maxLength: 10 }),
        multiplierArb,
        (fundings, stakes, bps) => {
          const required = fundings.reduce((sum, f) => sum + wageringRequirementOf(f, bps), 0n);
          const staked = stakes.reduce((sum, s) => sum + s, 0n);
          const expected = required > staked ? required - staked : 0n;
          expect(remainingWagering([...fundings.map(fund), ...stakes.map(stake)], bps)).toBe(
            expected,
          );
        },
      ),
    );
  });

  it('is at least the requirement of the last deposit minus the stakes after it', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 20 }),
        amountArb,
        fc.array(amountArb, { maxLength: 10 }),
        multiplierArb,
        (before, last, after, bps) => {
          const remaining = remainingWagering([...before, fund(last), ...after.map(stake)], bps);
          const lower = wageringRequirementOf(last, bps) - after.reduce((s, a) => s + a, 0n);
          expect(remaining >= lower).toBe(true);
        },
      ),
    );
  });

  it('when met, implies the plain rule from every deposit on: staked since >= required since', () => {
    // In particular from the first deposit: total staked since the first
    // deposit >= total deposited x multiplier. The running rule is stricter
    // only in that stakes never count towards a deposit made after them.
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), multiplierArb, (events, bps) => {
        if (remainingWagering(events, bps) !== 0n) return;
        events.forEach((event, start) => {
          if (event.kind !== 'funding') return;
          const suffix = events.slice(start);
          const required = suffix
            .filter((e) => e.kind === 'funding')
            .reduce((sum, e) => sum + wageringRequirementOf(e.amount, bps), 0n);
          const staked = suffix
            .filter((e) => e.kind === 'stake')
            .reduce((sum, e) => sum + e.amount, 0n);
          expect(staked >= required).toBe(true);
        });
      }),
    );
  });

  it('is monotone in the multiplier', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 30 }),
        multiplierArb,
        multiplierArb,
        (e, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(remainingWagering(e, lo) <= remainingWagering(e, hi)).toBe(true);
        },
      ),
    );
  });

  it('rejects negative event amounts', () => {
    expect(() => remainingWagering([stake(-1n)], 10_000)).toThrow(RangeError);
  });
});

describe('DEFAULT_PAYMENT_RULES', () => {
  it('pins the default payment limits', () => {
    expect(DEFAULT_PAYMENT_RULES).toEqual({
      minDeposit: birr(10),
      maxDeposit: birr(100_000),
      minWithdrawal: birr(50),
      maxWithdrawal: birr(100_000),
      dailyWithdrawalCap: birr(200_000),
      autoApproveBelow: birr(5_000),
      wageringMultiplierBps: 10_000,
      depositIntentTtlMinutes: 30,
      payoutMaxAttempts: 5,
    });
  });
});
