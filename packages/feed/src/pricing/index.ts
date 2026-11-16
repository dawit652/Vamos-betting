import type { SportCode } from '@vamos/core';
import type { FeedMarket, LiveScoreState, TeamRatings } from '../types';
import { expectedPoints, priceBasketball } from './basketball';
import { isPositiveFinite } from './book';
import { expectedGoals, priceFootball } from './football';
import { HOME_ADVANTAGE_KEY, homeAdvantageOf } from './homeadvantage';
import { DEFAULT_PLAYER_RATING, priceWinner } from './tennis';

export {
  CORRECT_SCORE_MARGIN_BPS,
  DEFAULT_MARGIN_BPS,
  LIVE_MARGIN_EXTRA_BPS,
  MIN_PROBABILITY,
  bookOverround,
  buildMarket,
  defaultMarginBps,
  normalCdf,
  priceBook,
  priceProbability,
} from './book';
export * from './football';
export * from './factory';
export * from './market';
export * from './board';
export * from './basketball';
export * from './tennis';
export * from './ratings';
export * from './homeadvantage';

/**
 * Model inputs of one match, derived from the two teams' ratings and shared
 * by the pricing and the live simulator:
 * - football: expected goals over 90 minutes,
 * - basketball: expected points over 48 minutes,
 * - tennis / volleyball: Elo-like ratings.
 */
export interface MatchStrengths {
  home: number;
  away: number;
}

/**
 * teams.ratings keys read by the mock feed (as written by the catalogue
 * seed). Missing or invalid values fall back to the neutral default.
 * - football: `attack` and `defence`, and on the home team's ratings the
 *   competition's `homeAdvantage` (learned from results, see homeadvantage.ts);
 *   basketball: `offence` (or `attack`) and
 *   `defence`. Multipliers of the league average, 1 = average; a higher
 *   defence concedes MORE.
 * - tennis, volleyball: `rating`, Elo-like with 1500 average.
 */
export const RATING_KEYS = Object.freeze({
  homeAdvantage: HOME_ADVANTAGE_KEY,
  attack: 'attack',
  offence: 'offence',
  defence: 'defence',
  rating: 'rating',
});

/** Strengths of a match from the teams' ratings (teams.ratings; null = defaults). */
export function matchStrengths(
  sport: SportCode,
  homeRatings: TeamRatings | null | undefined,
  awayRatings: TeamRatings | null | undefined,
): MatchStrengths {
  switch (sport) {
    case 'football':
      return expectedGoals(
        attackDefence(homeRatings, RATING_KEYS.attack),
        attackDefence(awayRatings, RATING_KEYS.attack),
        { homeAdvantage: homeAdvantageOf(homeRatings) },
      );
    case 'basketball':
      return expectedPoints(
        attackDefence(homeRatings, RATING_KEYS.offence),
        attackDefence(awayRatings, RATING_KEYS.offence),
      );
    case 'tennis':
    case 'volleyball':
      return {
        home: ratingOf(homeRatings, RATING_KEYS.rating, DEFAULT_PLAYER_RATING),
        away: ratingOf(awayRatings, RATING_KEYS.rating, DEFAULT_PLAYER_RATING),
      };
    default: {
      const unknown: never = sport;
      throw new RangeError(`unknown sport: "${String(unknown)}"`);
    }
  }
}

export interface MatchPricingOptions {
  /** In-play state; omitted for prematch prices. */
  state?: LiveScoreState;
  /** Overrides the default margin of the sport's main markets. */
  marginBps?: number;
}

/** Prices a match of any sport from its strengths, prematch or in play. */
export function priceMatch(
  sport: SportCode,
  strengths: MatchStrengths,
  opts: MatchPricingOptions = {},
): FeedMarket[] {
  const options = {
    ...(opts.state === undefined ? {} : { state: opts.state }),
    ...(opts.marginBps === undefined ? {} : { marginBps: opts.marginBps }),
  };
  switch (sport) {
    case 'football':
      return priceFootball(strengths.home, strengths.away, options);
    case 'basketball':
      return priceBasketball(strengths.home, strengths.away, options);
    case 'tennis':
    case 'volleyball':
      return priceWinner(sport, strengths.home, strengths.away, options);
    default: {
      const unknown: never = sport;
      throw new RangeError(`unknown sport: "${String(unknown)}"`);
    }
  }
}

/** Attack from `attackKey`, else the other spelling ('attack' / 'offence'), else 1. */
function attackDefence(
  ratings: TeamRatings | null | undefined,
  attackKey: string,
): { attack: number; defence: number } {
  const otherKey = attackKey === RATING_KEYS.attack ? RATING_KEYS.offence : RATING_KEYS.attack;
  return {
    attack: ratingOf(ratings, attackKey, ratingOf(ratings, otherKey, 1)),
    defence: ratingOf(ratings, RATING_KEYS.defence, 1),
  };
}

function ratingOf(ratings: TeamRatings | null | undefined, key: string, fallback: number): number {
  const value = ratings?.[key];
  return isPositiveFinite(value) ? value : fallback;
}
