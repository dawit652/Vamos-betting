import { clamp } from './book';
import { FOOTBALL_HOME_ADVANTAGE } from './football';

/**
 * A competition's home advantage learned from its finished results (F-07).
 *
 * The home advantage of the football model is the multiplier on the home
 * side's expected goals (FOOTBALL_HOME_ADVANTAGE, 1.15). Real leagues sit
 * higher (1.2 to 1.25 in the 2024-25 and 2025-26 seasons of the big five), so
 * the fixed constant prices the away side too short. The evidence is three
 * whole numbers per competition, summed over its finished matches (home
 * goals, away goals, matches), so the estimate is deterministic and exact to
 * store or recompute from the results; it is pulled towards the constant with
 * a number of pseudo-matches, kept in a band, and only used once the
 * competition has enough matches behind it.
 *
 * Pure and deterministic. Ratings and probabilities are floats, never money.
 */

/**
 * The teams.ratings key that carries the home advantage of a team's league on
 * the ratings of the teams playing in it (written by the results pipeline after
 * every applied LEAGUE result, P-8: setsHomeAdvantage; read here from the HOME
 * team's ratings by matchStrengths and updateFootballRatings, in any
 * competition). Absent or invalid: the default.
 */
export const HOME_ADVANTAGE_KEY = 'homeAdvantage';

/** What a competition's finished results say: whole numbers, summed over its matches. */
export interface HomeAdvantageEvidence {
  matches: number;
  homeGoals: number;
  awayGoals: number;
}

export interface HomeAdvantageOptions {
  /** Where the estimate is pulled from and what it falls back to (default FOOTBALL_HOME_ADVANTAGE). */
  prior?: number;
  /** Pseudo-matches that weigh the prior against the evidence (default HOME_ADVANTAGE_PRIOR_MATCHES). */
  priorMatches?: number;
  /** Fewer matches than this and the prior is used as it is (default HOME_ADVANTAGE_MIN_MATCHES). */
  minMatches?: number;
  /** The estimate stays in [min, max] (default HOME_ADVANTAGE_MIN, HOME_ADVANTAGE_MAX). */
  min?: number;
  max?: number;
}

/**
 * Pseudo-matches of the prior: a full 380-match season gets 32% of the say. Chosen on the
 * 2024-25 seasons (lowest log-loss among 100, 200, 400 and 800; docs/scraper-evaluation/
 * 03-odds-accuracy.md, F-07), then reported on 2025-26 untouched. A league's home edge moves
 * a lot from one season to the next (the Premier League's goal ratio was 1.22, 1.06 and
 * 1.25 in the last three seasons), so a season is mostly noise and the prior is heavy.
 */
export const HOME_ADVANTAGE_PRIOR_MATCHES = 800;
/** Matches a competition needs before its own results are used at all (about 4 rounds of 20 teams). */
export const HOME_ADVANTAGE_MIN_MATCHES = 40;
/** No league is believed to have less than a 5% or more than a 35% home edge in goals. */
export const HOME_ADVANTAGE_MIN = 1.05;
export const HOME_ADVANTAGE_MAX = 1.35;

/**
 * The home advantage of a competition: the log of the home/away goal ratio of
 * its results, averaged with the log of the prior weighted by
 * `priorMatches` pseudo-matches, ln ha = (n × ln(H / A) + n0 × ln prior) / (n +
 * n0), rounded to a hundredth and clamped to [min, max]. A competition with fewer than `minMatches`
 * matches, no home or no away goals, or malformed evidence gets the prior
 * itself, so there is always a usable number and a new league starts exactly as
 * before. The result is the same for the same evidence.
 *
 * @throws RangeError for an option that is not a finite positive number (a
 *   programmer error; evidence is data and falls back instead).
 */
export function learnedHomeAdvantage(
  evidence: HomeAdvantageEvidence | null | undefined,
  opts: HomeAdvantageOptions = {},
): number {
  const prior = opts.prior ?? FOOTBALL_HOME_ADVANTAGE;
  const priorMatches = opts.priorMatches ?? HOME_ADVANTAGE_PRIOR_MATCHES;
  const minMatches = opts.minMatches ?? HOME_ADVANTAGE_MIN_MATCHES;
  const min = opts.min ?? HOME_ADVANTAGE_MIN;
  const max = opts.max ?? HOME_ADVANTAGE_MAX;
  if (!(Number.isFinite(prior) && prior > 0)) throw new RangeError('prior must be positive');
  if (!(Number.isFinite(priorMatches) && priorMatches >= 0)) {
    throw new RangeError('priorMatches must be >= 0');
  }
  if (!(Number.isFinite(minMatches) && minMatches >= 0)) {
    throw new RangeError('minMatches must be >= 0');
  }
  if (!(Number.isFinite(min) && Number.isFinite(max) && min > 0 && min <= max)) {
    throw new RangeError('min and max must be positive with min <= max');
  }
  const bounded = clamp(prior, min, max);
  if (!usable(evidence) || evidence.matches < minMatches) return bounded;
  const n = evidence.matches;
  const logRatio = Math.log(evidence.homeGoals / evidence.awayGoals);
  const blended = (n * logRatio + priorMatches * Math.log(prior)) / (n + priorMatches);
  // Whole hundredths: a new result moves the estimate (and so every price of the
  // competition) only when it crosses a hundredth, not on every match.
  return clamp(Math.round(Math.exp(blended) * 100) / 100, min, max);
}

