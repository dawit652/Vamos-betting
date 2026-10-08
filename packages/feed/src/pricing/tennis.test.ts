import { isValidOddsMilli } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { createRng } from '../random';
import { bookOverround } from './book';
import {
  SETS_TO_WIN,
  eloWinProbability,
  matchWinProbability,
  priceTennis,
  priceVolleyball,
  priceWinner,
  setWinProbability,
} from './tennis';

function winnerOdds(markets: ReturnType<typeof priceWinner>): { home: number; away: number } {
  const [market] = markets;
  if (market === undefined) throw new Error('no winner market');
  expect(market.type).toBe('winner');
  expect(market.line).toBeNull();
  expect(market.selections.map((s) => s.code)).toEqual(['1', '2']);
  return { home: market.selections[0]!.oddsMilli, away: market.selections[1]!.oddsMilli };
}

describe('eloWinProbability', () => {
  it('is the logistic of the rating difference', () => {
    expect(eloWinProbability(1800, 1800)).toBe(0.5);
    expect(eloWinProbability(2000, 1600)).toBeCloseTo(10 / 11, 12);
    expect(eloWinProbability(1600, 2000)).toBeCloseTo(1 / 11, 12);
    expect(eloWinProbability(2100, 1700) + eloWinProbability(1700, 2100)).toBeCloseTo(1, 12);
  });
});

describe('set and match probabilities', () => {
  it('computes best-of-3 and best-of-5 match probabilities', () => {
    // p²(3 − 2p) and p³(10 − 15p + 6p²)
    expect(matchWinProbability(0.6, 2)).toBeCloseTo(0.36 * (3 - 1.2), 12);
    expect(matchWinProbability(0.6, 3)).toBeCloseTo(0.216 * (10 - 9 + 6 * 0.36), 12);
    expect(matchWinProbability(0.5, 3)).toBeCloseTo(0.5, 12);
  });

  it('accounts for sets already won', () => {
    expect(matchWinProbability(0.5, 2, 1, 0)).toBeCloseTo(0.75, 12);
    expect(matchWinProbability(0.5, 2, 1, 1)).toBeCloseTo(0.5, 12);
    expect(matchWinProbability(0.7, 3, 0, 2)).toBeCloseTo(0.343, 12);
    expect(matchWinProbability(0.3, 2, 2, 0)).toBe(1);
    expect(matchWinProbability(0.9, 2, 0, 2)).toBe(0);
    expect(() => matchWinProbability(0.5, 2, 2, 2)).toThrow(RangeError);
    expect(() => matchWinProbability(0.5, 2, 3, 0)).toThrow(RangeError);
    expect(() => matchWinProbability(1.5, 2)).toThrow(RangeError);
  });

  it('inverts the match probability to a set probability', () => {
    for (const setsToWin of [2, 3]) {
      for (const p of [0.01, 0.2, 0.5, 0.73, 0.99]) {
        const set = setWinProbability(p, setsToWin);
        expect(matchWinProbability(set, setsToWin)).toBeCloseTo(p, 10);
        // A longer match favours the stronger side: its set edge is smaller.
        if (p > 0.5) expect(set).toBeLessThan(p);
      }
    }
    expect(setWinProbability(0, 2)).toBe(0);
    expect(setWinProbability(1, 3)).toBe(1);
  });
});

describe('priceWinner', () => {
  it('makes the higher-rated player the favourite', () => {
    const { home, away } = winnerOdds(priceTennis(2100, 1750));
    expect(home).toBeLessThan(away);
    const swapped = winnerOdds(priceTennis(1750, 2100));
    expect(swapped.home).toBe(away);
    expect(swapped.away).toBe(home);
  });

  it('adjusts for sets won in play', () => {
    const prematch = winnerOdds(priceTennis(1900, 1900));
    const upASet = winnerOdds(priceTennis(1900, 1900, { state: { minute: 40, home: 1, away: 0 } }));
    expect(upASet.home).toBeLessThan(prematch.home);
    expect(upASet.away).toBeGreaterThan(prematch.away);
    // The favourite one set down in tennis is much closer to evens.
    const fav = winnerOdds(priceTennis(2100, 1800, { state: { minute: 40, home: 0, away: 1 } }));
    expect(fav.home).toBeGreaterThan(winnerOdds(priceTennis(2100, 1800)).home);
  });

  it('uses best of 5 for volleyball', () => {
    expect(SETS_TO_WIN.volleyball).toBe(3);
    const state = { minute: 50, home: 2, away: 0 };
    const tennis = winnerOdds(priceTennis(1900, 1900, { state: { minute: 50, home: 1, away: 0 } }));
    const volley = winnerOdds(priceVolleyball(1900, 1900, { state }));
    expect(volley.home).toBeLessThan(tennis.home);
    // 2-2 between equals: evens with the live margin, 1 / (0.5 × 1.08) rounded down.
    const decider = { minute: 60, home: 2, away: 2 };
    expect(winnerOdds(priceVolleyball(1900, 1900, { state: decider })).home).toBe(1850);
  });

  it('prices nothing once the match is decided', () => {
    expect(priceTennis(1800, 1800, { state: { minute: 90, home: 2, away: 1 } })).toEqual([]);
    expect(priceVolleyball(1800, 1800, { state: { minute: 90, home: 0, away: 3 } })).toEqual([]);
    expect(() => priceTennis(1800, 1800, { state: { minute: 90, home: 3, away: 0 } })).toThrow(
      RangeError,
    );
  });

  it('prices sound books for any ratings and set score (property)', () => {
    const rng = createRng('winner-property');
    for (let i = 0; i < 2000; i++) {
      const sport = rng.next() < 0.5 ? 'tennis' : 'volleyball';
      const toWin = SETS_TO_WIN[sport];
      const live = rng.next() < 0.7;
      const home = rng.int(0, toWin - 1);
      const away = rng.int(0, toWin - 1);
      const markets = priceWinner(
        sport,
        1400 + rng.next() * 900,
        1400 + rng.next() * 900,
        live ? { state: { minute: rng.next() * 150, home, away } } : {},
      );
      for (const market of markets) {
        for (const s of market.selections) expect(isValidOddsMilli(s.oddsMilli)).toBe(true);
        expect(bookOverround(market)).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
