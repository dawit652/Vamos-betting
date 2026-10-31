import {
  SCRAPE_FIXTURE_STATUSES,
  SCRAPE_ODDS_MARKETS,
  SCRAPE_ODDS_SELECTIONS,
  SCRAPE_RESULT_STATUSES,
  SCRAPE_SCORE_BASES,
  SCRAPE_SPORTS,
} from '@vamos/core';
import { z } from 'zod';

/**
 * The language every part of the scraper speaks (docs/scraper.md section 3).
 *
 * An adapter turns one fetched document into observations: what ONE source
 * said, at one moment, in the source's own words. Nothing here is trusted yet:
 * names are still raw, a result is still just a claim. Matching names to the
 * catalogue and deciding what may reach it happen later, in `normalize`,
 * `match` and `gates`.
 */

// ---------------------------------------------------------------------------
// Sources

export const SOURCE_KINDS = ['json_api', 'html', 'ical', 'embedded_json', 'licensed_api'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceDescriptor {
  /** Stable id of the source (scrape_sources.id), e.g. 'openfootball-en1'. */
  id: string;
  /**
   * Who produces the underlying data. Two sources with the same `upstream`
   * are NOT independent: they never count as two votes in a consensus.
   */
  upstream: string;
  kind: SourceKind;
}

// ---------------------------------------------------------------------------
// Observations

// Intentional: names must not carry control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !CONTROL_CHARS.test(value), 'control characters in a name');

const pointsSchema = z.number().int().min(0).max(99);

/** A football score: full time (regular time, see ScrapeScoreBasis) and optionally half time. */
export const ScoreSchema = z
  .object({
    home: pointsSchema,
    away: pointsSchema,
    htHome: pointsSchema.nullable(),
    htAway: pointsSchema.nullable(),
  })
  .refine((s) => (s.htHome === null) === (s.htAway === null), 'half-time score needs both sides')
  .refine(
    (s) => s.htHome === null || (s.htHome <= s.home && (s.htAway ?? 0) <= s.away),
    'half-time score above the full-time score',
  );
export type Score = z.infer<typeof ScoreSchema>;

/** How far from the moment of observation a kickoff may plausibly be. */
export const KICKOFF_PAST_LIMIT_MS = 6 * 365 * 24 * 3_600_000;
export const KICKOFF_FUTURE_LIMIT_MS = 2 * 365 * 24 * 3_600_000;

const observationBase = {
  sourceId: z.string().trim().min(1).max(64),
  /** The source's own id for the match when it has a stable one. */
  externalRef: z.string().trim().min(1).max(200).nullable(),
  sport: z.enum(SCRAPE_SPORTS),
  /** The competition as the source labels it (mapped to the catalogue by competition_aliases). */
  competition: nameSchema,
  home: nameSchema,
  away: nameSchema,
  /** The instant the match starts, as UTC. Adapters convert from the source's zone explicitly. */
  kickoff: z.date(),
  observedAt: z.date(),
};

interface ObservationShape {
  home: string;
  away: string;
  kickoff: Date;
  observedAt: Date;
}

function plausible(value: ObservationShape, ctx: z.RefinementCtx): void {
  if (value.home.toLowerCase() === value.away.toLowerCase()) {
    ctx.addIssue({ code: 'custom', message: 'home and away are the same team', path: ['away'] });
  }
  const delta = value.kickoff.getTime() - value.observedAt.getTime();
  if (delta < -KICKOFF_PAST_LIMIT_MS || delta > KICKOFF_FUTURE_LIMIT_MS) {
    ctx.addIssue({ code: 'custom', message: 'implausible kickoff', path: ['kickoff'] });
  }
}

export const FixtureObservationSchema = z
  .object({
    kind: z.literal('fixture'),
    ...observationBase,
    status: z.enum(SCRAPE_FIXTURE_STATUSES),
    round: z.string().trim().max(80).nullable(),
  })
  .superRefine(plausible);
export type FixtureObservation = z.infer<typeof FixtureObservationSchema>;

export const ResultObservationSchema = z
  .object({
    kind: z.literal('result'),
    ...observationBase,
    status: z.enum(SCRAPE_RESULT_STATUSES),
    /** Present exactly when the match finished. */
    score: ScoreSchema.nullable(),
    /** What the score covers; only 'regular_time' can ever settle a bet. */
    scoreBasis: z.enum(SCRAPE_SCORE_BASES),
  })
  .superRefine(plausible)
  .refine((r) => (r.status === 'finished') === (r.score !== null), {
    message: 'a finished match has a score, any other status has none',
    path: ['score'],
  });
export type ResultObservation = z.infer<typeof ResultObservationSchema>;

export type Observation = FixtureObservation | ResultObservation;

/** Decimal odds in integer milli (1.85 is 1850) the market feed may carry: 1.010 to 1000. */
export const MARKET_ODDS_MIN_MILLI = 1010;
export const MARKET_ODDS_MAX_MILLI = 1_000_000;

const bookmakerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !CONTROL_CHARS.test(value), 'control characters in a bookmaker id');

/**
 * What ONE bookmaker offered for ONE selection of ONE match, as a licensed market feed said it
 * (data class `market_odds`). Never shown to players and never a price of ours: the pricing step
 * reads these to check and weight our own prices. `priceMilli` is the decimal price times 1000,
 * rounded DOWN; `priceUpdatedAt` is when the bookmaker last moved the price (a fetch time is not
 * freshness; `observedAt` is the fetch time).
 */
