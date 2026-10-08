import type { FinalScore, SportCode } from '@vamos/core';
import { type MatchStrengths, priceMatch } from './pricing';
import { BASKETBALL_OVERTIME_MINUTES, BASKETBALL_REGULATION_MINUTES } from './pricing/basketball';
import { clamp } from './pricing/book';
import { SETS_TO_WIN, type SetSport, eloWinProbability, setWinProbability } from './pricing/tennis';
import type { Rng } from './random';
import type { FeedMarket, LiveScoreState } from './types';

/**
 * Deterministic live match simulator for demo mode. Pure: the state goes in,
 * the next state and the events that happened come out, and all randomness
 * comes from the Rng in the context. The same state, rng seed and sequence of
 * steps always gives the same match.
 *
 * Clocks:
 * - `minute` is the match clock shown to players. Football: 0–45 (+ added
 *   time) in the first half, 45 during the break, 45–90 (+ added time) in the
 *   second half. Basketball: 0–48, then 48+ in overtime. Tennis / volleyball:
 *   minutes in play.
 * - `elapsed` counts simulated minutes since kick-off including breaks; it
 *   never goes back, so the market suspension after a goal is measured on it.
 */

export type FootballPhase = 'pre' | 'first_half' | 'half_time' | 'second_half' | 'finished';
export type InPlayPhase = 'pre' | 'in_play' | 'finished';
export type LivePhase = FootballPhase | InPlayPhase;
export type Side = 'home' | 'away';

export interface LiveMatchState {
  sport: SportCode;
  /** Football uses FootballPhase; the other sports use InPlayPhase. */
  phase: LivePhase;
  /** Match clock (see the module notes). */
  minute: number;
  /** Goals (football), points (basketball) or sets won (tennis, volleyball). */
  home: number;
  away: number;
  /** Football half-time score, set when the first half ends. */
  htHome: number | null;
  htAway: number | null;
  /** 'NS' before the start, then '1H' | 'HT' | '2H', 'Q1'…'Q4' | 'OT', 'S1'…; 'FT' at the end. */
  periodLabel: string;
  /** Markets are suspended while `elapsed` < this (see {@link isSuspended}); null = not suspended. */
  suspendedUntilMinute: number | null;
  /** Simulated minutes since kick-off, breaks included. */
  elapsed: number;
  /** `elapsed` at which the current half, break, set or (over)time ends; null before and after. */
  periodEndsAt: number | null;
}

export type MatchEventType =
  'goal' | 'point_burst' | 'set_won' | 'half_time' | 'kick_off' | 'second_half' | 'full_time';

export interface MatchEvent {
  type: MatchEventType;
  side?: Side;
  /** Match clock when it happened. */
  minute: number;
  /** Points scored in a 'point_burst'. */
  points?: number;
}

export interface AdvanceContext {
  /** From matchStrengths(): expected goals / points, or Elo-like ratings. */
  strengths: MatchStrengths;
  rng: Rng;
  /** Simulated minutes to advance; may be fractional. */
  minutes: number;
}

export interface AdvanceResult {
  state: LiveMatchState;
  events: MatchEvent[];
}

export const HALF_TIME_BREAK_MINUTES = 15;
export const GOAL_SUSPENSION_MINUTES = 2;
export const SET_SUSPENSION_MINUTES = 1;
/** Football added time per half, whole minutes drawn uniformly from these ranges. */
export const FIRST_HALF_ADDED_TIME: readonly [number, number] = [1, 3];
export const SECOND_HALF_ADDED_TIME: readonly [number, number] = [2, 6];

const HALF_MINUTES = 45;
const FULL_TIME_MINUTES = 90;
/**
 * Expected goals are per match including added time, so the per-minute goal
 * rate is λ / (90 + mean added time); the simulated mean is then exactly λ.
 */
const FOOTBALL_PLAYING_MINUTES =
  FULL_TIME_MINUTES +
  (FIRST_HALF_ADDED_TIME[0] + FIRST_HALF_ADDED_TIME[1]) / 2 +
  (SECOND_HALF_ADDED_TIME[0] + SECOND_HALF_ADDED_TIME[1]) / 2;
