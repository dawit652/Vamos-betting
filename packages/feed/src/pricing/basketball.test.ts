import { isValidOddsMilli, parseLine, selectionsFor } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { createRng } from '../random';
import type { FeedMarket, LiveScoreState } from '../types';
import {
  BASKETBALL_MAX_MARGIN,
  BASKETBALL_MAX_TOTAL,
  BASKETBALL_MIN_TOTAL,
  expectedPoints,
  priceBasketball,
} from './basketball';
import { bookOverround } from './book';

const NEUTRAL = { attack: 1, defence: 1 };

function odds(
  markets: FeedMarket[],
  type: string,
  code: string,
  line: string | null = null,
): number {
  const selection = markets
    .find((m) => m.type === type && m.line === line)
    ?.selections.find((s) => s.code === code);
  if (selection === undefined) throw new Error(`${type} ${line ?? ''} ${code} not offered`);
  return selection.oddsMilli;
}

function totalLines(markets: FeedMarket[]): number[] {
  return markets.filter((m) => m.type === 'total').map((m) => parseLine(m.line ?? ''));
}

function expectSoundBooks(markets: FeedMarket[]): void {
  for (const market of markets) {
    expect(market.selections.map((s) => s.code)).toEqual([...selectionsFor(market.type)]);
    for (const s of market.selections) expect(isValidOddsMilli(s.oddsMilli)).toBe(true);
    expect(bookOverround(market)).toBeGreaterThanOrEqual(1);
  }
}

describe('expectedPoints', () => {
  it('gives about 195 points for two average teams, with home court', () => {
    const points = expectedPoints(NEUTRAL, NEUTRAL);
    expect(points.home + points.away).toBeCloseTo(97.5 * 2.015, 9);
    expect(points.home).toBeGreaterThan(points.away);
  });

  it('keeps the expected total within 160–230 and the margin within 25 points', () => {
    const rng = createRng('expected-points');
    for (let i = 0; i < 500; i++) {
      const r = () => ({ attack: 0.3 + rng.next() * 2, defence: 0.3 + rng.next() * 2 });
      const points = expectedPoints(r(), r());
      const total = points.home + points.away;
      expect(total).toBeGreaterThanOrEqual(BASKETBALL_MIN_TOTAL - 1e-9);
      expect(total).toBeLessThanOrEqual(BASKETBALL_MAX_TOTAL + 1e-9);
      expect(Math.abs(points.home - points.away)).toBeLessThanOrEqual(BASKETBALL_MAX_MARGIN + 1e-9);
      // Even the biggest mismatch keeps a priced winner market.
      expect(priceBasketball(points.home, points.away).some((m) => m.type === 'ml')).toBe(true);
    }
  });

  it('rejects invalid ratings', () => {
    expect(() => expectedPoints({ attack: -1, defence: 1 }, NEUTRAL)).toThrow(RangeError);
  });
});

