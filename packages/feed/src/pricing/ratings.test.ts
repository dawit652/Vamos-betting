import { isValidOddsMilli } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { type Rng, createRng } from '../random';
import type { TeamRatings } from '../types';
import { DEFAULT_MARGIN_BPS, bookOverround } from './book';
import { FOOTBALL_BASE_GOALS, FOOTBALL_HOME_ADVANTAGE, expectedGoals } from './football';
import { matchStrengths, priceMatch } from './index';
import {
  type FootballResult,
  MAX_TEAM_RATING,
  MIN_TEAM_RATING,
  RATING_META_KEYS,
  priceFixture,
  replayRatings,
  updateFootballRatings,
} from './ratings';

/*
 * Property tests run over seeded random cases (createRng) rather than
 * fast-check, which @vamos/feed cannot resolve: same idea, deterministic.
 */
const CASES = 500;

/** Values a jsonb ratings field might hold, valid or not. */
function anyValue(rng: Rng): unknown {
  return rng.pick<() => unknown>([
    () => undefined,
    () => null,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => -rng.next() * 5,
    () => 0,
    () => 'x',
    () => '1.2',
    () => 1e9,
    () => 1e-9,
    () => rng.next() * 4,
    () => 0.35 + rng.next() * 2.65,
  ])();
}

/** A team's ratings object, possibly garbage (as an untyped jsonb read can be). */
function anyRatings(rng: Rng): TeamRatings | null | undefined {
  const shape = rng.int(0, 9);
  if (shape === 0) return null;
  if (shape === 1) return undefined;
  if (shape === 2) return 'garbage' as unknown as TeamRatings;
  if (shape === 3) return [1, 2] as unknown as TeamRatings;
  const ratings: Record<string, unknown> = {};
  for (const key of ['attack', 'defence', 'matches', 'offence', 'manual', 'custom']) {
    if (rng.next() < 0.7) ratings[key] = anyValue(rng);
  }
  if (rng.next() < 0.5) ratings.matches = rng.int(0, 200);
  return ratings as TeamRatings;
}

function anyScore(rng: Rng): { home: number; away: number } {
  // Mostly realistic scores, sometimes anything up to 99.
  return rng.next() < 0.8
    ? { home: rng.int(0, 6), away: rng.int(0, 6) }
    : { home: rng.int(0, 99), away: rng.int(0, 99) };
}

function expectInBand(ratings: TeamRatings): void {
  for (const key of ['attack', 'defence']) {
    const value = ratings[key];
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(MIN_TEAM_RATING);
    expect(value).toBeLessThanOrEqual(MAX_TEAM_RATING);
  }
}

function matchesOf(ratings: TeamRatings | null | undefined): number {
  const value = (ratings as Record<string, unknown> | null | undefined)?.matches;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Spearman rank correlation (no ties expected in continuous data). */
function rankCorrelation(xs: number[], ys: number[]): number {
  const ranks = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(values.length);
    order.forEach(([, i], rank) => (out[i] = rank));
    return out;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += ((rx[i] ?? 0) - (ry[i] ?? 0)) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** Every pair plays home and away (n × (n − 1) matches), in a seeded shuffled order. */
function doubleRoundRobin(teams: readonly string[], rng: Rng): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const home of teams) for (const away of teams) if (home !== away) pairs.push([home, away]);
  return rng.shuffle(pairs);
}

describe('RATING_META_KEYS', () => {
  it('names the calibration keys shared with the safety gates', () => {
    expect(RATING_META_KEYS).toEqual({ matches: 'matches', manual: 'manual' });
    expect(Object.isFrozen(RATING_META_KEYS)).toBe(true);
  });
});

