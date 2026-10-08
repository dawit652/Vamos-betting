import {
  MAX_ODDS_MILLI,
  SPORT_MARKETS,
  isValidOddsMilli,
  resolveSelection,
  selectionsFor,
} from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { type Rng, createRng } from '../random';
import type { FeedMarket, LiveScoreState } from '../types';
import { bookOverround } from './book';
import {
  DEFAULT_GOAL_LINES,
  FIRST_HALF_ADDED_TIME,
  FOOTBALL_BASE_GOALS,
  FOOTBALL_HOME_ADVANTAGE,
  FOOTBALL_PLAYING_MINUTES,
  MAX_EXPECTED_GOALS,
  MIN_EXPECTED_GOALS,
  type PlayingTime,
  SECOND_HALF_ADDED_TIME,
  expectedGoals,
  priceFootball,
  remainingPlayingTime,
  scoreMatrix,
} from './football';

const NEUTRAL = { attack: 1, defence: 1 };
const FUTURES = [
  [0, 0],
  [10, 0],
  [0, 10],
  [10, 10],
] as const;

function find(
  markets: FeedMarket[],
  type: string,
  line: string | null = null,
): FeedMarket | undefined {
  return markets.find((m) => m.type === type && m.line === line);
}

function odds(
  markets: FeedMarket[],
  type: string,
  code: string,
  line: string | null = null,
): number {
  const market = find(markets, type, line);
  if (market === undefined) throw new Error(`market ${type} ${line ?? ''} not offered`);
  const selection = market.selections.find((s) => s.code === code);
  if (selection === undefined) throw new Error(`selection ${code} missing`);
  return selection.oddsMilli;
}

function randomStrength(rng: Rng): { attack: number; defence: number } {
  return { attack: 0.4 + rng.next() * 1.8, defence: 0.4 + rng.next() * 1.8 };
}

function randomState(rng: Rng): LiveScoreState {
  const minute = rng.next() * 97;
  const home = rng.int(0, 6);
  const away = rng.int(0, 6);
  if (minute >= 45 && rng.next() < 0.9) {
    return { minute, home, away, htHome: rng.int(0, home), htAway: rng.int(0, away) };
  }
  return { minute, home, away };
}

/** Checks shared by every priced book: exact codes, valid odds, overround. */
function expectSoundBooks(markets: FeedMarket[]): void {
  for (const market of markets) {
    expect(market.selections.map((s) => s.code)).toEqual([...selectionsFor(market.type)]);
    for (const selection of market.selections) {
      expect(isValidOddsMilli(selection.oddsMilli)).toBe(true);
    }
    // Double chance covers each outcome twice, so its fair book sums to 2.
    expect(bookOverround(market)).toBeGreaterThanOrEqual(market.type === 'dc' ? 2 : 1);
  }
}

describe('expectedGoals', () => {
  it('uses base 1.35 and home advantage 1.15', () => {
    expect(FOOTBALL_BASE_GOALS).toBe(1.35);
    expect(FOOTBALL_HOME_ADVANTAGE).toBe(1.15);
    const goals = expectedGoals(NEUTRAL, NEUTRAL);
    expect(goals.home).toBeCloseTo(1.35 * 1.15, 12);
    expect(goals.away).toBeCloseTo(1.35, 12);
  });

  it('multiplies attack by the opponent defence (higher defence concedes more)', () => {
    const goals = expectedGoals({ attack: 1.2, defence: 0.8 }, { attack: 0.9, defence: 1.1 });
    expect(goals.home).toBeCloseTo(1.35 * 1.2 * 1.1 * 1.15, 12);
    expect(goals.away).toBeCloseTo(1.35 * 0.9 * 0.8, 12);
    const leaky = expectedGoals(NEUTRAL, { attack: 1, defence: 1.5 });
    expect(leaky.home).toBeGreaterThan(expectedGoals(NEUTRAL, NEUTRAL).home);
  });

  it('accepts a neutral venue and a custom base', () => {
    const goals = expectedGoals(NEUTRAL, NEUTRAL, { homeAdvantage: 1, base: 1.5 });
    expect(goals).toEqual({ home: 1.5, away: 1.5 });
  });

  it('clamps extreme ratings', () => {
    const goals = expectedGoals({ attack: 50, defence: 0.001 }, { attack: 0.001, defence: 50 });
    expect(goals.home).toBe(MAX_EXPECTED_GOALS);
    expect(goals.away).toBe(MIN_EXPECTED_GOALS);
  });

  it('rejects non-positive ratings', () => {
    expect(() => expectedGoals({ attack: 0, defence: 1 }, NEUTRAL)).toThrow(RangeError);
    expect(() => expectedGoals(NEUTRAL, { attack: 1, defence: Number.NaN })).toThrow(RangeError);
    expect(() => expectedGoals(NEUTRAL, NEUTRAL, { base: -1 })).toThrow(RangeError);
  });
});

