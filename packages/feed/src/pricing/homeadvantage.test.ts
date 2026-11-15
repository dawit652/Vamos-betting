import { describe, expect, it } from 'vitest';
import { createRng } from '../random';
import { FOOTBALL_HOME_ADVANTAGE, expectedGoals } from './football';
import {
  HOME_ADVANTAGE_KEY,
  HOME_ADVANTAGE_MAX,
  HOME_ADVANTAGE_MIN,
  HOME_ADVANTAGE_MIN_MATCHES,
  HOME_ADVANTAGE_PRIOR_MATCHES,
  addHomeAdvantageResult,
  homeAdvantageOf,
  learnedHomeAdvantage,
  withHomeAdvantage,
} from './homeadvantage';
import { matchStrengths } from './index';
import { priceFixture, updateFootballRatings } from './ratings';

const season = (
  ratio: number,
  matches = 380,
): { matches: number; homeGoals: number; awayGoals: number } => {
  const away = Math.round(matches * 1.2);
  return { matches, homeGoals: Math.round(away * ratio), awayGoals: away };
};

describe('learnedHomeAdvantage', () => {
  it('falls back to the default constant with too little or unusable evidence', () => {
    expect(learnedHomeAdvantage(null)).toBe(FOOTBALL_HOME_ADVANTAGE);
    expect(learnedHomeAdvantage(undefined)).toBe(FOOTBALL_HOME_ADVANTAGE);
    expect(learnedHomeAdvantage(season(1.5, HOME_ADVANTAGE_MIN_MATCHES - 1))).toBe(
      FOOTBALL_HOME_ADVANTAGE,
    );
    for (const bad of [
      { matches: 100, homeGoals: 0, awayGoals: 90 },
      { matches: 100, homeGoals: 150, awayGoals: 0 },
      { matches: 100.5, homeGoals: 150, awayGoals: 90 },
      { matches: 100, homeGoals: Number.NaN, awayGoals: 90 },
      { matches: -5, homeGoals: 150, awayGoals: 90 },
      { matches: '100', homeGoals: 150, awayGoals: 90 },
    ]) {
      expect(learnedHomeAdvantage(bad as never)).toBe(FOOTBALL_HOME_ADVANTAGE);
    }
  });

  it('moves towards the observed ratio, weighted against the prior', () => {
    const high = learnedHomeAdvantage(season(1.4));
    const low = learnedHomeAdvantage(season(0.95));
    expect(high).toBeGreaterThan(FOOTBALL_HOME_ADVANTAGE);
    expect(high).toBeLessThan(1.4);
    expect(low).toBeLessThan(FOOTBALL_HOME_ADVANTAGE);
    expect(low).toBeGreaterThan(0.95);
    // One season weighs n / (n + n0) of the log ratio (the ratio of the rounded goals).
    const evidence = season(1.4);
    const weight = 380 / (380 + HOME_ADVANTAGE_PRIOR_MATCHES);
    const exact = Math.exp(
      weight * Math.log(evidence.homeGoals / evidence.awayGoals) +
        (1 - weight) * Math.log(FOOTBALL_HOME_ADVANTAGE),
    );
    expect(Math.abs(learnedHomeAdvantage(evidence) - exact)).toBeLessThanOrEqual(0.005 + 1e-9);
    // More evidence moves it further; no prior weight follows the data (within the band).
    expect(learnedHomeAdvantage(season(1.3, 3800))).toBeGreaterThan(
      learnedHomeAdvantage(season(1.3, 380)),
    );
    expect(learnedHomeAdvantage(season(1.25), { priorMatches: 0 })).toBe(1.25);
  });

  it('is kept in the band whatever the evidence', () => {
    expect(learnedHomeAdvantage(season(5, 100_000), { priorMatches: 0 })).toBe(HOME_ADVANTAGE_MAX);
    expect(learnedHomeAdvantage(season(0.2, 100_000), { priorMatches: 0 })).toBe(
      HOME_ADVANTAGE_MIN,
    );
    expect(learnedHomeAdvantage(null, { prior: 3 })).toBe(HOME_ADVANTAGE_MAX);
  });

  it('rejects bad options', () => {
    expect(() => learnedHomeAdvantage(null, { prior: 0 })).toThrow(RangeError);
    expect(() => learnedHomeAdvantage(null, { priorMatches: -1 })).toThrow(RangeError);
    expect(() => learnedHomeAdvantage(null, { minMatches: Number.NaN })).toThrow(RangeError);
    expect(() => learnedHomeAdvantage(null, { min: 2, max: 1 })).toThrow(RangeError);
  });

  it('property: deterministic, in the band, a whole hundredth, monotone in the home goals', () => {
    const rng = createRng('home-advantage');
    for (let i = 0; i < 5000; i++) {
      const matches = rng.int(0, 2000);
      const away = rng.int(0, 3 * matches + 1);
      const home = rng.int(0, 3 * matches + 1);
      const evidence = { matches, homeGoals: home, awayGoals: away };
      const value = learnedHomeAdvantage(evidence);
      expect(value).toBe(learnedHomeAdvantage({ ...evidence }));
      expect(value).toBeGreaterThanOrEqual(HOME_ADVANTAGE_MIN);
      expect(value).toBeLessThanOrEqual(HOME_ADVANTAGE_MAX);
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-9);
      if (matches >= HOME_ADVANTAGE_MIN_MATCHES && away > 0 && home > 0) {
        expect(learnedHomeAdvantage({ ...evidence, homeGoals: home + 5 })).toBeGreaterThanOrEqual(
          value,
        );
      } else {
        expect(value).toBe(FOOTBALL_HOME_ADVANTAGE);
      }
    }
  });
});

