import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computePayout } from './betslip';
import { birr } from './money';
import { MAX_ODDS_MILLI, VOID_ODDS_MILLI } from './odds';
import {
  DEFAULT_BET_RULES,
  DEFAULT_MULTI_BONUS,
  DEFAULT_TAX,
  type MultiBonusConfig,
  type TaxConfig,
} from './rules';
import {
  type BetSettlement,
  type LegState,
  type SettlementLeg,
  canSettle,
  settleBet,
} from './settlement';

const maxPayout = DEFAULT_BET_RULES.maxPayout;
const multiBonus = DEFAULT_MULTI_BONUS;
const tax = DEFAULT_TAX;
const noBonus: MultiBonusConfig = { ...DEFAULT_MULTI_BONUS, enabled: false };

const won = (oddsMilli: number): SettlementLeg => ({ oddsMilli, state: 'won' });
const lost = (oddsMilli: number): SettlementLeg => ({ oddsMilli, state: 'lost' });
const voided = (oddsMilli: number): SettlementLeg => ({ oddsMilli, state: 'void' });
const open = (oddsMilli: number): SettlementLeg => ({ oddsMilli, state: 'open' });

const oddsArb = fc.integer({ min: 1010, max: 20_000 });
const stakeArb = fc.bigInt({ min: DEFAULT_BET_RULES.minStake, max: DEFAULT_BET_RULES.maxStake });
const stateArb = fc.constantFrom<LegState>('open', 'won', 'lost', 'void');
const legArb: fc.Arbitrary<SettlementLeg> = fc.record({ oddsMilli: oddsArb, state: stateArb });
const taxConfigArb: fc.Arbitrary<TaxConfig> = fc.record({
  rateBps: fc.integer({ min: 0, max: 10_000 }),
  base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
  exemptBelow: fc.bigInt({ min: 0n, max: birr(10_000) }),
});

/** A settleable winning bet: at least one won leg, the rest won or void. */
const wonOrVoidLegsArb = fc
  .tuple(
    // 39 others + the inserted won leg = DEFAULT_BET_RULES.maxLegs (40). fast-check 4
    // ignores maxLength when sizing arrays unless size is 'max' (default 'small' caps at ~10).
    fc.array(fc.record({ oddsMilli: oddsArb, state: fc.constantFrom<LegState>('won', 'void') }), {
      maxLength: 39,
      size: 'max',
    }),
    oddsArb,
    fc.nat(),
  )
  .map(([others, wonOdds, position]) => {
    const legs = [...others];
    legs.splice(position % (others.length + 1), 0, won(wonOdds));
    return legs;
  });

function moneyFields(s: BetSettlement): Omit<BetSettlement, 'status' | 'effectiveOddsMilli'> {
  const { status: _status, effectiveOddsMilli: _odds, ...money } = s;
  return money;
}

describe('canSettle', () => {
  it('is false for no legs', () => {
    expect(canSettle([])).toBe(false);
  });

  it('is false while a leg is open and none is lost', () => {
    expect(canSettle([open(2000)])).toBe(false);
    expect(canSettle([won(2000), open(2000)])).toBe(false);
    expect(canSettle([voided(2000), open(2000), won(1500)])).toBe(false);
  });

  it('is true as soon as any leg is lost, even with open legs', () => {
    expect(canSettle([lost(2000)])).toBe(true);
    expect(canSettle([open(2000), lost(2000), open(1500)])).toBe(true);
  });

  it('is true when no leg is open', () => {
    expect(canSettle([won(2000)])).toBe(true);
    expect(canSettle([won(2000), voided(1500)])).toBe(true);
    expect(canSettle([voided(2000), voided(1500)])).toBe(true);
  });

  it('agrees with settleBet throwing', () => {
    fc.assert(
      fc.property(fc.array(legArb, { maxLength: 10 }), stakeArb, (legs, stake) => {
        const settle = () => settleBet({ stake, legs, maxPayout, multiBonus, tax });
        if (canSettle(legs)) expect(settle).not.toThrow();
        else expect(settle).toThrow(RangeError);
      }),
    );
  });
});