describe('updateFootballRatings', () => {
  it('starts neutral teams at 1 with 0 matches and counts the result', () => {
    const { home, away } = updateFootballRatings(null, undefined, { home: 1, away: 1 });
    expect(home.matches).toBe(1);
    expect(away.matches).toBe(1);
    // 1 goal is below the home side's 1.55 expectation and below 1.35 away.
    expect(home.attack).toBeLessThan(1);
    expect(away.attack).toBeLessThan(1);
    expect(home.defence).toBeLessThan(1);
    expect(away.defence).toBeLessThan(1);
  });

  it('moves attack and the opponent defence toward observed / expected goals', () => {
    const { home, away } = updateFootballRatings(
      { attack: 1, defence: 1, matches: 100 },
      { attack: 1, defence: 1, matches: 100 },
      { home: 4, away: 0 },
      { shrink: 0 },
    );
    const lambda = expectedGoals({ attack: 1, defence: 1 }, { attack: 1, defence: 1 });
    // k = kMin = 0.05 after 100 matches; gradient step min(ratio, 4) − 1.
    expect(home.attack).toBeCloseTo(Math.exp(0.05 * (4 / lambda.home - 1)), 12);
    expect(away.defence).toBeCloseTo(Math.exp(0.05 * (4 / lambda.home - 1)), 12);
    expect(away.attack).toBeCloseTo(Math.exp(-0.05), 12);
    expect(home.defence).toBeCloseTo(Math.exp(-0.05), 12);
  });

  it('leaves ratings unchanged (but for the pull toward 1) when the score is as expected', () => {
    // λh = 1.35 × 1.15 × (2 / 1.5525) / … choose ratings so both λ are whole numbers.
    const home = { attack: 2 / (FOOTBALL_BASE_GOALS * FOOTBALL_HOME_ADVANTAGE), defence: 1 };
    const away = { attack: 1 / FOOTBALL_BASE_GOALS, defence: 1 };
    const next = updateFootballRatings(home, away, { home: 2, away: 1 }, { shrink: 0 });
    expect(next.home.attack).toBeCloseTo(home.attack, 12);
    expect(next.home.defence).toBeCloseTo(1, 12);
    expect(next.away.attack).toBeCloseTo(away.attack, 12);
    expect(next.away.defence).toBeCloseTo(1, 12);
  });

  it('learns faster for a new team than for an established one', () => {
    const fresh = updateFootballRatings({ matches: 0 }, { matches: 0 }, { home: 3, away: 0 });
    const old = updateFootballRatings({ matches: 50 }, { matches: 50 }, { home: 3, away: 0 });
    expect(fresh.home.attack!).toBeGreaterThan(old.home.attack!);
    expect(fresh.away.attack!).toBeLessThan(old.away.attack!);
  });

  it('caps the effect of a freak score', () => {
    const nine = updateFootballRatings(null, null, { home: 9, away: 0 }, { shrink: 0 });
    const ninety = updateFootballRatings(null, null, { home: 90, away: 0 }, { shrink: 0 });
    // Both hit the ratio cap of 4: k = 1/6, step 3 → exp(0.5).
    expect(nine.home.attack).toBeCloseTo(Math.exp(0.5), 12);
    expect(ninety.home.attack).toBe(nine.home.attack);
  });

  it('preserves other keys and their order, including manual', () => {
    const home = { custom: 7, manual: 1, attack: 1.2, zeta: -3, defence: 0.9, matches: 4 };
    const away = { rating: 1500, offence: 1.1 };
    const next = updateFootballRatings(home, away, { home: 2, away: 2 });
    expect(Object.keys(next.home)).toEqual(Object.keys(home));
    expect(next.home.custom).toBe(7);
    expect(next.home.manual).toBe(1);
    expect(next.home.zeta).toBe(-3);
    expect(next.home.matches).toBe(5);
    expect(Object.keys(next.away)).toEqual(['rating', 'offence', 'attack', 'defence', 'matches']);
    expect(next.away.rating).toBe(1500);
    // Inputs are not modified.
    expect(home).toEqual({ custom: 7, manual: 1, attack: 1.2, zeta: -3, defence: 0.9, matches: 4 });
  });

  it('reads the attack as matchStrengths does (offence when attack is missing)', () => {
    const viaOffence = updateFootballRatings({ offence: 1.4 }, null, { home: 1, away: 1 });
    const viaAttack = updateFootballRatings({ attack: 1.4 }, null, { home: 1, away: 1 });
    expect(viaOffence.home.attack).toBe(viaAttack.home.attack);
  });

  it('treats invalid values as neutral 1 with 0 matches', () => {
    const garbage = {
      attack: Number.NaN,
      defence: -2,
      matches: Number.NaN,
    } as TeamRatings;
    const strings = { attack: '1.5', defence: null, matches: 'ten' } as unknown as TeamRatings;
    const neutral = updateFootballRatings(null, null, { home: 2, away: 1 });
    for (const ratings of [garbage, strings, 'nope' as unknown as TeamRatings]) {
      const next = updateFootballRatings(ratings, ratings, { home: 2, away: 1 });
      expect(next.home.attack).toBe(neutral.home.attack);
      expect(next.home.defence).toBe(neutral.home.defence);
      expect(next.away.attack).toBe(neutral.away.attack);
      expect(next.home.matches).toBe(1);
    }
  });

  it('rejects scores that are not non-negative integers', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2' as unknown as number]) {
      expect(() => updateFootballRatings(null, null, { home: bad, away: 0 })).toThrow(RangeError);
      expect(() => updateFootballRatings(null, null, { home: 0, away: bad })).toThrow(RangeError);
    }
  });

  it('rejects out-of-range options', () => {
    const score = { home: 1, away: 0 };
    expect(() => updateFootballRatings(null, null, score, { kMin: -0.1 })).toThrow(RangeError);
    expect(() => updateFootballRatings(null, null, score, { kOffset: 0 })).toThrow(RangeError);
    expect(() => updateFootballRatings(null, null, score, { maxRatio: 0.5 })).toThrow(RangeError);
    expect(() => updateFootballRatings(null, null, score, { shrink: 1 })).toThrow(RangeError);
    expect(() => updateFootballRatings(null, null, score, { base: 0 })).toThrow(RangeError);
  });

  describe('properties', () => {
    it('keeps every rating finite and within [0.35, 3] for any score and any start', () => {
      const rng = createRng('ratings:bounds');
      for (let i = 0; i < CASES; i++) {
        const next = updateFootballRatings(anyRatings(rng), anyRatings(rng), anyScore(rng));
        expectInBand(next.home);
        expectInBand(next.away);
      }
    });

    it('increments matches by exactly 1 on both teams', () => {
      const rng = createRng('ratings:matches');
      for (let i = 0; i < CASES; i++) {
        const home = anyRatings(rng);
        const away = anyRatings(rng);
        const next = updateFootballRatings(home, away, anyScore(rng));
        expect(next.home.matches).toBe(matchesOf(home) + 1);
        expect(next.away.matches).toBe(matchesOf(away) + 1);
      }
    });

    it('preserves every key other than attack, defence and matches', () => {
      const rng = createRng('ratings:keys');
      const learned = new Set(['attack', 'defence', 'matches']);
      for (let i = 0; i < CASES; i++) {
        const home = anyRatings(rng);
        const next = updateFootballRatings(home, anyRatings(rng), anyScore(rng));
        const isObject = typeof home === 'object' && home !== null && !Array.isArray(home);
        const before = isObject ? Object.entries(home).filter(([k]) => !learned.has(k)) : [];
        const after = Object.entries(next.home).filter(([k]) => !learned.has(k));
        expect(after).toEqual(before);
      }
    });

    it('scoring more never lowers the scorer attack nor the opponent defence (conceded more)', () => {
      const rng = createRng('ratings:monotone');
      for (let i = 0; i < CASES; i++) {
        const home = anyRatings(rng);
        const away = anyRatings(rng);
        const score = anyScore(rng);
        const extra = rng.int(1, 5);
        const base = updateFootballRatings(home, away, score);
        const homeMore = updateFootballRatings(home, away, {
          home: score.home + extra,
          away: score.away,
        });
        expect(homeMore.home.attack!).toBeGreaterThanOrEqual(base.home.attack!);
        expect(homeMore.away.defence!).toBeGreaterThanOrEqual(base.away.defence!);
        // The other side's numbers do not depend on the home goals.
        expect(homeMore.away.attack).toBe(base.away.attack);
        expect(homeMore.home.defence).toBe(base.home.defence);
        const awayMore = updateFootballRatings(home, away, {
          home: score.home,
          away: score.away + extra,
        });
        expect(awayMore.away.attack!).toBeGreaterThanOrEqual(base.away.attack!);
        expect(awayMore.home.defence!).toBeGreaterThanOrEqual(base.home.defence!);
      }
    });

    it('drifts a team that keeps winning 3-0 toward high attack / low defence, bounded', () => {
      let strong: TeamRatings | null = null;
      let previous = { attack: 1, defence: 1 };
      for (let i = 0; i < 300; i++) {
        const atHome = i % 2 === 0;
        const next: TeamRatings = atHome
          ? updateFootballRatings(strong, null, { home: 3, away: 0 }).home
          : updateFootballRatings(null, strong, { home: 0, away: 3 }).away;
        expectInBand(next);
        // Near its equilibrium (evidence against the pull toward 1) a rating may wobble a little.
        expect(next.attack!).toBeGreaterThanOrEqual(previous.attack - 0.01);
        expect(next.defence!).toBeLessThanOrEqual(previous.defence + 0.01);
        previous = { attack: next.attack!, defence: next.defence! };
        strong = next;
      }
      expect(previous.attack).toBeGreaterThan(1.5);
      expect(previous.defence).toBeLessThan(0.7);
    });
  });
});

