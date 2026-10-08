import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CashOutLeg, cashOutOffer } from './cashout';
import { birr } from './money';
import { grossReturn } from './odds';
import { type CashOutConfig, DEFAULT_BET_RULES, DEFAULT_CASH_OUT } from './rules';

const NO_MARGIN: CashOutConfig = { enabled: true, marginBps: 0, minOffer: 0n };
const MAX = DEFAULT_BET_RULES.maxPayout;

const open = (placed: number, current: number | null = placed): CashOutLeg => ({
  placedOddsMilli: placed,
  state: 'open',
  currentOddsMilli: current,
});
const won = (placed: number): CashOutLeg => ({
  placedOddsMilli: placed,
  state: 'won',
  currentOddsMilli: null,
});
const lost = (placed: number): CashOutLeg => ({
  placedOddsMilli: placed,
  state: 'lost',
  currentOddsMilli: null,
});
const voided = (placed: number): CashOutLeg => ({
  placedOddsMilli: placed,
  state: 'void',
  currentOddsMilli: null,
});

describe('cashOutOffer – availability checks', () => {
  it('is unavailable when cash-out is disabled, but still reports the potential return', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(2000, 1500)],
      config: { ...DEFAULT_CASH_OUT, enabled: false },
      maxPayout: MAX,
    });
    expect(offer).toEqual({
      available: false,
      amount: 0n,
      reason: 'disabled',
      potentialReturn: birr(200),
    });
  });

  it('checks disabled before every other reason', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [lost(2000)],
      config: { ...DEFAULT_CASH_OUT, enabled: false },
      maxPayout: MAX,
    });
    expect(offer.reason).toBe('disabled');
    expect(offer.potentialReturn).toBe(0n);
  });

  it('is unavailable without legs', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({ available: false, amount: 0n, reason: 'no_legs', potentialReturn: 0n });
  });

  it('is unavailable once any leg is lost (before suspension)', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(2000, null), lost(1500), won(1800)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({
      available: false,
      amount: 0n,
      reason: 'leg_lost',
      potentialReturn: 0n,
    });
  });

  it('is unavailable when an open leg is suspended (null odds)', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(2000, null), won(1500)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({
      available: false,
      amount: 0n,
      reason: 'leg_suspended',
      potentialReturn: birr(300),
    });
  });

  it('treats invalid live odds as suspended', () => {
    for (const current of [1000, 0, -5, 1_000_001, 1850.5, Number.NaN]) {
      const offer = cashOutOffer({
        stake: birr(100),
        legs: [open(2000, current)],
        config: DEFAULT_CASH_OUT,
        maxPayout: MAX,
      });
      expect(offer.reason).toBe('leg_suspended');
      expect(offer.amount).toBe(0n);
    }
  });

  it('ignores the live odds of won and void legs', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [
        { placedOddsMilli: 2000, state: 'won', currentOddsMilli: 1 },
        { placedOddsMilli: 3000, state: 'void', currentOddsMilli: null },
        open(1500, 1500),
      ],
      config: NO_MARGIN,
      maxPayout: MAX,
    });
    expect(offer.available).toBe(true);
    expect(offer.amount).toBe(birr(200));
  });

  it('is unavailable when every leg is settled (awaits normal settlement)', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [won(2000), voided(1500), won(1500)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({
      available: false,
      amount: 0n,
      reason: 'all_legs_settled',
      potentialReturn: birr(300),
    });
  });

  it('is unavailable when every leg is void', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [voided(2000)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer.reason).toBe('all_legs_settled');
    expect(offer.potentialReturn).toBe(birr(100));
  });

  it('is unavailable when the offer is below the minimum', () => {
    const offer = cashOutOffer({
      stake: birr(1),
      legs: [open(2000, 5000)],
      config: DEFAULT_CASH_OUT, // minOffer 1 ETB
      maxPayout: MAX,
    });
    expect(offer).toEqual({
      available: false,
      amount: 0n,
      reason: 'below_minimum',
      potentialReturn: birr(2),
    });
  });

  it('offers exactly the minimum', () => {
    // 2 ETB × 2.00 / 4.00 = 1 ETB with no margin.
    const offer = cashOutOffer({
      stake: birr(2),
      legs: [open(2000, 4000)],
      config: { enabled: true, marginBps: 0, minOffer: birr(1) },
      maxPayout: MAX,
    });
    expect(offer).toEqual({ available: true, amount: birr(1), potentialReturn: birr(4) });
    expect(offer).not.toHaveProperty('reason');
  });
});

