import { marketKey, resolveSelection, type SportCode } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { type MatchStrengths, matchStrengths } from './pricing';
import { createRng } from './random';
import { type LiveMatchState, advance, finalResult, initialState, priceState } from './simulator';
import type { TeamRatings } from './types';

/**
 * The mock feed's markets are settled on the live simulator's results, so its
 * prices must not give bettors an edge over the simulator: at any point of a
 * simulated match, each offered selection must win no more often than its
 * price implies (1 / odds, which includes the margin). Matches are played as
 * the live-sim task plays them (one-minute steps, one RNG per step), every
 * offered selection is "bet" at chosen checkpoints, and the wins per
 * selection are compared with the implied probabilities. Deterministic seeds.
 */

interface Checkpoint {
  name: string;
  reached(state: LiveMatchState): boolean;
}

interface Tally {
  bets: number;
  wins: number;
  /** Σ 1/odds and Σ (1/odds)(1 − 1/odds) of the bets. */
  implied: number;
  variance: number;
}

/** Wins above the implied expectation by more than this many standard deviations fail. */
const MAX_Z = 4;
const MIN_BETS = 100;

function calibrate(
  sport: SportCode,
  strengths: MatchStrengths,
  checkpoints: readonly Checkpoint[],
  matches: number,
  seed: string,
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (let match = 0; match < matches; match++) {
    let state = initialState(sport);
    const bets: Array<{
      key: string;
      type: string;
      line: string | null;
      code: string;
      odds: number;
    }> = [];
    const reached = new Set<string>();
    const place = () => {
      for (const checkpoint of checkpoints) {
        if (reached.has(checkpoint.name) || !checkpoint.reached(state)) continue;
        reached.add(checkpoint.name);
        for (const market of priceState(state, strengths)) {
          for (const selection of market.selections) {
            bets.push({
              key: `${checkpoint.name} | ${marketKey(market.type, market.line)} ${selection.code}`,
              type: market.type,
              line: market.line,
              code: selection.code,
              odds: selection.oddsMilli,
            });
          }
        }
      }
    };
    place();
    state = advance(state, {
      strengths,
      rng: createRng(`${seed}|${match}|kick-off`),
      minutes: 0,
    }).state;
    for (let step = 0; state.phase !== 'finished'; step++) {
      place();
      state = advance(state, {
        strengths,
        rng: createRng(`${seed}|${match}|${step}`),
        minutes: 1,
      }).state;
    }
    const result = finalResult(state);
    for (const bet of bets) {
      const outcome = resolveSelection(
        { type: bet.type as Parameters<typeof resolveSelection>[0]['type'], line: bet.line },
        bet.code,
        result,
      );
      if (outcome === 'void') continue;
      const implied = 1000 / bet.odds;
      const tally = tallies.get(bet.key) ?? { bets: 0, wins: 0, implied: 0, variance: 0 };
      tally.bets++;
      if (outcome === 'won') tally.wins++;
      tally.implied += implied;
      tally.variance += implied * (1 - implied);
      tallies.set(bet.key, tally);
    }
  }
  return tallies;
}

/** Selections that won more often than their prices allow, with their z-scores. */
function edges(tallies: Map<string, Tally>): string[] {
  const found: string[] = [];
  for (const [key, tally] of tallies) {
    if (tally.bets < MIN_BETS) continue;
    const z = (tally.wins - tally.implied) / Math.sqrt(Math.max(tally.variance, 1e-9));
    if (z > MAX_Z) {
      found.push(
        `${key}: won ${tally.wins} of ${tally.bets}, implied ${tally.implied.toFixed(1)} (z ${z.toFixed(1)})`,
      );
    }
  }
  return found;
}

const FOOTBALL_CHECKPOINTS: readonly Checkpoint[] = [
  { name: 'prematch', reached: (s) => s.phase === 'pre' },
  { name: '1H 20', reached: (s) => s.phase === 'first_half' && s.minute >= 20 },
  { name: '1H added time', reached: (s) => s.phase === 'first_half' && s.minute >= 45 },
  { name: 'half time', reached: (s) => s.phase === 'half_time' },
  { name: '2H 80', reached: (s) => s.phase === 'second_half' && s.minute >= 80 },
  { name: '2H added time', reached: (s) => s.phase === 'second_half' && s.minute >= 90 },
];

const BASKETBALL_CHECKPOINTS: readonly Checkpoint[] = [
  { name: 'prematch', reached: (s) => s.phase === 'pre' },
  { name: 'Q2', reached: (s) => s.phase === 'in_play' && s.minute >= 12 },
  { name: 'half', reached: (s) => s.phase === 'in_play' && s.minute >= 24 },
  { name: 'Q4 40', reached: (s) => s.phase === 'in_play' && s.minute >= 40 },
  { name: 'Q4 46', reached: (s) => s.phase === 'in_play' && s.minute >= 46 },
  { name: 'overtime', reached: (s) => s.phase === 'in_play' && s.minute > 48 },
];

const pairings = (
  sport: SportCode,
  pairs: ReadonlyArray<[string, TeamRatings, TeamRatings]>,
): Array<[string, MatchStrengths]> =>
  pairs.map(([name, home, away]) => [name, matchStrengths(sport, home, away)]);

describe('prices against the simulator that settles them', () => {
  it.each(
    pairings('football', [
      ['equal teams', { attack: 1, defence: 1 }, { attack: 1, defence: 1 }],
      ['a strong favourite', { attack: 1.75, defence: 0.78 }, { attack: 0.9, defence: 1.02 }],
    ]),
  )(
    'football (%s): no selection beats its price, added time included',
    (name, strengths) => {
      const tallies = calibrate('football', strengths, FOOTBALL_CHECKPOINTS, 2500, `fb|${name}`);
      for (const checkpoint of FOOTBALL_CHECKPOINTS) {
        expect([...tallies.keys()].some((key) => key.startsWith(`${checkpoint.name} |`))).toBe(
          true,
        );
      }
      expect(edges(tallies)).toEqual([]);
    },
    60_000,
  );

  it.each(
    pairings('basketball', [
      ['equal teams', { offence: 1, defence: 1 }, { offence: 1, defence: 1 }],
      ['a strong favourite', { offence: 1.06, defence: 0.92 }, { offence: 0.97, defence: 1.03 }],
    ]),
  )(
    'basketball (%s): no selection beats its price, overtime included',
    (name, strengths) => {
      const tallies = calibrate(
        'basketball',
        strengths,
        BASKETBALL_CHECKPOINTS,
        2500,
        `bb|${name}`,
      );
      expect([...tallies.keys()].some((key) => key.startsWith('overtime |'))).toBe(true);
      expect(edges(tallies)).toEqual([]);
    },
    60_000,
  );
});
