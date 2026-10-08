import type { MarketTypeCode, OddsMilli, SportCode } from '@vamos/core';

/**
 * The odds-feed contract. In demo mode the MockFeedProvider implements it with
 * simulated pricing; a licensed deployment plugs in a real provider (e.g.
 * Sportradar, BetConstruct) behind the same interface.
 */

export interface FeedSelection {
  /** Selection code from selectionsFor(type) in @vamos/core ('1', 'X', 'over', '2-1', …). */
  code: string;
  oddsMilli: OddsMilli;
}

export interface FeedMarket {
  type: MarketTypeCode;
  /** Half-point line for 'ou' / 'total' markets, else null. */
  line: string | null;
  selections: FeedSelection[];
}

export interface FeedFixture {
  /** Stable, unique reference within the provider. */
  feedRef: string;
  sport: SportCode;
  competitionSlug: string;
  /** Team short names (match teams.short_name in the catalogue). */
  homeShortName: string;
  awayShortName: string;
  startTime: Date;
}

/** Pricing inputs per team, as stored in teams.ratings. */
export type TeamRatings = Record<string, number>;

export interface FeedTeam {
  shortName: string;
  ratings: TeamRatings;
}

export interface FeedCompetition {
  slug: string;
  sport: SportCode;
  featured: boolean;
}

/** Constructor input of the MockFeedProvider (built from the catalogue by loadFeedTeams). */
export interface MockFeedConfig {
  competitions: FeedCompetition[];
  /** Team pool per competition slug. */
  teams: Record<string, FeedTeam[]>;
  /** Extra fixtures starting every N minutes so the demo always has live matches. */
  rolling?: { everyMinutes: number; horizonMinutes: number; competitionSlugs: string[] };
  /** Seed for deterministic generation. */
  seed?: string;
}

export interface LiveScoreState {
  minute: number;
  home: number;
  away: number;
  htHome?: number | null;
  htAway?: number | null;
}

export interface OddsFeedProvider {
  readonly name: string;
  /** Fixtures starting in [now, now + horizonHours]. */
  fixtures(now: Date, horizonHours: number): FeedFixture[];
  /** Markets with odds for a fixture, prematch (no state) or live. */
  price(fixture: FeedFixture, state?: LiveScoreState): FeedMarket[];
}