describe('replayRatings', () => {
  it('replays results in order and is deterministic', () => {
    const results: FootballResult[] = [
      { home: 'a', away: 'b', homeGoals: 2, awayGoals: 1 },
      { home: 'b', away: 'c', homeGoals: 0, awayGoals: 0 },
      { home: 'c', away: 'a', homeGoals: 1, awayGoals: 3 },
    ];
    const once = replayRatings(results);
    expect(replayRatings(results)).toEqual(once);
    let a: TeamRatings | undefined;
    let b: TeamRatings | undefined;
    let c: TeamRatings | undefined;
    ({ home: a, away: b } = updateFootballRatings(a, b, { home: 2, away: 1 }));
    ({ home: b, away: c } = updateFootballRatings(b, c, { home: 0, away: 0 }));
    ({ home: c, away: a } = updateFootballRatings(c, a, { home: 1, away: 3 }));
    expect(once).toEqual(
      new Map([
        ['a', a],
        ['b', b],
        ['c', c],
      ]),
    );
    expect(once.get('a')?.matches).toBe(2);
  });

  it('starts from the initial ratings without modifying them', () => {
    const initial = new Map([['a', { attack: 1.5, defence: 0.7, matches: 30, manual: 1 }]]);
    const snapshot = structuredClone(initial);
    const out = replayRatings([{ home: 'a', away: 'z', homeGoals: 1, awayGoals: 1 }], initial);
    expect(initial).toEqual(snapshot);
    expect(out.get('a')?.matches).toBe(31);
    expect(out.get('a')?.manual).toBe(1);
    expect(out.get('z')?.matches).toBe(1);
  });

  it('rejects a team playing itself', () => {
    expect(() => replayRatings([{ home: 'a', away: 'a', homeGoals: 0, awayGoals: 0 }])).toThrow(
      RangeError,
    );
  });

  it('gives a symmetric league near-equal attack ratings', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rng = createRng('ratings:symmetric');
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [0, 0],
      [3, 2],
    ] as const) {
      // Every pair plays home and away, both legs ending x-y, in a seeded order.
      const results = doubleRoundRobin(teams, rng).map(([home, away]) => ({
        home,
        away,
        homeGoals: x,
        awayGoals: y,
      }));
      const learned = replayRatings(results);
      const attacks = teams.map((t) => learned.get(t)!.attack!);
      const defences = teams.map((t) => learned.get(t)!.defence!);
      expect(Math.max(...attacks) - Math.min(...attacks)).toBeLessThan(0.1);
      expect(Math.max(...defences) - Math.min(...defences)).toBeLessThan(0.1);
    }
  });

  it('does not depend on the order of two matches between different teams', () => {
    const rng = createRng('ratings:commute');
    for (let i = 0; i < 100; i++) {
      const initial = new Map<string, TeamRatings>();
      for (const team of ['a', 'b', 'c', 'd']) {
        const r = anyRatings(rng);
        if (r !== undefined && r !== null) initial.set(team, r);
      }
      const first = { home: 'a', away: 'b', homeGoals: rng.int(0, 9), awayGoals: rng.int(0, 9) };
      const second = { home: 'c', away: 'd', homeGoals: rng.int(0, 9), awayGoals: rng.int(0, 9) };
      expect(replayRatings([second, first], initial)).toEqual(
        replayRatings([first, second], initial),
      );
    }
  });

  it('learns strengths that rank like the true ones after one 20-team season', () => {
    const rng = createRng('ratings:calibration');
    const teams = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const truth = new Map(
      teams.map((t) => [
        t,
        { attack: Math.exp(rng.normal(0, 0.3)), defence: Math.exp(rng.normal(0, 0.3)) },
      ]),
    );
    const results: FootballResult[] = doubleRoundRobin(teams, rng).map(([home, away]) => {
      const goals = expectedGoals(truth.get(home)!, truth.get(away)!);
      return { home, away, homeGoals: rng.poisson(goals.home), awayGoals: rng.poisson(goals.away) };
    });
    expect(results).toHaveLength(380);
    const learned = replayRatings(results);
    const strength = (r: { attack: number; defence: number }): number =>
      Math.log(r.attack) - Math.log(r.defence);
    const trueStrength = teams.map((t) => strength(truth.get(t)!));
    const learnedStrength = teams.map((t) => strength(learned.get(t) as never));
    expect(rankCorrelation(learnedStrength, trueStrength)).toBeGreaterThan(0.7);
    expect(
      rankCorrelation(
        teams.map((t) => learned.get(t)!.attack!),
        teams.map((t) => truth.get(t)!.attack),
      ),
    ).toBeGreaterThan(0.7);
    expect(
      rankCorrelation(
        teams.map((t) => learned.get(t)!.defence!),
        teams.map((t) => truth.get(t)!.defence),
      ),
    ).toBeGreaterThan(0.7);
    for (const t of teams) expect(learned.get(t)!.matches).toBe(38);
  });
});

