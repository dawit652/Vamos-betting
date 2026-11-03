import { isValidOddsMilli, selectionsFor } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  correctScoreProbabilities,
  fitGoalsModel,
  overProbability,
  resultProbabilities,
  scoreGrid,
  type GoalsModel,
} from './goals-model';
import {
  pricingMargins,
  priceEvent,
  shouldWritePrice,
  type EventConsensus,
  type TotalConsensus,
} from './price';
import type { FeedMarket } from '../types';

const MARGINS = pricingMargins();
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const implied = (market: FeedMarket | undefined, code: string): number => {
  const selection = market?.selections.find((s) => s.code === code);
  if (selection === undefined) throw new Error(`no selection ${code}`);
  return 1000 / selection.oddsMilli;
};
const find = (markets: FeedMarket[], type: string, line: string | null = null) =>
  markets.find((m) => m.type === type && m.line === line);

function targetsOf(model: GoalsModel, line = 2.5) {
  const grid = scoreGrid(model);
  const result = resultProbabilities(grid);
  return { ...result, total: { line, over: overProbability(grid, line) } };
}

describe('goals model', () => {
  it('builds a score grid that sums to 1, with ρ < 0 adding draws', () => {
    const base = { lambdaHome: 1.5, lambdaAway: 1.1, rho: 0 };
    const grid = scoreGrid(base);
    expect(sum(grid.flat())).toBeCloseTo(1, 12);
    const draws = resultProbabilities(grid).draw;
    expect(resultProbabilities(scoreGrid({ ...base, rho: -0.12 })).draw).toBeGreaterThan(draws);
    const cs = correctScoreProbabilities(grid);
    expect(Object.keys(cs)).toEqual([...selectionsFor('cs')]);
    expect(sum(Object.values(cs))).toBeCloseTo(1, 12);
  });

  it('recovers the parameters that produced the market', () => {
    const model = { lambdaHome: 1.6, lambdaAway: 1.1, rho: -0.08 };
    const fit = fitGoalsModel(targetsOf(model));
    expect(fit.error).toBeLessThan(1e-5);
    expect(fit.lambdaHome).toBeCloseTo(1.6, 2);
    expect(fit.lambdaAway).toBeCloseTo(1.1, 2);
    expect(fit.rho).toBeCloseTo(-0.08, 2);
  });

  it('fits any typical match closely (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.4, max: 3, noNaN: true }),
        fc.double({ min: 0.4, max: 3, noNaN: true }),
        fc.double({ min: -0.15, max: 0.05, noNaN: true }),
        fc.constantFrom(1.5, 2.5, 3.5),
        (lambdaHome, lambdaAway, rho, line) => {
          const fit = fitGoalsModel(targetsOf({ lambdaHome, lambdaAway, rho }, line));
          expect(fit.error).toBeLessThan(1e-3);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('refuses invalid targets', () => {
    const total = { line: 2.5, over: 0.5 };
    expect(() => fitGoalsModel({ home: 0.5, draw: 0.3, away: 0.3, total })).toThrow(RangeError);
    expect(() =>
      fitGoalsModel({ home: 0.5, draw: 0.3, away: 0.2, total: { line: 2, over: 0.5 } }),
    ).toThrow(RangeError);
    expect(() => fitGoalsModel({ home: 1, draw: 0, away: 0, total })).toThrow(RangeError);
  });
});

describe('priceEvent', () => {
  const total = (line: number, over: number, books = 4): TotalConsensus => ({
    line,
    probabilities: [over, 1 - over],
    books,
  });
  const football = (result: number[], totals: TotalConsensus[]): EventConsensus => ({
    sport: 'football',
    result,
    totals,
  });

  it('prices football from the consensus, deriving the rest from the fitted model', () => {
    const model = { lambdaHome: 1.55, lambdaAway: 1.05, rho: -0.06 };
    const targets = targetsOf(model);
    const priced = priceEvent(
      football([targets.home, targets.draw, targets.away], [total(2.5, targets.total.over, 6)]),
      { margins: MARGINS, derived: true },
    );
    expect(priced.derived).toBe(true);
    expect(priced.fit?.error).toBeLessThan(1e-4);
    const keys = priced.markets.map((m) => (m.line === null ? m.type : `${m.type}:${m.line}`));
    expect(keys).toEqual([
      '1x2',
      'dc',
      'ou:0.5',
      'ou:1.5',
      'ou:2.5',
      'ou:3.5',
      'ou:4.5',
      'btts',
      'dnb',
      'cs',
    ]);
    expect(keys).not.toContain('ht_1x2');

    // Every price pays less than the fair probability allows.
    const x12 = find(priced.markets, '1x2');
    expect(implied(x12, '1')).toBeGreaterThanOrEqual(targets.home);
    expect(implied(x12, 'X')).toBeGreaterThanOrEqual(targets.draw);
    expect(implied(find(priced.markets, 'dc'), '1X')).toBeGreaterThanOrEqual(
      targets.home + targets.draw,
    );
    expect(implied(find(priced.markets, 'dnb'), '1')).toBeGreaterThanOrEqual(
      targets.home / (targets.home + targets.away),
    );
    expect(implied(find(priced.markets, 'ou', '2.5'), 'over')).toBeGreaterThanOrEqual(
      targets.total.over,
    );
    // The real line keeps the main margin; model lines carry the extra margin.
    const real = find(priced.markets, 'ou', '2.5');
    const derived = find(priced.markets, 'ou', '3.5');
    const book = (m: FeedMarket | undefined) =>
      sum((m?.selections ?? []).map((s) => 1000 / s.oddsMilli));
    expect(book(derived)).toBeGreaterThan(book(real));
  });

  it('offers only the exact markets without a total, or when derived markets are off', () => {
    const result = [0.45, 0.28, 0.27];
    const bare = priceEvent(football(result, []), { margins: MARGINS, derived: true });
    expect(bare.markets.map((m) => m.type)).toEqual(['1x2', 'dc', 'dnb']);
    expect(bare.fit).toBeNull();
    const off = priceEvent(football(result, [total(2.5, 0.5)]), {
      margins: MARGINS,
      derived: false,
    });
    expect(off.markets.map((m) => m.type)).toEqual(['1x2', 'dc', 'dnb', 'ou']);
    expect(off.derived).toBe(false);
  });

  it('withholds the model markets when the market cannot be fitted', () => {
    // A 90% favourite in a match with almost no goals: no goals model produces that.
    const priced = priceEvent(football([0.9, 0.06, 0.04], [total(2.5, 0.04)]), {
      margins: MARGINS,
      derived: true,
    });
    expect(priced.fit?.error).toBeGreaterThan(0.015);
    expect(priced.derived).toBe(false);
    expect(priced.markets.some((m) => m.type === 'btts' || m.type === 'cs')).toBe(false);
  });

  it('drops goal lines that cross the main line', () => {
    const priced = priceEvent(
      football([0.45, 0.28, 0.27], [total(1.5, 0.74, 3), total(2.5, 0.52, 6), total(3.5, 0.55, 2)]),
      { margins: MARGINS, derived: false },
    );
    const lines = priced.markets.filter((m) => m.type === 'ou').map((m) => m.line);
    expect(lines).toEqual(['1.5', '2.5']);
  });

  it('prices basketball on the main total line and tennis on the winner', () => {
    const basketball = priceEvent(
      {
        sport: 'basketball',
        result: [0.62, 0.38],
        totals: [total(224.5, 0.5, 5), total(225.5, 0.48, 2)],
      },
      { margins: MARGINS, derived: true },
    );
    expect(basketball.markets.map((m) => `${m.type}:${m.line ?? ''}`)).toEqual([
      'ml:',
      'total:224.5',
    ]);
    const tennis = priceEvent(
      { sport: 'tennis', result: [0.7, 0.3], totals: [] },
      { margins: MARGINS, derived: true },
    );
    expect(tennis.markets.map((m) => m.type)).toEqual(['winner']);
    expect(
      priceEvent({ sport: 'tennis', result: null, totals: [] }, { margins: MARGINS, derived: true })
        .markets,
    ).toEqual([]);
  });

  it('only ever produces valid books that pay less than fair (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.3, max: 3.2, noNaN: true }),
        fc.double({ min: 0.3, max: 3.2, noNaN: true }),
        fc.double({ min: -0.15, max: 0.05, noNaN: true }),
        fc.boolean(),
        (lambdaHome, lambdaAway, rho, live) => {
          const targets = targetsOf({ lambdaHome, lambdaAway, rho });
          const priced = priceEvent(
            football([targets.home, targets.draw, targets.away], [total(2.5, targets.total.over)]),
            { margins: pricingMargins(600, live), derived: true },
          );
          const fair: Record<string, Record<string, number>> = {
            '1x2': { '1': targets.home, X: targets.draw, '2': targets.away },
            'ou:2.5': { over: targets.total.over, under: 1 - targets.total.over },
          };
          for (const market of priced.markets) {
            expect(market.selections.map((s) => s.code)).toEqual([...selectionsFor(market.type)]);
            for (const selection of market.selections) {
              expect(isValidOddsMilli(selection.oddsMilli)).toBe(true);
              const key = market.line === null ? market.type : `${market.type}:${market.line}`;
              const p = fair[key]?.[selection.code];
              if (p !== undefined) expect(1000 / selection.oddsMilli).toBeGreaterThanOrEqual(p);
            }
            expect(sum(market.selections.map((s) => 1000 / s.oddsMilli))).toBeGreaterThan(
              market.type === 'dc' ? 2 : 1,
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('shouldWritePrice and margins', () => {
  it('writes shorter prices at once and longer ones after 1%', () => {
    expect(shouldWritePrice(2000, 1990)).toBe(true);
    expect(shouldWritePrice(2000, 2000)).toBe(false);
    expect(shouldWritePrice(2000, 2010)).toBe(false);
    expect(shouldWritePrice(2000, 2020)).toBe(true);
  });

  it('adds the live and model margins', () => {
    expect(pricingMargins()).toEqual({ main: 600, derived: 800, correctScore: 1500 });
    expect(pricingMargins(500, true)).toEqual({ main: 700, derived: 900, correctScore: 1700 });
  });
});
