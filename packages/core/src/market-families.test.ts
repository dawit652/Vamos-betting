import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_FAMILY,
  DEFAULT_FAMILY_MARGIN_BPS,
  DEFAULT_MARKET_FAMILIES,
  FAMILY_RETURN_RAISE_BPS,
  familyDecision,
  familyMarginBps,
  factoryPricingPlan,
  type FamilyWeek,
  isMarketFamily,
  keptTooLittle,
  MARKET_FAMILIES,
  type MarketFamilyState,
  parseMarketFamilies,
} from './market-families';
import { FACTORY_SELECTION_LIABILITY_SHARE_BPS } from './risk';

const FLOOR = 10_000_000n;

describe('market family settings', () => {
  it('defaults reproduce today: 600 / 700 / 1200, no override, a quarter of the cap', () => {
    expect(DEFAULT_MARKET_FAMILIES.marginBps).toEqual({ main: 600, derivative: 700, long: 1200 });
    expect(DEFAULT_MARKET_FAMILIES.typeMarginBps).toEqual({});
    expect(DEFAULT_MARKET_FAMILIES.factoryLiabilityShareBps).toBe(
      FACTORY_SELECTION_LIABILITY_SHARE_BPS,
    );
    expect(parseMarketFamilies(DEFAULT_MARKET_FAMILIES)).toEqual({
      ok: true,
      value: DEFAULT_MARKET_FAMILIES,
    });
  });

  it('families are the factory-only types, not today’s', () => {
    expect(MARKET_FAMILIES.length).toBeGreaterThan(50);
    expect(isMarketFamily('htft')).toBe(true);
    expect(isMarketFamily('1x2')).toBe(false);
    expect(isMarketFamily('ou')).toBe(false);
    expect(new Set(MARKET_FAMILIES).size).toBe(MARKET_FAMILIES.length);
  });

  it('accepts the stored form (santim as a string) and sorts the overrides', () => {
    const parsed = parseMarketFamilies({
      marginBps: { main: 500, derivative: 800, long: 1500 },
      typeMarginBps: { htft: 1400, h1_ou: 650 },
      factoryLiabilityShareBps: 1000,
      minWeeklyStake: '500000',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        marginBps: { main: 500, derivative: 800, long: 1500 },
        typeMarginBps: { h1_ou: 650, htft: 1400 },
        factoryLiabilityShareBps: 1000,
        minWeeklyStake: 500_000n,
      },
    });
    if (parsed.ok) expect(Object.keys(parsed.value.typeMarginBps)).toEqual(['h1_ou', 'htft']);
  });

  it('refuses out-of-range margins and shares, unknown types and fields, bad amounts', () => {
    const bad = parseMarketFamilies({
      marginBps: { main: -1, derivative: 10_001, long: 1.5, extra: 1 },
      typeMarginBps: { '1x2': 500, nope: 500, htft: 20_000 },
      factoryLiabilityShareBps: 10_001,
      minWeeklyStake: '-5',
      other: true,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues).toEqual(
      expect.arrayContaining([
        'other: unknown field',
        'marginBps.extra: unknown margin class',
        'marginBps.main: must be an integer from 0 to 10000',
        'marginBps.derivative: must be an integer from 0 to 10000',
        'marginBps.long: must be an integer from 0 to 10000',
        'typeMarginBps.1x2: not a factory market family',
        'typeMarginBps.nope: not a factory market family',
        'typeMarginBps.htft: must be an integer from 0 to 10000',
        'factoryLiabilityShareBps: must be an integer from 0 to 10000',
        'minWeeklyStake: must not be negative',
      ]),
    );
    expect(parseMarketFamilies(null).ok).toBe(false);
    expect(parseMarketFamilies({ ...DEFAULT_MARKET_FAMILIES, minWeeklyStake: 'x' }).ok).toBe(false);
    expect(parseMarketFamilies({ ...DEFAULT_MARKET_FAMILIES, typeMarginBps: [] }).ok).toBe(false);
  });

  it('property: every valid value parses to itself; any margin outside 0..10000 is refused', () => {
    const bps = fc.integer({ min: 0, max: 10_000 });
    fc.assert(
      fc.property(
        bps,
        bps,
        bps,
        bps,
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.dictionary(fc.constantFrom(...MARKET_FAMILIES), bps),
        (main, derivative, long, share, floor, types) => {
          const value = {
            marginBps: { main, derivative, long },
            typeMarginBps: types,
            factoryLiabilityShareBps: share,
            minWeeklyStake: floor.toString(),
          };
          const parsed = parseMarketFamilies(value);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          expect(parsed.value.minWeeklyStake).toBe(floor);
          expect(parsed.value.typeMarginBps).toEqual(types);
          expect(parseMarketFamilies(parsed.value)).toEqual(parsed);
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ max: -1 }), fc.integer({ min: 10_001 })),
        fc.constantFrom('main', 'derivative', 'long'),
        (margin, marginClass) => {
          const value = {
            ...DEFAULT_MARKET_FAMILIES,
            marginBps: { ...DEFAULT_MARKET_FAMILIES.marginBps, [marginClass]: margin },
          };
          expect(parseMarketFamilies(value).ok).toBe(false);
          expect(
            parseMarketFamilies({ ...DEFAULT_MARKET_FAMILIES, factoryLiabilityShareBps: margin })
              .ok,
          ).toBe(false);
        },
      ),
    );
  });
});

