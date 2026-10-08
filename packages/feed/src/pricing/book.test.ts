import {
  MAX_ODDS_MILLI,
  MIN_ODDS_MILLI,
  isValidOddsMilli,
  oddsFromProbability,
  selectionsFor,
} from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { createRng } from '../random';
import {
  CORRECT_SCORE_MARGIN_BPS,
  DEFAULT_MARGIN_BPS,
  LIVE_MARGIN_EXTRA_BPS,
  bookOverround,
  buildMarket,
  checkedLiveState,
  defaultMarginBps,
  normalCdf,
  priceProbability,
} from './book';

describe('priceProbability', () => {
  it('uses oddsFromProbability in the normal range', () => {
    for (const p of [0.05, 0.2, 0.45, 0.5, 0.7, 0.9]) {
      expect(priceProbability(p, 600)).toBe(oddsFromProbability(p, 600));
    }
  });

  it('falls back to thousandths when the 1.01 floor would give the customer an edge', () => {
    // 1.01 pays out more than the fair 1/0.995 ≈ 1.005.
    expect(oddsFromProbability(0.995, 800)).toBe(1010);
    expect(priceProbability(0.995, 800)).toBe(MIN_ODDS_MILLI);
    // Below 1/1.01 the hundredths floor is still safe.
    expect(priceProbability(0.98, 800)).toBe(1010);
  });

  it('refuses outcomes too likely to be priced even at 1.001', () => {
    expect(priceProbability(0.9995, 600)).toBeNull();
    expect(priceProbability(1, 0)).toBeNull();
  });

  it('clamps tiny probabilities to the maximum odds', () => {
    expect(priceProbability(0, 600)).toBe(MAX_ODDS_MILLI);
    expect(priceProbability(1e-12, 1500)).toBe(MAX_ODDS_MILLI);
  });

  it('never prices above the fair odds and always returns valid odds (property)', () => {
    const rng = createRng('price-probability');
    for (let i = 0; i < 20_000; i++) {
      const p = i % 10 === 0 ? 1 - rng.next() * 0.02 : rng.next();
      const margin = rng.int(0, 2500);
      const odds = priceProbability(p, margin);
      if (odds === null) {
        expect(p).toBeGreaterThan(1000 / 1001);
        continue;
      }
      expect(isValidOddsMilli(odds)).toBe(true);
      expect(1000 / odds).toBeGreaterThanOrEqual(Math.max(p, 1e-6));
    }
  });

  it('rejects invalid input', () => {
    expect(() => priceProbability(-0.1, 600)).toThrow(RangeError);
    expect(() => priceProbability(1.1, 600)).toThrow(RangeError);
    expect(() => priceProbability(Number.NaN, 600)).toThrow(RangeError);
    expect(() => priceProbability(0.5, -1)).toThrow(RangeError);
    expect(() => priceProbability(0.5, 1.5)).toThrow(RangeError);
    expect(() => priceProbability(0.5, 20_000)).toThrow(RangeError);
  });

  it('tolerates float noise at the edges of [0, 1]', () => {
    expect(priceProbability(1 + 1e-15, 600)).toBeNull();
    expect(priceProbability(-1e-15, 600)).toBe(MAX_ODDS_MILLI);
  });
});

describe('buildMarket', () => {
  it('lists exactly the selections of the market type, in order', () => {
    const market = buildMarket('1x2', null, { '2': 0.3, X: 0.25, '1': 0.45 }, 600);
    expect(market?.type).toBe('1x2');
    expect(market?.line).toBeNull();
    expect(market?.selections.map((s) => s.code)).toEqual([...selectionsFor('1x2')]);
  });

  it('drops the market when one selection cannot be priced', () => {
    expect(buildMarket('btts', null, { yes: 0.9999, no: 0.0001 }, 600)).toBeNull();
  });

  it('throws when a selection has no probability', () => {
    expect(() => buildMarket('1x2', null, { '1': 0.5, X: 0.5 }, 600)).toThrow(RangeError);
  });

  it('gives an overround of at least 1 for any probability split (property)', () => {
    const rng = createRng('build-market');
    for (let i = 0; i < 5000; i++) {
      const a = rng.next();
      const b = rng.next() * (1 - a);
      const market = buildMarket('1x2', null, { '1': a, X: b, '2': 1 - a - b }, rng.int(0, 2000));
      if (market === null) continue;
      expect(bookOverround(market)).toBeGreaterThanOrEqual(1 - 1e-12);
    }
  });
});

describe('margins', () => {
  it('has the documented defaults', () => {
    expect(defaultMarginBps('1x2', false)).toBe(DEFAULT_MARGIN_BPS);
    expect(defaultMarginBps('cs', false)).toBe(CORRECT_SCORE_MARGIN_BPS);
    expect(defaultMarginBps('ou', true)).toBe(DEFAULT_MARGIN_BPS + LIVE_MARGIN_EXTRA_BPS);
    expect(defaultMarginBps('cs', true)).toBe(1700);
    expect(DEFAULT_MARGIN_BPS).toBe(600);
  });
});

describe('normalCdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5);
    expect(normalCdf(-8)).toBeGreaterThan(0);
    expect(normalCdf(-8)).toBeLessThan(1e-14);
    expect(normalCdf(40)).toBe(1);
  });

  it('is symmetric and increasing', () => {
    let previous = 0;
    for (let x = -6; x <= 6; x += 0.25) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 7);
      expect(normalCdf(x)).toBeGreaterThan(previous);
      previous = normalCdf(x);
    }
  });
});

describe('checkedLiveState', () => {
  it('normalises absent half-time scores to null', () => {
    expect(checkedLiveState({ minute: 10, home: 1, away: 0 })).toEqual({
      minute: 10,
      home: 1,
      away: 0,
      htHome: null,
      htAway: null,
    });
  });

  it('rejects invalid states', () => {
    expect(() => checkedLiveState({ minute: -1, home: 0, away: 0 })).toThrow(RangeError);
    expect(() => checkedLiveState({ minute: Number.NaN, home: 0, away: 0 })).toThrow(RangeError);
    expect(() => checkedLiveState({ minute: 10, home: 1.5, away: 0 })).toThrow(RangeError);
    expect(() => checkedLiveState({ minute: 10, home: 0, away: -1 })).toThrow(RangeError);
    expect(() => checkedLiveState({ minute: 60, home: 1, away: 0, htHome: 2, htAway: 0 })).toThrow(
      RangeError,
    );
  });
});
