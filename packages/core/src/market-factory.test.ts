import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FACTORY_GROUPS,
  FACTORY_MARKETS,
  type FactoryMarket,
  type FactoryOutcome,
  type FactoryScoreGrids,
  type Goals,
  LEGACY_FOOTBALL_TYPES,
  canonicalFactoryLine,
  factoryMarket,
  fairBook,
  findFactoryMarket,
  resolveFactorySelection,
} from './market-factory';
import {
  type MarketTypeCode,
  type ResolutionInput,
  canonicalLine,
  resolveSelection,
  selectionsFor,
} from './markets';

const keyOf = (m: FactoryMarket) => (m.line === null ? m.type : `${m.type}:${m.line}`);

function outcomeOn(market: FactoryMarket, first: Goals, second: Goals): FactoryOutcome {
  const full = { home: first.home + second.home, away: first.away + second.away };
  switch (market.basis) {
    case 'ft':
      return market.outcome(full);
    case 'h1':
      return market.outcome(first);
    case 'h2':
      return market.outcome(second);
    case 'halves':
      return market.outcome(first, second);
  }
}

/** Every pair of halves with at most `max` goals per side and half. */
function halvesStates(max: number): Array<[Goals, Goals]> {
  const states: Array<[Goals, Goals]> = [];
  for (let h1 = 0; h1 <= max; h1++)
    for (let a1 = 0; a1 <= max; a1++)
      for (let h2 = 0; h2 <= max; h2++)
        for (let a2 = 0; a2 <= max; a2++)
          states.push([
            { home: h1, away: a1 },
            { home: h2, away: a2 },
          ]);
  return states;
}

const STATES = halvesStates(5);

function finished(first: Goals, second: Goals): ResolutionInput {
  return {
    status: 'finished',
    score: {
      home: first.home + second.home,
      away: first.away + second.away,
      htHome: first.home,
      htAway: first.away,
    },
  };
}

describe('the catalogue', () => {
  it('has one market per type and line, with valid groups and selections', () => {
    const keys = new Set<string>();
    for (const market of FACTORY_MARKETS) {
      expect(keys.has(keyOf(market)), keyOf(market)).toBe(false);
      keys.add(keyOf(market));
      expect(FACTORY_GROUPS).toContain(market.group);
      expect(market.selections.length, keyOf(market)).toBeGreaterThanOrEqual(2);
      expect(new Set(market.selections).size, keyOf(market)).toBe(market.selections.length);
      expect(market.winners).toBeGreaterThanOrEqual(1);
      expect(market.winners).toBeLessThan(market.selections.length);
      expect(Object.isFrozen(market)).toBe(true);
      expect(Object.isFrozen(market.selections)).toBe(true);
    }
  });

  it('is big enough for the match page (section 4.1) and stable', () => {
    const selections = FACTORY_MARKETS.reduce((n, m) => n + m.selections.length, 0);
    const types = new Set(FACTORY_MARKETS.map((m) => m.type));
    // Snapshot of the catalogue: a change here is a deliberate catalogue change.
    expect({ markets: FACTORY_MARKETS.length, selections, types: types.size })
      .toMatchInlineSnapshot(`
      {
        "markets": 164,
        "selections": 515,
        "types": 79,
      }
    `);
  });

  it("keeps today's football market types with their codes, lines and selections", () => {
    for (const type of LEGACY_FOOTBALL_TYPES) {
      const markets = FACTORY_MARKETS.filter((m) => m.type === type);
      expect(markets.length, type).toBeGreaterThan(0);
      for (const market of markets) {
        expect(market.selections).toEqual(selectionsFor(type as MarketTypeCode));
        // The line is the one today's catalogue accepts, in its canonical form.
        expect(canonicalLine(type as MarketTypeCode, market.line)).toBe(market.line);
      }
    }
    // Today's default lines are all there.
    for (const line of ['0.5', '1.5', '2.5', '3.5', '4.5'])
      expect(findFactoryMarket('ou', line)).toBeDefined();
    for (const line of ['-1.5', '-1', '-0.5', '0.5', '1', '1.5'])
      expect(findFactoryMarket('ah', line)).toBeDefined();
    for (const line of ['-1', '1']) expect(findFactoryMarket('eh', line)).toBeDefined();
  });
});

