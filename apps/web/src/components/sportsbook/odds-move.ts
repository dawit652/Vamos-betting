/**
 * Price-move indicator of an odds button: pure helpers (no React, no clock of
 * their own; callers pass `now` in ms) so they are unit tested.
 */

/** How long the arrow stays after a change. */
export const MOVE_MS = 3000;

export type OddsMove = 'up' | 'down';

/** Direction from the previous to the next odds (integer milli); null when equal. */
export function oddsDirection(previousMilli: number, nextMilli: number): OddsMove | null {
  if (nextMilli > previousMilli) return 'up';
  if (nextMilli < previousMilli) return 'down';
  return null;
}

export interface MoveState {
  /** The odds last seen. */
  oddsMilli: number;
  move: OddsMove | null;
  /** The arrow is shown while `now < until`. */
  until: number;
}

/** The first value shown is a baseline, never a change. */
export function initialMove(oddsMilli: number): MoveState {
  return { oddsMilli, move: null, until: 0 };
}

/** Records the next odds: a change starts (or restarts) the arrow, the same value keeps the state. */
export function advanceMove(state: MoveState, oddsMilli: number, now: number): MoveState {
  const move = oddsDirection(state.oddsMilli, oddsMilli);
  if (move === null) return state;
  return { oddsMilli, move, until: now + MOVE_MS };
}

/** The arrow to show at `now`, null once it expired. */
export function activeMove(state: MoveState, now: number): OddsMove | null {
  return state.move !== null && now < state.until ? state.move : null;
}