describe('factoryPricingPlan', () => {
  it('defaults: every family, class margins, no override and an empty tag', () => {
    const plan = factoryPricingPlan(DEFAULT_MARKET_FAMILIES);
    expect(plan).toEqual({
      marginBps: { ...DEFAULT_FAMILY_MARGIN_BPS },
      typeMarginBps: {},
      types: [...MARKET_FAMILIES],
      excluded: [],
      tag: '',
    });
  });

  it('leaves suspended and off families out and prices a returned one at its raised margin', () => {
    const states = new Map<string, MarketFamilyState>([
      ['htft', { status: 'suspended', sinceWeek: '2026-W40', raisedMarginBps: 1400 }],
      ['h1_cs', { status: 'off', sinceWeek: '2026-W44', raisedMarginBps: 1400 }],
      ['h1_ou', { status: 'active', sinceWeek: '2026-W45', raisedMarginBps: 800 }],
      ['h2_ou', { status: 'active', sinceWeek: '2026-W45', raisedMarginBps: 800 }],
    ]);
    const plan = factoryPricingPlan(
      { ...DEFAULT_MARKET_FAMILIES, typeMarginBps: { h2_ou: 900 } },
      states,
    );
    expect(plan.excluded).toEqual(['h1_cs', 'htft']);
    expect(plan.types).not.toContain('htft');
    expect(plan.types).toHaveLength(MARKET_FAMILIES.length - 2);
    expect(familyMarginBps(plan, 'h1_ou')).toBe(800);
    // The settings' margin is higher than the raised one: never cheaper than either.
    expect(familyMarginBps(plan, 'h2_ou')).toBe(900);
    expect(plan.tag).toMatch(/^[0-9a-f]{8}$/);
  });

  it('property: the tag is empty only for the defaults and changes with the margins', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom(...MARKET_FAMILIES),
        (margin, type) => {
          const withMain = factoryPricingPlan({
            ...DEFAULT_MARKET_FAMILIES,
            marginBps: { ...DEFAULT_FAMILY_MARGIN_BPS, main: margin },
          });
          expect(withMain.tag === '').toBe(margin === DEFAULT_FAMILY_MARGIN_BPS.main);
          const withType = factoryPricingPlan({
            ...DEFAULT_MARKET_FAMILIES,
            typeMarginBps: { [type]: margin },
          });
          expect(withType.tag).not.toBe('');
          expect(familyMarginBps(withType, type)).toBe(margin);
          // Deterministic.
          expect(
            factoryPricingPlan({ ...DEFAULT_MARKET_FAMILIES, typeMarginBps: { [type]: margin } })
              .tag,
          ).toBe(withType.tag);
        },
      ),
    );
  });
});

// ------------------------------------------------------------------ decisions