describe('scoreMatrix', () => {
  it('is an (n+1)×(n+1) grid of probabilities summing to 1', () => {
    const rng = createRng('score-matrix');
    for (let i = 0; i < 200; i++) {
      const lh = rng.next() * 5;
      const la = rng.next() * 5;
      const grid = scoreMatrix(lh, la);
      expect(grid).toHaveLength(11);
      let total = 0;
      for (const row of grid) {
        expect(row).toHaveLength(11);
        for (const p of row) {
          expect(p).toBeGreaterThanOrEqual(0);
          total += p;
        }
      }
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('has the Poisson means', () => {
    const grid = scoreMatrix(1.6, 0.9, 20);
    let home = 0;
    let away = 0;
    grid.forEach((row, h) => row.forEach((p, a) => ((home += h * p), (away += a * p))));
    expect(home).toBeCloseTo(1.6, 9);
    expect(away).toBeCloseTo(0.9, 9);
    expect(scoreMatrix(1.2, 1.1)[0]![0]).toBeCloseTo(Math.exp(-2.3), 6);
  });

  it('puts everything on 0-0 when no goals are expected', () => {
    const grid = scoreMatrix(0, 0, 3);
    expect(grid[0]![0]).toBe(1);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('rejects invalid input', () => {
    expect(() => scoreMatrix(-1, 1)).toThrow(RangeError);
    expect(() => scoreMatrix(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => scoreMatrix(1, 1, 2.5)).toThrow(RangeError);
    expect(() => scoreMatrix(1, 1, 500)).toThrow(RangeError);
  });
});

describe('remainingPlayingTime', () => {
  const minutes = (time: PlayingTime | null) =>
    (time ?? []).map((t) => Math.round(t.minutes * 1000) / 1000).sort((a, b) => a - b);
  const mean = (time: PlayingTime) => time.reduce((sum, t) => sum + t.minutes * t.weight, 0);

  it('covers the whole match, added time included, before kick-off', () => {
    const { fullTime, firstHalf } = remainingPlayingTime(0, false);
    expect(FOOTBALL_PLAYING_MINUTES).toBe(96);
    expect(mean(fullTime)).toBeCloseTo(FOOTBALL_PLAYING_MINUTES, 9);
    expect(fullTime.reduce((sum, t) => sum + t.weight, 0)).toBeCloseTo(1, 12);
    expect(minutes(fullTime)).toEqual([93, 94, 95, 96, 97, 98, 99]);
    expect(minutes(firstHalf)).toEqual([46, 47, 48]);
    expect(FIRST_HALF_ADDED_TIME).toEqual([1, 3]);
    expect(SECOND_HALF_ADDED_TIME).toEqual([2, 6]);
  });

  it('keeps the added time still possible once a half runs on', () => {
    // 47th minute of the first half: only 3 minutes of added time remain possible.
    expect(minutes(remainingPlayingTime(47, false).firstHalf)).toEqual([1]);
    expect(minutes(remainingPlayingTime(45, false).firstHalf)).toEqual([1, 2, 3]);
    // Half time and the start of the second half: 45 minutes plus 2–6 added.
    const halfTime = remainingPlayingTime(45, true);
    expect(halfTime.firstHalf).toBeNull();
    expect(minutes(halfTime.fullTime)).toEqual([47, 48, 49, 50, 51]);
    expect(minutes(remainingPlayingTime(90, true).fullTime)).toEqual([2, 3, 4, 5, 6]);
    expect(minutes(remainingPlayingTime(92, true).fullTime)).toEqual([1, 2, 3, 4]);
    // Beyond the longest added time (a real feed's clock): a token half minute.
    expect(minutes(remainingPlayingTime(97, true).fullTime)).toEqual([0.5]);
    expect(() => remainingPlayingTime(-1, false)).toThrow(RangeError);
  });
});

describe('priceFootball prematch', () => {
  const { home, away } = expectedGoals(NEUTRAL, NEUTRAL);
  const markets = priceFootball(home, away);

  it('offers every football market in display order, one O/U market per line', () => {
    const expected = SPORT_MARKETS.football.flatMap((type) =>
      type === 'ou' ? DEFAULT_GOAL_LINES.map((line) => `ou:${line}`) : [type],
    );
    expect(markets.map((m) => (m.line === null ? m.type : `${m.type}:${m.line}`))).toEqual(
      expected,
    );
    expect(find(markets, 'cs')?.selections).toHaveLength(26);
  });

  it('prices sound books', () => {
    expectSoundBooks(markets);
  });

  it('applies 600 bps to the main markets and 1500 bps to correct score', () => {
    // Rounding odds down to hundredths only ever adds a little overround.
    const main = bookOverround(find(markets, '1x2')!);
    expect(main).toBeGreaterThanOrEqual(1.06 - 1e-9);
    expect(main).toBeLessThan(1.08);
    const cs = bookOverround(find(markets, 'cs')!);
    expect(cs).toBeGreaterThanOrEqual(1.15 - 1e-9);
    expect(cs).toBeLessThan(1.2);
  });

  it('gives a fair book (overround ≈ 1) with a zero margin', () => {
    const fair = priceFootball(home, away, { marginBps: 0, correctScoreMarginBps: 0 });
    for (const market of fair) {
      const expected = market.type === 'dc' ? 2 : 1;
      expect(bookOverround(market)).toBeGreaterThanOrEqual(expected);
      if (market.type !== 'cs' && market.type !== 'ou') {
        expect(bookOverround(market)).toBeLessThan(expected + 0.03);
      }
    }
  });

  it('makes the stronger home team the favourite', () => {
    const strong = expectedGoals({ attack: 1.6, defence: 0.7 }, { attack: 0.7, defence: 1.4 });
    const priced = priceFootball(strong.home, strong.away);
    expect(odds(priced, '1x2', '1')).toBeLessThan(odds(priced, '1x2', '2'));
    expect(odds(priced, '1x2', '1')).toBeLessThan(1500);
    expect(odds(priced, 'dnb', '1')).toBeLessThan(odds(priced, 'dnb', '2'));
    // And the other way round.
    const weak = expectedGoals({ attack: 0.6, defence: 1.5 }, { attack: 1.7, defence: 0.7 });
    const pricedWeak = priceFootball(weak.home, weak.away);
    expect(odds(pricedWeak, '1x2', '2')).toBeLessThan(odds(pricedWeak, '1x2', '1'));
  });

  it('prices equal teams on a neutral venue symmetrically', () => {
    const goals = expectedGoals(NEUTRAL, NEUTRAL, { homeAdvantage: 1 });
    const priced = priceFootball(goals.home, goals.away);
    expect(odds(priced, '1x2', '1')).toBe(odds(priced, '1x2', '2'));
    expect(odds(priced, 'dc', '1X')).toBe(odds(priced, 'dc', 'X2'));
    expect(odds(priced, 'cs', '2-1')).toBe(odds(priced, 'cs', '1-2'));
  });

  it('keeps double chance consistent with 1X2', () => {
    const rng = createRng('dc-consistency');
    for (let i = 0; i < 300; i++) {
      const goals = expectedGoals(randomStrength(rng), randomStrength(rng));
      const priced = priceFootball(goals.home, goals.away);
      const pairs = { '1X': ['1', 'X'], '12': ['1', '2'], X2: ['X', '2'] } as const;
      for (const [dc, [a, b]] of Object.entries(pairs)) {
        if (find(priced, 'dc') === undefined) continue;
        const dcOdds = odds(priced, 'dc', dc);
        const oddsA = odds(priced, '1x2', a);
        const oddsB = odds(priced, '1x2', b);
        expect(dcOdds).toBeLessThanOrEqual(Math.min(oddsA, oddsB));
        if (Math.min(dcOdds, oddsA, oddsB) >= 1100 && Math.max(oddsA, oddsB) < 100_000) {
          // Same margin on both books: the DC price is the sum of its parts.
          expect(Math.abs(1000 / dcOdds - (1000 / oddsA + 1000 / oddsB))).toBeLessThan(0.02);
        }
      }
    }
  });

  it('orders O/U prices by line', () => {
    const overs = DEFAULT_GOAL_LINES.map((line) => odds(markets, 'ou', 'over', line));
    expect([...overs].sort((a, b) => a - b)).toEqual(overs);
  });

  it('canonicalises, sorts and de-duplicates custom lines', () => {
    const priced = priceFootball(home, away, { lines: ['5.5', '02.5', '2.5', '3.5'] });
    expect(priced.filter((m) => m.type === 'ou').map((m) => m.line)).toEqual(['2.5', '3.5', '5.5']);
    // A line nobody could realistically go over is not offered.
    expect(priceFootball(home, away, { lines: ['10.5'] }).some((m) => m.type === 'ou')).toBe(false);
    expect(() => priceFootball(home, away, { lines: ['2'] })).toThrow(RangeError);
    expect(() => priceFootball(home, away, { lines: ['2.25'] })).toThrow(RangeError);
  });

  it('rejects invalid input', () => {
    expect(() => priceFootball(-1, 1)).toThrow(RangeError);
    expect(() => priceFootball(1, Number.NaN)).toThrow(RangeError);
    expect(() => priceFootball(1, 1, { marginBps: -5 })).toThrow(RangeError);
    expect(() => priceFootball(1, 1, { state: { minute: -3, home: 0, away: 0 } })).toThrow(
      RangeError,
    );
  });

  it('prices sound books for any strengths (property)', () => {
    const rng = createRng('football-prematch-property');
    for (let i = 0; i < 400; i++) {
      const goals = expectedGoals(randomStrength(rng), randomStrength(rng), {
        homeAdvantage: 1 + rng.next() * 0.3,
      });
      expectSoundBooks(priceFootball(goals.home, goals.away));
    }
  });
});

describe('priceFootball in play', () => {
  const { home, away } = expectedGoals(NEUTRAL, NEUTRAL);

  it('makes a 2-0 lead in the 80th minute a near-certain home win', () => {
    for (const [h, a] of [
      [NEUTRAL, NEUTRAL],
      [
        { attack: 0.6, defence: 1.5 },
        { attack: 1.8, defence: 0.6 },
      ],
    ] as const) {
      const goals = expectedGoals(h, a);
      const state = { minute: 80, home: 2, away: 0, htHome: 1, htAway: 0 };
      const priced = priceFootball(goals.home, goals.away, { state });
      expect(odds(priced, '1x2', '1')).toBeLessThan(1100);
      expect(odds(priced, '1x2', '2')).toBeGreaterThan(20_000);
      expectSoundBooks(priced);
    }
  });

  it('uses the live margins by default (+200 bps)', () => {
    const prematch = bookOverround(find(priceFootball(home, away), '1x2')!);
    const kickOff = priceFootball(home, away, { state: { minute: 0, home: 0, away: 0 } });
    const live = bookOverround(find(kickOff, '1x2')!);
    expect(live).toBeGreaterThanOrEqual(1.08 - 1e-9);
    expect(live).toBeGreaterThan(prematch);
    expect(bookOverround(find(kickOff, 'cs')!)).toBeGreaterThanOrEqual(1.17 - 1e-9);
  });

  it('omits O/U lines already exceeded', () => {
    const priced = priceFootball(home, away, { state: { minute: 30, home: 1, away: 1 } });
    const lines = priced.filter((m) => m.type === 'ou').map((m) => m.line);
    expect(lines).not.toContain('0.5');
    expect(lines).not.toContain('1.5');
    expect(lines).toContain('2.5');
    const oneGoal = priceFootball(home, away, { state: { minute: 10, home: 0, away: 1 } });
    expect(find(oneGoal, 'ou', '0.5')).toBeUndefined();
    expect(find(oneGoal, 'ou', '1.5')).toBeDefined();
  });

  it('omits BTTS once both teams scored', () => {
    const both = priceFootball(home, away, { state: { minute: 30, home: 1, away: 1 } });
    expect(find(both, 'btts')).toBeUndefined();
    const one = priceFootball(home, away, { state: { minute: 30, home: 1, away: 0 } });
    expect(odds(one, 'btts', 'yes')).toBeLessThan(
      odds(priceFootball(home, away, { state: { minute: 30, home: 0, away: 0 } }), 'btts', 'yes'),
    );
  });

  it('offers the half-time result only until the first half is over', () => {
    const firstHalf = priceFootball(home, away, { state: { minute: 30, home: 1, away: 0 } });
    // Fifteen minutes to defend the lead for HT, sixty for FT.
    expect(odds(firstHalf, 'ht_1x2', '1')).toBeLessThan(odds(firstHalf, '1x2', '1'));
    const addedTime = priceFootball(home, away, { state: { minute: 46.5, home: 0, away: 0 } });
    expect(find(addedTime, 'ht_1x2')).toBeDefined();
    expect(odds(addedTime, 'ht_1x2', 'X')).toBeLessThan(1100);
    const halfTime = { minute: 45, home: 1, away: 0, htHome: 1, htAway: 0 };
    expect(find(priceFootball(home, away, { state: halfTime }), 'ht_1x2')).toBeUndefined();
  });

  it('shortens the leader as the clock runs down', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let minute = 46; minute <= 92; minute += 2) {
      const state = { minute, home: 1, away: 0, htHome: 0, htAway: 0 };
      const price = odds(priceFootball(home, away, { state }), '1x2', '1');
      expect(price).toBeLessThanOrEqual(previous);
      previous = price;
    }
    expect(previous).toBeLessThan(1100);
  });

  it('prices impossible correct scores at the maximum odds and drops a decided grid', () => {
    const priced = priceFootball(home, away, {
      state: { minute: 60, home: 2, away: 1, htHome: 1, htAway: 1 },
    });
    expect(odds(priced, 'cs', '0-0')).toBe(MAX_ODDS_MILLI);
    expect(odds(priced, 'cs', '1-1')).toBe(MAX_ODDS_MILLI);
    expect(odds(priced, 'cs', '2-1')).toBeLessThan(10_000);
    const outsideGrid = { minute: 70, home: 5, away: 0, htHome: 3, htAway: 0 };
    expect(find(priceFootball(home, away, { state: outsideGrid }), 'cs')).toBeUndefined();
  });

  it('prices the goals still to come in added time (regression)', () => {
    // 0-0 at 90:00 still has 2–6 minutes of added time (4 on average) to play,
    // at the simulator's rate of λ / 96 per minute: a goal in about 11% of matches.
    const state = { minute: 90, home: 0, away: 0, htHome: 0, htAway: 0 };
    const priced = priceFootball(home, away, { state });
    const over = odds(priced, 'ou', 'over', '0.5');
    expect(over).toBeGreaterThan(7000);
    expect(over).toBeLessThan(9500);
    expect(odds(priced, '1x2', 'X')).toBeGreaterThan(1020);
    // The same in first-half added time for the half-time result.
    const firstHalf = priceFootball(home, away, { state: { minute: 45, home: 0, away: 0 } });
    expect(odds(firstHalf, 'ht_1x2', '1')).toBeLessThan(40_000);
    expect(odds(firstHalf, 'ht_1x2', '2')).toBeLessThan(40_000);
  });

  it('drops a market once its outcome is practically decided', () => {
    // 0-0 deep in added time: the draw and "under 0.5" are all but certain.
    const state = { minute: 95, home: 0, away: 0, htHome: 0, htAway: 0 };
    const priced = priceFootball(home, away, { state });
    for (const market of priced) {
      for (const selection of market.selections) {
        expect(1000 / selection.oddsMilli).toBeLessThanOrEqual(1);
      }
    }
    expect(odds(priced, 'ou', 'under', '0.5')).toBeLessThan(1020);
    expectSoundBooks(priced);
  });

  it('agrees with settlement: certain outcomes are never offered (property)', () => {
    const rng = createRng('football-certain-outcomes');
    for (let i = 0; i < 600; i++) {
      const state = randomState(rng);
      const goals = expectedGoals(randomStrength(rng), randomStrength(rng));
      const priced = priceFootball(goals.home, goals.away, { state });
      const firstHalfOver = state.htHome !== undefined && state.htHome !== null;
      for (const market of priced) {
        if (market.type === 'ou') expect(state.home + state.away).toBeLessThan(Number(market.line));
        if (market.type === 'btts') expect(state.home > 0 && state.away > 0).toBe(false);
        if (market.type === 'ht_1x2') expect(firstHalfOver).toBe(false);
        if (market.type === 'cs') expect(state.home <= 4 && state.away <= 4).toBe(true);
        // Different futures (no more goals, a flood for either or both sides) settle the
        // market differently, so its outcome is still open.
        const settlements = new Set(
          FUTURES.map(([h, a]) => {
            const home = state.home + h;
            const away = state.away + a;
            const score = firstHalfOver
              ? { home, away, htHome: state.htHome, htAway: state.htAway }
              : { home, away, htHome: home, htAway: away };
            const input = { status: 'finished' as const, score };
            return market.selections.map((s) => resolveSelection(market, s.code, input)).join();
          }),
        );
        expect(settlements.size).toBeGreaterThan(1);
      }
    }
  });

  it('prices sound books for any strengths and live state (property)', () => {
    const rng = createRng('football-live-property');
    for (let i = 0; i < 1500; i++) {
      const goals = expectedGoals(randomStrength(rng), randomStrength(rng));
      const priced = priceFootball(goals.home, goals.away, { state: randomState(rng) });
      expectSoundBooks(priced);
    }
  });
});