describe('priceFixture', () => {
  it('prices neutral ratings exactly as priceMatch prices neutral strengths', () => {
    const neutral = expectedGoals({ attack: 1, defence: 1 }, { attack: 1, defence: 1 });
    expect(priceFixture('football', null, undefined)).toEqual(priceMatch('football', neutral));
    expect(priceFixture('football', {}, {}, { marginBps: 400 })).toEqual(
      priceMatch('football', neutral, { marginBps: 400 }),
    );
  });

  it('prices from matchStrengths of the ratings, with a 1x2 overround inside the margin bounds', () => {
    const home = { attack: 1.4, defence: 0.8, matches: 20 };
    const away = { attack: 0.9, defence: 1.2, matches: 20 };
    const markets = priceFixture('football', home, away);
    expect(markets).toEqual(priceMatch('football', matchStrengths('football', home, away)));
    for (const market of markets) {
      for (const s of market.selections) expect(isValidOddsMilli(s.oddsMilli)).toBe(true);
    }
    const oneXTwo = markets.find((m) => m.type === '1x2')!;
    const overround = bookOverround(oneXTwo);
    expect(Math.abs(overround - (1 + DEFAULT_MARGIN_BPS / 10_000))).toBeLessThan(0.005);
  });

  it('refuses sports whose ratings this path does not calibrate', () => {
    for (const sport of ['basketball', 'tennis', 'volleyball'] as const) {
      expect(() => priceFixture(sport, null, null)).toThrow(RangeError);
    }
  });
});
