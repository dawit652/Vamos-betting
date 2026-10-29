import type { SportCode } from '@vamos/core';
import type { FeedMarket, TeamRatings } from '../types';
import { clamp, isPositiveFinite } from './book';
import { FOOTBALL_BASE_GOALS, FOOTBALL_HOME_ADVANTAGE, expectedGoals } from './football';
import { RATING_KEYS, matchStrengths, priceMatch } from './index';

/**
 * Mode A of the scraper (docs/scraper.md, 6.5): matches are priced in house
 * from team ratings, and the final scores scraped from outside sources update
 * those ratings. Scraped bookmaker odds never enter this path.
 *
 * Football ratings are `attack` and `defence`, multipliers of the league
 * average (1 = average; a higher defence concedes MORE), read exactly as
 * matchStrengths reads them so that what is learned is what gets priced.
 *
 * Floats are fine here: ratings and probabilities are not money. Prices come
 * out as integer milli through priceMatch.
 */

/**
 * teams.ratings keys this module writes besides the strengths, shared by
 * convention with the scraper's safety gates (rule O1: a team is calibrated
 * when `matches >= MIN_RATING_MATCHES` or `manual = 1`).
 * - `matches`: number of results the ratings have learned from.
 * - `manual`: 1 when a trader verified the team; never written here.
 */
export const RATING_META_KEYS = Object.freeze({
  matches: 'matches',
  manual: 'manual',
} as const);

/** Every learned strength is kept in this band, so no result can make a team unpriceable. */
export const MIN_TEAM_RATING = 0.35;
export const MAX_TEAM_RATING = 3.0;
/** Floor of the learning rate: an established team still follows changes in form. */
export const DEFAULT_RATING_K_MIN = 0.05;
/** The learning rate is 1 / (matches + offset): the first results move a new team the most. */
export const DEFAULT_RATING_K_OFFSET = 6;
/**
 * Observed / expected goals is capped at this ratio, so one freak score (9-0)
 * cannot explode a rating. The lower end needs no cap: see updateFootballRatings.
 */
export const DEFAULT_MAX_GOALS_RATIO = 4;
/** Share of the log-rating removed after each update: a mild pull back toward the average 1. */
export const DEFAULT_RATING_SHRINK = 0.01;

export interface RatingUpdateOptions {
  /** Learning-rate floor (default 0.05). */
  kMin?: number;
  /** Learning-rate offset: k = max(kMin, 1 / (matches + kOffset)) (default 6). */
  kOffset?: number;
  /** Cap of observed / expected goals (default 4). */
  maxRatio?: number;
  /** Pull toward 1 per update, as a share of the log-rating in [0, 1) (default 0.01). */
  shrink?: number;
  /** League-average goals per team, as in expectedGoals (default FOOTBALL_BASE_GOALS). */
  base?: number;
  /** Home advantage, as in expectedGoals (default FOOTBALL_HOME_ADVANTAGE). */
  homeAdvantage?: number;
}

export interface FootballScore {
  home: number;
  away: number;
}

/**
 * Both teams' ratings after one final football score. Pure: the inputs are
 * not modified.
 *
 * The goals the CURRENT ratings expect (expectedGoals) are compared with the
 * goals scored. Home attack and away defence move toward homeGoals / λh (the
 * away side conceded those goals), away attack and home defence toward
 * awayGoals / λa. Each team learns at its own rate
 * k = max(kMin, 1 / (matches + kOffset)), so a new team converges quickly and
 * an established one is not thrown around by a single result.
 *
 * The step is taken in log space, ln r' = ln r + k × (min(ratio, maxRatio) − 1),
 * which is the gradient of the Poisson log-likelihood with respect to the
 * log-rating. It deliberately differs from the plainer k × ln(ratio): the
 * logarithm of a Poisson ratio averages well below 0 even when the ratings
 * are exactly right (≈ −0.23 at λ = 1.35, because 0 goals is common), so
 * every team would sink match after match and total goals would be
 * under-priced. The gradient step is unbiased, needs no lower cap (it is never
 * below −1) and agrees with k × ln(ratio) for results close to expectation.
 *
 * Then the log-rating shrinks by `shrink` toward 0 (rating 1), which pins the
 * otherwise free scale between attack and defence, and every rating is
 * clamped to [MIN_TEAM_RATING, MAX_TEAM_RATING]. `matches` goes up by exactly
 * 1; every other key (including `manual` and unknown keys) is kept as it was.
 *
 * Missing or invalid inputs (null, NaN, negative, non-numbers) count as the
 * neutral 1 with 0 matches; out-of-band ratings are clamped first.
 *
 * @throws RangeError when a score is not a non-negative safe integer, or an
 *   option is out of range: programmer errors, the gates validate scores first.
 */