const weekId = (n: number): string => `2026-W${String(n).padStart(2, '0')}`;
/** Weeks 40.. with these stakes and kept amounts, at 700 bps. */
const weeksOf = (rows: ReadonlyArray<[bigint, bigint]>, start = 40, marginBps = 700): FamilyWeek[] =>
  rows.map(([stakes, kept], i) => ({ week: weekId(start + i), stakes, kept, marginBps }));
const lastWeek = (weeks: readonly FamilyWeek[]): string => weeks[weeks.length - 1]!.week;

/** 700 bps keeps 700/10700 ≈ 6.54% on fair odds. */
const SHORT: [bigint, bigint] = [FLOOR, 500_000n]; // 5% kept
const GOOD: [bigint, bigint] = [FLOOR, 700_000n]; // 7% kept
const THIN: [bigint, bigint] = [FLOOR - 1n, -FLOOR]; // lost a lot, under the floor

const decide = (
  state: MarketFamilyState,
  weeks: FamilyWeek[],
  historyTestPassed = false,
  minWeeklyStake = FLOOR,
) =>
  familyDecision({
    family: 'htft',
    state,
    week: lastWeek(weeks),
    weeks,
    minWeeklyStake,
    historyTestPassed,
  });

describe('keptTooLittle', () => {
  it('compares the money kept with what the margin keeps on fair odds, in bigint', () => {
    expect(keptTooLittle(weeksOf([SHORT])[0]!, FLOOR)).toBe(true);
    expect(keptTooLittle(weeksOf([GOOD])[0]!, FLOOR)).toBe(false);
    // Exactly 700/10700 of the stakes is enough.
    expect(keptTooLittle(weeksOf([[10_700n * 1000n, 700n * 1000n]])[0]!, 0n)).toBe(false);
    expect(keptTooLittle(weeksOf([[10_700n * 1000n, 700n * 1000n - 1n]])[0]!, 0n)).toBe(true);
    expect(keptTooLittle(weeksOf([THIN])[0]!, FLOOR)).toBe(false);
  });
});