describe('settleBet', () => {
  it('rejects bets without legs, with open legs or with unknown leg states', () => {
    const base = { stake: birr(10), maxPayout, multiBonus, tax };
    expect(() => settleBet({ ...base, legs: [] })).toThrow(RangeError);
    expect(() => settleBet({ ...base, legs: [won(2000), open(2000)] })).toThrow(RangeError);
    const weird = { oddsMilli: 2000, state: 'cancelled' } as unknown as SettlementLeg;
    expect(() => settleBet({ ...base, legs: [won(2000), weird] })).toThrow(RangeError);
    expect(() => settleBet({ ...base, stake: -1n, legs: [won(2000)] })).toThrow(RangeError);
  });

  it('settles as lost as soon as any leg is lost', () => {
    const result = settleBet({
      stake: birr(100),
      legs: [won(2000), open(3000), lost(1500), voided(2000)],
      maxPayout,
      multiBonus,
      tax,
    });
    expect(result).toEqual({
      status: 'lost',
      effectiveOddsMilli: [],
      grossReturn: 0n,
      bonusPercentBps: 0,
      qualifyingLegs: 0,
      bonusAmount: 0n,
      grossPayout: 0n,
      cappedByMaxPayout: false,
      taxAmount: 0n,
      netPayout: 0n,
    });
  });

  it('refunds the stake when every leg is void', () => {
    const result = settleBet({
      stake: birr(250),
      legs: [voided(2000), voided(3500)],
      maxPayout,
      multiBonus,
      tax,
    });
    expect(result).toEqual({
      status: 'void',
      effectiveOddsMilli: [VOID_ODDS_MILLI, VOID_ODDS_MILLI],
      grossReturn: birr(250),
      bonusPercentBps: 0,
      qualifyingLegs: 0,
      bonusAmount: 0n,
      grossPayout: birr(250),
      cappedByMaxPayout: false,
      taxAmount: 0n,
      netPayout: birr(250),
    });
  });

  it('pays a winning single', () => {
    const result = settleBet({ stake: birr(100), legs: [won(1850)], maxPayout, multiBonus, tax });
    expect(result).toEqual({
      status: 'won',
      effectiveOddsMilli: [1850],
      grossReturn: birr(185),
      bonusPercentBps: 0,
      qualifyingLegs: 1,
      bonusAmount: 0n,
      grossPayout: birr(185),
      cappedByMaxPayout: false,
      taxAmount: 0n,
      netPayout: birr(185),
    });
  });

  it('prices void legs at 1.00 and excludes them from the multi bonus', () => {
    const result = settleBet({
      stake: birr(100),
      legs: [won(2000), voided(3000), won(2000), won(2000)],
      maxPayout,
      multiBonus,
      tax,
    });
    expect(result).toEqual({
      status: 'won',
      effectiveOddsMilli: [2000, 1000, 2000, 2000],
      grossReturn: birr(800),
      bonusPercentBps: 300,
      qualifyingLegs: 3,
      bonusAmount: birr(21),
      grossPayout: birr(821),
      cappedByMaxPayout: false,
      taxAmount: birr(144.2),
      netPayout: birr(676.8),
    });
  });

  it('drops the bonus when voids leave too few won legs', () => {
    const result = settleBet({
      stake: birr(100),
      legs: [won(2000), won(2000), voided(2000)],
      maxPayout,
      multiBonus,
      tax,
    });
    expect(result).toMatchObject({
      status: 'won',
      grossReturn: birr(400),
      qualifyingLegs: 2,
      bonusPercentBps: 0,
      bonusAmount: 0n,
    });

    const single = settleBet({
      stake: birr(100),
      legs: [voided(2000), won(3000), voided(2000), voided(5000)],
      maxPayout,
      multiBonus: { ...multiBonus, tiers: [{ minLegs: 1, percentBps: 5_000 }] },
      tax,
    });
    expect(single).toMatchObject({ status: 'won', grossReturn: birr(300), bonusAmount: 0n });
  });

  it('settles a won leg at the maximum odds of 1000.00', () => {
    expect(
      settleBet({ stake: birr(1), legs: [won(MAX_ODDS_MILLI)], maxPayout, multiBonus, tax })
        .grossReturn,
    ).toBe(birr(1_000));
    expect(
      settleBet({
        stake: birr(1),
        legs: [voided(MAX_ODDS_MILLI), won(MAX_ODDS_MILLI), won(2000)],
        maxPayout,
        multiBonus: noBonus,
        tax,
      }),
    ).toMatchObject({
      status: 'won',
      effectiveOddsMilli: [1000, MAX_ODDS_MILLI, 2000],
      grossReturn: birr(2_000),
    });
  });

  it('applies the max payout cap and the winnings tax', () => {
    const result = settleBet({
      stake: birr(100_000),
      legs: [won(5000), won(4000), won(3000)],
      maxPayout,
      multiBonus,
      tax,
    });
    expect(result).toMatchObject({
      status: 'won',
      grossReturn: birr(6_000_000),
      bonusAmount: 0n,
      grossPayout: maxPayout,
      cappedByMaxPayout: true,
      taxAmount: birr(80_000),
      netPayout: birr(420_000),
    });
  });

  it('pays nothing when a lost leg is anywhere in the bet', () => {
    fc.assert(
      fc.property(
        fc.array(legArb, { maxLength: 39, size: 'max' }),
        oddsArb,
        fc.nat(),
        stakeArb,
        (others, lostOdds, position, stake) => {
          const legs = [...others];
          legs.splice(position % (others.length + 1), 0, lost(lostOdds));
          const result = settleBet({ stake, legs, maxPayout, multiBonus, tax });
          expect(result.status).toBe('lost');
          expect(result.netPayout).toBe(0n);
          expect(result.grossPayout).toBe(0n);
          expect(result.effectiveOddsMilli).toEqual([]);
        },
      ),
    );
  });

  it('settling with void legs equals settling without them (bonus disabled)', () => {
    fc.assert(
      fc.property(wonOrVoidLegsArb, stakeArb, taxConfigArb, (legs, stake, taxConfig) => {
        const withVoids = settleBet({
          stake,
          legs,
          maxPayout,
          multiBonus: noBonus,
          tax: taxConfig,
        });
        const withoutVoids = settleBet({
          stake,
          legs: legs.filter((leg) => leg.state === 'won'),
          maxPayout,
          multiBonus: noBonus,
          tax: taxConfig,
        });
        expect(withVoids.status).toBe('won');
        expect(moneyFields(withVoids)).toEqual(moneyFields(withoutVoids));
      }),
    );
  });

  it('settling with void legs equals settling without them (default bonus)', () => {
    fc.assert(
      fc.property(wonOrVoidLegsArb, stakeArb, (legs, stake) => {
        const withVoids = settleBet({ stake, legs, maxPayout, multiBonus, tax });
        const withoutVoids = settleBet({
          stake,
          legs: legs.filter((leg) => leg.state === 'won'),
          maxPayout,
          multiBonus,
          tax,
        });
        expect(moneyFields(withVoids)).toEqual(moneyFields(withoutVoids));
      }),
    );
  });

  it('a won bet matches computePayout over the won legs and keeps the payout invariants', () => {
    fc.assert(
      fc.property(
        wonOrVoidLegsArb,
        stakeArb,
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        taxConfigArb,
        (legs, stake, cap, taxConfig) => {
          const result = settleBet({ stake, legs, maxPayout: cap, multiBonus, tax: taxConfig });
          const wonOdds = legs.filter((leg) => leg.state === 'won').map((leg) => leg.oddsMilli);
          expect(result.status).toBe('won');
          expect(result.effectiveOddsMilli).toEqual(
            legs.map((leg) => (leg.state === 'won' ? leg.oddsMilli : VOID_ODDS_MILLI)),
          );
          expect(moneyFields(result)).toEqual(
            computePayout({ stake, legOdds: wonOdds, maxPayout: cap, multiBonus, tax: taxConfig }),
          );
          expect(result.netPayout).toBeLessThanOrEqual(result.grossPayout);
          expect(result.grossPayout).toBeLessThanOrEqual(cap);
          expect(result.bonusAmount).toBeLessThanOrEqual(multiBonus.maxBonus);
          const winnings = result.grossPayout > stake ? result.grossPayout - stake : 0n;
          expect(result.taxAmount).toBeLessThanOrEqual(winnings);
          if (result.grossPayout >= stake) expect(result.netPayout).toBeGreaterThanOrEqual(stake);
        },
      ),
    );
  });
});
