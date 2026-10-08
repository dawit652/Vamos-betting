import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type SlipError,
  type SlipErrorCode,
  type SlipLeg,
  computePayout,
  quoteBet,
  validateSlip,
} from './betslip';
import { birr, maxSantim, minSantim } from './money';
import { computeMultiBonus } from './multibonus';
import { MAX_ODDS_MILLI, grossReturn, productOddsMilli } from './odds';
import {
  DEFAULT_BET_RULES,
  DEFAULT_MULTI_BONUS,
  DEFAULT_TAX,
  type BetRules,
  type MultiBonusConfig,
  type TaxConfig,
} from './rules';

const rules = DEFAULT_BET_RULES;
const multiBonus = DEFAULT_MULTI_BONUS;
const tax = DEFAULT_TAX;
const noBonus: MultiBonusConfig = { ...DEFAULT_MULTI_BONUS, enabled: false };

function leg(n: number, oddsMilli: number, eventId = `e${n}`): SlipLeg {
  return { selectionId: `s${n}`, eventId, oddsMilli };
}

function legsOf(odds: readonly number[]): SlipLeg[] {
  return odds.map((o, i) => leg(i + 1, o));
}

function codes(errors: readonly SlipError[]): SlipErrorCode[] {
  return errors.map((e) => e.code);
}

const taxConfigArb: fc.Arbitrary<TaxConfig> = fc.record({
  rateBps: fc.integer({ min: 0, max: 10_000 }),
  base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
  exemptBelow: fc.bigInt({ min: 0n, max: birr(10_000) }),
});

const multiBonusArb: fc.Arbitrary<MultiBonusConfig> = fc.record({
  enabled: fc.boolean(),
  minLegOddsMilli: fc.integer({ min: 1001, max: 2_000 }),
  tiers: fc.constant(DEFAULT_MULTI_BONUS.tiers),
  maxBonus: fc.bigInt({ min: 0n, max: birr(100_000) }),
});