describe('priceBasketball', () => {
  it('offers the winner and three half-point total lines around the mean', () => {
    const markets = priceBasketball(102, 96);
    expect(markets.map((m) => m.type)).toEqual(['ml', 'total', 'total', 'total']);
    expect(markets[0]?.selections.map((s) => s.code)).toEqual(['1', '2']);
    expect(totalLines(markets)).toEqual([193.5, 198.5, 203.5]);
    expectSoundBooks(markets);
  });

  it('prices the middle line close to evens and the stronger team as favourite', () => {
    const markets = priceBasketball(102, 96);
    expect(odds(markets, 'ml', '1')).toBeLessThan(odds(markets, 'ml', '2'));
    const over = odds(markets, 'total', 'over', '198.5');
    const under = odds(markets, 'total', 'under', '198.5');
    expect(Math.abs(over - under)).toBeLessThan(200);
  });

  it('prices equal teams equally', () => {
    const markets = priceBasketball(100, 100);
    expect(odds(markets, 'ml', '1')).toBe(odds(markets, 'ml', '2'));
    expect(odds(markets, 'ml', '1')).toBe(1880); // 1 / (0.5 × 1.06), rounded down
  });

  it('uses the spread of single Poisson points, as simulated (regression)', () => {
    // 108 v 87 expected points: the margin's SD is √(108 + 87) ≈ 14, so the
    // underdog wins about 6% of games (an SD of 11 would make it 2.5%).
    const markets = priceBasketball(108.05, 87.01);
    const underdog = odds(markets, 'ml', '2');
    expect(underdog).toBeGreaterThan(12_000);
    expect(underdog).toBeLessThan(18_000);
    // Overtime points count towards the total: level at 100-100 with seconds to go,
    // 200.5 is all but certain to be passed (in regulation or in overtime).
    const late = priceBasketball(100, 100, { state: { minute: 47.9, home: 100, away: 100 } });
    expect(totalLines(late)).toEqual([201.5]);
    expect(odds(late, 'total', 'over', '201.5')).toBeLessThan(
      odds(late, 'total', 'under', '201.5'),
    );
  });

  it('follows the score in play', () => {
    const late = priceBasketball(100, 100, { state: { minute: 44, home: 96, away: 90 } });
    expect(odds(late, 'ml', '1')).toBeLessThan(1050);
    // Ten up with two minutes left is practically decided: the winner market goes.
    const decided = priceBasketball(100, 100, { state: { minute: 46, home: 98, away: 88 } });
    expect(decided.some((m) => m.type === 'ml')).toBe(false);
    const early = priceBasketball(100, 100, { state: { minute: 6, home: 14, away: 10 } });
    expect(odds(early, 'ml', '1')).toBeGreaterThan(1300);
    expect(odds(early, 'ml', '1')).toBeLessThan(odds(early, 'ml', '2'));
  });

  it('centres the total lines on the projected final total and drops exceeded ones', () => {
    const state = { minute: 24, home: 50, away: 50 };
    const lines = totalLines(priceBasketball(100, 100, { state }));
    for (const line of lines) expect(Math.abs(line - 200)).toBeLessThanOrEqual(5);
    const nearEnd = priceBasketball(100, 100, { state: { minute: 47.9, home: 101, away: 99 } });
    for (const line of totalLines(nearEnd)) expect(line).toBeGreaterThan(200);
  });

  it('prices overtime from the running 5-minute period', () => {
    const tiedAtBuzzer = priceBasketball(102, 96, { state: { minute: 48, home: 100, away: 100 } });
    // A tie at the end of regulation goes to a fresh overtime: close to a coin flip.
    const home = odds(tiedAtBuzzer, 'ml', '1');
    expect(home).toBeLessThan(odds(tiedAtBuzzer, 'ml', '2'));
    expect(home).toBeGreaterThan(odds(priceBasketball(102, 96), 'ml', '1'));
    expect(home).toBeGreaterThan(1500);
    expect(totalLines(tiedAtBuzzer).every((line) => line > 200)).toBe(true);
    const overtime = priceBasketball(102, 96, { state: { minute: 50, home: 104, away: 100 } });
    expect(odds(overtime, 'ml', '1')).toBeLessThan(1200);
    expectSoundBooks(overtime);
  });

  it('prices nothing once the game is decided', () => {
    expect(priceBasketball(100, 100, { state: { minute: 48, home: 110, away: 90 } })).toEqual([]);
    expect(priceBasketball(100, 100, { state: { minute: 53, home: 111, away: 110 } })).toEqual([]);
  });

  it('rejects invalid input', () => {
    expect(() => priceBasketball(0, 100)).toThrow(RangeError);
    expect(() => priceBasketball(100, 100, { marginBps: 1.5 })).toThrow(RangeError);
  });

  it('prices sound books for any strengths and live state (property)', () => {
    const rng = createRng('basketball-property');
    for (let i = 0; i < 1500; i++) {
      const total = 160 + rng.next() * 70;
      const share = 0.4 + rng.next() * 0.2;
      const live = rng.next() < 0.8;
      const minute = rng.next() * 58;
      const state: LiveScoreState = {
        minute,
        home: rng.int(0, Math.round(minute * 2.6)),
        away: rng.int(0, Math.round(minute * 2.6)),
      };
      const markets = priceBasketball(total * share, total * (1 - share), live ? { state } : {});
      expectSoundBooks(markets);
      for (const line of totalLines(markets)) {
        expect(line).toBeGreaterThan(live ? state.home + state.away : 0);
      }
    }
  });
});
