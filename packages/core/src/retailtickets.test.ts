import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { birr } from './money';
import {
  DEFAULT_RETAIL_TICKET_LIMITS,
  parseRetailTicketLimits,
  resolveRetailTicketLimits,
  retailBetRules,
  retailCancelRefusal,
  serializeRetailTicketLimits,
} from './retailtickets';
import { DEFAULT_BET_RULES } from './rules';

describe('retail ticket limits', () => {
  it('fill the defaults: the online minimum stake, match count and odds; their own stake and win', () => {
    const limits = resolveRetailTicketLimits(DEFAULT_BET_RULES, {});
    expect(limits).toEqual({
      minStake: DEFAULT_BET_RULES.minStake,
      maxStake: birr(100_000),
      maxWin: birr(500_000),
      maxLegs: DEFAULT_BET_RULES.maxLegs,
      minLegOddsMilli: DEFAULT_BET_RULES.minLegOddsMilli,
      dailySales: null,
      cancelMinutes: 5,
      hqApprovalAbove: birr(10_000),
      expiryDays: 30,
    });
    expect(DEFAULT_RETAIL_TICKET_LIMITS.cancelMinutes).toBe(5);
  });

  it("an agent's overrides win, and the bet rules carry them (the max win caps the payout)", () => {
    const limits = resolveRetailTicketLimits(DEFAULT_BET_RULES, {
      maxStake: birr(2_000),
      maxWin: birr(50_000),
      maxLegs: 10,
      dailySales: birr(100_000),
    });
    const rules = retailBetRules(DEFAULT_BET_RULES, limits);
    expect(rules).toMatchObject({
      minStake: DEFAULT_BET_RULES.minStake,
      maxStake: birr(2_000),
      maxPayout: birr(50_000),
      maxLegs: 10,
      maxTotalOddsMilli: DEFAULT_BET_RULES.maxTotalOddsMilli,
    });
    expect(limits.dailySales).toBe(birr(100_000));
    // A maximum win below the maximum stake caps the stake too.
    const low = retailBetRules(
      DEFAULT_BET_RULES,
      resolveRetailTicketLimits(DEFAULT_BET_RULES, { maxWin: birr(1_000) }),
    );
    expect(low).toMatchObject({ maxStake: birr(1_000), maxPayout: birr(1_000) });
  });

  it('never gives bet rules whose stake range is upside down or above the win', () => {
    const santim = fc.bigInt({ min: 1n, max: 10n ** 10n });
    fc.assert(
      fc.property(santim, santim, santim, (minStake, maxStake, maxWin) => {
        fc.pre(minStake <= maxStake);
        const rules = retailBetRules(
          DEFAULT_BET_RULES,
          resolveRetailTicketLimits(DEFAULT_BET_RULES, { minStake, maxStake, maxWin }),
        );
        expect(rules.minStake <= rules.maxStake).toBe(true);
        expect(rules.maxStake <= rules.maxPayout).toBe(true);
      }),
    );
  });

  it('parses the stored JSON and refuses anything malformed', () => {
    expect(parseRetailTicketLimits({})).toEqual({});
    expect(parseRetailTicketLimits(null)).toEqual({});
    expect(
      parseRetailTicketLimits({ maxStake: '200000', cancelMinutes: 10, dailySales: null }),
    ).toEqual({ maxStake: 200_000n, cancelMinutes: 10, dailySales: null });
    for (const bad of [
      [],
      'x',
      { maxStake: '1.5' },
      { maxStake: '0' },
      { maxStake: -5 },
      { minStake: '500', maxStake: '100' },
      { cancelMinutes: 2000 },
      { minLegOddsMilli: 999 },
      { maxLegs: 0 },
      { whatever: 1 },
    ]) {
      expect(() => parseRetailTicketLimits(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('round-trips through its JSON form', () => {
    const santim = fc.bigInt({ min: 1n, max: 10n ** 12n });
    fc.assert(
      fc.property(
        fc.record(
          {
            minStake: santim,
            maxWin: santim,
            maxLegs: fc.integer({ min: 1, max: 100 }),
            minLegOddsMilli: fc.integer({ min: 1000, max: 1_000_000 }),
            dailySales: fc.option(santim, { nil: null }),
            cancelMinutes: fc.integer({ min: 0, max: 1440 }),
            hqApprovalAbove: santim,
            expiryDays: fc.integer({ min: 1, max: 3650 }),
          },
          { requiredKeys: [] },
        ),
        (limits) => {
          const stored = JSON.parse(JSON.stringify(serializeRetailTicketLimits(limits))) as unknown;
          expect(parseRetailTicketLimits(stored)).toEqual(limits);
        },
      ),
    );
  });
});

describe('cancelling a shop ticket', () => {
  const soldAt = new Date('2026-11-20T10:00:00Z');
  const kickoff = new Date('2026-11-20T15:00:00Z');
  const at = (minutes: number) => new Date(soldAt.getTime() + minutes * 60_000);

  it('the cashier within the window; owner and admin later; nobody after kick-off', () => {
    const base = { open: true, soldAt, firstKickoff: kickoff, cancelMinutes: 5 };
    expect(retailCancelRefusal({ ...base, role: 'cashier', now: at(5) })).toBeNull();
    expect(retailCancelRefusal({ ...base, role: 'cashier', now: at(6) })).toBe(
      'cancel_window_passed',
    );
    expect(retailCancelRefusal({ ...base, role: 'owner', now: at(60) })).toBeNull();
    expect(retailCancelRefusal({ ...base, role: 'admin', now: at(299) })).toBeNull();
    expect(retailCancelRefusal({ ...base, role: 'admin', now: kickoff })).toBe('match_started');
    expect(retailCancelRefusal({ ...base, open: false, role: 'admin', now: at(1) })).toBe(
      'not_open',
    );
  });

  it('never allows a cancel at or after the first kick-off, whoever asks', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('cashier' as const, 'owner' as const, 'admin' as const),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 1440 }),
        fc.integer({ min: 0, max: 600 }),
        (role, afterKickoffMinutes, cancelMinutes, kickoffMinutes) => {
          const firstKickoff = at(kickoffMinutes);
          const now = new Date(firstKickoff.getTime() + afterKickoffMinutes * 60_000);
          expect(
            retailCancelRefusal({ role, open: true, soldAt, firstKickoff, now, cancelMinutes }),
          ).not.toBeNull();
        },
      ),
    );
  });
});