describe('familyDecision', () => {
  it('suspends after three short weeks, to return once at +200 bps', () => {
    const d = decide(ACTIVE_FAMILY, weeksOf([GOOD, SHORT, SHORT, SHORT]));
    expect(d.move).toBe('suspend');
    expect(d.next).toEqual({ status: 'suspended', sinceWeek: '2026-W43', raisedMarginBps: 900 });
    expect(d.reason).toContain('2026-W41, 2026-W42, 2026-W43');
    expect(FAMILY_RETURN_RAISE_BPS).toBe(200);
  });

  it('keeps on two short weeks, a good week, a thin week, or too few weeks', () => {
    expect(decide(ACTIVE_FAMILY, weeksOf([SHORT, GOOD, SHORT, SHORT])).move).toBe('keep');
    expect(decide(ACTIVE_FAMILY, weeksOf([SHORT, SHORT, THIN])).move).toBe('keep');
    expect(decide(ACTIVE_FAMILY, weeksOf([SHORT, SHORT, THIN])).reason).toContain('under the floor');
    expect(decide(ACTIVE_FAMILY, weeksOf([SHORT, SHORT])).reason).toBe('2 of 3 weeks to judge');
  });

  it('a suspended family stays suspended without a passed history test, and says so', () => {
    const suspended: MarketFamilyState = {
      status: 'suspended',
      sinceWeek: '2026-W43',
      raisedMarginBps: 900,
    };
    const stay = decide(suspended, weeksOf([SHORT], 44));
    expect(stay.move).toBe('stay_suspended');
    expect(stay.next).toEqual(suspended);
    expect(stay.reason).toContain('no passed history test at 900 bps');
    const back = decide(suspended, weeksOf([SHORT], 44), true);
    expect(back.move).toBe('return');
    expect(back.next).toEqual({ status: 'active', sinceWeek: '2026-W44', raisedMarginBps: 900 });
  });

  it('after its return only later weeks count, and failing again turns it off for good', () => {
    const returned: MarketFamilyState = {
      status: 'active',
      sinceWeek: '2026-W44',
      raisedMarginBps: 900,
    };
    // The short weeks before the return are not judged.
    expect(decide(returned, weeksOf([SHORT, SHORT, SHORT, SHORT, SHORT], 41)).move).toBe('keep');
    const off = decide(returned, weeksOf([SHORT, SHORT, SHORT], 45, 900));
    expect(off.move).toBe('off');
    expect(off.next).toEqual({ status: 'off', sinceWeek: '2026-W47', raisedMarginBps: 900 });
    const stays = decide(off.next, weeksOf([GOOD], 48), true);
    expect(stays.move).toBe('stay_off');
  });

  it('caps the raised margin at 10000 and refuses malformed weeks', () => {
    expect(decide(ACTIVE_FAMILY, weeksOf([SHORT, SHORT, SHORT], 40, 9_900)).next.raisedMarginBps).toBe(
      10_000,
    );
    const weeks = weeksOf([SHORT, SHORT]);
    expect(() => decide(ACTIVE_FAMILY, [weeks[1]!, weeks[0]!])).toThrow(RangeError);
    expect(() =>
      familyDecision({
        family: 'htft',
        state: ACTIVE_FAMILY,
        week: '2026-W50',
        weeks,
        minWeeklyStake: FLOOR,
        historyTestPassed: false,
      }),
    ).toThrow(RangeError);
  });

  const weekArb = fc.record({
    stakes: fc.bigInt({ min: 0n, max: 3n * FLOOR }),
    keptShareBps: fc.integer({ min: -20_000, max: 2_000 }),
    marginBps: fc.integer({ min: 0, max: 10_000 }),
  });
  const weeksArb = fc.array(weekArb, { minLength: 1, maxLength: 8 }).map((rows) =>
    rows.map((r, i) => ({
      week: weekId(10 + i),
      stakes: r.stakes,
      kept: (r.stakes * BigInt(r.keptShareBps)) / 10_000n,
      marginBps: r.marginBps,
    })),
  );
  const stateArb: fc.Arbitrary<MarketFamilyState> = fc.oneof(
    fc.constant(ACTIVE_FAMILY),
    fc.record({
      status: fc.constantFrom('active', 'suspended', 'off') as fc.Arbitrary<
        MarketFamilyState['status']
      >,
      sinceWeek: fc.option(fc.integer({ min: 1, max: 20 }).map(weekId), { nil: null }),
      raisedMarginBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
    }),
  );

  it('property: never suspends or turns off when a judged week is under the volume floor', () => {
    fc.assert(
      fc.property(stateArb, weeksArb, fc.boolean(), (state, weeks, passed) => {
        const d = decide(state, weeks, passed);
        if (d.move === 'suspend' || d.move === 'off') {
          const judged = weeks
            .filter((w) => state.sinceWeek === null || w.week > state.sinceWeek)
            .slice(-3);
          expect(judged).toHaveLength(3);
          for (const w of judged) {
            expect(w.stakes >= FLOOR).toBe(true);
            expect(keptTooLittle(w, FLOOR)).toBe(true);
          }
        }
      }),
    );
  });

  it('property: deterministic, and a family returns at most once over any run of weeks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(weekArb, fc.boolean()), { minLength: 1, maxLength: 40 }),
        (run) => {
          let state: MarketFamilyState = ACTIVE_FAMILY;
          const history: FamilyWeek[] = [];
          let returns = 0;
          run.forEach(([w, passed], i) => {
            history.push({
              week: `${2000 + Math.floor(i / 50)}-W${String((i % 50) + 1).padStart(2, '0')}`,
              stakes: w.stakes,
              kept: (w.stakes * BigInt(w.keptShareBps)) / 10_000n,
              marginBps: w.marginBps,
            });
            const d = decide(state, history.slice(-6), passed);
            expect(decide(state, history.slice(-6), passed)).toEqual(d);
            if (d.move === 'return') returns += 1;
            if (state.status === 'off') expect(d.move).toBe('stay_off');
            if (state.status === 'active' && state.raisedMarginBps !== null) {
              expect(d.move).not.toBe('suspend');
            }
            state = d.next;
          });
          expect(returns).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