describe('cashOutOffer – amounts', () => {
  it('values a single at stake × placed / current minus margin', () => {
    // 100 ETB @ 3.00, now 1.50: fair = 200 ETB, 5% margin → 190 ETB.
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(3000, 1500)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({ available: true, amount: birr(190), potentialReturn: birr(300) });
  });

  it('values an accumulator with won, void and open legs', () => {
    // 50 ETB × 2.00 (won) × 1.00 (void) × 1.80/1.20 × 2.50/2.00 = 187.50 ETB fair;
    // 5% margin → 178.125 ETB.
    const offer = cashOutOffer({
      stake: birr(50),
      legs: [won(2000), voided(3500), open(1800, 1200), open(2500, 2000)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer.available).toBe(true);
    expect(offer.amount).toBe(17_812n); // 178.125 ETB rounded down
    expect(offer.potentialReturn).toBe(birr(450)); // 50 × 2 × 1.8 × 2.5
  });

  it('rounds down once over the exact fraction', () => {
    // 333 × 1.001 / 1.003 × 0.9999 = 332.30… → 332 (one floor over the whole fraction).
    const offer = cashOutOffer({
      stake: 333n,
      legs: [open(1001, 1003)],
      config: { enabled: true, marginBps: 1, minOffer: 0n },
      maxPayout: MAX,
    });
    expect(offer.amount).toBe((333n * 1001n * 9999n) / (1003n * 10_000n));
    expect(offer.amount).toBe(332n);
  });

  it('discounts the capped return when maxPayout binds', () => {
    // Uncapped: 100 × 10 / 1.001 ≈ 999 ETB, but the bet can never pay more than 500 ETB,
    // so the offer is 500 × 1000/1001 = 499.50 ETB (rounded down), not the full 500.
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(10_000, 1001)],
      config: NO_MARGIN,
      maxPayout: birr(500),
    });
    expect(offer).toEqual({ available: true, amount: 49_950n, potentialReturn: birr(500) });
  });

  it('never pays the full max payout on a capped accumulator with an open leg (regression)', () => {
    // 10,000 ETB on 5 won legs at 3.00 + one open leg at 4.00: uncapped return 9.72m ETB,
    // capped at 500,000. Fair value = 500,000 × 1/4 × 0.95 = 118,750 ETB.
    const offer = cashOutOffer({
      stake: birr(10_000),
      legs: [won(3000), won(3000), won(3000), won(3000), won(3000), open(4000, 4000)],
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer).toEqual({ available: true, amount: birr(118_750), potentialReturn: MAX });
  });

  it('applies the live odds of the open leg to the capped value (regression)', () => {
    // 9 won legs at 2.00 + an open leg now at 50.00: 500,000 / 50 × 0.95 = 9,500 ETB.
    const legs = [...Array.from({ length: 9 }, () => won(2000)), open(2000, 50_000)];
    const offer = cashOutOffer({
      stake: birr(1000),
      legs,
      config: DEFAULT_CASH_OUT,
      maxPayout: MAX,
    });
    expect(offer.amount).toBe(birr(9_500));
  });

  it('offers nothing with a 100% margin', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [open(2000, 1500)],
      config: { enabled: true, marginBps: 10_000, minOffer: 1n },
      maxPayout: MAX,
    });
    expect(offer).toMatchObject({ available: false, amount: 0n, reason: 'below_minimum' });
  });

  it('returns stake × won odds when live odds equal placed odds and margin is 0', () => {
    const offer = cashOutOffer({
      stake: birr(100),
      legs: [won(1500), open(2000, 2000), open(3000, 3000)],
      config: NO_MARGIN,
      maxPayout: MAX,
    });
    expect(offer.amount).toBe(birr(150));
    expect(offer.potentialReturn).toBe(birr(900));
  });

  it('can equal the floored potential return even with a margin (regression)', () => {
    // potentialReturn = floor(1 × 1.002) = 1; offer = floor(1 × 1.002 / 1.001 × 0.9999) = 1.
    expect(
      cashOutOffer({
        stake: 1n,
        legs: [open(1002, 1001)],
        config: { enabled: true, marginBps: 1, minOffer: 0n },
        maxPayout: 2n,
      }),
    ).toEqual({ available: true, amount: 1n, potentialReturn: 1n });
    // Shrunk counterexample of the old (wrong) "strictly below potentialReturn" property.
    expect(
      cashOutOffer({
        stake: 1n,
        legs: [open(1001, 1001), won(1001)],
        config: { enabled: true, marginBps: 1, minOffer: 0n },
        maxPayout: 2n,
      }),
    ).toEqual({ available: true, amount: 1n, potentialReturn: 1n });
  });

  it('a zero stake has a zero offer (available when minOffer is 0)', () => {
    const offer = cashOutOffer({
      stake: 0n,
      legs: [open(2000, 1500)],
      config: NO_MARGIN,
      maxPayout: MAX,
    });
    expect(offer).toEqual({ available: true, amount: 0n, potentialReturn: 0n });
  });
});

