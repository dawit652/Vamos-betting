import {
  matchStrengths,
  priceFixture,
  replayRatings,
  updateFootballRatings,
  type FeedMarket,
  type FootballResult,
  type RatingUpdateOptions,
} from '@vamos/feed';
import { isCalibrated } from '@vamos/scraper';
import {
  normalise3,
  outcomeOf,
  proportional,
  seededRatings,
  type MatchRow,
  type Outcome,
  type Probs3,
  type Ratings,
} from './odds-lib';

/**
 * The production pricing and rating loop, replayed over a season in date
 * order: price with the CURRENT ratings (priceFixture), record, then update
 * the ratings with updateFootballRatings. No production code is changed.
 */

export interface BookView {
  odds1x2: [number, number, number];
  /** Margin-free 1X2 probabilities: proportional normalisation of the offered odds. */
  p: Probs3;
  /** Margin-free over 2.5 probability, or null when the market is absent. */
  over25: number | null;
  /** Margin-free both-teams-to-score "yes" probability, or null. */
  btts: number | null;
  markets: FeedMarket[];
}

export function marketOf(
  markets: readonly FeedMarket[],
  type: string,
  line: string | null = null,
): FeedMarket | undefined {
  return markets.find((m) => m.type === type && m.line === line);
}

function oddsOf(m: FeedMarket | undefined, codes: readonly string[]): number[] | null {
  if (m === undefined) return null;
  const out: number[] = [];
  for (const c of codes) {
    const s = m.selections.find((x) => x.code === c);
    if (s === undefined) return null;
    out.push(s.oddsMilli / 1000);
  }
  return out;
}

export function bookView(home: Ratings | null, away: Ratings | null): BookView {
  const markets = priceFixture('football', home, away);
  const o = oddsOf(marketOf(markets, '1x2'), ['1', 'X', '2']);
  if (o === null) throw new Error('1x2 market missing');
  const p = proportional(o);
  const ou = oddsOf(marketOf(markets, 'ou', '2.5'), ['over', 'under']);
  const bt = oddsOf(marketOf(markets, 'btts'), ['yes', 'no']);
  return {
    odds1x2: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0],
    p: normalise3([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]),
    over25: ou === null ? null : (proportional(ou)[0] ?? null),
    btts: bt === null ? null : (proportional(bt)[0] ?? null),
    markets,
  };
}

export interface PredRecord {
  idx: number;
  date: string;
  month: string;
  round: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  outcome: Outcome;
  p: Probs3;
  odds1x2: [number, number, number];
  lamH: number;
  lamA: number;
  over25: number | null;
  btts: number | null;
  /** Both teams' `matches` counter is at least MIN_RATING_MATCHES (8), as in rule O1. */
  eligible: boolean;
  matchesHome: number;
  matchesAway: number;
}

export type RatingMap = Map<string, Ratings>;

export type World = 'truth' | 'visible';

export interface RunOptions {
  world?: World;
  update?: RatingUpdateOptions;
}

/** Walk-forward over `matches` (sorted by date). Returns the records and the final ratings. */
export function walkForward(
  matches: readonly MatchRow[],
  initial: ReadonlyMap<string, Ratings>,
  options: RunOptions = {},
): { records: PredRecord[]; ratings: RatingMap } {
  const world = options.world ?? 'truth';
  const ratings: RatingMap = new Map(initial);
  const records: PredRecord[] = [];
  matches.forEach((m, idx) => {
    const h = ratings.get(m.home) ?? null;
    const a = ratings.get(m.away) ?? null;
    const book = bookView(h, a);
    const lam = matchStrengths('football', h, a);
    const mh = h?.matches ?? 0;
    const ma = a?.matches ?? 0;
    records.push({
      idx,
      date: m.date,
      month: m.date.slice(0, 7),
      round: m.round,
      home: m.home,
      away: m.away,
      hg: m.hg,
      ag: m.ag,
      outcome: outcomeOf(m.hg, m.ag),
      p: book.p,
      odds1x2: book.odds1x2,
      lamH: lam.home,
      lamA: lam.away,
      over25: book.over25,
      btts: book.btts,
      eligible: isCalibrated(h, 8) && isCalibrated(a, 8),
      matchesHome: mh,
      matchesAway: ma,
    });
    if (world === 'visible' && !m.visible) return;
    const next = updateFootballRatings(h, a, { home: m.hg, away: m.ag }, options.update ?? {});
    ratings.set(m.home, next.home);
    ratings.set(m.away, next.away);
  });
  return { records, ratings };
}

/** Initial ratings of the three starting conditions for a set of team names. */
export function neutralStart(): RatingMap {
  return new Map();
}

export function seededStart(teamNames: Iterable<string>): RatingMap {
  const map: RatingMap = new Map();
  for (const t of teamNames) {
    const r = seededRatings(t);
    if (r !== null) map.set(t, r);
  }
  return map;
}

/**
 * What `ratings backfill` does with a season of results: a replay from
 * neutral (production starts every team neutral, apps/scraper/src/cli/ratings.ts).
 */
export function backfilled(
  previous: readonly MatchRow[],
  world: World,
  update?: RatingUpdateOptions,
): RatingMap {
  const results: FootballResult[] = previous
    .filter((m) => world === 'truth' || m.visible)
    .map((m) => ({ home: m.home, away: m.away, homeGoals: m.hg, awayGoals: m.ag }));
  return new Map(replayRatings(results, new Map(), update ?? {}));
}

export function teamsOf(matches: readonly MatchRow[]): string[] {
  return [...new Set(matches.flatMap((m) => [m.home, m.away]))];
}