describe('validateSlip', () => {
  it('reports invalid odds on a repeated selection instead of hiding them (regression)', () => {
    const legs: SlipLeg[] = [
      { selectionId: 'a', eventId: 'e1', oddsMilli: 500_000 },
      { selectionId: 'b', eventId: 'e2', oddsMilli: 500_000 },
      { selectionId: 'c', eventId: 'e3', oddsMilli: 500_000 },
      { selectionId: 'a', eventId: 'e1', oddsMilli: 0 },
    ];
    const codes = validateSlip({ stake: birr(10), legs, rules: DEFAULT_BET_RULES }).map(
      (e) => e.code,
    );
    expect(codes).toContain('duplicate_selection');
    expect(codes).toContain('invalid_odds');
    const quote = quoteBet({
      stake: birr(10),
      legs,
      rules: DEFAULT_BET_RULES,
      multiBonus: DEFAULT_MULTI_BONUS,
      tax: DEFAULT_TAX,
    });
    expect(quote.errors.map((e) => e.code)).toContain('invalid_odds');
    expect(quote.netPayout).toBe(0n);
  });

  it('accepts a valid single and a valid multi', () => {
    expect(validateSlip({ stake: birr(10), legs: legsOf([1850]), rules })).toEqual([]);
    expect(validateSlip({ stake: birr(10), legs: legsOf([1850, 2100, 1500]), rules })).toEqual([]);
  });

  it('accepts stakes exactly at the limits', () => {
    expect(validateSlip({ stake: rules.minStake, legs: legsOf([2000]), rules })).toEqual([]);
    expect(validateSlip({ stake: rules.maxStake, legs: legsOf([2000]), rules })).toEqual([]);
  });

  it('requires at least one selection', () => {
    const errors = validateSlip({ stake: birr(10), legs: [], rules });
    expect(codes(errors)).toEqual(['no_selections']);
    expect(errors[0]!.message).toMatch(/at least one selection/);
  });

  it('limits the number of legs', () => {
    const small: BetRules = { ...rules, maxLegs: 2 };
    expect(validateSlip({ stake: birr(10), legs: legsOf([1500, 1500]), rules: small })).toEqual([]);
    const errors = validateSlip({
      stake: birr(10),
      legs: legsOf([1500, 1500, 1500]),
      rules: small,
    });
    expect(codes(errors)).toEqual(['too_many_legs']);
    expect(errors[0]!.message).toContain('at most 2 selections');

    const fortyOne = legsOf(Array.from({ length: 41 }, () => 1010));
    expect(codes(validateSlip({ stake: birr(10), legs: fortyOne, rules }))).toEqual([
      'too_many_legs',
    ]);
    expect(validateSlip({ stake: birr(10), legs: fortyOne.slice(0, 40), rules })).toEqual([]);
  });

  it('reports the same selection twice once, as duplicate_selection', () => {
    const legs = [leg(1, 2000), leg(2, 1500), leg(1, 2000), leg(1, 2000)];
    const errors = validateSlip({ stake: birr(10), legs, rules });
    expect(errors).toEqual([
      {
        code: 'duplicate_selection',
        message: expect.any(String) as string,
        selectionId: 's1',
        eventId: 'e1',
      },
    ]);
  });

  it('reports two selections from the same event as duplicate_event', () => {
    const legs = [leg(1, 2000, 'match'), leg(2, 3000, 'other'), leg(3, 3400, 'match')];
    const errors = validateSlip({ stake: birr(10), legs, rules });
    expect(errors).toEqual([
      {
        code: 'duplicate_event',
        message: expect.any(String) as string,
        selectionId: 's3',
        eventId: 'match',
      },
    ]);
    expect(errors[0]!.message).toMatch(/one selection per match/);
  });

  it('reports each conflicting event once', () => {
    const legs = [leg(1, 2000, 'a'), leg(2, 2000, 'a'), leg(3, 2000, 'a'), leg(4, 2000, 'b')];
    expect(codes(validateSlip({ stake: birr(10), legs, rules }))).toEqual(['duplicate_event']);
    const twoEvents = [leg(1, 2000, 'a'), leg(2, 2000, 'b'), leg(3, 2000, 'a'), leg(4, 2000, 'b')];
    const errors = validateSlip({ stake: birr(10), legs: twoEvents, rules });
    expect(errors.map((e) => [e.code, e.eventId])).toEqual([
      ['duplicate_event', 'a'],
      ['duplicate_event', 'b'],
    ]);
  });

  it('reports both a duplicate selection and a second selection of its event', () => {
    const legs = [leg(1, 2000, 'm'), leg(1, 2000, 'm'), leg(2, 2500, 'm')];
    expect(codes(validateSlip({ stake: birr(10), legs, rules }))).toEqual([
      'duplicate_selection',
      'duplicate_event',
    ]);
  });

  it('rejects invalid odds', () => {
    for (const odds of [1000, 0, -1500, 1500.5, Number.NaN, 1_000_001]) {
      const errors = validateSlip({ stake: birr(10), legs: [leg(1, odds)], rules });
      expect(errors).toEqual([
        {
          code: 'invalid_odds',
          message: expect.any(String) as string,
          selectionId: 's1',
          eventId: 'e1',
        },
      ]);
    }
  });

  it('rejects valid odds below the minimum', () => {
    const errors = validateSlip({ stake: birr(10), legs: [leg(1, 2000), leg(2, 1005)], rules });
    expect(errors).toEqual([
      {
        code: 'odds_below_minimum',
        message: 'Odds of 1.005 are below the minimum of 1.01 per selection.',
        selectionId: 's2',
        eventId: 'e2',
      },
    ]);
    expect(validateSlip({ stake: birr(10), legs: [leg(1, 1010)], rules })).toEqual([]);
  });

  it('rejects a stake of zero or less', () => {
    for (const stake of [0n, -1n, -birr(10)]) {
      const errors = validateSlip({ stake, legs: legsOf([2000]), rules });
      expect(codes(errors)).toEqual(['invalid_stake']);
    }
  });

  it('enforces the minimum and maximum stake', () => {
    const below = validateSlip({ stake: rules.minStake - 1n, legs: legsOf([2000]), rules });
    expect(below).toEqual([
      { code: 'stake_below_minimum', message: 'The minimum stake is ETB 5.00.' },
    ]);
    const above = validateSlip({ stake: rules.maxStake + 1n, legs: legsOf([2000]), rules });
    expect(above).toEqual([
      { code: 'stake_above_maximum', message: 'The maximum stake is ETB 100,000.00.' },
    ]);
  });

  it('enforces the maximum total odds', () => {
    const tight: BetRules = { ...rules, maxTotalOddsMilli: 10_000n };
    expect(validateSlip({ stake: birr(10), legs: legsOf([2500, 4000]), rules: tight })).toEqual([]);
    const errors = validateSlip({ stake: birr(10), legs: legsOf([3000, 4000]), rules: tight });
    expect(errors).toEqual([
      {
        code: 'total_odds_above_maximum',
        message: 'Total odds of 12.00 are above the maximum of 10.00.',
      },
    ]);

    const twenty = legsOf(Array.from({ length: 20 }, () => 2500));
    const big = validateSlip({ stake: birr(10), legs: twenty, rules });
    expect(codes(big)).toEqual(['total_odds_above_maximum']);
    expect(big[0]!.message).toBe(
      'Total odds of 90,949,470.177 are above the maximum of 1,000,000.00.',
    );
  });

  it('skips the total odds check when a leg has invalid odds', () => {
    const tight: BetRules = { ...rules, maxTotalOddsMilli: 10_000n };
    const errors = validateSlip({
      stake: birr(10),
      legs: legsOf([5000, 5000, Number.NaN]),
      rules: tight,
    });
    expect(codes(errors)).toEqual(['invalid_odds']);
  });

  it('collects every applicable error', () => {
    const small: BetRules = { ...rules, maxLegs: 3, maxTotalOddsMilli: 2_000n };
    const legs = [leg(1, 1005), leg(2, 2000, 'e1'), leg(1, 1005), leg(4, 2000)];
    const errors = validateSlip({ stake: 100n, legs, rules: small });
    expect(codes(errors)).toEqual([
      'too_many_legs',
      'odds_below_minimum',
      'duplicate_event',
      'duplicate_selection',
      'stake_below_minimum',
      'total_odds_above_maximum',
    ]);
    for (const error of errors) expect(error.message.length).toBeGreaterThan(0);
  });

  it('accepts generated valid slips and flags a second pick from the same event', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1010, max: 3_000 }), { minLength: 1, maxLength: 12 }),
        fc.bigInt({ min: rules.minStake, max: rules.maxStake }),
        fc.nat(),
        (odds, stake, pick) => {
          const legs = legsOf(odds);
          expect(validateSlip({ stake, legs, rules })).toEqual([]);
          const target = legs[pick % legs.length]!;
          const conflicting: SlipLeg = {
            selectionId: 'extra',
            eventId: target.eventId,
            oddsMilli: 2000,
          };
          const errors = validateSlip({ stake, legs: [...legs, conflicting], rules });
          expect(codes(errors)).toContain('duplicate_event');
        },
      ),
    );
  });
});

