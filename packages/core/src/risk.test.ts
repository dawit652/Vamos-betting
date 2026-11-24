import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quoteBet } from './betslip';
import { birr } from './money';
import {
  DEFAULT_BOARD_RISK_LIMITS,
  DEFAULT_RISK_LIMITS,
  FACTORY_SELECTION_LIABILITY_SHARE_BPS,
  hasRiskLimits,
  largestStakeWithin,
  liabilityBreach,
  type LiabilityExposure,
  needsLiabilityCheck,
  type RiskLimits,
  selectionLiabilityCap,
  strictestCap,
} from './risk';
import { DEFAULT_BET_RULES, DEFAULT_MULTI_BONUS, DEFAULT_TAX } from './rules';

const exposure = (id: string, current: bigint): LiabilityExposure => ({ id, current });

describe('hasRiskLimits', () => {
  it('is false for the default (no caps) and true once either cap is set', () => {
    expect(hasRiskLimits(DEFAULT_RISK_LIMITS)).toBe(false);
    expect(hasRiskLimits({ ...DEFAULT_RISK_LIMITS, maxSelectionLiability: 1n })).toBe(true);
    expect(hasRiskLimits({ ...DEFAULT_RISK_LIMITS, maxEventLiability: 1n })).toBe(true);
  });
});

describe('liabilityBreach', () => {
  const limits: RiskLimits = { maxSelectionLiability: birr(1_000), maxEventLiability: birr(1_500) };

  it('accepts a payout that fits every scope, to the last santim', () => {
    const fits = liabilityBreach({
      payout: birr(400),
      selections: [exposure('s1', birr(600))],
      events: [exposure('e1', birr(1_100))],
      limits,
    });
    expect(fits).toBeNull();
    const over = liabilityBreach({
      payout: birr(400) + 1n,
      selections: [exposure('s1', birr(600))],
      events: [exposure('e1', birr(1_100))],
      limits,
    });
    expect(over).toMatchObject({ scope: 'selection', id: 's1', headroom: birr(400) });
  });

  it('names the scope with the least room', () => {
    const breach = liabilityBreach({
      payout: birr(300),
      selections: [exposure('s1', birr(500)), exposure('s2', birr(900))],
      events: [exposure('e1', birr(1_400))],
      limits,
    });
    // s2 has 100 left, e1 has 100 left: the selection wins the tie.
    expect(breach).toMatchObject({ scope: 'selection', id: 's2', headroom: birr(100) });
    const eventTighter = liabilityBreach({
      payout: birr(300),
      selections: [exposure('s1', birr(500))],
      events: [exposure('e1', birr(1_450))],
      limits,
    });
    expect(eventTighter).toMatchObject({ scope: 'event', id: 'e1', headroom: birr(50) });
  });

  it('gives no room when a cap was lowered below what is already open', () => {
    const breach = liabilityBreach({
      payout: 1n,
      selections: [exposure('s1', birr(1_200))],
      events: [],
      limits,
    });
    expect(breach).toMatchObject({ headroom: 0n, current: birr(1_200), cap: birr(1_000) });
  });

  it('ignores a scope without a cap', () => {
    const noEventCap: RiskLimits = { ...limits, maxEventLiability: null };
    expect(
      liabilityBreach({
        payout: birr(10),
        selections: [],
        events: [exposure('e1', birr(10_000))],
        limits: noEventCap,
      }),
    ).toBeNull();
    expect(
      liabilityBreach({
        payout: birr(10),
        selections: [exposure('s1', birr(10_000))],
        events: [exposure('e1', birr(10_000))],
        limits: DEFAULT_RISK_LIMITS,
      }),
    ).toBeNull();
  });

  it('refuses a negative payout', () => {
    expect(() => liabilityBreach({ payout: -1n, selections: [], events: [], limits })).toThrow(
      RangeError,
    );
  });

  const amount = fc.bigInt({ min: 0n, max: birr(5_000) });
  const exposures = (prefix: string) =>
    fc
      .array(amount, { maxLength: 6 })
      .map((list) => list.map((current, i) => exposure(`${prefix}${i}`, current)));
  const capArb = fc.option(fc.bigInt({ min: 1n, max: birr(5_000) }), { nil: null });

  it('agrees with a brute-force check of every scope (property)', () => {
    fc.assert(
      fc.property(
        // A bet always pays something, so the payout is at least one santim.
        fc.bigInt({ min: 1n, max: birr(3_000) }),
        exposures('s'),
        exposures('e'),
        capArb,
        capArb,
        (payout, selections, events, maxSelectionLiability, maxEventLiability) => {
          const result = liabilityBreach({
            payout,
            selections,
            events,
            limits: { maxSelectionLiability, maxEventLiability },
          });
          const breached = [
            ...selections.flatMap((x) =>
              maxSelectionLiability !== null && x.current + payout > maxSelectionLiability
                ? [{ scope: 'selection', id: x.id, cap: maxSelectionLiability, current: x.current }]
                : [],
            ),
            ...events.flatMap((x) =>
              maxEventLiability !== null && x.current + payout > maxEventLiability
                ? [{ scope: 'event', id: x.id, cap: maxEventLiability, current: x.current }]
                : [],
            ),
          ];
          if (breached.length === 0) {
            expect(result).toBeNull();
            return;
          }
          expect(result).not.toBeNull();
          const room = (b: { cap: bigint; current: bigint }) =>
            b.cap > b.current ? b.cap - b.current : 0n;
          const least = breached.reduce((m, b) => (room(b) < m ? room(b) : m), room(breached[0]!));
          expect(result!.headroom).toBe(least);
          expect(result!.headroom).toBeLessThan(payout);
          expect(breached.some((b) => b.scope === result!.scope && b.id === result!.id)).toBe(true);
        },
      ),
    );
  });

  it('does not depend on the order of the input (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: birr(3_000) }),
        exposures('s'),
        exposures('e'),
        fc.bigInt({ min: 1n, max: birr(5_000) }),
        (payout, selections, events, cap) => {
          const limitsBoth = { maxSelectionLiability: cap, maxEventLiability: cap };
          const a = liabilityBreach({ payout, selections, events, limits: limitsBoth });
          const b = liabilityBreach({
            payout,
            selections: [...selections].reverse(),
            events: [...events].reverse(),
            limits: limitsBoth,
          });
          expect(b).toEqual(a);
        },
      ),
    );
  });
});

