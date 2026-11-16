import {
  FACTORY_MARKETS,
  LEGACY_FOOTBALL_TYPES,
  fairBook,
  type FactoryScoreGrids,
} from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bookOverround } from './book';
import {
  FACTORY_MARGIN_BPS,
  prematchFactoryGrids,
  priceFactoryMarkets,
  type FactoryPricedMarket,
} from './factory';
import {
  DEFAULT_ASIAN_HANDICAP_LINES,
  DEFAULT_THREE_WAY_HANDICAP_LINES,
  mixedScoreMatrix,
  priceFootball,
  remainingPlayingTime,
  scoreMatrix,
} from './football';

const UNPRUNED = { minFavouriteOddsMilli: null, maxListedOddsMilli: null } as const;

function find(markets: readonly FactoryPricedMarket[], type: string, line: string | null = null) {
  return markets.find((m) => m.type === type && m.line === line);
}

function expectedGoalsSteps(): number[] {
  const steps: number[] = [];
  for (let tenths = 4; tenths <= 32; tenths += 2) steps.push(tenths / 10);
  return steps;
}

describe('prematchFactoryGrids', () => {
  it('builds exactly today’s grids with every switch off', () => {
    const grids = prematchFactoryGrids(1.45, 1.15);
    const playing = remainingPlayingTime(0, false);
    expect(grids.ft).toEqual(mixedScoreMatrix(1.45, 1.15, playing.fullTime));
    expect(grids.h1).toEqual(mixedScoreMatrix(1.45, 1.15, playing.firstHalf!));
    expect(grids.h2).toEqual(mixedScoreMatrix(1.45, 1.15, remainingPlayingTime(45, true).fullTime));
  });

  it('firstHalfShare changes only the half grids', () => {
    const off = prematchFactoryGrids(1.45, 1.15);
    const on = prematchFactoryGrids(1.45, 1.15, { firstHalfShare: 0.42 });
    expect(on.ft).toEqual(off.ft);
    expect(on.h1).toEqual(scoreMatrix(1.45 * 0.42, 1.15 * 0.42));
    expect(on.h2).toEqual(scoreMatrix(1.45 * (1 - 0.42), 1.15 * (1 - 0.42)));
    expect(on.h1).not.toEqual(off.h1);
  });

  it('drawCorrection of 0 equals off; ρ moves the low scores with the sign of its τ factors', () => {
    const off = prematchFactoryGrids(1.3, 1.1);
    expect(prematchFactoryGrids(1.3, 1.1, { drawCorrection: 0 })).toEqual(off);
    expect(prematchFactoryGrids(1.3, 1.1, { drawCorrection: null })).toEqual(off);
    const sum = (grid: FactoryScoreGrids['ft']) =>
      grid.reduce((s, row) => s + row.reduce((a, p) => a + p, 0), 0);
    // τ00 = 1 - λhλaρ and τ11 = 1 - ρ: a negative ρ raises 0-0 and 1-1 (the usual draw inflation).
    const more = prematchFactoryGrids(1.3, 1.1, { drawCorrection: -0.1 });
    expect(more.h1).toEqual(off.h1);
    expect(more.h2).toEqual(off.h2);
    expect(sum(more.ft)).toBeCloseTo(1, 12);
    expect(more.ft[0]![0]!).toBeGreaterThan(off.ft[0]![0]!);
    expect(more.ft[1]![1]!).toBeGreaterThan(off.ft[1]![1]!);
    expect(more.ft[0]![1]!).toBeLessThan(off.ft[0]![1]!);
    expect(more.ft[1]![0]!).toBeLessThan(off.ft[1]![0]!);
    // and a positive ρ does the opposite
    const fewer = prematchFactoryGrids(1.3, 1.1, { drawCorrection: 0.1 });
    expect(fewer.ft[0]![0]!).toBeLessThan(off.ft[0]![0]!);
    expect(fewer.ft[1]![1]!).toBeLessThan(off.ft[1]![1]!);
    expect(fewer.ft[0]![1]!).toBeGreaterThan(off.ft[0]![1]!);
    expect(fewer.ft[1]![0]!).toBeGreaterThan(off.ft[1]![0]!);
  });

  it('rejects invalid switches with a RangeError', () => {
    for (const share of [0.29, 0.71, Number.NaN, Infinity]) {
      expect(() => prematchFactoryGrids(1.3, 1.1, { firstHalfShare: share })).toThrow(RangeError);
    }
    expect(() => prematchFactoryGrids(1.3, 1.1, { drawCorrection: Number.NaN })).toThrow(
      RangeError,
    );
    // τ00 = 1 - 1.3 × 1.1 × 1 < 0
    expect(() => prematchFactoryGrids(1.3, 1.1, { drawCorrection: 1 })).toThrow(RangeError);
    // τ11 = 1 - ρ < 0 for ρ = 1.5, τ01 = 1 + 1.3ρ < 0 for ρ = -1
    expect(() => prematchFactoryGrids(0.2, 0.2, { drawCorrection: 1.5 })).toThrow(RangeError);
    expect(() => prematchFactoryGrids(1.3, 1.1, { drawCorrection: -1 })).toThrow(RangeError);
    expect(() => prematchFactoryGrids(-1, 1.1)).toThrow(RangeError);
  });
});