describe('every rule', () => {
  it('names exactly `winners` distinct selections of its market for every score, or voids the market', () => {
    const problems: string[] = [];
    for (const market of FACTORY_MARKETS) {
      for (const [first, second] of STATES) {
        const outcome = outcomeOn(market, first, second);
        if (outcome === 'void') continue;
        const state = `${first.home}-${first.away}/${second.home}-${second.away}`;
        if (new Set(outcome).size !== market.winners) {
          problems.push(`${keyOf(market)} ${state}: ${outcome.length} winners`);
        }
        for (const selection of outcome) {
          if (!market.selections.includes(selection)) {
            problems.push(`${keyOf(market)} ${state}: unlisted ${selection}`);
          }
        }
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  it('lets every listed selection both win and lose', () => {
    for (const market of FACTORY_MARKETS) {
      const won = new Set<string>();
      const lost = new Set<string>();
      for (const [first, second] of STATES) {
        const outcome = outcomeOn(market, first, second);
        if (outcome === 'void') continue;
        for (const selection of market.selections) {
          (outcome.includes(selection) ? won : lost).add(selection);
        }
      }
      for (const selection of market.selections) {
        expect(won.has(selection), `${keyOf(market)} ${selection} never wins`).toBe(true);
        expect(lost.has(selection), `${keyOf(market)} ${selection} never loses`).toBe(true);
      }
    }
  });

  it('voids only markets whose rules can push', () => {
    const canVoid = new Set<string>();
    for (const market of FACTORY_MARKETS) {
      if (STATES.some(([a, b]) => outcomeOn(market, a, b) === 'void')) canVoid.add(market.type);
    }
    expect([...canVoid].sort()).toEqual(
      [
        'ah',
        'asian_total',
        'away_no_bet',
        'dnb',
        'h1_ah',
        'h1_asian_total',
        'h1_dnb',
        'h2_ah',
        'h2_asian_total',
        'h2_dnb',
        'home_no_bet',
      ].sort(),
    );
  });
});

describe("settlement of today's market types", () => {
  it('agrees with resolveSelection on every score up to 6-6 and every half-time score', () => {
    const legacy = FACTORY_MARKETS.filter((m) => LEGACY_FOOTBALL_TYPES.includes(m.type));
    const mismatches: string[] = [];
    for (let home = 0; home <= 6; home++) {
      for (let away = 0; away <= 6; away++) {
        for (let htHome = 0; htHome <= home; htHome++) {
          for (let htAway = 0; htAway <= away; htAway++) {
            const input: ResolutionInput = {
              status: 'finished',
              score: { home, away, htHome, htAway },
            };
            for (const market of legacy) {
              const ref = { type: market.type as MarketTypeCode, line: market.line };
              for (const selection of market.selections) {
                const factory = resolveFactorySelection(market, selection, input);
                const today = resolveSelection(ref, selection, input);
                if (factory !== today) {
                  mismatches.push(
                    `${keyOf(market)} ${selection} ${htHome}-${htAway}/${home}-${away}: ${factory} vs ${today}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  it('settles full-time markets without a half-time score, as today', () => {
    const input: ResolutionInput = { status: 'finished', score: { home: 2, away: 1 } };
    expect(resolveFactorySelection({ type: '1x2' }, '1', input)).toBe('won');
    expect(resolveFactorySelection({ type: 'ah', line: '-1' }, '1', input)).toBe('void');
    expect(resolveFactorySelection({ type: 'cs' }, '2-1', input)).toBe('won');
    expect(() => resolveFactorySelection({ type: 'ht_1x2' }, '1', input)).toThrow(RangeError);
  });

  it('voids every selection of a cancelled, abandoned or postponed match', () => {
    for (const status of ['cancelled', 'abandoned', 'postponed'] as const) {
      for (const market of FACTORY_MARKETS) {
        expect(resolveFactorySelection(market, market.selections[0]!, { status })).toBe('void');
      }
    }
  });
});

describe('the rule that prices is the rule that settles', () => {
  /** A random probability grid of (size+1)² cells summing to 1. */
  const grid = (size: number) =>
    fc
      .array(fc.double({ min: 0, max: 1, noNaN: true }), {
        minLength: (size + 1) ** 2,
        maxLength: (size + 1) ** 2,
      })
      .filter((cells) => cells.reduce((a, b) => a + b, 0) > 1e-6)
      .map((cells) => {
        const totalMass = cells.reduce((a, b) => a + b, 0);
        const rows: number[][] = [];
        for (let h = 0; h <= size; h++)
          rows.push(cells.slice(h * (size + 1), (h + 1) * (size + 1)).map((p) => p / totalMass));
        return rows;
      });

  it('fair probabilities equal the settled outcomes weighted by the same score distribution', () => {
    fc.assert(
      fc.property(
        grid(3),
        grid(3),
        grid(5),
        fc.integer({ min: 0, max: FACTORY_MARKETS.length - 1 }),
        (h1, h2, ft, pick) => {
          const grids: FactoryScoreGrids = { ft, h1, h2 };
          const market = FACTORY_MARKETS[pick]!;
          const book = fairBook(market, grids);
          // Independently: the settlement function over the same scores.
          const won = market.selections.map(() => 0);
          let voidMass = 0;
          let mass = 0;
          let decisive = 0;
          const visit = (input: ResolutionInput, p: number) => {
            if (p === 0) return;
            mass += p;
            const results = market.selections.map((s) => resolveFactorySelection(market, s, input));
            if (results.every((r) => r === 'void')) voidMass += p;
            else decisive += p;
            results.forEach((r, i) => {
              if (r === 'won') won[i] = (won[i] ?? 0) + p;
            });
          };
          if (market.basis === 'ft') {
            ft.forEach((row, home) =>
              row.forEach((p, away) => visit({ status: 'finished', score: { home, away } }, p)),
            );
          } else {
            h1.forEach((r1, fh) =>
              r1.forEach((p1, fa) =>
                h2.forEach((r2, sh) =>
                  r2.forEach((p2, sa) =>
                    visit(finished({ home: fh, away: fa }, { home: sh, away: sa }), p1 * p2),
                  ),
                ),
              ),
            );
          }
          if (decisive <= 1e-12) {
            expect(book.priceable).toBe(false);
            return;
          }
          expect(book.priceable).toBe(true);
          expect(book.voidProbability).toBeCloseTo(voidMass / mass, 9);
          book.probabilities.forEach((p, i) => {
            const expected = voidMass > 0 ? won[i]! / decisive : won[i]!;
            expect(p).toBeCloseTo(expected, 9);
          });
          // A partition sums to `winners` once the void mass is taken out.
          const sumOf = book.probabilities.reduce((a, b) => a + b, 0);
          expect(sumOf).toBeCloseTo(market.winners * (voidMass > 0 ? 1 : decisive), 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('prices a point mass as certain', () => {
    const point = (home: number, away: number, size = 6) =>
      Array.from({ length: size + 1 }, (_, h) =>
        Array.from({ length: size + 1 }, (_, a) => (h === home && a === away ? 1 : 0)),
      );
    const grids: FactoryScoreGrids = { ft: point(2, 1), h1: point(1, 1), h2: point(1, 0) };
    const htft = fairBook(factoryMarket('htft'), grids);
    expect(htft.probabilities[htft.market.selections.indexOf('X/1')]).toBe(1);
    const ah = fairBook(factoryMarket('ah', '-1'), grids);
    expect(ah.priceable).toBe(false);
    expect(ah.voidProbability).toBe(1);
  });
});

describe('selected rules on known scores', () => {
  const settle = (
    type: string,
    line: string | null,
    selection: string,
    ht: [number, number],
    ft: [number, number],
  ) =>
    resolveFactorySelection({ type, line }, selection, {
      status: 'finished',
      score: { home: ft[0], away: ft[1], htHome: ht[0], htAway: ht[1] },
    });

  it('reads the second half as the 90-minute score minus the half-time score', () => {
    expect(settle('h2_1x2', null, '2', [2, 0], [2, 1])).toBe('won');
    expect(settle('h2_ou', '0.5', 'over', [1, 1], [1, 1])).toBe('lost');
    expect(settle('highest_scoring_half', null, '2nd', [0, 1], [2, 1])).toBe('won');
    expect(settle('home_score_both_halves', null, 'yes', [1, 0], [2, 3])).toBe('won');
    expect(settle('away_win_either_half', null, 'yes', [1, 0], [1, 1])).toBe('won');
    expect(settle('h1_h2_1x2', null, '1/2', [1, 0], [1, 1])).toBe('won');
  });

  it('settles the full-time families', () => {
    expect(settle('winning_margin', null, '1by3+', [0, 0], [4, 1])).toBe('won');
    expect(settle('goal_range', null, '4-5', [0, 0], [3, 2])).toBe('won');
    expect(settle('exact_goals', null, '6+', [0, 0], [4, 3])).toBe('won');
    expect(settle('multigoals', '2-4', 'yes', [0, 0], [3, 1])).toBe('won');
    expect(settle('multigoals', '2-4', 'yes', [0, 0], [3, 2])).toBe('lost');
    expect(settle('asian_total', '3', 'over', [0, 0], [2, 1])).toBe('void');
    expect(settle('home_no_bet', null, 'X', [0, 0], [2, 1])).toBe('void');
    expect(settle('home_no_bet', null, '2', [0, 0], [0, 1])).toBe('won');
    expect(settle('ft_dc_btts', null, '1X&yes', [0, 0], [1, 1])).toBe('won');
    expect(settle('ft_dc_btts', null, 'X2&yes', [0, 0], [1, 1])).toBe('won');
    expect(settle('ft_dc_btts', null, '12&yes', [0, 0], [1, 1])).toBe('lost');
    expect(settle('home_win_to_nil', null, 'yes', [0, 0], [2, 0])).toBe('won');
  });

  it('drops selections that no score can produce', () => {
    // Home leads at half time and away wins: at least three goals, so never under 2.5.
    expect(factoryMarket('htft_ou', '2.5').selections).not.toContain('1/2&under');
    expect(factoryMarket('htft_ou', '2.5').selections).not.toContain('2/1&under');
    expect(factoryMarket('htft_ou', '3.5').selections).toContain('1/2&under');
    // Both teams scored means at least two goals.
    expect(factoryMarket('ft_btts_ou', '2.5').selections).toContain('yes&under');
  });
});

describe('lookup and validation', () => {
  it('canonicalises lines', () => {
    expect(canonicalFactoryLine('+1')).toBe('1');
    expect(canonicalFactoryLine('-0')).toBe('0');
    expect(canonicalFactoryLine('02.5')).toBe('2.5');
    expect(canonicalFactoryLine('1-3')).toBe('1-3');
    expect(canonicalFactoryLine(null)).toBeNull();
    expect(findFactoryMarket('ah', '+1')?.line).toBe('1');
    expect(findFactoryMarket('nope')).toBeUndefined();
    expect(findFactoryMarket('ou', '2.25')).toBeUndefined();
  });

  it('rejects unknown markets and selections, bad scores and impossible half-time scores', () => {
    const ok: ResolutionInput = {
      status: 'finished',
      score: { home: 1, away: 0, htHome: 0, htAway: 0 },
    };
    expect(() => resolveFactorySelection({ type: 'nope' }, '1', ok)).toThrow(RangeError);
    expect(() => resolveFactorySelection({ type: '1x2' }, 'Y', ok)).toThrow(RangeError);
    expect(() =>
      resolveFactorySelection({ type: '1x2' }, '1', {
        status: 'finished',
        score: { home: -1, away: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveFactorySelection({ type: 'htft' }, '1/1', {
        status: 'finished',
        score: { home: 1, away: 0, htHome: 2, htAway: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveFactorySelection({ type: 'h2_1x2' }, '1', {
        status: 'finished',
        score: { home: 1, away: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveFactorySelection({ type: '1x2' }, '1', {
        status: 'live',
      } as unknown as ResolutionInput),
    ).toThrow(RangeError);
  });
});
