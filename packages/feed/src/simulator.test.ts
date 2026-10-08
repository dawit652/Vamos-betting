import { SPORT_MARKETS, type SportCode, resolveSelection, selectionsFor } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { type MatchStrengths, expectedGoals, priceMatch } from './pricing';
import { createRng } from './random';
import {
  FIRST_HALF_ADDED_TIME,
  GOAL_SUSPENSION_MINUTES,
  HALF_TIME_BREAK_MINUTES,
  type LiveMatchState,
  type MatchEvent,
  SECOND_HALF_ADDED_TIME,
  advance,
  finalResult,
  initialState,
  isSuspended,
  liveMinute,
  priceState,
  toLiveScoreState,
} from './simulator';

const FOOTBALL = expectedGoals({ attack: 1, defence: 1 }, { attack: 1, defence: 1 });
const BASKETBALL: MatchStrengths = { home: 101, away: 96 };
const TENNIS: MatchStrengths = { home: 2000, away: 1850 };

interface Played {
  state: LiveMatchState;
  events: MatchEvent[];
  states: LiveMatchState[];
}

/** Plays a match to the end with fixed steps (or one huge step when step is Infinity). */
function playOut(
  sport: SportCode,
  strengths: MatchStrengths,
  seed: number | string,
  step = 1,
): Played {
  const rng = createRng(seed);
  let state = initialState(sport);
  const events: MatchEvent[] = [];
  const states: LiveMatchState[] = [];
  for (let i = 0; i < 100_000 && state.phase !== 'finished'; i++) {
    const result = advance(state, {
      strengths,
      rng,
      minutes: Number.isFinite(step) ? step : 10_000,
    });
    state = result.state;
    events.push(...result.events);
    states.push(state);
  }
  return { state, events, states };
}

describe('initialState', () => {
  it('has not started', () => {
    expect(initialState('football')).toEqual({
      sport: 'football',
      phase: 'pre',
      minute: 0,
      home: 0,
      away: 0,
      htHome: null,
      htAway: null,
      periodLabel: 'NS',
      suspendedUntilMinute: null,
      elapsed: 0,
      periodEndsAt: null,
    });
    expect(() => initialState('cricket' as SportCode)).toThrow(RangeError);
  });
});