describe('priceFactoryMarkets', () => {
  it('prices today’s legacy markets unchanged to the last thousandth', () => {
    const steps = expectedGoalsSteps();
    expect(steps).toHaveLength(15);
    let compared = 0;
    for (const home of steps) {
      for (const away of steps) {
        const factory = priceFactoryMarkets(home, away, {
          ...UNPRUNED,
          types: LEGACY_FOOTBALL_TYPES,
        });
        const legacy = priceFootball(home, away);
        for (const market of legacy) {
          const mine = find(factory, market.type, market.line);
          expect(mine, `${market.type} ${market.line} at ${home}/${away}`).toBeDefined();
          expect(mine!.selections, `${market.type} ${market.line} at ${home}/${away}`).toEqual(
            market.selections,
          );
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(225 * 15);
  });

  it('covers the legacy lines of the handicap markets', () => {
    const factory = priceFactoryMarkets(1.4, 1.2, { ...UNPRUNED, types: ['ah', 'eh'] });
    for (const line of DEFAULT_ASIAN_HANDICAP_LINES)
      expect(find(factory, 'ah', line)).toBeDefined();
    for (const line of DEFAULT_THREE_WAY_HANDICAP_LINES)
      expect(find(factory, 'eh', line)).toBeDefined();
  });

  it('keeps every book at its margin and never prices above fair', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 32 }), fc.integer({ min: 4, max: 32 }), (h, a) => {
        const lambdaHome = h / 10;
        const lambdaAway = a / 10;
        const grids = prematchFactoryGrids(lambdaHome, lambdaAway);
        const priced = priceFactoryMarkets(lambdaHome, lambdaAway, UNPRUNED);
        expect(priced.length).toBeGreaterThan(100);
        for (const market of priced) {
          const definition = FACTORY_MARKETS.find(
            (m) => m.type === market.type && m.line === market.line,
          )!;
          const book = fairBook(definition, grids);
          const margin =
            (LEGACY_FOOTBALL_TYPES.includes(market.type)
              ? market.type === 'cs'
                ? 1500
                : 600
              : FACTORY_MARGIN_BPS[market.marginClass]) / 10_000;
          const fairSum = book.probabilities.reduce((s, p) => s + p, 0);
          const overround = bookOverround(market);
          // within one price step (10 milli at the shortest price of 1.01, i.e. under 1 percent of a share)
          const step = 1000 / 1000 - 1000 / 1010;
          expect(overround).toBeGreaterThanOrEqual((1 + margin) * fairSum - step - 1e-9);
          market.selections.forEach((selection, i) => {
            expect(1000 / selection.oddsMilli).toBeGreaterThanOrEqual(
              book.probabilities[i]! - 1e-12,
            );
          });
        }
      }),
      { numRuns: 25 },
    );
    // About 600 markets priced for each of 25 matches: 1.4 s alone, but CI runs several packages'
    // tests at once and it passed vitest's default 5 s there (run 431). The checks stay as they are.
  }, 30_000);

  it('applies class and per-type margins, the per-type one winning', () => {
    const base = priceFactoryMarkets(1.5, 1.2, { ...UNPRUNED, types: ['1x2', 'odd_even', 'htft'] });
    const overround = (markets: FactoryPricedMarket[], type: string) =>
      bookOverround(find(markets, type)!);
    expect(overround(base, '1x2')).toBeGreaterThan(1.059);
    expect(overround(base, 'odd_even')).toBeGreaterThan(1.069);
    expect(overround(base, 'htft')).toBeGreaterThan(1.119);
    const tuned = priceFactoryMarkets(1.5, 1.2, {
      ...UNPRUNED,
      types: ['1x2', 'odd_even', 'htft'],
      marginBps: { main: 300, derivative: 1000 },
      typeMarginBps: { htft: 2000 },
    });
    expect(overround(tuned, '1x2')).toBeLessThan(1.04);
    expect(overround(tuned, 'odd_even')).toBeGreaterThan(1.095);
    expect(overround(tuned, 'htft')).toBeGreaterThan(1.19);
    expect(() => priceFactoryMarkets(1.5, 1.2, { marginBps: { main: -1 } })).toThrow(RangeError);
    expect(() => priceFactoryMarkets(1.5, 1.2, { typeMarginBps: { htft: 1.5 } })).toThrow(
      RangeError,
    );
  });

  it('restricts by types and lines', () => {
    const only = priceFactoryMarkets(1.5, 1.2, {
      types: ['ou', 'btts'],
      lines: { ou: ['2.5', '+3.5'] },
    });
    expect(only.map((m) => `${m.type}:${m.line}`)).toEqual(['ou:2.5', 'ou:3.5', 'btts:null']);
    expect(() => priceFactoryMarkets(1.5, 1.2, { types: ['nope'] })).toThrow(RangeError);
    expect(() => priceFactoryMarkets(1.5, 1.2, { lines: { ou: ['9.5'] } })).toThrow(RangeError);
  });

  it('prunes short favourites and long shots', () => {
    const all = priceFactoryMarkets(3.2, 0.4, UNPRUNED);
    const pruned = priceFactoryMarkets(3.2, 0.4);
    expect(pruned.length).toBeLessThan(all.length);
    for (const market of pruned) {
      const full = find(all, market.type, market.line)!;
      expect(Math.min(...full.selections.map((s) => s.oddsMilli))).toBeGreaterThanOrEqual(1020);
      for (const selection of market.selections) {
        expect(selection.oddsMilli).toBeLessThanOrEqual(500_000);
        expect(full.selections).toContainEqual(selection);
      }
    }
    // a long shot is omitted but the market stays and its prices do not move
    const cs = find(pruned, 'cs')!;
    const csAll = find(all, 'cs')!;
    expect(cs.selections.length).toBeLessThan(csAll.selections.length);
    const looser = priceFactoryMarkets(3.2, 0.4, {
      maxListedOddsMilli: 2_000,
      minFavouriteOddsMilli: 0,
    });
    expect(find(looser, 'cs')!.selections.every((s) => s.oddsMilli <= 2_000)).toBe(true);
    expect(() => priceFactoryMarkets(1, 1, { minFavouriteOddsMilli: -1 })).toThrow(RangeError);
    expect(() => priceFactoryMarkets(1, 1, { maxListedOddsMilli: Number.NaN })).toThrow(RangeError);
  });

  it('switches change only the markets that use the grid they touch', () => {
    const off = priceFactoryMarkets(1.45, 1.15, UNPRUNED);
    const on = priceFactoryMarkets(1.45, 1.15, { ...UNPRUNED, firstHalfShare: 0.4 });
    expect(on.map((m) => `${m.type}:${m.line}`)).toEqual(off.map((m) => `${m.type}:${m.line}`));
    for (const [i, market] of off.entries()) {
      const definition = FACTORY_MARKETS.find(
        (m) => m.type === market.type && m.line === market.line,
      )!;
      if (definition.basis === 'ft') expect(on[i]).toEqual(market);
    }
    expect(find(on, 'ht_1x2')).not.toEqual(find(off, 'ht_1x2'));
    expect(find(on, 'htft')).not.toEqual(find(off, 'htft'));
    const zero = priceFactoryMarkets(1.45, 1.15, { ...UNPRUNED, drawCorrection: 0 });
    expect(zero).toEqual(off);
    const dc = priceFactoryMarkets(1.45, 1.15, { ...UNPRUNED, drawCorrection: -0.1 });
    expect(find(dc, 'cs')).not.toEqual(find(off, 'cs'));
    expect(find(dc, 'ht_1x2')).toEqual(find(off, 'ht_1x2'));
  });

  it('lists the same number of selections for the reference matches (snapshot)', () => {
    const counts = [
      [1.45, 1.15],
      [1.05, 1.8],
      [2.6, 0.6],
      [0.95, 0.8],
    ].map(([h, a]) => {
      const priced = priceFactoryMarkets(h!, a!);
      return {
        markets: priced.length,
        selections: priced.reduce((sum, m) => sum + m.selections.length, 0),
      };
    });
    // Plan 4.1 and task 2.8: a typical match lists at least 500 options after pruning.
    for (const count of counts) expect(count.selections).toBeGreaterThanOrEqual(500);
    expect(counts).toMatchInlineSnapshot(`
      [
        {
          "markets": 176,
          "selections": 635,
        },
        {
          "markets": 173,
          "selections": 629,
        },
        {
          "markets": 165,
          "selections": 596,
        },
        {
          "markets": 156,
          "selections": 587,
        },
      ]
    `);
  });

  it('prices all markets of a match quickly', () => {
    priceFactoryMarkets(1.45, 1.15); // warm up
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) priceFactoryMarkets(1.45 + i / 100, 1.15);
    const perMatch = (performance.now() - start) / runs;
    console.warn(`priceFactoryMarkets: ${perMatch.toFixed(1)} ms per match`);
    expect(perMatch).toBeLessThan(500);
  });
});
