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
  priceBook,
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

  it('delivers the margin of a lopsided market (F-08)', () => {
    const market = buildMarket('ou', '1.5', { over: 0.965, under: 0.035 }, 600)!;
    expect(Math.abs(bookOverround(market) - 1.06)).toBeLessThan(0.005);
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

/** Σ 1/odds of a priced book. */
function overroundOf(prices: readonly number[]): number {
  return prices.reduce((sum, odds) => sum + 1000 / odds, 0);
}

/** A random probability split of `n` selections summing to 1, from a heavy-tailed draw. */
function randomSplit(rng: ReturnType<typeof createRng>, n: number): number[] {
  const weights = Array.from({ length: n }, () => Math.exp(-rng.next() * 12 * rng.next()));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

describe('priceBook', () => {
  it('delivers the margin on a lopsided over/under line (F-08)', () => {
    // Over 1.5 for a heavy favourite: 1.06 × 0.97 = 1.028 is below the 1.01 floor's implied
    // 0.990, so the favourite cannot carry its share. Priced one by one, the book was 1.0299;
    // the longshot opposite now carries the rest.
    const [over, under] = priceBook([0.97, 0.03], 600)!;
    expect(over).toBe(1010);
    const overround = overroundOf([over!, under!]);
    expect(Math.abs(overround - 1.06)).toBeLessThan(0.005);
    expect(1000 / under!).toBeGreaterThan(0.03 * 1.06);
    const alone = [priceProbability(0.97, 600)!, priceProbability(0.03, 600)!];
    expect(overroundOf(alone)).toBeLessThan(1.045);
  });

  it('delivers the margin on a lopsided double chance and 1X2 (F-08)', () => {
    const dc = priceBook(
      [0.992, 0.9, 0.108].map((p) => p),
      600,
    )!;
    // Σ p = 2: the double chance book carries 2 × 6%.
    expect(Math.abs(overroundOf(dc) / 2 - 1.06)).toBeLessThan(0.005);
    const oneXTwo = priceBook([0.95, 0.04, 0.01], 600)!;
    expect(Math.abs(overroundOf(oneXTwo) - 1.06)).toBeLessThan(0.005);
  });

  it('prices a book on which nothing is capped like the single-selection price, within a step', () => {
    const probabilities = [0.45, 0.27, 0.28];
    const prices = priceBook(probabilities, 600)!;
    probabilities.forEach((p, i) => {
      const alone = oddsFromProbability(p, 600);
      expect(Math.abs(prices[i]! - alone)).toBeLessThanOrEqual(10);
    });
    expect(Math.abs(overroundOf(prices) - 1.06)).toBeLessThan(0.002);
  });

  it('hits the margin within 0.5 percentage points and never prices above fair (property)', () => {
    const rng = createRng('price-book');
    let priced = 0;
    for (let i = 0; i < 6000; i++) {
      const n = [2, 3, 3, 26][i % 4]!;
      const probabilities = randomSplit(rng, n);
      const margin = [600, 600, 1500, rng.int(0, 2500)][i % 4]!;
      const prices = priceBook(probabilities, margin);
      if (prices === null) {
        expect(Math.max(...probabilities)).toBeGreaterThan(1000 / 1001);
        continue;
      }
      priced++;
      expect(prices).toHaveLength(n);
      prices.forEach((odds, k) => {
        expect(isValidOddsMilli(odds)).toBe(true);
        // Whole hundredths from 1.01 up (the 1.001 fallback is for p above 1/1.01 only).
        if (odds < 1010) expect(probabilities[k]!).toBeGreaterThan(1000 / 1010);
        else if (odds < MAX_ODDS_MILLI) expect(odds % 10).toBe(0);
        // No selection is offered above its fair price.
        expect(1000 / odds).toBeGreaterThanOrEqual(Math.max(probabilities[k]!, 1e-6));
      });
      // With enough selections the cap at 1000 can swallow part of a long book's margin
      // (26 selections of correct score), which is why the two-way and three-way books are
      // held to the strict bound.
      const target = 1 + margin / 10_000;
      const tolerance = n === 26 ? 0.03 : 0.005;
      const overround = overroundOf(prices);
      expect(overround).toBeGreaterThanOrEqual(1);
      if (n < 26) expect(Math.abs(overround - target)).toBeLessThan(tolerance);
      else expect(overround - target).toBeLessThan(tolerance);
    }
    expect(priced).toBeGreaterThan(5000);
  });

  it('does not depend on the order of the selections, and equal probabilities get equal prices (property)', () => {
    const rng = createRng('price-book-order');
    for (let i = 0; i < 2000; i++) {
      const n = i % 2 === 0 ? 3 : 5;
      const probabilities = randomSplit(rng, n);
      if (i % 3 === 0) probabilities[1] = probabilities[0]!; // a tie
      const order = [...probabilities.keys()].sort(() => rng.next() - 0.5);
      const prices = priceBook(probabilities, 600);
      const shuffled = priceBook(
        order.map((k) => probabilities[k]!),
        600,
      );
      if (prices === null || shuffled === null) {
        expect(prices === null && shuffled === null).toBe(true);
        continue;
      }
      order.forEach((k, position) => expect(shuffled[position]).toBe(prices[k]));
      if (i % 3 === 0) expect(prices[0]).toBe(prices[1]);
    }
  });

  it('keeps the old rules at the edges', () => {
    expect(priceBook([0.9995, 0.0005], 600)).toBeNull();
    expect(priceBook([1, 0], 0)).toBeNull();
    // A near-certain outcome stays at 1.001 and the other selection carries what is left.
    const prices = priceBook([0.995, 0.005], 600)!;
    expect(prices[0]).toBe(MIN_ODDS_MILLI);
    expect(Math.abs(overroundOf(prices) - 1.06)).toBeLessThan(0.005);
    // A zero probability is priced at the longest price (and the rest still sums up).
    const zero = priceBook([0.5, 0.5, 0], 600)!;
    expect(zero[2]).toBe(MAX_ODDS_MILLI);
    expect(() => priceBook([0.5, -0.1], 600)).toThrow(RangeError);
    expect(() => priceBook([0.5, Number.NaN], 600)).toThrow(RangeError);
    expect(() => priceBook([0.5, 0.5], 20_000)).toThrow(RangeError);
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
