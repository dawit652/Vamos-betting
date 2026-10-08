import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_ODDS_MILLI, MIN_ODDS_MILLI } from './odds';
import {
  applyOddsChangePolicy,
  ODDS_CHANGE_POLICIES,
  type OddsChangePolicy,
  type OddsCheckLeg,
} from './oddspolicy';

const leg = (selectionId: string, requested: number, current: number): OddsCheckLeg => ({
  selectionId,
  requestedOddsMilli: requested,
  currentOddsMilli: current,
});

describe('applyOddsChangePolicy', () => {
  const same = leg('a', 1850, 1850);
  const up = leg('b', 2000, 2100);
  const down = leg('c', 3000, 2900);

  it('accepts unchanged odds under every policy', () => {
    for (const policy of ODDS_CHANGE_POLICIES) {
      expect(applyOddsChangePolicy(policy, [same])).toEqual({
        accepted: true,
        oddsMilli: [1850],
        changes: [],
      });
    }
  });

  it('none: refuses any change, naming every changed leg', () => {
    const result = applyOddsChangePolicy('none', [same, up, down]);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.rejected.map((c) => [c.selectionId, c.direction])).toEqual([
      ['b', 'up'],
      ['c', 'down'],
    ]);
  });

  it('higher: takes higher odds, refuses a lower price', () => {
    expect(applyOddsChangePolicy('higher', [same, up])).toEqual({
      accepted: true,
      oddsMilli: [1850, 2100],
      changes: [
        { selectionId: 'b', requestedOddsMilli: 2000, currentOddsMilli: 2100, direction: 'up' },
      ],
    });
    const result = applyOddsChangePolicy('higher', [same, up, down]);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.rejected.map((c) => c.selectionId)).toEqual(['c']);
    expect(result.changes.map((c) => c.selectionId)).toEqual(['b', 'c']);
  });

  it('any: takes the current odds up or down', () => {
    const result = applyOddsChangePolicy('any', [same, up, down]);
    expect(result).toMatchObject({ accepted: true, oddsMilli: [1850, 2100, 2900] });
    expect(result.changes).toHaveLength(2);
  });

  it('accepts an empty slip', () => {
    expect(applyOddsChangePolicy('none', [])).toEqual({
      accepted: true,
      oddsMilli: [],
      changes: [],
    });
  });

  it('rejects unknown policies and invalid odds', () => {
    expect(() => applyOddsChangePolicy('lower' as OddsChangePolicy, [same])).toThrow(RangeError);
    expect(() => applyOddsChangePolicy('any', [leg('x', 1000, 1850)])).toThrow(RangeError);
    expect(() => applyOddsChangePolicy('any', [leg('x', 1850, 1850.5)])).toThrow(RangeError);
    expect(() => applyOddsChangePolicy('any', [leg('x', 1850, MAX_ODDS_MILLI + 1)])).toThrow(
      RangeError,
    );
  });

  describe('properties', () => {
    const odds = fc.integer({ min: MIN_ODDS_MILLI, max: MAX_ODDS_MILLI });
    const legs = fc
      .array(fc.tuple(odds, odds, fc.boolean()), { maxLength: 12 })
      .map((tuples) =>
        tuples.map(([requested, current, keep], i) =>
          leg(`s${i}`, requested, keep ? requested : current),
        ),
      );
    const policy = fc.constantFrom(...ODDS_CHANGE_POLICIES);

    it('an accepted bet is priced at the current odds of every leg', () => {
      fc.assert(
        fc.property(policy, legs, (p, slip) => {
          const result = applyOddsChangePolicy(p, slip);
          if (result.accepted) {
            expect(result.oddsMilli).toEqual(slip.map((l) => l.currentOddsMilli));
          }
        }),
      );
    });

    it('acceptance follows the policy definition', () => {
      fc.assert(
        fc.property(legs, (slip) => {
          const allSame = slip.every((l) => l.currentOddsMilli === l.requestedOddsMilli);
          const noneLower = slip.every((l) => l.currentOddsMilli >= l.requestedOddsMilli);
          expect(applyOddsChangePolicy('none', slip).accepted).toBe(allSame);
          expect(applyOddsChangePolicy('higher', slip).accepted).toBe(noneLower);
          expect(applyOddsChangePolicy('any', slip).accepted).toBe(true);
        }),
      );
    });

    it('changes list exactly the legs whose odds moved, with their direction', () => {
      fc.assert(
        fc.property(policy, legs, (p, slip) => {
          const result = applyOddsChangePolicy(p, slip);
          const moved = slip.filter((l) => l.currentOddsMilli !== l.requestedOddsMilli);
          expect(result.changes.map((c) => c.selectionId)).toEqual(moved.map((l) => l.selectionId));
          for (const change of result.changes) {
            expect(change.direction === 'up').toBe(
              change.currentOddsMilli > change.requestedOddsMilli,
            );
          }
          if (!result.accepted) {
            expect(result.rejected.length).toBeGreaterThan(0);
            for (const r of result.rejected) expect(result.changes).toContainEqual(r);
          }
        }),
      );
    });
  });
});