const QUARTER_MINUTES = BASKETBALL_REGULATION_MINUTES / 4;
/** Set length in minutes: N(mean, sd) clamped to [min, max]. */
const SET_DURATION: Readonly<
  Record<SetSport, { mean: number; sd: number; min: number; max: number }>
> = {
  tennis: { mean: 42, sd: 8, min: 25, max: 70 },
  volleyball: { mean: 24, sd: 4, min: 16, max: 35 },
};
/** Volleyball's deciding fifth set is played to 15 points. */
const VOLLEYBALL_DECIDER_FACTOR = 0.6;
const EPSILON = 1e-9;

const FOOTBALL_PHASES: ReadonlySet<string> = new Set([
  'pre',
  'first_half',
  'half_time',
  'second_half',
  'finished',
]);
const IN_PLAY_PHASES: ReadonlySet<string> = new Set(['pre', 'in_play', 'finished']);

/** A match that has not started. */
export function initialState(sport: SportCode): LiveMatchState {
  if (!isSport(sport)) throw new RangeError(`unknown sport: "${String(sport)}"`);
  return {
    sport,
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
  };
}

/**
 * Advances the match by `ctx.minutes` simulated minutes. A match that has not
 * started kicks off first (at no cost in time); a finished match does not
 * change. Football goals and basketball points arrive as Poisson processes,
 * so many small steps and one big step give the same distribution.
 */