describe('cashOutOffer – input validation', () => {
  const base = { stake: birr(10), legs: [open(2000)], config: DEFAULT_CASH_OUT, maxPayout: MAX };

  it('rejects margins outside 0..10000 or non-integers', () => {
    for (const marginBps of [-1, 10_001, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cashOutOffer({ ...base, config: { ...DEFAULT_CASH_OUT, marginBps } })).toThrow(
        RangeError,
      );
    }
    // validated even when disabled
    expect(() =>
      cashOutOffer({ ...base, config: { enabled: false, marginBps: -1, minOffer: 0n } }),
    ).toThrow(RangeError);
  });

  it('accepts the boundary margins', () => {
    for (const marginBps of [0, 10_000]) {
      expect(() =>
        cashOutOffer({ ...base, config: { ...DEFAULT_CASH_OUT, marginBps } }),
      ).not.toThrow();
    }
  });

  it('rejects a negative stake or maxPayout', () => {
    expect(() => cashOutOffer({ ...base, stake: -1n })).toThrow(RangeError);
    expect(() => cashOutOffer({ ...base, maxPayout: -1n })).toThrow(RangeError);
  });

  it('rejects invalid placed odds on non-void legs but not on void legs', () => {
    expect(() => cashOutOffer({ ...base, legs: [open(1000)] })).toThrow(RangeError);
    expect(() => cashOutOffer({ ...base, legs: [won(999), open(2000)] })).toThrow(RangeError);
    expect(() => cashOutOffer({ ...base, legs: [lost(1_000_001)] })).toThrow(RangeError);
    expect(() => cashOutOffer({ ...base, legs: [voided(1000), open(2000)] })).not.toThrow();
  });

  it('rejects an unknown leg state', () => {
    const bad = { placedOddsMilli: 2000, state: 'pending', currentOddsMilli: 2000 };
    expect(() => cashOutOffer({ ...base, legs: [bad as unknown as CashOutLeg] })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

const oddsArb = fc.integer({ min: 1001, max: 50_000 });
const stakeArb = fc.bigInt({ min: 0n, max: birr(100_000) });
const maxPayoutArb = fc.bigInt({ min: 0n, max: birr(1_000_000) });
const configArb: fc.Arbitrary<CashOutConfig> = fc.record({
  enabled: fc.constant(true),
  marginBps: fc.integer({ min: 0, max: 10_000 }),
  minOffer: fc.bigInt({ min: 0n, max: birr(10) }),
});
const openLegArb: fc.Arbitrary<CashOutLeg> = fc.record({
  placedOddsMilli: oddsArb,
  state: fc.constant('open' as const),
  currentOddsMilli: oddsArb,
});
const settledLegArb: fc.Arbitrary<CashOutLeg> = fc.record({
  placedOddsMilli: oddsArb,
  state: fc.constantFrom('won' as const, 'void' as const),
  currentOddsMilli: fc.option(fc.integer({ min: -10, max: 2_000_000 }), { nil: null }),
});
/** Legs with at least one open leg, so an offer can be computed. */
const offerableLegsArb = fc
  .tuple(
    fc.array(openLegArb, { minLength: 1, maxLength: 6 }),
    fc.array(settledLegArb, { maxLength: 6 }),
  )
  .chain(([openLegs, settled]) =>
    fc.shuffledSubarray([...openLegs, ...settled], {
      minLength: openLegs.length + settled.length,
      maxLength: openLegs.length + settled.length,
    }),
  );
const anyLegArb: fc.Arbitrary<CashOutLeg> = fc.record({
  placedOddsMilli: oddsArb,
  state: fc.constantFrom('open' as const, 'won' as const, 'lost' as const, 'void' as const),
  currentOddsMilli: fc.option(fc.integer({ min: -10, max: 2_000_000 }), { nil: null }),
});

describe('cashOutOffer – properties', () => {
  it('0 <= amount <= potentialReturn <= maxPayout, and unavailable offers are 0n', () => {
    fc.assert(
      fc.property(
        stakeArb,
        fc.array(anyLegArb, { maxLength: 8 }),
        configArb,
        fc.boolean(),
        maxPayoutArb,
        (stake, legs, config, enabled, maxPayout) => {
          const offer = cashOutOffer({ stake, legs, config: { ...config, enabled }, maxPayout });
          expect(offer.amount >= 0n).toBe(true);
          expect(offer.amount <= offer.potentialReturn).toBe(true);
          expect(offer.potentialReturn <= maxPayout).toBe(true);
          if (offer.available) {
            expect(offer.reason).toBeUndefined();
            expect(offer.amount >= config.minOffer).toBe(true);
          } else {
            expect(offer.reason).toBeDefined();
            expect(offer.amount).toBe(0n);
          }
        },
      ),
    );
  });

  it('potentialReturn is the capped return with void legs at 1.000 (0n if lost)', () => {
    fc.assert(
      fc.property(
        stakeArb,
        fc.array(anyLegArb, { minLength: 1, maxLength: 8 }),
        maxPayoutArb,
        (stake, legs, maxPayout) => {
          const offer = cashOutOffer({ stake, legs, config: DEFAULT_CASH_OUT, maxPayout });
          if (legs.some((l) => l.state === 'lost')) {
            expect(offer.potentialReturn).toBe(0n);
            return;
          }
          const odds = legs.filter((l) => l.state !== 'void').map((l) => l.placedOddsMilli);
          const full = grossReturn(stake, odds);
          expect(offer.potentialReturn).toBe(full < maxPayout ? full : maxPayout);
        },
      ),
    );
  });

  it('matches the exact single-fraction formula', () => {
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        configArb,
        maxPayoutArb,
        (stake, legs, config, maxPayout) => {
          const offer = cashOutOffer({ stake, legs, config, maxPayout });
          const nonVoid = legs.filter((l) => l.state !== 'void');
          const openLegs = legs.filter((l) => l.state === 'open');
          let num = stake * BigInt(10_000 - config.marginBps) * 1000n ** BigInt(openLegs.length);
          for (const l of nonVoid) num *= BigInt(l.placedOddsMilli);
          let den = 10_000n * 1000n ** BigInt(nonVoid.length);
          for (const l of openLegs) den *= BigInt(l.currentOddsMilli!);
          const raw = num / den;
          // When maxPayout binds, the capped return is discounted instead.
          const cNum =
            maxPayout * BigInt(10_000 - config.marginBps) * 1000n ** BigInt(openLegs.length);
          let cDen = 10_000n;
          for (const l of openLegs) cDen *= BigInt(l.currentOddsMilli!);
          const rawCapped = cNum / cDen;
          let capped = raw < rawCapped ? raw : rawCapped;
          capped = capped < offer.potentialReturn ? capped : offer.potentialReturn;
          expect(offer.amount).toBe(capped >= config.minOffer ? capped : 0n);
          expect(offer.available).toBe(capped >= config.minOffer);
        },
      ),
    );
  });

  it("raising an open leg's current odds never increases the offer", () => {
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        configArb,
        maxPayoutArb,
        fc.nat(),
        fc.integer({ min: 1, max: 100_000 }),
        (stake, legs, config, maxPayout, pick, bump) => {
          const openIdx = legs.flatMap((l, i) => (l.state === 'open' ? [i] : []));
          const idx = openIdx[pick % openIdx.length]!;
          const leg = legs[idx]!;
          const raised = Math.min(1_000_000, leg.currentOddsMilli! + bump);
          const bumped = legs.map((l, i) => (i === idx ? { ...l, currentOddsMilli: raised } : l));
          const before = cashOutOffer({ stake, legs, config, maxPayout });
          const after = cashOutOffer({ stake, legs: bumped, config, maxPayout });
          expect(after.amount <= before.amount).toBe(true);
        },
      ),
    );
  });

  it('a higher margin never increases the offer', () => {
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        configArb,
        fc.integer({ min: 0, max: 10_000 }),
        maxPayoutArb,
        (stake, legs, config, otherMargin, maxPayout) => {
          const lo = Math.min(config.marginBps, otherMargin);
          const hi = Math.max(config.marginBps, otherMargin);
          const low = cashOutOffer({
            stake,
            legs,
            config: { ...config, marginBps: lo },
            maxPayout,
          });
          const high = cashOutOffer({
            stake,
            legs,
            config: { ...config, marginBps: hi },
            maxPayout,
          });
          expect(high.amount <= low.amount).toBe(true);
        },
      ),
    );
  });

  it('with unchanged odds and no margin the offer is stake × won odds (capped)', () => {
    // Fair value discounts each open leg by 1 / current odds, so when nothing has moved
    // the open legs cancel out and only the won legs' gains remain.
    fc.assert(
      fc.property(stakeArb, offerableLegsArb, maxPayoutArb, (stake, legs, maxPayout) => {
        const unchanged = legs.map((l) =>
          l.state === 'open' ? { ...l, currentOddsMilli: l.placedOddsMilli } : l,
        );
        const offer = cashOutOffer({ stake, legs: unchanged, config: NO_MARGIN, maxPayout });
        const wonOdds = unchanged.filter((l) => l.state === 'won').map((l) => l.placedOddsMilli);
        const uncapped = grossReturn(stake, wonOdds);
        // Capped value: maxPayout × Π_open(1000 / placed).
        let cNum = maxPayout;
        let cDen = 1n;
        for (const l of unchanged.filter((leg) => leg.state === 'open')) {
          cNum *= 1000n;
          cDen *= BigInt(l.placedOddsMilli);
        }
        const capped = cNum / cDen;
        let expected = uncapped < capped ? uncapped : capped;
        expected = expected < offer.potentialReturn ? expected : offer.potentialReturn;
        expect(offer.available).toBe(true);
        expect(offer.amount).toBe(expected);
      }),
    );
  });

  it('won legs keep their placed odds (potentialReturn unchanged, offer never lower)', () => {
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        configArb,
        maxPayoutArb,
        fc.nat(),
        fc.option(oddsArb, { nil: null }),
        (stake, legs, config, maxPayout, pick, staleOdds) => {
          const openIdx = legs.flatMap((l, i) => (l.state === 'open' ? [i] : []));
          fc.pre(openIdx.length >= 2);
          const idx = openIdx[pick % openIdx.length]!;
          // Whatever live odds a won leg still carries are ignored.
          const settled = legs.map((l, i) =>
            i === idx ? { ...l, state: 'won' as const, currentOddsMilli: staleOdds } : l,
          );
          const before = cashOutOffer({ stake, legs, config, maxPayout });
          const after = cashOutOffer({ stake, legs: settled, config, maxPayout });
          expect(after.potentialReturn).toBe(before.potentialReturn);
          expect(after.amount >= before.amount).toBe(true);
        },
      ),
    );
  });

  it('void legs do not change the offer', () => {
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        oddsArb,
        configArb,
        maxPayoutArb,
        (stake, legs, placed, config, maxPayout) => {
          const a = cashOutOffer({ stake, legs, config, maxPayout });
          const b = cashOutOffer({ stake, legs: [...legs, voided(placed)], config, maxPayout });
          expect(b).toEqual(a);
        },
      ),
    );
  });

  it('with a positive margin and an open leg the offer is strictly below the exact return and the cap', () => {
    // Not "strictly below potentialReturn": that value is floor(return), and the offer is
    // floor(return × discount), so both floors can land on the same integer (see the
    // 'can equal the floored potential return' example above).
    fc.assert(
      fc.property(
        stakeArb,
        offerableLegsArb,
        fc.integer({ min: 1, max: 10_000 }),
        maxPayoutArb,
        (stake, legs, marginBps, maxPayout) => {
          const offer = cashOutOffer({
            stake,
            legs,
            config: { enabled: true, marginBps, minOffer: 0n },
            maxPayout,
          });
          fc.pre(offer.available && offer.potentialReturn > 0n);
          // Exact (unfloored) return: stake × Π placed / 1000^n over the non-void legs.
          const nonVoid = legs.filter((l) => l.state !== 'void');
          const num = nonVoid.reduce((acc, l) => acc * BigInt(l.placedOddsMilli), stake);
          const den = 1000n ** BigInt(nonVoid.length);
          expect(offer.amount * den < num).toBe(true);
          expect(offer.amount < maxPayout).toBe(true);
          expect(offer.amount <= offer.potentialReturn).toBe(true);
        },
      ),
    );
  });
});