describe('advance', () => {
  it('kicks off without using time', () => {
    const { state, events } = advance(initialState('football'), {
      strengths: FOOTBALL,
      rng: createRng(1),
      minutes: 0,
    });
    expect(events).toEqual([{ type: 'kick_off', minute: 0 }]);
    expect(state).toMatchObject({ phase: 'first_half', periodLabel: '1H', minute: 0, elapsed: 0 });
    expect(state.periodEndsAt).toBeGreaterThanOrEqual(45 + FIRST_HALF_ADDED_TIME[0]);
    expect(state.periodEndsAt).toBeLessThanOrEqual(45 + FIRST_HALF_ADDED_TIME[1]);
  });

  it('is reproducible: same seed and steps give the same match', () => {
    for (const [sport, strengths] of [
      ['football', FOOTBALL],
      ['basketball', BASKETBALL],
      ['tennis', TENNIS],
      ['volleyball', TENNIS],
    ] as const) {
      for (const seed of [1, 2, 'x']) {
        const a = playOut(sport, strengths, seed, 0.7);
        const b = playOut(sport, strengths, seed, 0.7);
        expect(b.events).toEqual(a.events);
        expect(b.states).toEqual(a.states);
      }
      const results = new Set(
        Array.from({ length: 30 }, (_, seed) =>
          JSON.stringify(playOut(sport, strengths, seed).events),
        ),
      );
      expect(results.size).toBeGreaterThan(20);
    }
  });

  it('does not modify the input state', () => {
    const rng = createRng(3);
    const start = Object.freeze(initialState('football'));
    const first = advance(start, { strengths: FOOTBALL, rng, minutes: 30 });
    const frozen = Object.freeze({ ...first.state });
    expect(() => advance(frozen, { strengths: FOOTBALL, rng, minutes: 60 })).not.toThrow();
    expect(start.phase).toBe('pre');
  });

  it('leaves a finished match alone', () => {
    const { state } = playOut('football', FOOTBALL, 4);
    const again = advance(state, { strengths: FOOTBALL, rng: createRng(1), minutes: 50 });
    expect(again.state).toEqual(state);
    expect(again.events).toEqual([]);
  });

  it('rejects invalid input', () => {
    const rng = createRng(1);
    const state = initialState('football');
    expect(() => advance(state, { strengths: FOOTBALL, rng, minutes: -1 })).toThrow(RangeError);
    expect(() => advance(state, { strengths: FOOTBALL, rng, minutes: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() =>
      advance(state, { strengths: { home: Number.NaN, away: 1 }, rng, minutes: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      advance({ ...state, phase: 'in_play' }, { strengths: FOOTBALL, rng, minutes: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      advance(
        { ...state, sport: 'tennis', phase: 'first_half' },
        { strengths: TENNIS, rng, minutes: 1 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      advance({ ...state, phase: 'first_half' }, { strengths: FOOTBALL, rng, minutes: 1 }),
    ).toThrow(RangeError); // no periodEndsAt
  });
});

describe('football simulation', () => {
  it('runs first half, a 15-minute break, second half and full time', () => {
    for (let seed = 0; seed < 50; seed++) {
      const { state, events, states } = playOut('football', FOOTBALL, seed, 0.5);
      const types = events.filter((e) => e.type !== 'goal').map((e) => e.type);
      expect(types).toEqual(['kick_off', 'half_time', 'second_half', 'full_time']);
      const halfTime = events.find((e) => e.type === 'half_time')!;
      const fullTime = events.find((e) => e.type === 'full_time')!;
      expect(halfTime.minute).toBeGreaterThanOrEqual(45 + FIRST_HALF_ADDED_TIME[0]);
      expect(halfTime.minute).toBeLessThanOrEqual(45 + FIRST_HALF_ADDED_TIME[1]);
      expect(fullTime.minute).toBeGreaterThanOrEqual(90 + SECOND_HALF_ADDED_TIME[0]);
      expect(fullTime.minute).toBeLessThanOrEqual(90 + SECOND_HALF_ADDED_TIME[1]);

      const breakStart = states.findIndex((s) => s.phase === 'half_time');
      const breakEnd = states.findIndex((s) => s.phase === 'second_half');
      const breakElapsed = states[breakEnd]!.elapsed - states[breakStart]!.elapsed;
      // Measured on 0.5-minute steps.
      expect(Math.abs(breakElapsed - HALF_TIME_BREAK_MINUTES)).toBeLessThanOrEqual(0.5);
      expect(state.elapsed).toBeCloseTo(fullTime.minute + halfTime.minute - 45 + 15, 9);

      const labels = [...new Set(states.map((s) => s.periodLabel))];
      expect(labels).toEqual(['1H', 'HT', '2H', 'FT']);
      expect(state).toMatchObject({ phase: 'finished', minute: 90, periodEndsAt: null });

      const goals = events.filter((e) => e.type === 'goal');
      expect(goals.filter((g) => g.side === 'home')).toHaveLength(state.home);
      expect(goals.filter((g) => g.side === 'away')).toHaveLength(state.away);
      const firstHalfGoals = goals.filter((g) => events.indexOf(g) < events.indexOf(halfTime));
      expect(state.htHome! + state.htAway!).toBe(firstHalfGoals.length);
      for (const goal of goals) expect(goal.minute).toBeLessThanOrEqual(fullTime.minute);
      // Events come out in time order within each half.
      const minutes = (list: MatchEvent[]) => list.map((g) => g.minute);
      expect(minutes(firstHalfGoals)).toEqual([...minutes(firstHalfGoals)].sort((a, b) => a - b));
    }
  });

  it('averages λh + λa goals over 2,000 seeds (within 10%)', () => {
    let home = 0;
    let away = 0;
    const seeds = 2000;
    for (let seed = 0; seed < seeds; seed++) {
      const { state } = playOut('football', FOOTBALL, `goals-${seed}`, 1);
      home += state.home;
      away += state.away;
    }
    expect(Math.abs(home / seeds - FOOTBALL.home) / FOOTBALL.home).toBeLessThan(0.1);
    expect(Math.abs(away / seeds - FOOTBALL.away) / FOOTBALL.away).toBeLessThan(0.1);
    const total = (home + away) / seeds;
    expect(
      Math.abs(total - (FOOTBALL.home + FOOTBALL.away)) / (FOOTBALL.home + FOOTBALL.away),
    ).toBeLessThan(0.1);
  });

  it('gives the same goal distribution for many small steps and one big step', () => {
    const seeds = 2000;
    let small = 0;
    let big = 0;
    let smallHalf = 0;
    let bigHalf = 0;
    for (let seed = 0; seed < seeds; seed++) {
      const a = playOut('football', FOOTBALL, `steps-${seed}`, 0.25).state;
      const b = playOut('football', FOOTBALL, `steps-${seed}`, Number.POSITIVE_INFINITY).state;
      small += a.home + a.away;
      big += b.home + b.away;
      smallHalf += a.htHome! + a.htAway!;
      bigHalf += b.htHome! + b.htAway!;
    }
    const expected = FOOTBALL.home + FOOTBALL.away;
    expect(Math.abs(small - big) / seeds / expected).toBeLessThan(0.1);
    expect(Math.abs(big / seeds - expected) / expected).toBeLessThan(0.1);
    expect(Math.abs(smallHalf - bigHalf) / seeds / (expected / 2)).toBeLessThan(0.12);
  });

  it('suspends markets for two minutes after a goal', () => {
    const rng = createRng(5);
    let { state } = advance(initialState('football'), { strengths: FOOTBALL, rng, minutes: 10 });
    expect(isSuspended(state)).toBe(false);
    // A huge scoring rate makes a goal in the next half minute certain.
    const flood = advance(state, { strengths: { home: 5000, away: 0 }, rng, minutes: 0.5 });
    state = flood.state;
    const lastGoal = flood.events.filter((e) => e.type === 'goal').at(-1)!;
    expect(lastGoal.side).toBe('home');
    expect(isSuspended(state)).toBe(true);
    expect(state.suspendedUntilMinute).toBeCloseTo(lastGoal.minute + GOAL_SUSPENSION_MINUTES, 9);
    const quiet = { home: 0, away: 0 };
    // In the first half the elapsed clock equals the match minute.
    const untilJustBefore = lastGoal.minute + GOAL_SUSPENSION_MINUTES - state.elapsed - 0.05;
    state = advance(state, { strengths: quiet, rng, minutes: untilJustBefore }).state;
    expect(isSuspended(state)).toBe(true);
    state = advance(state, { strengths: quiet, rng, minutes: 0.1 }).state;
    expect(isSuspended(state)).toBe(false);
    expect(state.suspendedUntilMinute).toBeNull();
  });

  it('produces a result that settles every football market', () => {
    for (let seed = 0; seed < 100; seed++) {
      const { state } = playOut('football', FOOTBALL, seed, 3);
      const result = finalResult(state);
      expect(result.score).toEqual({
        home: state.home,
        away: state.away,
        htHome: state.htHome,
        htAway: state.htAway,
      });
      for (const market of priceMatch('football', FOOTBALL)) {
        const outcomes = market.selections.map((s) => resolveSelection(market, s.code, result));
        if (market.type === 'dnb' && state.home === state.away) {
          expect(outcomes).toEqual(['void', 'void']);
        } else if (market.type === 'dc') {
          expect(outcomes.filter((o) => o === 'won')).toHaveLength(2);
        } else {
          expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
        }
      }
    }
  });

  it('refuses a result before full time', () => {
    const { state } = advance(initialState('football'), {
      strengths: FOOTBALL,
      rng: createRng(1),
      minutes: 50,
    });
    expect(() => finalResult(state)).toThrow(RangeError);
  });
});

describe('basketball simulation', () => {
  it('plays four quarters, goes to overtime on a tie and never ends level', () => {
    let total = 0;
    const seeds = 500;
    for (let seed = 0; seed < seeds; seed++) {
      const { state, states, events } = playOut('basketball', BASKETBALL, seed, 1);
      expect(state.phase).toBe('finished');
      expect(state.home).not.toBe(state.away);
      expect(state.minute).toBeGreaterThanOrEqual(48);
      expect((state.minute - 48) % 5).toBeCloseTo(0, 6);
      const labels = [...new Set(states.map((s) => s.periodLabel))];
      expect(labels.slice(0, 4)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
      expect(labels.at(-1)).toBe('FT');
      const scored = events.filter((e) => e.type === 'point_burst');
      expect(scored.filter((e) => e.side === 'home').reduce((s, e) => s + e.points!, 0)).toBe(
        state.home,
      );
      total += state.home + state.away;
      const outcomes = selectionsFor('ml').map((code) =>
        resolveSelection({ type: 'ml' }, code, finalResult(state)),
      );
      expect(outcomes.sort()).toEqual(['lost', 'won']);
    }
    // Overtime adds a little; regulation alone averages home + away.
    const mean = total / seeds;
    expect(mean).toBeGreaterThan(BASKETBALL.home + BASKETBALL.away - 3);
    expect(mean).toBeLessThan(BASKETBALL.home + BASKETBALL.away + 6);
  });

  it('adds a 5-minute overtime when tied at the buzzer', () => {
    const rng = createRng(1);
    const tied: LiveMatchState = {
      ...initialState('basketball'),
      phase: 'in_play',
      periodLabel: 'Q4',
      minute: 47.5,
      elapsed: 47.5,
      home: 90,
      away: 90,
      periodEndsAt: 48,
    };
    const next = advance(tied, { strengths: { home: 0, away: 0 }, rng, minutes: 1 }).state;
    expect(next).toMatchObject({ phase: 'in_play', periodLabel: 'OT', periodEndsAt: 53 });
    expect(next.minute).toBeCloseTo(48.5, 9);
  });
});

describe('tennis and volleyball simulation', () => {
  it.each([
    ['tennis', 2],
    ['volleyball', 3],
  ] as const)('%s ends when a side has won %d sets', (sport, setsToWin) => {
    let homeWins = 0;
    const seeds = 600;
    for (let seed = 0; seed < seeds; seed++) {
      const { state, events, states } = playOut(sport, TENNIS, seed, 2);
      expect(Math.max(state.home, state.away)).toBe(setsToWin);
      expect(Math.min(state.home, state.away)).toBeLessThan(setsToWin);
      const sets = events.filter((e) => e.type === 'set_won');
      expect(sets).toHaveLength(state.home + state.away);
      const labels = [...new Set(states.map((s) => s.periodLabel))];
      expect(labels.at(-1)).toBe('FT');
      expect(labels[0]).toBe('S1');
      if (state.home > state.away) homeWins++;
      const outcome = resolveSelection({ type: 'winner' }, '1', finalResult(state));
      expect(outcome).toBe(state.home > state.away ? 'won' : 'lost');
    }
    // The higher-rated side (Elo +150 → 70% per match) wins clearly more often.
    expect(homeWins / seeds).toBeGreaterThan(0.6);
    expect(homeWins / seeds).toBeLessThan(0.8);
  });

  it('suspends markets briefly after a set', () => {
    const rng = createRng(2);
    let state = advance(initialState('tennis'), { strengths: TENNIS, rng, minutes: 0 }).state;
    const setEnd = state.periodEndsAt!;
    state = advance(state, { strengths: TENNIS, rng, minutes: setEnd + 0.5 }).state;
    expect(state.home + state.away).toBe(1);
    expect(state.periodLabel).toBe('S2');
    expect(isSuspended(state)).toBe(true);
    state = advance(state, { strengths: TENNIS, rng, minutes: 0.6 }).state;
    expect(isSuspended(state)).toBe(false);
  });
});

describe('helpers', () => {
  it('liveMinute holds the football clock at 45 / 90 in added time', () => {
    const rng = createRng(8);
    const pre = initialState('football');
    expect(liveMinute(pre)).toBeNull();
    let state = advance(pre, { strengths: FOOTBALL, rng, minutes: 30.7 }).state;
    expect(liveMinute(state)).toBe(30);
    state = advance(state, { strengths: FOOTBALL, rng, minutes: 15.2 }).state; // 45+0.9
    expect(state.phase).toBe('first_half');
    expect(liveMinute(state)).toBe(45);
    const { state: done } = playOut('football', FOOTBALL, 8);
    expect(liveMinute(done)).toBe(90);
    const basketball = advance(initialState('basketball'), {
      strengths: BASKETBALL,
      rng,
      minutes: 13.5,
    }).state;
    expect(liveMinute(basketball)).toBe(13);
    expect(basketball.periodLabel).toBe('Q2');
  });

  it('toLiveScoreState and priceState follow the match', () => {
    const rng = createRng(9);
    const pre = initialState('football');
    expect(priceState(pre, FOOTBALL)).toEqual(priceMatch('football', FOOTBALL));
    const live = advance(pre, { strengths: FOOTBALL, rng, minutes: 60 }).state;
    expect(toLiveScoreState(live)).toEqual({
      minute: live.minute,
      home: live.home,
      away: live.away,
      htHome: live.htHome,
      htAway: live.htAway,
    });
    const livePrices = priceState(live, FOOTBALL);
    expect(livePrices).toEqual(priceMatch('football', FOOTBALL, { state: toLiveScoreState(live) }));
    expect(livePrices.some((m) => m.type === 'ht_1x2')).toBe(false);
    const { state: done } = playOut('football', FOOTBALL, 9);
    expect(priceState(done, FOOTBALL)).toEqual([]);
    for (const sport of ['basketball', 'tennis', 'volleyball'] as const) {
      const strengths = sport === 'basketball' ? BASKETBALL : TENNIS;
      const types = new Set(priceState(initialState(sport), strengths).map((m) => m.type));
      expect([...types]).toEqual([...SPORT_MARKETS[sport]]);
    }
  });
});