describe('board caps (settings board_risk_limits)', () => {
  const none: RiskLimits = { maxSelectionLiability: null, maxEventLiability: null };
  const board = (
    limits: RiskLimits,
    events: readonly string[] = ['b'],
    selections: readonly string[] = ['bs'],
  ) => ({ limits, events: new Set(events), selections: new Set(selections) });

  it('defaults to ETB 20,000 per match and no selection cap (owner, 21 Nov 2026)', () => {
    expect(DEFAULT_BOARD_RISK_LIMITS).toEqual({
      maxSelectionLiability: null,
      maxEventLiability: birr(20_000),
    });
  });

  it('strictestCap keeps the lower cap and treats null as no cap', () => {
    expect(strictestCap(null, null)).toBeNull();
    expect(strictestCap(5n, null)).toBe(5n);
    expect(strictestCap(null, 7n)).toBe(7n);
    expect(strictestCap(9n, 4n)).toBe(4n);
    expect(strictestCap(4n, 9n)).toBe(4n);
  });

  it('needs a check only for plain caps, or for board caps on a bet with a board match', () => {
    expect(needsLiabilityCheck(none)).toBe(false);
    expect(needsLiabilityCheck(none, board(DEFAULT_BOARD_RISK_LIMITS, []))).toBe(false);
    expect(needsLiabilityCheck(none, board(none))).toBe(false);
    expect(needsLiabilityCheck(none, board(DEFAULT_BOARD_RISK_LIMITS))).toBe(true);
    expect(needsLiabilityCheck({ ...none, maxEventLiability: 1n })).toBe(true);
  });

  it('caps a board match at the board cap and leaves other matches alone', () => {
    const input = {
      payout: birr(15_000),
      selections: [exposure('bs', 0n), exposure('s', 0n)],
      events: [exposure('b', birr(6_000)), exposure('e', birr(6_000))],
      limits: none,
      board: board(DEFAULT_BOARD_RISK_LIMITS),
    };
    // 6 000 + 15 000 > 20 000 on the board match; the other match has no cap at all.
    expect(liabilityBreach(input)).toEqual({
      scope: 'event',
      id: 'b',
      cap: birr(20_000),
      current: birr(6_000),
      headroom: birr(14_000),
    });
    expect(liabilityBreach({ ...input, payout: birr(14_000) })).toBeNull();
    expect(liabilityBreach({ ...input, board: undefined })).toBeNull();
  });

  it('applies the stricter of the plain and the board cap', () => {
    const events = [exposure('b', 0n)];
    const plainLower = { maxSelectionLiability: null, maxEventLiability: birr(5_000) };
    expect(
      liabilityBreach({
        payout: birr(6_000),
        selections: [],
        events,
        limits: plainLower,
        board: board(DEFAULT_BOARD_RISK_LIMITS),
      })?.cap,
    ).toBe(birr(5_000));
    const boardSelection = { maxSelectionLiability: birr(1_000), maxEventLiability: null };
    expect(
      liabilityBreach({
        payout: birr(1_500),
        selections: [exposure('bs', 0n), exposure('s', 0n)],
        events: [],
        limits: { maxSelectionLiability: birr(3_000), maxEventLiability: null },
        board: board(boardSelection),
      }),
    ).toEqual({
      scope: 'selection',
      id: 'bs',
      cap: birr(1_000),
      current: 0n,
      headroom: birr(1_000),
    });
  });

  const amount = fc.bigInt({ min: 0n, max: birr(30_000) });
  const capArb = fc.option(fc.bigInt({ min: 1n, max: birr(30_000) }), { nil: null });
  const ids = fc.uniqueArray(fc.constantFrom<string>('a', 'b', 'c', 'd'), { maxLength: 4 });

  it('without a board match, the board caps change nothing (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: birr(30_000) }),
        fc.array(amount, { maxLength: 4 }),
        fc.array(amount, { maxLength: 4 }),
        capArb,
        capArb,
        capArb,
        capArb,
        (payout, sel, evt, ps, pe, bs, be) => {
          const selections = sel.map((current, i) => exposure(`s${i}`, current));
          const events = evt.map((current, i) => exposure(`e${i}`, current));
          const limits = { maxSelectionLiability: ps, maxEventLiability: pe };
          const without = liabilityBreach({ payout, selections, events, limits });
          const withBoard = liabilityBreach({
            payout,
            selections,
            events,
            limits,
            board: board({ maxSelectionLiability: bs, maxEventLiability: be }, ['x'], ['y']),
          });
          expect(withBoard).toEqual(without);
        },
      ),
    );
  });

  it('a board cap can only refuse more, never less (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: birr(30_000) }),
        fc.array(amount, { minLength: 4, maxLength: 4 }),
        fc.array(amount, { minLength: 4, maxLength: 4 }),
        capArb,
        capArb,
        capArb,
        capArb,
        ids,
        ids,
        (payout, sel, evt, ps, pe, bs, be, boardEvents, boardSelections) => {
          const names = ['a', 'b', 'c', 'd'];
          const selections = sel.map((current, i) => exposure(names[i]!, current));
          const events = evt.map((current, i) => exposure(names[i]!, current));
          const limits = { maxSelectionLiability: ps, maxEventLiability: pe };
          const without = liabilityBreach({ payout, selections, events, limits });
          const withBoard = liabilityBreach({
            payout,
            selections,
            events,
            limits,
            board: board(
              { maxSelectionLiability: bs, maxEventLiability: be },
              boardEvents,
              boardSelections,
            ),
          });
          if (without !== null) {
            expect(withBoard).not.toBeNull();
            expect(withBoard!.headroom <= without.headroom).toBe(true);
          }
          // A board match over its board cap is always refused.
          for (const e of events) {
            if (be !== null && boardEvents.includes(e.id) && e.current + payout > be) {
              expect(withBoard).not.toBeNull();
            }
          }
        },
      ),
    );
  });
});