function usable(
  evidence: HomeAdvantageEvidence | null | undefined,
): evidence is HomeAdvantageEvidence {
  if (typeof evidence !== 'object' || evidence === null) return false;
  const { matches, homeGoals, awayGoals } = evidence;
  return (
    Number.isSafeInteger(matches) &&
    Number.isSafeInteger(homeGoals) &&
    Number.isSafeInteger(awayGoals) &&
    matches > 0 &&
    homeGoals > 0 &&
    awayGoals > 0
  );
}

/** Adds one finished result to the evidence (a new object; the input is not modified). */
export function addHomeAdvantageResult(
  evidence: HomeAdvantageEvidence | null | undefined,
  homeGoals: number,
  awayGoals: number,
): HomeAdvantageEvidence {
  for (const [what, value] of [
    ['home goals', homeGoals],
    ['away goals', awayGoals],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${what} must be a non-negative integer, got ${String(value)}`);
    }
  }
  const base = evidence ?? { matches: 0, homeGoals: 0, awayGoals: 0 };
  return {
    matches: base.matches + 1,
    homeGoals: base.homeGoals + homeGoals,
    awayGoals: base.awayGoals + awayGoals,
  };
}

/**
 * The home advantage a match is priced with: the one stored on the HOME team's
 * ratings (HOME_ADVANTAGE_KEY), kept in [HOME_ADVANTAGE_MIN, HOME_ADVANTAGE_MAX],
 * else FOOTBALL_HOME_ADVANTAGE. Ratings come from a jsonb column, so anything that
 * is not a finite positive number counts as absent.
 */
export function homeAdvantageOf(
  homeRatings: Readonly<Record<string, unknown>> | null | undefined,
): number {
  const value =
    typeof homeRatings === 'object' && homeRatings !== null && !Array.isArray(homeRatings)
      ? homeRatings[HOME_ADVANTAGE_KEY]
      : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return FOOTBALL_HOME_ADVANTAGE;
  }
  return clamp(value, HOME_ADVANTAGE_MIN, HOME_ADVANTAGE_MAX);
}

/**
 * `ratings` with the competition's home advantage written on it (a new object).
 * Ratings that do not carry a value yet and would get the default one are
 * returned as they are, so a league that is still on the default changes
 * nothing, in the stored ratings or in the fingerprint that decides which events
 * are priced again.
 */
export function withHomeAdvantage<T extends Readonly<Record<string, number>>>(
  ratings: T,
  homeAdvantage: number,
): T | (T & Record<typeof HOME_ADVANTAGE_KEY, number>) {
  const stored = Object.hasOwn(ratings, HOME_ADVANTAGE_KEY);
  if (!stored && homeAdvantage === FOOTBALL_HOME_ADVANTAGE) return ratings;
  return { ...ratings, [HOME_ADVANTAGE_KEY]: homeAdvantage };
}

/**
 * Words of a competition slug that name a cup or a tournament rather than a league: domestic cups
 * (FA Cup, EFL Cup, Copa del Rey, Coppa Italia, DFB-Pokal, Coupe de France, KNVB Beker, Taça),
 * super cups and shields, the club competitions of a confederation (Champions, Europa and
 * Conference League, Libertadores, Sudamericana, CAF Confederation Cup), national-team
 * tournaments, play-offs and friendlies. Matched against the slug's words (split on anything that
 * is not a letter or a digit), so `championship`, `super-lig` and `swiss-super-league` are leagues.
 */
const CUP_SLUG_WORDS: ReadonlySet<string> = new Set([
  'cup',
  'pokal',
  'copa',
  'coupe',
  'coppa',
  'beker',
  'taca',
  'trophy',
  'shield',
  'supercup',
  'supercopa',
  'supercoppa',
  'superpokal',
  'champions',
  'europa',
  'conference',
  'libertadores',
  'sudamericana',
  'nations',
  'playoff',
  'playoffs',
  'friendly',
  'friendlies',
  'qualifiers',
  'qualification',
]);

/** What decides whether a competition's results set the home advantage (P-8). */
export interface HomeAdvantageCompetition {
  /** The catalogue slug (competitions.slug). */
  slug: string;
  /** The competition policy's `extraTime` (knockout matches; false without a policy row). */
  extraTime: boolean;
}

/**
 * P-8: true when the results of `competition` may write the home advantage on its teams' ratings,
 * i.e. it is a league. The value is one per team (read from the HOME team's ratings whatever the
 * competition of the match) and learned from one competition's results, so a cup or a European
 * competition must not overwrite the value of the league the team plays in every week: a cup has
 * few results of its own (the default would be written) or neutral and mixed venues.
 *
 * A competition is a cup when its policy says its matches can go to extra time (`extraTime`, the
 * operator's explicit knockout marker), or when its slug has a cup word (CUP_SLUG_WORDS: the
 * catalogue's cups carry no flag unless an operator set one). Leans to cup: a league taken for a
 * cup keeps the value it has (or the default, as before F-07); a cup taken for a league would
 * overwrite the league's value.
 */
export function setsHomeAdvantage(competition: HomeAdvantageCompetition): boolean {
  if (competition.extraTime) return false;
  return !competition.slug
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => CUP_SLUG_WORDS.has(word));
}