export function updateFootballRatings(
  home: TeamRatings | null | undefined,
  away: TeamRatings | null | undefined,
  score: FootballScore,
  opts: RatingUpdateOptions = {},
): { home: TeamRatings; away: TeamRatings } {
  checkGoals(score.home, 'home goals');
  checkGoals(score.away, 'away goals');
  const options = checkedOptions(opts);

  const h = readFootball(home);
  const a = readFootball(away);
  const expected = expectedGoals(
    { attack: h.attack, defence: h.defence },
    { attack: a.attack, defence: a.defence },
    { base: options.base, homeAdvantage: options.homeAdvantage },
  );
  const homeStep = Math.min(score.home / expected.home, options.maxRatio) - 1;
  const awayStep = Math.min(score.away / expected.away, options.maxRatio) - 1;
  const kHome = learningRate(h.matches, options);
  const kAway = learningRate(a.matches, options);

  return {
    home: written(home, {
      attack: step(h.attack, kHome * homeStep, options.shrink),
      defence: step(h.defence, kHome * awayStep, options.shrink),
      matches: h.matches + 1,
    }),
    away: written(away, {
      attack: step(a.attack, kAway * awayStep, options.shrink),
      defence: step(a.defence, kAway * homeStep, options.shrink),
      matches: a.matches + 1,
    }),
  };
}

export interface FixturePricingOptions {
  /** Overrides the default margin of the main markets. */
  marginBps?: number;
}

/**
 * Prematch markets of a fixture from the two teams' ratings:
 * priceMatch(sport, matchStrengths(sport, home, away), opts).
 *
 * Football only: other sports' ratings are not calibrated by this path, so
 * pricing them here would sell neutral or stale numbers.
 * Calibration itself (rule O1) is checked by the caller, not here.
 *
 * @throws RangeError for any sport but football.
 */
export function priceFixture(
  sport: SportCode,
  home: TeamRatings | null | undefined,
  away: TeamRatings | null | undefined,
  opts: FixturePricingOptions = {},
): FeedMarket[] {
  if (sport !== 'football') {
    throw new RangeError(`priceFixture supports football only, got "${String(sport)}"`);
  }
  return priceMatch(
    sport,
    matchStrengths(sport, home, away),
    opts.marginBps === undefined ? {} : { marginBps: opts.marginBps },
  );
}

