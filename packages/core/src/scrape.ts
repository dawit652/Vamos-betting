/**
 * Shared vocabulary of the data scraper (docs/scraper.md): the closed sets of
 * values that the scraper package, the database, the admin API and the back
 * office all have to agree on. Constants and types only: no logic, no I/O.
 */

/** Sports the scraper accepts. Anything else is dropped with an issue. */
export const SCRAPE_SPORTS = ['football'] as const;
export type ScrapeSport = (typeof SCRAPE_SPORTS)[number];

/** Adapter implementations a source row can name (scrape_sources.adapter). */
export const SCRAPE_ADAPTERS = ['openfootball', 'generic-json', 'generic-html'] as const;
export type ScrapeAdapterName = (typeof SCRAPE_ADAPTERS)[number];

/** What a source row is for (scrape_runs.data_class, scheduling). */
export const SCRAPE_DATA_CLASSES = ['fixtures', 'results'] as const;
export type ScrapeDataClass = (typeof SCRAPE_DATA_CLASSES)[number];

/** Status a source reports for a fixture that has not been played. */
export const SCRAPE_FIXTURE_STATUSES = ['scheduled', 'postponed', 'cancelled'] as const;
export type ScrapeFixtureStatus = (typeof SCRAPE_FIXTURE_STATUSES)[number];

/** Status a source reports for a played (or not played) match; mirrors resultEvent's statuses. */
export const SCRAPE_RESULT_STATUSES = ['finished', 'cancelled', 'abandoned', 'postponed'] as const;
export type ScrapeResultStatus = (typeof SCRAPE_RESULT_STATUSES)[number];

/**
 * What a score covers. Football bets settle on regular time (90 minutes plus
 * stoppage), so only `regular_time` may ever settle a bet.
 */
export const SCRAPE_SCORE_BASES = ['regular_time', 'includes_extra_time', 'unknown'] as const;
export type ScrapeScoreBasis = (typeof SCRAPE_SCORE_BASES)[number];

/** scrape_runs.status. */
export const SCRAPE_RUN_STATUSES = [
  'running',
  'ok',
  /** Transport or HTTP failure (nothing usable arrived). */
  'failed',
  /** The page arrived but its shape changed (parse yield collapsed): nothing was stored. */
  'broken',
  /** Refused by robots.txt, a block page or a rate limit: we back off, we do not work around it. */
  'blocked',
  'skipped',
] as const;
export type ScrapeRunStatus = (typeof SCRAPE_RUN_STATUSES)[number];

/** Why a person has to look at something (scrape_review_items.kind). */
export const SCRAPE_REVIEW_KINDS = [
  /** A team name no alias or catalogue name matches. */
  'unknown_team',
  /** A competition label no alias matches. */
  'unknown_competition',
  /** Sources disagree about a fixture, or it matches several events. */
  'fixture_conflict',
  /** A kickoff change the rules do not apply by themselves. */
  'kickoff_change',
  /** An event no source has listed for a long time (absence never cancels). */
  'fixture_missing',
  /** A source says postponed / cancelled / abandoned (this would void bets). */
  'cancellation_proposed',
  /** The event exists but a team's ratings are not calibrated: no odds are offered. */
  'ratings_uncalibrated',
  /** The event exists with betting closed, waiting for a trader to open it. */
  'odds_approval',
  /** Sources agree on a final score and the competition is not on automatic results. */
  'result_ready',
  /** Only one source has a final score after the waiting time. */
  'result_unverified',
  /** Sources disagree about the final score. */
  'result_conflict',
  /** A source now shows a different score than the one applied. */
  'result_correction',
  /** The score is not known to be a regular-time score. */
  'score_basis_unknown',
  /** A source's pages stopped parsing the way they used to. */
  'source_broken',
] as const;
export type ScrapeReviewKind = (typeof SCRAPE_REVIEW_KINDS)[number];

export const SCRAPE_REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ScrapeReviewStatus = (typeof SCRAPE_REVIEW_STATUSES)[number];

export const SCRAPE_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ScrapeSeverity = (typeof SCRAPE_SEVERITIES)[number];

/** The `feed_provider` of events created from scraped data (events.feed_provider). */
export const SCRAPED_FEED_PROVIDER = 'scraped';

/** Actor string written to audit_log and odds_history for automatic scraper changes. */
export const SCRAPER_ACTOR = 'system:scraper';