describe('computePayout', () => {
  it('prices a single without bonus (winnings under the tax threshold)', () => {
    expect(
      computePayout({
        stake: birr(100),
        legOdds: [1850],
        maxPayout: rules.maxPayout,
        multiBonus,
        tax,
      }),
    ).toEqual({
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

  it('adds the multi bonus and withholds tax', () => {
    // 100 ETB × 2 × 2 × 2 = 800 ETB; bonus 3% × 700 = 21 ETB; tax 20% × 721 = 144.20 ETB
    expect(
      computePayout({
        stake: birr(100),
        legOdds: [2000, 2000, 2000],
        maxPayout: rules.maxPayout,
        multiBonus,
        tax,
      }),
    ).toEqual({
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

  it('reduces the bonus first when the max payout caps the bet', () => {
    const result = computePayout({
      stake: birr(100),
      legOdds: [2000, 2000, 2000],
      maxPayout: birr(810),
      multiBonus,
      tax,
    });
    expect(result).toMatchObject({
      grossReturn: birr(800),
      bonusPercentBps: 300,
      bonusAmount: birr(10),
      grossPayout: birr(810),
      cappedByMaxPayout: true,
      taxAmount: birr(142),
      netPayout: birr(668),
    });
  });

  it('drops the bonus entirely when the return alone exceeds the cap', () => {
    const result = computePayout({
      stake: birr(100),
      legOdds: [2000, 2000, 2000],
      maxPayout: birr(500),
      multiBonus,
      tax,
    });
    expect(result).toMatchObject({
      grossReturn: birr(800),
      bonusAmount: 0n,
      grossPayout: birr(500),
      cappedByMaxPayout: true,
      taxAmount: birr(80),
      netPayout: birr(420),
    });
  });

  it('is not capped when the payout equals the cap exactly', () => {
    const result = computePayout({
      stake: birr(100),
      legOdds: [2000, 2000, 2000],
      maxPayout: birr(821),
      multiBonus,
      tax,
    });
    expect(result.cappedByMaxPayout).toBe(false);
    expect(result.grossPayout).toBe(birr(821));
    expect(result.bonusAmount).toBe(birr(21));
  });

  it('uses bonusLegOdds for the bonus but legOdds for the return', () => {
    const result = computePayout({
      stake: birr(100),
      legOdds: [2000, 2000, 2000, 1000],
      bonusLegOdds: [2000, 2000],
      maxPayout: rules.maxPayout,
      multiBonus,
      tax,
    });
    expect(result.grossReturn).toBe(birr(800));
    expect(result.qualifyingLegs).toBe(2);
    expect(result.bonusPercentBps).toBe(0);
    expect(result.bonusAmount).toBe(0n);
  });

  it('returns the stake for no legs or all-void odds', () => {
    for (const legOdds of [[], [1000, 1000]]) {
      const result = computePayout({
        stake: birr(50),
        legOdds,
        maxPayout: rules.maxPayout,
        multiBonus,
        tax,
      });
      expect(result.grossPayout).toBe(birr(50));
      expect(result.netPayout).toBe(birr(50));
      expect(result.taxAmount).toBe(0n);
    }
  });

  it('prices and settles a leg at the maximum odds of 1000.00', () => {
    expect(
      computePayout({
        stake: birr(1),
        legOdds: [MAX_ODDS_MILLI],
        maxPayout: rules.maxPayout,
        multiBonus,
        tax,
      }).grossReturn,
    ).toBe(birr(1_000));
    // Inside a multi too, and the same price one milli lower.
    expect(
      computePayout({
        stake: birr(1),
        legOdds: [MAX_ODDS_MILLI, 2000],
        maxPayout: rules.maxPayout,
        multiBonus: noBonus,
        tax,
      }).grossReturn,
    ).toBe(birr(2_000));
    expect(
      computePayout({
        stake: birr(1),
        legOdds: [MAX_ODDS_MILLI - 1],
        maxPayout: rules.maxPayout,
        multiBonus,
        tax,
      }).grossReturn,
    ).toBe(99_999n);
  });

  it('rejects invalid inputs', () => {
    const base = { stake: birr(10), legOdds: [2000], maxPayout: rules.maxPayout, multiBonus, tax };
    expect(() => computePayout({ ...base, stake: -1n })).toThrow(RangeError);
    expect(() => computePayout({ ...base, maxPayout: -1n })).toThrow(RangeError);
    for (const odds of [999, 1_000_001, 1500.5, Number.NaN]) {
      expect(() => computePayout({ ...base, legOdds: [odds] })).toThrow(RangeError);
    }
  });

  it('keeps netPayout <= grossPayout <= maxPayout and the bonus within maxBonus', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: birr(100_000) }),
        fc.array(fc.integer({ min: 1000, max: MAX_ODDS_MILLI }), { maxLength: 40, size: 'max' }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        multiBonusArb,
        taxConfigArb,
        (stake, legOdds, maxPayout, bonusConfig, taxConfig) => {
          const r = computePayout({
            stake,
            legOdds,
            maxPayout,
            multiBonus: bonusConfig,
            tax: taxConfig,
          });
          const winnings = r.grossPayout > stake ? r.grossPayout - stake : 0n;
          const capped = r.grossReturn < maxPayout ? r.grossReturn : maxPayout;
          expect(r.netPayout).toBeLessThanOrEqual(r.grossPayout);
          expect(r.grossPayout).toBeLessThanOrEqual(maxPayout);
          expect(r.netPayout).toBeGreaterThanOrEqual(0n);
          expect(r.bonusAmount).toBeGreaterThanOrEqual(0n);
          expect(r.bonusAmount).toBeLessThanOrEqual(bonusConfig.maxBonus);
          expect(r.taxAmount).toBeGreaterThanOrEqual(0n);
          expect(r.taxAmount).toBeLessThanOrEqual(winnings);
          expect(r.grossPayout).toBe(capped + r.bonusAmount);
          expect(r.netPayout).toBe(r.grossPayout - r.taxAmount);
          if (r.grossPayout >= stake) expect(r.netPayout).toBeGreaterThanOrEqual(stake);
        },
      ),
    );
  });

  it('the max-payout cap reduces the bonus first (property)', () => {
    // computeMultiBonus is the oracle for the bonus earned. Half the runs put the cap
    // inside [gross, gross + bonus], the region where the cap only trims the bonus.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: birr(100_000) }),
        fc.array(fc.integer({ min: 1000, max: MAX_ODDS_MILLI }), { maxLength: 40, size: 'max' }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        fc.boolean(),
        multiBonusArb,
        taxConfigArb,
        (stake, legOdds, frac, freeCap, capInBonus, bonusConfig, taxConfig) => {
          const gross = grossReturn(stake, legOdds);
          const bonus = computeMultiBonus({
            stake,
            grossReturn: gross,
            legOdds,
            config: bonusConfig,
          });
          const maxPayout = capInBonus ? gross + (bonus.amount * frac) / 10_000n : freeCap;
          const r = computePayout({
            stake,
            legOdds,
            maxPayout,
            multiBonus: bonusConfig,
            tax: taxConfig,
          });
          expect(r.grossReturn).toBe(gross);
          expect(r.bonusPercentBps).toBe(bonus.percentBps);
          expect(r.qualifyingLegs).toBe(bonus.qualifyingLegs);
          expect(r.bonusAmount).toBe(minSantim(bonus.amount, maxSantim(0n, maxPayout - gross)));
          expect(r.grossPayout).toBe(minSantim(gross + bonus.amount, maxPayout));
          expect(r.cappedByMaxPayout).toBe(gross + bonus.amount > maxPayout);
        },
      ),
    );
  });
});

describe('quoteBet', () => {
  it('quotes a single', () => {
    const quote = quoteBet({ stake: birr(100), legs: legsOf([1850]), rules, multiBonus, tax });
    expect(quote).toEqual({
      betType: 'single',
      legCount: 1,
      stake: birr(100),
      totalOddsMilli: 1850n,
      errors: [],
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

  it('quotes a multi with bonus and tax', () => {
    const quote = quoteBet({
      stake: birr(100),
      legs: legsOf([2000, 2000, 2000]),
      rules,
      multiBonus,
      tax,
    });
    expect(quote).toMatchObject({
      betType: 'multi',
      legCount: 3,
      totalOddsMilli: 8000n,
      errors: [],
      grossReturn: birr(800),
      bonusAmount: birr(21),
      grossPayout: birr(821),
      taxAmount: birr(144.2),
      netPayout: birr(676.8),
    });
  });

  it('applies the rules max payout', () => {
    const quote = quoteBet({
      stake: birr(100_000),
      legs: legsOf([5000, 4000, 3000]),
      rules,
      multiBonus,
      tax,
    });
    expect(quote).toMatchObject({
      errors: [],
      grossReturn: birr(6_000_000),
      bonusAmount: 0n,
      grossPayout: rules.maxPayout,
      cappedByMaxPayout: true,
      taxAmount: birr(80_000),
      netPayout: birr(420_000),
    });
  });

  const zeroMoney = {
    totalOddsMilli: 1000n,
    grossReturn: 0n,
    bonusPercentBps: 0,
    qualifyingLegs: 0,
    bonusAmount: 0n,
    grossPayout: 0n,
    cappedByMaxPayout: false,
    taxAmount: 0n,
    netPayout: 0n,
  };

  it('returns zero money for an empty slip', () => {
    const quote = quoteBet({ stake: birr(10), legs: [], rules, multiBonus, tax });
    expect(quote).toEqual({
      betType: 'multi',
      legCount: 0,
      stake: birr(10),
      errors: [{ code: 'no_selections', message: expect.any(String) as string }],
      ...zeroMoney,
    });
  });

  it('returns zero money for a stake of zero or less', () => {
    for (const stake of [0n, -birr(5)]) {
      const quote = quoteBet({ stake, legs: legsOf([2000, 3000]), rules, multiBonus, tax });
      expect(quote).toMatchObject({ betType: 'multi', legCount: 2, stake, ...zeroMoney });
      expect(codes(quote.errors)).toEqual(['invalid_stake']);
    }
  });

  it('returns zero money when a leg has invalid odds', () => {
    const quote = quoteBet({ stake: birr(10), legs: legsOf([2000, 1000]), rules, multiBonus, tax });
    expect(quote).toMatchObject(zeroMoney);
    expect(codes(quote.errors)).toEqual(['invalid_odds']);
  });

  it('still computes the potential win when there are other errors', () => {
    const quote = quoteBet({ stake: birr(1), legs: legsOf([2000]), rules, multiBonus, tax });
    expect(codes(quote.errors)).toEqual(['stake_below_minimum']);
    expect(quote.grossReturn).toBe(birr(2));
    expect(quote.netPayout).toBe(birr(2));

    const sameEvent = [leg(1, 2000, 'm'), leg(2, 3000, 'm')];
    const dup = quoteBet({ stake: birr(10), legs: sameEvent, rules, multiBonus, tax });
    expect(codes(dup.errors)).toEqual(['duplicate_event']);
    expect(dup.totalOddsMilli).toBe(6000n);
    expect(dup.grossReturn).toBe(birr(60));
  });

  it('matches computePayout and pays at least the stake for valid slips', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1010, max: 3_000 }), { minLength: 1, maxLength: 12 }),
        fc.bigInt({ min: rules.minStake, max: rules.maxStake }),
        taxConfigArb,
        fc.boolean(),
        (odds, stake, taxConfig, bonusOn) => {
          const bonusConfig = bonusOn ? multiBonus : noBonus;
          const legs = legsOf(odds);
          const quote = quoteBet({ stake, legs, rules, multiBonus: bonusConfig, tax: taxConfig });
          expect(quote.errors).toEqual([]);
          expect(quote.betType).toBe(odds.length === 1 ? 'single' : 'multi');
          expect(quote.legCount).toBe(odds.length);
          expect(quote.totalOddsMilli).toBe(productOddsMilli(odds));
          const payout = computePayout({
            stake,
            legOdds: odds,
            maxPayout: rules.maxPayout,
            multiBonus: bonusConfig,
            tax: taxConfig,
          });
          expect(quote).toMatchObject(payout);
          expect(quote.grossPayout).toBeGreaterThanOrEqual(stake);
          expect(quote.netPayout).toBeGreaterThanOrEqual(stake);
          expect(quote.netPayout).toBeLessThanOrEqual(quote.grossPayout);
          expect(quote.grossPayout).toBeLessThanOrEqual(rules.maxPayout);
          expect(quote.bonusAmount).toBeLessThanOrEqual(bonusConfig.maxBonus);
        },
      ),
    );
  });
});