export interface FootballResult {
  /** Team key (whatever the caller uses: id, slug), the same in `initial`. */
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

/**
 * Ratings learned from a sequence of results, applied with
 * updateFootballRatings in the order given (the caller sorts chronologically),
 * e.g. to bootstrap a league from a season of history. Teams missing from
 * `initial` start neutral. Deterministic; `initial` is not modified.
 *
 * @throws RangeError when a team plays itself or a score is invalid.
 */
export function replayRatings(
  results: ReadonlyArray<FootballResult>,
  initial: ReadonlyMap<string, TeamRatings> = new Map(),
  opts: RatingUpdateOptions = {},
): Map<string, TeamRatings> {
  const ratings = new Map(initial);
  for (const result of results) {
    if (result.home === result.away) {
      throw new RangeError(`team "${result.home}" cannot play itself`);
    }
    const next = updateFootballRatings(
      ratings.get(result.home),
      ratings.get(result.away),
      { home: result.homeGoals, away: result.awayGoals },
      opts,
    );
    ratings.set(result.home, next.home);
    ratings.set(result.away, next.away);
  }
  return ratings;
}

interface FootballRatingState {
  attack: number;
  defence: number;
  matches: number;
}

/** The ratings as matchStrengths reads them (attack, else offence), clamped to the band. */
function readFootball(ratings: TeamRatings | null | undefined): FootballRatingState {
  const source = asRecord(ratings);
  const attack = source[RATING_KEYS.attack];
  const offence = source[RATING_KEYS.offence];
  const defence = source[RATING_KEYS.defence];
  const matches = source[RATING_META_KEYS.matches];
  return {
    attack: inBand(isPositiveFinite(attack) ? attack : isPositiveFinite(offence) ? offence : 1),
    defence: inBand(isPositiveFinite(defence) ? defence : 1),
    matches:
      typeof matches === 'number' && Number.isFinite(matches) && matches >= 0
        ? Math.floor(Math.min(matches, Number.MAX_SAFE_INTEGER - 1))
        : 0,
  };
}

/** A copy of `original` (keys and their order kept) with the learned values set. */
function written(
  original: TeamRatings | null | undefined,
  learned: FootballRatingState,
): TeamRatings {
  return {
    ...asRecord(original),
    [RATING_KEYS.attack]: learned.attack,
    [RATING_KEYS.defence]: learned.defence,
    [RATING_META_KEYS.matches]: learned.matches,
  };
}

/** ratings come from a jsonb column: anything that is not a plain object counts as empty. */
function asRecord(ratings: unknown): Readonly<Record<string, unknown>> {
  if (typeof ratings !== 'object' || ratings === null || Array.isArray(ratings)) return {};
  return ratings as Record<string, unknown>;
}

function step(rating: number, logStep: number, shrink: number): number {
  return inBand(Math.exp((1 - shrink) * (Math.log(rating) + logStep)));
}

function inBand(rating: number): number {
  return clamp(rating, MIN_TEAM_RATING, MAX_TEAM_RATING);
}

function learningRate(matches: number, options: Required<RatingUpdateOptions>): number {
  return Math.max(options.kMin, 1 / (matches + options.kOffset));
}

function checkGoals(goals: number, what: string): void {
  if (!Number.isSafeInteger(goals) || goals < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(goals)}`);
  }
}

function checkedOptions(opts: RatingUpdateOptions): Required<RatingUpdateOptions> {
  const options = {
    kMin: opts.kMin ?? DEFAULT_RATING_K_MIN,
    kOffset: opts.kOffset ?? DEFAULT_RATING_K_OFFSET,
    maxRatio: opts.maxRatio ?? DEFAULT_MAX_GOALS_RATIO,
    shrink: opts.shrink ?? DEFAULT_RATING_SHRINK,
    base: opts.base ?? FOOTBALL_BASE_GOALS,
    homeAdvantage: opts.homeAdvantage ?? FOOTBALL_HOME_ADVANTAGE,
  };
  if (!(Number.isFinite(options.kMin) && options.kMin >= 0 && options.kMin <= 1)) {
    throw new RangeError(`kMin must be in [0, 1], got ${String(options.kMin)}`);
  }
  if (!(Number.isFinite(options.kOffset) && options.kOffset >= 1)) {
    throw new RangeError(`kOffset must be >= 1, got ${String(options.kOffset)}`);
  }
  if (!(Number.isFinite(options.maxRatio) && options.maxRatio >= 1)) {
    throw new RangeError(`maxRatio must be >= 1, got ${String(options.maxRatio)}`);
  }
  if (!(Number.isFinite(options.shrink) && options.shrink >= 0 && options.shrink < 1)) {
    throw new RangeError(`shrink must be in [0, 1), got ${String(options.shrink)}`);
  }
  return options;
}