export function advance(state: LiveMatchState, ctx: AdvanceContext): AdvanceResult {
  const { strengths, rng, minutes } = ctx;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a finite number >= 0, got ${String(minutes)}`);
  }
  checkState(state);
  checkStrengths(state.sport, strengths);

  const next: LiveMatchState = { ...state };
  const events: MatchEvent[] = [];
  if (next.phase === 'finished') return { state: next, events };
  if (next.phase === 'pre') kickOff(next, rng, events);

  let budget = minutes;
  while (budget > EPSILON && !isFinished(next)) {
    const end = next.periodEndsAt;
    if (end === null) throw new RangeError(`state in phase "${next.phase}" has no periodEndsAt`);
    const step = Math.max(0, Math.min(budget, end - next.elapsed));
    play(next, step, strengths, rng, events);
    budget -= step;
    if (next.elapsed >= end - EPSILON) {
      next.elapsed = end;
      endPeriod(next, strengths, rng, events);
    }
  }
  if (next.suspendedUntilMinute !== null && next.elapsed >= next.suspendedUntilMinute) {
    next.suspendedUntilMinute = null;
  }
  return { state: next, events };
}

/** The result of a finished match, ready for resolveSelection() from @vamos/core. */
export function finalResult(state: LiveMatchState): { status: 'finished'; score: FinalScore } {
  if (state.phase !== 'finished') {
    throw new RangeError(`the match is not finished (phase "${state.phase}")`);
  }
  const score: FinalScore =
    state.sport === 'football'
      ? { home: state.home, away: state.away, htHome: state.htHome, htAway: state.htAway }
      : { home: state.home, away: state.away };
  return { status: 'finished', score };
}

/** True while markets stay suspended after a goal or a set. */
export function isSuspended(state: LiveMatchState): boolean {
  return state.suspendedUntilMinute !== null && state.elapsed < state.suspendedUntilMinute;
}

/** The score state used for in-play pricing. */
export function toLiveScoreState(state: LiveMatchState): LiveScoreState {
  return {
    minute: state.minute,
    home: state.home,
    away: state.away,
    htHome: state.htHome,
    htAway: state.htAway,
  };
}

/**
 * Prices the match in its current state: prematch before kick-off, in play
 * while it runs, and no markets once it is finished.
 */
export function priceState(state: LiveMatchState, strengths: MatchStrengths): FeedMarket[] {
  if (state.phase === 'finished') return [];
  if (state.phase === 'pre') return priceMatch(state.sport, strengths);
  return priceMatch(state.sport, strengths, { state: toLiveScoreState(state) });
}

/**
 * Whole minute for events.live_minute: null before the start; in football the
 * clock stops at 45 / 90 during added time ("45+").
 */
export function liveMinute(state: LiveMatchState): number | null {
  if (state.phase === 'pre') return null;
  const whole = Math.floor(state.minute + EPSILON);
  if (state.sport !== 'football') return whole;
  if (state.phase === 'first_half' || state.phase === 'half_time') {
    return Math.min(whole, HALF_MINUTES);
  }
  return Math.min(whole, FULL_TIME_MINUTES);
}

function kickOff(state: LiveMatchState, rng: Rng, events: MatchEvent[]): void {
  state.minute = 0;
  state.elapsed = 0;
  events.push({ type: 'kick_off', minute: 0 });
  switch (state.sport) {
    case 'football':
      state.phase = 'first_half';
      state.periodLabel = '1H';
      state.periodEndsAt = HALF_MINUTES + rng.int(...FIRST_HALF_ADDED_TIME);
      return;
    case 'basketball':
      state.phase = 'in_play';
      state.periodLabel = 'Q1';
      state.periodEndsAt = BASKETBALL_REGULATION_MINUTES;
      return;
    case 'tennis':
    case 'volleyball':
      state.phase = 'in_play';
      state.periodLabel = 'S1';
      state.periodEndsAt = setDuration(state.sport, 1, rng);
      return;
  }
}

/** Plays `step` minutes inside the current period (no period boundary is crossed). */
function play(
  state: LiveMatchState,
  step: number,
  strengths: MatchStrengths,
  rng: Rng,
  events: MatchEvent[],
): void {
  const start = state.elapsed;
  state.elapsed += step;
  if (state.sport === 'football') {
    if (state.phase === 'half_time') return;
    playFootball(state, start, step, strengths, rng, events);
    return;
  }
  state.minute += step;
  if (state.sport === 'basketball') playBasketball(state, step, strengths, rng, events);
}

function playFootball(
  state: LiveMatchState,
  start: number,
  step: number,
  strengths: MatchStrengths,
  rng: Rng,
  events: MatchEvent[],
): void {
  const minute0 = state.minute;
  const homeGoals = rng.poisson((strengths.home / FOOTBALL_PLAYING_MINUTES) * step);
  const awayGoals = rng.poisson((strengths.away / FOOTBALL_PLAYING_MINUTES) * step);
  const goals: Array<{ side: Side; at: number }> = [];
  for (let i = 0; i < homeGoals; i++) goals.push({ side: 'home', at: rng.next() * step });
  for (let i = 0; i < awayGoals; i++) goals.push({ side: 'away', at: rng.next() * step });
  goals.sort((a, b) => a.at - b.at);
  for (const goal of goals) {
    if (goal.side === 'home') state.home++;
    else state.away++;
    events.push({ type: 'goal', side: goal.side, minute: minute0 + goal.at });
    suspend(state, start + goal.at + GOAL_SUSPENSION_MINUTES);
  }
  state.minute = minute0 + step;
}

function playBasketball(
  state: LiveMatchState,
  step: number,
  strengths: MatchStrengths,
  rng: Rng,
  events: MatchEvent[],
): void {
  const homePoints = rng.poisson((strengths.home / BASKETBALL_REGULATION_MINUTES) * step);
  const awayPoints = rng.poisson((strengths.away / BASKETBALL_REGULATION_MINUTES) * step);
  if (homePoints > 0) {
    state.home += homePoints;
    events.push({ type: 'point_burst', side: 'home', minute: state.minute, points: homePoints });
  }
  if (awayPoints > 0) {
    state.away += awayPoints;
    events.push({ type: 'point_burst', side: 'away', minute: state.minute, points: awayPoints });
  }
  state.periodLabel = basketballPeriod(state.minute);
}

/** Moves past the end of the current period (half, break, regulation / overtime, set). */
function endPeriod(
  state: LiveMatchState,
  strengths: MatchStrengths,
  rng: Rng,
  events: MatchEvent[],
): void {
  switch (state.sport) {
    case 'football':
      endFootballPeriod(state, rng, events);
      return;
    case 'basketball':
      if (state.home === state.away) {
        state.periodLabel = 'OT';
        state.periodEndsAt = state.elapsed + BASKETBALL_OVERTIME_MINUTES;
      } else {
        finish(state, events);
      }
      return;
    case 'tennis':
    case 'volleyball':
      endSet(state, state.sport, strengths, rng, events);
      return;
  }
}

function endFootballPeriod(state: LiveMatchState, rng: Rng, events: MatchEvent[]): void {
  switch (state.phase) {
    case 'first_half':
      events.push({ type: 'half_time', minute: state.minute });
      state.phase = 'half_time';
      state.periodLabel = 'HT';
      state.htHome = state.home;
      state.htAway = state.away;
      state.minute = HALF_MINUTES;
      state.periodEndsAt = state.elapsed + HALF_TIME_BREAK_MINUTES;
      return;
    case 'half_time':
      events.push({ type: 'second_half', minute: HALF_MINUTES });
      state.phase = 'second_half';
      state.periodLabel = '2H';
      state.minute = HALF_MINUTES;
      state.periodEndsAt = state.elapsed + HALF_MINUTES + rng.int(...SECOND_HALF_ADDED_TIME);
      return;
    case 'second_half':
      finish(state, events);
      state.minute = FULL_TIME_MINUTES;
      return;
    default:
      throw new RangeError(`no football period ends in phase "${state.phase}"`);
  }
}

function endSet(
  state: LiveMatchState,
  sport: SetSport,
  strengths: MatchStrengths,
  rng: Rng,
  events: MatchEvent[],
): void {
  const setsToWin = SETS_TO_WIN[sport];
  const pSet = setWinProbability(eloWinProbability(strengths.home, strengths.away), setsToWin);
  const side: Side = rng.next() < pSet ? 'home' : 'away';
  if (side === 'home') state.home++;
  else state.away++;
  events.push({ type: 'set_won', side, minute: state.minute });
  if (state.home === setsToWin || state.away === setsToWin) {
    finish(state, events);
    return;
  }
  const setNumber = state.home + state.away + 1;
  state.periodLabel = `S${setNumber}`;
  state.periodEndsAt = state.elapsed + setDuration(sport, setNumber, rng);
  suspend(state, state.elapsed + SET_SUSPENSION_MINUTES);
}

function finish(state: LiveMatchState, events: MatchEvent[]): void {
  events.push({ type: 'full_time', minute: state.minute });
  state.phase = 'finished';
  state.periodLabel = 'FT';
  state.periodEndsAt = null;
  state.suspendedUntilMinute = null;
}

function suspend(state: LiveMatchState, until: number): void {
  state.suspendedUntilMinute = Math.max(state.suspendedUntilMinute ?? until, until);
}

function setDuration(sport: SetSport, setNumber: number, rng: Rng): number {
  const { mean, sd, min, max } = SET_DURATION[sport];
  const minutes = clamp(rng.normal(mean, sd), min, max);
  const decider = sport === 'volleyball' && setNumber === 2 * SETS_TO_WIN.volleyball - 1;
  return decider ? minutes * VOLLEYBALL_DECIDER_FACTOR : minutes;
}

function basketballPeriod(minute: number): string {
  if (minute >= BASKETBALL_REGULATION_MINUTES) return 'OT';
  return `Q${Math.min(4, Math.floor(minute / QUARTER_MINUTES) + 1)}`;
}

/** A function, so the phase is re-read after the period transitions mutate the state. */
function isFinished(state: LiveMatchState): boolean {
  return state.phase === 'finished';
}

function isSport(sport: unknown): sport is SportCode {
  return (
    sport === 'football' || sport === 'basketball' || sport === 'tennis' || sport === 'volleyball'
  );
}

function checkState(state: LiveMatchState): void {
  if (typeof state !== 'object' || state === null || !isSport(state.sport)) {
    throw new RangeError('invalid live match state');
  }
  const phases = state.sport === 'football' ? FOOTBALL_PHASES : IN_PLAY_PHASES;
  if (!phases.has(state.phase)) {
    throw new RangeError(`invalid phase "${String(state.phase)}" for ${state.sport}`);
  }
  for (const value of [state.home, state.away]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`invalid score: ${String(value)}`);
    }
  }
  for (const value of [state.minute, state.elapsed]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`invalid clock: ${String(value)}`);
    }
  }
}

function checkStrengths(sport: SportCode, strengths: MatchStrengths): void {
  const { home, away } = strengths;
  const valid =
    sport === 'tennis' || sport === 'volleyball'
      ? Number.isFinite(home) && Number.isFinite(away)
      : Number.isFinite(home) && Number.isFinite(away) && home >= 0 && away >= 0;
  if (!valid) throw new RangeError(`invalid strengths for ${sport}: ${home}, ${away}`);
}