describe('largestStakeWithin', () => {
  /** A payout like a single's: stake times the odds, rounded down. */
  const times = (oddsMilli: bigint) => (stake: bigint) => (stake * oddsMilli) / 1000n;

  it('finds the largest stake that fits, in whole birr', () => {
    // 2.000 odds, room for a payout of 99.99: the exact limit is 49.99 → 49.
    expect(
      largestStakeWithin({
        headroom: birr(99) + 99n,
        minStake: birr(5),
        maxStake: birr(1_000),
        payoutOf: times(2000n),
      }),
    ).toBe(birr(49));
  });

  it('keeps the exact figure when rounding down would go below the minimum stake', () => {
    expect(
      largestStakeWithin({
        headroom: birr(9) + 80n,
        minStake: birr(4) + 50n,
        maxStake: birr(1_000),
        payoutOf: times(2000n),
      }),
    ).toBe(birr(4) + 90n);
  });

  it('is null when even the minimum stake pays too much, and when the range is empty', () => {
    const payoutOf = times(2000n);
    expect(
      largestStakeWithin({ headroom: birr(9), minStake: birr(5), maxStake: birr(50), payoutOf }),
    ).toBeNull();
    expect(
      largestStakeWithin({ headroom: birr(100), minStake: birr(5), maxStake: birr(4), payoutOf }),
    ).toBeNull();
  });

  it('never goes above the maximum stake', () => {
    expect(
      largestStakeWithin({
        headroom: birr(1_000_000),
        minStake: birr(5),
        maxStake: birr(100),
        payoutOf: times(1500n),
      }),
    ).toBe(birr(100));
  });

  it('matches a linear search on a monotone payout (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_010n, max: 50_000n }),
        fc.bigInt({ min: 0n, max: 400_000n }),
        fc.bigInt({ min: 1n, max: 500n }),
        fc.bigInt({ min: 0n, max: 2_000n }),
        fc.bigInt({ min: 0n, max: 300_000n }),
        (oddsMilli, headroom, minStake, extra, capAt) => {
          const maxStake = minStake + extra;
          // Monotone but not strictly: the payout is capped, as a bet's is by maxPayout.
          const payoutOf = (stake: bigint) => {
            const p = (stake * oddsMilli) / 1000n;
            return p > capAt ? capAt : p;
          };
          let best: bigint | null = null;
          for (let s = minStake; s <= maxStake; s += 1n) {
            if (payoutOf(s) <= headroom) best = s;
          }
          const found = largestStakeWithin({ headroom, minStake, maxStake, payoutOf });
          if (best === null) {
            expect(found).toBeNull();
            return;
          }
          const whole = (best / 100n) * 100n;
          expect(found).toBe(whole >= minStake ? whole : best);
          expect(payoutOf(found!)).toBeLessThanOrEqual(headroom);
        },
      ),
    );
  });

  it('works with the real bet quote, whose payout never falls as the stake grows (property)', () => {
    const legArb = fc.record({
      selectionId: fc.uuid(),
      eventId: fc.uuid(),
      oddsMilli: fc.integer({ min: 1_010, max: 12_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(legArb, { minLength: 1, maxLength: 8 }),
        fc.bigInt({ min: 0n, max: birr(600_000) }),
        (legs, headroom) => {
          const unique = legs.map((leg, i) => ({
            ...leg,
            selectionId: `s${i}`,
            eventId: `e${i}`,
          }));
          const payoutOf = (stake: bigint) =>
            quoteBet({
              stake,
              legs: unique,
              rules: DEFAULT_BET_RULES,
              multiBonus: DEFAULT_MULTI_BONUS,
              tax: DEFAULT_TAX,
            }).grossPayout;
          const { minStake, maxStake } = DEFAULT_BET_RULES;
          const found = largestStakeWithin({ headroom, minStake, maxStake, payoutOf });
          if (found === null) {
            expect(payoutOf(minStake)).toBeGreaterThan(headroom);
            return;
          }
          expect(found).toBeGreaterThanOrEqual(minStake);
          expect(found).toBeLessThanOrEqual(maxStake);
          expect(payoutOf(found)).toBeLessThanOrEqual(headroom);
          // One more whole birr (if allowed) pays too much, unless a round-down left room.
          const next = found + birr(1);
          if (next <= maxStake && found % birr(1) === 0n) {
            const exact = largestStakeWithin({
              headroom,
              minStake,
              maxStake,
              payoutOf,
            });
            expect(exact).toBe(found);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('factory selections (plan task 2.5: shown with low limits)', () => {
  const limits: RiskLimits = { maxSelectionLiability: birr(1_000), maxEventLiability: null };

  it('caps a factory selection at a quarter of the selection cap, rounded down', () => {
    expect(FACTORY_SELECTION_LIABILITY_SHARE_BPS).toBe(2_500);
    expect(selectionLiabilityCap(limits, false)).toBe(birr(1_000));
    expect(selectionLiabilityCap(limits, true)).toBe(birr(250));
    expect(
      selectionLiabilityCap({ maxSelectionLiability: 3n, maxEventLiability: null }, true),
    ).toBe(0n);
    expect(selectionLiabilityCap(DEFAULT_RISK_LIMITS, true)).toBeNull();
  });

  it('applies the lower cap only to the selections named as factory ones', () => {
    const selections = [exposure('legacy', birr(200)), exposure('factory', birr(200))];
    expect(
      liabilityBreach({
        payout: birr(100),
        selections,
        events: [],
        limits,
        factorySelections: new Set(),
      }),
    ).toBeNull();
    expect(
      liabilityBreach({
        payout: birr(100),
        selections,
        events: [],
        limits,
        factorySelections: new Set(['factory']),
      }),
    ).toEqual({
      scope: 'selection',
      id: 'factory',
      cap: birr(250),
      current: birr(200),
      headroom: birr(50),
    });
  });

  it('takes the share from the settings (market_families.factoryLiabilityShareBps)', () => {
    expect(selectionLiabilityCap(limits, true, 1_000)).toBe(birr(100));
    expect(selectionLiabilityCap(limits, true, 10_000)).toBe(birr(1_000));
    expect(selectionLiabilityCap(limits, true, 0)).toBe(0n);
    expect(selectionLiabilityCap(limits, false, 1_000)).toBe(birr(1_000));
    expect(() => selectionLiabilityCap(limits, true, 10_001)).toThrow(RangeError);
    expect(() => selectionLiabilityCap(limits, true, -1)).toThrow(RangeError);
    expect(() => selectionLiabilityCap(limits, true, 2.5)).toThrow(RangeError);
    expect(
      liabilityBreach({
        payout: birr(100),
        selections: [exposure('factory', birr(0))],
        events: [],
        limits,
        factorySelections: new Set(['factory']),
        factoryShareBps: 500,
      }),
    ).toMatchObject({ id: 'factory', cap: birr(50), headroom: birr(50) });
  });

  it('is never looser than the plain cap, whatever the share', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        fc.integer({ min: 0, max: 10_000 }),
        (cap, share) => {
          const caps: RiskLimits = { maxSelectionLiability: cap, maxEventLiability: null };
          expect(selectionLiabilityCap(caps, true, share)! <= cap).toBe(true);
        },
      ),
    );
  });

  it('is never looser than the plain cap', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        (cap, current, payout) => {
          const caps: RiskLimits = { maxSelectionLiability: cap, maxEventLiability: null };
          const plain = liabilityBreach({
            payout,
            selections: [exposure('s', current)],
            events: [],
            limits: caps,
          });
          const factory = liabilityBreach({
            payout,
            selections: [exposure('s', current)],
            events: [],
            limits: caps,
            factorySelections: new Set(['s']),
          });
          if (plain !== null) expect(factory).not.toBeNull();
          if (factory !== null && plain !== null)
            expect(factory.headroom <= plain.headroom).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