describe('addHomeAdvantageResult', () => {
  it('adds a result without modifying the input, and checks the goals', () => {
    const before = { matches: 3, homeGoals: 5, awayGoals: 4 };
    expect(addHomeAdvantageResult(before, 2, 1)).toEqual({
      matches: 4,
      homeGoals: 7,
      awayGoals: 5,
    });
    expect(before).toEqual({ matches: 3, homeGoals: 5, awayGoals: 4 });
    expect(addHomeAdvantageResult(null, 0, 0)).toEqual({ matches: 1, homeGoals: 0, awayGoals: 0 });
    expect(() => addHomeAdvantageResult(null, -1, 0)).toThrow(RangeError);
    expect(() => addHomeAdvantageResult(null, 1, 0.5)).toThrow(RangeError);
  });
});

describe('homeAdvantageOf and what reads it', () => {
  const home = { attack: 1.2, defence: 0.9, matches: 20 };
  const away = { attack: 0.9, defence: 1.1, matches: 20 };

  it('reads the home team, clamps, and ignores anything that is not a number', () => {
    expect(homeAdvantageOf({ ...home, [HOME_ADVANTAGE_KEY]: 1.22 })).toBe(1.22);
    expect(homeAdvantageOf({ [HOME_ADVANTAGE_KEY]: 9 })).toBe(HOME_ADVANTAGE_MAX);
    expect(homeAdvantageOf({ [HOME_ADVANTAGE_KEY]: 0.1 })).toBe(HOME_ADVANTAGE_MIN);
    for (const ratings of [
      null,
      undefined,
      {},
      [],
      { homeAdvantage: 'x' },
      { homeAdvantage: -1 },
      { homeAdvantage: Number.NaN },
      { homeAdvantage: Number.POSITIVE_INFINITY },
    ]) {
      expect(homeAdvantageOf(ratings as never)).toBe(FOOTBALL_HOME_ADVANTAGE);
    }
  });

  it('prices the match with the home team value, and the away team value does nothing', () => {
    const plain = matchStrengths('football', home, away);
    expect(plain).toEqual(
      expectedGoals({ attack: 1.2, defence: 0.9 }, { attack: 0.9, defence: 1.1 }),
    );
    const learned = matchStrengths('football', { ...home, homeAdvantage: 1.25 }, away);
    expect(learned.home).toBeCloseTo((plain.home * 1.25) / FOOTBALL_HOME_ADVANTAGE, 12);
    expect(learned.away).toBe(plain.away);
    expect(matchStrengths('football', home, { ...away, homeAdvantage: 1.3 })).toEqual(plain);
    // Higher advantage: shorter home price, longer away price.
    const odds = (h: Record<string, number>, code: string): number =>
      priceFixture('football', h, away)
        .find((m) => m.type === '1x2')!
        .selections.find((s) => s.code === code)!.oddsMilli;
    expect(odds({ ...home, homeAdvantage: 1.3 }, '1')).toBeLessThan(odds(home, '1'));
    expect(odds({ ...home, homeAdvantage: 1.3 }, '2')).toBeGreaterThan(odds(home, '2'));
  });

  it('learns with the value it prices with, keeps it, and an explicit option wins', () => {
    const learned = { ...home, homeAdvantage: 1.3 };
    const viaKey = updateFootballRatings(learned, away, { home: 3, away: 0 });
    const viaOption = updateFootballRatings(
      home,
      away,
      { home: 3, away: 0 },
      { homeAdvantage: 1.3 },
    );
    expect(viaKey.home.attack).toBe(viaOption.home.attack);
    expect(viaKey.away.defence).toBe(viaOption.away.defence);
    expect(viaKey.home.homeAdvantage).toBe(1.3);
    expect(viaKey.away).not.toHaveProperty('homeAdvantage');
    const overridden = updateFootballRatings(
      learned,
      away,
      { home: 3, away: 0 },
      { homeAdvantage: 1.15 },
    );
    expect(overridden.home.attack).toBe(
      updateFootballRatings(home, away, { home: 3, away: 0 }).home.attack,
    );
    // Without the key nothing changes from the constant.
    expect(updateFootballRatings(home, away, { home: 1, away: 1 }).home).not.toHaveProperty(
      'homeAdvantage',
    );
  });

  it('withHomeAdvantage writes the value, but leaves default ratings that have none alone', () => {
    expect(withHomeAdvantage(home, FOOTBALL_HOME_ADVANTAGE)).toBe(home);
    expect(withHomeAdvantage(home, 1.2)).toEqual({ ...home, homeAdvantage: 1.2 });
    expect(withHomeAdvantage({ ...home, homeAdvantage: 1.2 }, FOOTBALL_HOME_ADVANTAGE)).toEqual({
      ...home,
      homeAdvantage: FOOTBALL_HOME_ADVANTAGE,
    });
    expect(home).not.toHaveProperty('homeAdvantage');
  });
});