export const MarketOddsObservationSchema = z
  .object({
    kind: z.literal('market_odds'),
    ...observationBase,
    market: z.enum(SCRAPE_ODDS_MARKETS),
    /** Null for the 1X2; the total as a decimal text for 'ou' ('2.5'). */
    line: z
      .string()
      .regex(/^[0-9]{1,2}(\.[0-9]{1,2})?$/, 'line must be a plain decimal such as 2.5')
      .nullable(),
    selection: z.enum(SCRAPE_ODDS_SELECTIONS),
    /** The bookmaker as the feed names it (an affiliate id as text). */
    bookmaker: bookmakerSchema,
    priceMilli: z.number().int().min(MARKET_ODDS_MIN_MILLI).max(MARKET_ODDS_MAX_MILLI),
    priceUpdatedAt: z.date(),
  })
  .superRefine(plausible)
  .superRefine((o, ctx) => {
    const onePair = o.market === '1x2' ? ['1', 'X', '2'] : ['over', 'under'];
    if (!onePair.includes(o.selection)) {
      ctx.addIssue({
        code: 'custom',
        message: `selection ${o.selection} does not belong to ${o.market}`,
        path: ['selection'],
      });
    }
    if ((o.market === '1x2') !== (o.line === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'the 1x2 has no line and the over/under needs one',
        path: ['line'],
      });
    }
  });
export type MarketOddsObservation = z.infer<typeof MarketOddsObservationSchema>;

// ---------------------------------------------------------------------------
// Fetched documents and parsing

/** A fetched document, decoded to text, ready for an adapter. */
export interface RawDocument {
  sourceId: string;
  /** The final URL (after redirects). */
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: Date;
  /** SHA-256 (hex) of the exact response bytes. */
  contentHash: string;
}

export interface ParseIssue {
  severity: 'warning' | 'error';
  /** Short machine-readable code, e.g. 'bad_json', 'bad_time', 'dropped_record'. */
  code: string;
  message: string;
  /**
   * The whole document could not be understood (not one record). A fatal
   * issue makes the run count as a broken page.
   */
  fatal?: boolean;
  context?: Record<string, unknown>;
}

export interface ParseStats {
  /** Candidate records found in the document before validation. */
  recordsSeen: number;
  /** Records that became valid observations. */
  recordsAccepted: number;
}

export interface ParseOutcome {
  fixtures: FixtureObservation[];
  results: ResultObservation[];
  /** Bookmaker prices (data class `market_odds`); empty for every adapter but a market feed. */
  marketOdds: MarketOddsObservation[];
  issues: ParseIssue[];
  stats: ParseStats;
}

/**
 * A reference to an API key, never the key: the header to send it in and the NAME of the
 * environment variable (SCRAPER_SECRET_*) that holds it. The fetcher reads the value when it
 * fetches (docs/scraper.md 6.7).
 */
export interface RequestAuthRef {
  header: string;
  secret: string;
}

export interface FetchPlanItem {
  url: string;
  purpose: 'fixtures' | 'results' | 'both';
  headers?: Record<string, string>;
  /** Sent only to the origin of `url`; a redirect to another origin drops it. */
  auth?: RequestAuthRef;
}

/**
 * One source of data. Pure: no network, no clock, no randomness. `parse`
 * never throws; whatever goes wrong becomes an issue in the outcome.
 */
export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  /** Hosts this adapter may fetch; the fetcher refuses every other host, redirects included. */
  readonly allowedHosts: readonly string[];
  /** The requests of one run. */
  plan(now: Date): FetchPlanItem[];
  parse(doc: RawDocument): ParseOutcome;
}

// ---------------------------------------------------------------------------
// Resolved data (what the rules work on)

/** Catalogue ids a fixture's raw names resolved to. */
export interface ResolvedNames {
  competitionId: string;
  competitionSlug: string;
  homeTeamId: string;
  awayTeamId: string;
}

/**
 * The current state of one source's observation, with its names resolved and
 * its clocks. `changedAt` is when this source's observation last took its
 * current value; the result rules wait on it.
 */
export interface ResolvedObservation<T extends Observation = Observation> {
  upstream: string;
  names: ResolvedNames;
  obs: T;
  firstSeenAt: Date;
  changedAt: Date;
  lastSeenAt: Date;
}

export type ScrapedEventStatus =
  'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed' | 'abandoned';

/** An event of the catalogue that the scraper created (feed_provider 'scraped'). */
export interface ExistingEvent {
  eventId: string;
  /** The stable key the event was created under (events.feed_ref); it never changes. */
  feedRef: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  status: ScrapedEventStatus;
  bettingOpen: boolean;
  /** At least one bet (any status) exists on the event. */
  hasBets: boolean;
  /** The event has a market that needs the half-time score (ht_1x2, …). */
  needsHalfTimeScore: boolean;
  resultedAt: Date | null;
  /** The score the event was resulted with, if it was. */
  score: Score | null;
}

/** scrape_competition_policy as the rules see it. */
export interface CompetitionPolicy {
  competitionId: string;
  /**
   * The kill switch (rule S4): the scraper may create fixtures, move kickoffs and
   * apply results in this competition. Off, it only observes and raises review
   * items (shadow mode); nothing is created, moved or applied by itself.
   */
  enabled: boolean;
  /** Open betting by itself on new fixtures whose teams are calibrated. */
  autoOpen: boolean;
  /** Apply confirmed final scores without a person (only while `enabled`, and never with `extraTime`). */
  autoResults: boolean;
  /**
   * Matches can go to extra time / penalties (knockouts). A source wrongly
   * configured as regular time could then pass a longer-play score off as
   * settling, so such a competition never auto-applies: a person confirms.
   */
  extraTime: boolean;
}
