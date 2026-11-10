import {
  SCRAPE_ADAPTERS,
  SCRAPE_FIXTURE_STATUSES,
  SCRAPE_ODDS_MARKETS,
  SCRAPE_ODDS_SELECTIONS,
  SCRAPE_PRICING_SOURCES,
  SCRAPE_RESULT_STATUSES,
  SCRAPE_REVIEW_KINDS,
  SCRAPE_REVIEW_STATUSES,
  SCRAPE_RUN_STATUSES,
  SCRAPE_SCORE_BASES,
  SCRAPE_SEVERITIES,
  SCRAPE_SPORTS,
} from '@vamos/core';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { competitions, events, sports, teams } from './catalog';

/**
 * The data scraper's tables (docs/scraper.md section 4). The services are in
 * packages/db/src/scrape; the rules that decide what reaches the catalogue are
 * in @vamos/scraper and apps/scraper. Nothing here is catalogue data: the
 * scraper only stages what sources said, and `scrape_observation_history` is
 * the append-only evidence behind every result the catalogue accepted
 * (migration 0034_scrape_history_guards).
 */

/** `column IN ('a', 'b', …)` from a closed set of @vamos/core constants (never user input). */
function oneOf(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  )})`;
}

/** The score object kept in `scrape_observations.score` (a ScrapeScore). */
export interface ScrapeScoreJson {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}

/** One issue of a run (a ParseIssue, capped by finishRun). */
export interface ScrapeRunIssueJson {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  fatal?: boolean;
  context?: Record<string, unknown>;
}

const SHA256_HEX = /* sql */ `'^[0-9a-f]{64}$'`;

/**
 * A place data is scraped from. `enabled` defaults to false: a source is
 * switched on by a person after its terms were checked (and switched off at
 * any time: the kill switch). `config` is the adapter's configuration
 * (allowedHosts, requests, timeZone, competition label, scoreBasis).
 */
export const scrapeSources = pgTable(
  'scrape_sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    adapter: text('adapter').notNull(),
    /** Who produces the data: sources sharing an upstream count as one vote. */
    upstream: text('upstream').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Staff id, or 'system:…' for changes made by code. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('scrape_sources_adapter', oneOf(t.adapter, SCRAPE_ADAPTERS)),
    check('scrape_sources_id_format', sql`${t.id} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check('scrape_sources_upstream_not_empty', sql`btrim(${t.upstream}) <> ''`),
  ],
);

/**
 * What the scraper may do per competition. No row = everything off. Every
 * flag defaults to false (shadow mode: observe, never create or open).
 */
export const scrapeCompetitionPolicy = pgTable(
  'scrape_competition_policy',
  {
    competitionId: uuid('competition_id')
      .primaryKey()
      .references(() => competitions.id, { onDelete: 'restrict' }),
    /** The scraper may create fixtures here. */
    enabled: boolean('enabled').notNull().default(false),
    /** Open betting by itself for new fixtures whose teams are calibrated. */
    autoOpen: boolean('auto_open').notNull().default(false),
    /** Apply confirmed final scores without a person. */
    autoResults: boolean('auto_results').notNull().default(false),
    /** Matches can go to extra time / penalties (knockouts). */
    extraTime: boolean('extra_time').notNull().default(false),
    /** 'model' (team ratings, default) or 'market' (licensed bookmaker odds first, model as fallback). */
    pricingSource: text('pricing_source').notNull().default('model'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    check(
      'scrape_competition_policy_pricing_source',
      oneOf(t.pricingSource, SCRAPE_PRICING_SOURCES),
    ),
  ],
);

/**
 * One fetch + parse cycle of a source. `running` has no `finished_at`; every
 * other status has one. `issues` is capped by finishRun; `error` is truncated.
 */
export const scrapeRuns = pgTable(
  'scrape_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => scrapeSources.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** ScrapeRunStatus. */
    status: text('status').notNull().default('running'),
    /** 'schedule' | 'manual'. */
    trigger: text('trigger').notNull().default('schedule'),
    requests: integer('requests').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    recordsSeen: integer('records_seen').notNull().default(0),
    recordsAccepted: integer('records_accepted').notNull().default(0),
    fixtures: integer('fixtures').notNull().default(0),
    results: integer('results').notNull().default(0),
    issues: jsonb('issues').$type<ScrapeRunIssueJson[]>().notNull().default([]),
    error: text('error'),
    /**
     * A metered API's credits (docs/theoddsapi-plan/README.md, rule G2; null for other sources):
     * the sum of what this run's responses cost, and the period's used and remaining credits as
     * the run's last response reported them. The credit guard reads these.
     */
    apiCreditsSpent: integer('api_credits_spent'),
    apiCreditsUsed: integer('api_credits_used'),
    apiCreditsRemaining: integer('api_credits_remaining'),
  },
  (t) => [
    index('scrape_runs_source_started_idx').on(t.sourceId, t.startedAt.desc(), t.id),
    check('scrape_runs_status', oneOf(t.status, SCRAPE_RUN_STATUSES)),
    check('scrape_runs_trigger', oneOf(t.trigger, ['schedule', 'manual'])),
    check('scrape_runs_finished', sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
    check(
      'scrape_runs_counts',
      sql`${t.requests} >= 0 AND ${t.bytes} >= 0 AND ${t.recordsSeen} >= 0 AND ${t.recordsAccepted} >= 0 AND ${t.fixtures} >= 0 AND ${t.results} >= 0`,
    ),
    check('scrape_runs_issues_array', sql`jsonb_typeof(${t.issues}) = 'array'`),
    check(
      'scrape_runs_api_credits',
      sql`(${t.apiCreditsSpent} IS NULL OR ${t.apiCreditsSpent} >= 0) AND (${t.apiCreditsUsed} IS NULL OR ${t.apiCreditsUsed} >= 0) AND (${t.apiCreditsRemaining} IS NULL OR ${t.apiCreditsRemaining} >= 0)`,
    ),
  ],
);

/**
 * A stored snapshot (the bytes are in the archive directory under their
 * hash). `keep` marks the evidence of an applied result: never pruned.
 * `observations.raw_id` and `history.raw_id` deliberately have no foreign key:
 * pruning an old snapshot must not need to touch the append-only history.
 * `records_seen` / `records_accepted` are this document's parse yield (the
 * baseline for the shape check S1 is per URL).
 */
export const scrapeRaw = pgTable(
  'scrape_raw',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => scrapeRuns.id, { onDelete: 'restrict' }),
    url: text('url').notNull(),
    status: integer('status').notNull(),
    contentType: text('content_type'),
    /** SHA-256 (hex) of the exact response bytes. */
    contentHash: text('content_hash').notNull(),
    bytes: integer('bytes').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    keep: boolean('keep').notNull().default(false),
    recordsSeen: integer('records_seen'),
    recordsAccepted: integer('records_accepted'),
  },
  (t) => [
    uniqueIndex('scrape_raw_run_url_uq').on(t.runId, t.url),
    index('scrape_raw_hash_idx').on(t.contentHash),
    index('scrape_raw_prune_idx')
      .on(t.fetchedAt)
      .where(sql`${t.keep} = false`),
    check('scrape_raw_hash', sql`${t.contentHash} ~ ${sql.raw(SHA256_HEX)}`),
    check('scrape_raw_sizes', sql`${t.bytes} >= 0 AND ${t.status} BETWEEN 100 AND 599`),
    check(
      'scrape_raw_yield',
      sql`(${t.recordsSeen} IS NULL OR ${t.recordsSeen} >= 0) AND (${t.recordsAccepted} IS NULL OR ${t.recordsAccepted} >= 0)`,
    ),
  ],
);

/** A point-valued JSON field of a score: a whole number 0..99. */
const scoreField = (score: AnyColumn, field: string): SQL =>
  sql`(${score}->>${sql.raw(`'${field}'`)}) ~ '^[0-9]{1,2}$'`;
const scoreFieldOrNull = (score: AnyColumn, field: string): SQL =>
  sql`((${score}->>${sql.raw(`'${field}'`)}) IS NULL OR (${score}->>${sql.raw(`'${field}'`)}) ~ '^[0-9]{1,2}$')`;

/**
 * The columns an observation and its history rows share: what one source said
 * about one match (raw names, kickoff, status, score), i.e. the payload whose
 * hash detects a change. Resolved catalogue ids are NOT part of the payload.
 */
const payloadColumns = {
  sport: text('sport').notNull(),
  competitionRaw: text('competition_raw').notNull(),
  homeRaw: text('home_raw').notNull(),
  awayRaw: text('away_raw').notNull(),
  kickoff: timestamp('kickoff', { withTimezone: true }).notNull(),
  /** Fixture: ScrapeFixtureStatus; result: ScrapeResultStatus. */
  status: text('status').notNull(),
  round: text('round'),
  /** Results only; present exactly when status = 'finished'. */
  score: jsonb('score').$type<ScrapeScoreJson>(),
  /** Results only (ScrapeScoreBasis). */
  scoreBasis: text('score_basis'),
  /** SHA-256 (hex) of the canonical payload. */
  payloadHash: text('payload_hash').notNull(),
};

/** The CHECK constraints of payloadColumns, named per table. */
function payloadChecks(
  prefix: string,
  t: {
    kind: AnyColumn;
    sport: AnyColumn;
    status: AnyColumn;
    score: AnyColumn;
    scoreBasis: AnyColumn;
    payloadHash: AnyColumn;
  },
) {
  return [
    check(`${prefix}_kind`, oneOf(t.kind, ['fixture', 'result'])),
    check(`${prefix}_sport`, oneOf(t.sport, SCRAPE_SPORTS)),
    check(
      `${prefix}_status`,
      sql`(${t.kind} = 'fixture' AND ${oneOf(t.status, SCRAPE_FIXTURE_STATUSES)}) OR (${t.kind} = 'result' AND ${oneOf(t.status, SCRAPE_RESULT_STATUSES)})`,
    ),
    check(
      `${prefix}_score_basis`,
      sql`(${t.kind} = 'fixture' AND ${t.scoreBasis} IS NULL) OR (${t.kind} = 'result' AND ${t.scoreBasis} IS NOT NULL AND ${oneOf(t.scoreBasis, SCRAPE_SCORE_BASES)})`,
    ),
    // A finished result has a score, anything else none.
    check(
      `${prefix}_score_presence`,
      sql`(${t.kind} = 'result' AND ${t.status} = 'finished') = (${t.score} IS NOT NULL)`,
    ),
    check(
      `${prefix}_score_shape`,
      sql`${t.score} IS NULL OR (jsonb_typeof(${t.score}) = 'object' AND ${scoreField(t.score, 'home')} AND ${scoreField(t.score, 'away')} AND ${scoreFieldOrNull(t.score, 'htHome')} AND ${scoreFieldOrNull(t.score, 'htAway')} AND ((${t.score}->>'htHome') IS NULL) = ((${t.score}->>'htAway') IS NULL))`,
    ),
    check(`${prefix}_payload_hash`, sql`${t.payloadHash} ~ ${sql.raw(SHA256_HEX)}`),
  ];
}

/**
 * The CURRENT state of one source's claim per (source, kind, source_key).
 * `first_seen_at` never changes, `changed_at` is when the payload last took
 * its current value, `last_seen_at` is the latest run that still showed it.
 * Resolved ids are nullable until the names resolve (aliases). Never deleted
 * (the history references it).
 */
export const scrapeObservations = pgTable(
  'scrape_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => scrapeSources.id, { onDelete: 'restrict' }),
    /** 'fixture' | 'result'. */
    kind: text('kind').notNull(),
    /** The caller's stable key for the match within the source (its own id, else a composite). */
    sourceKey: text('source_key').notNull(),
    ...payloadColumns,
    competitionId: uuid('competition_id').references(() => competitions.id, {
      onDelete: 'restrict',
    }),
    homeTeamId: uuid('home_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    awayTeamId: uuid('away_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => scrapeRuns.id, { onDelete: 'restrict' }),
    /** The snapshot it was last read from (no foreign key: snapshots are pruned). */
    rawId: uuid('raw_id'),
  },
  (t) => [
    uniqueIndex('scrape_observations_key_uq').on(t.sourceId, t.kind, t.sourceKey),
    index('scrape_observations_kind_comp_kickoff_idx').on(t.kind, t.competitionId, t.kickoff),
    index('scrape_observations_source_seen_idx').on(t.sourceId, t.lastSeenAt),
    index('scrape_observations_unresolved_idx')
      .on(t.firstSeenAt)
      .where(sql`${t.competitionId} IS NULL OR ${t.homeTeamId} IS NULL OR ${t.awayTeamId} IS NULL`),
    ...payloadChecks('scrape_observations', t),
    check(
      'scrape_observations_clock',
      sql`${t.firstSeenAt} <= ${t.changedAt} AND ${t.changedAt} <= ${t.lastSeenAt}`,
    ),
    check(
      'scrape_observations_teams_differ',
      sql`${t.homeTeamId} IS NULL OR ${t.awayTeamId} IS NULL OR ${t.homeTeamId} <> ${t.awayTeamId}`,
    ),
  ],
);

/**
 * APPEND-ONLY: every distinct payload an observation had, in order. The
 * evidence behind a settlement. Updates and deletes are refused by a trigger
 * and the app role has no UPDATE/DELETE privilege (migration 0034).
 */
export const scrapeObservationHistory = pgTable(
  'scrape_observation_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => scrapeObservations.id, { onDelete: 'restrict' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => scrapeSources.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    sourceKey: text('source_key').notNull(),
    ...payloadColumns,
    /** When this payload was first read. */
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => scrapeRuns.id, { onDelete: 'restrict' }),
    rawId: uuid('raw_id'),
  },
  (t) => [
    index('scrape_observation_history_obs_idx').on(t.observationId, t.id),
    index('scrape_observation_history_seen_idx').on(t.seenAt),
    ...payloadChecks('scrape_observation_history', t),
  ],
);

const aliasChecks = (prefix: string, t: { aliasNorm: AnyColumn }): ReturnType<typeof check>[] => [
  // Normalised by the caller (normalizeName in @vamos/scraper): never empty, never padded.
  check(
    `${prefix}_alias_norm`,
    sql`${t.aliasNorm} <> '' AND ${t.aliasNorm} = btrim(${t.aliasNorm})`,
  ),
];

/**
 * Normalised raw team name → catalogue team, optionally limited to one source
 * (null = any source). One mapping per (sport, name, source); the unique
 * expression index treats a null source as one scope of its own.
 */
export const teamAliases = pgTable(
  'team_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id, { onDelete: 'restrict' }),
    aliasNorm: text('alias_norm').notNull(),
    sourceId: text('source_id').references(() => scrapeSources.id, { onDelete: 'restrict' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('team_aliases_uq').on(t.sportId, t.aliasNorm, sql`coalesce(${t.sourceId}, '')`),
    index('team_aliases_team_idx').on(t.teamId),
    ...aliasChecks('team_aliases', t),
  ],
);

/** The same for competition labels. */
export const competitionAliases = pgTable(
  'competition_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id, { onDelete: 'restrict' }),
    aliasNorm: text('alias_norm').notNull(),
    sourceId: text('source_id').references(() => scrapeSources.id, { onDelete: 'restrict' }),
    competitionId: uuid('competition_id')
      .notNull()
      .references(() => competitions.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('competition_aliases_uq').on(
      t.sportId,
      t.aliasNorm,
      sql`coalesce(${t.sourceId}, '')`,
    ),
    index('competition_aliases_competition_idx').on(t.competitionId),
    ...aliasChecks('competition_aliases', t),
  ],
);

/**
 * What a person must look at. At most ONE OPEN item per (kind, subject_key)
 * (partial unique index); once resolved or dismissed, a new one may open.
 * `payload` carries what the person needs (sources, scores, exposure …).
 */
export const scrapeReviewItems = pgTable(
  'scrape_review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** What the item is about (a fixture key, a raw name, a source id …). */
    subjectKey: text('subject_key').notNull(),
    status: text('status').notNull().default('open'),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolution: text('resolution'),
    /** Staff id, or 'system:…' when the cause disappeared. */
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('scrape_review_items_open_uq')
      .on(t.kind, t.subjectKey)
      .where(sql`${t.status} = 'open'`),
    index('scrape_review_items_list_idx').on(t.status, t.kind, t.createdAt.desc(), t.id.desc()),
    index('scrape_review_items_subject_idx').on(t.subjectKey),
    check('scrape_review_items_kind', oneOf(t.kind, SCRAPE_REVIEW_KINDS)),
    check('scrape_review_items_status', oneOf(t.status, SCRAPE_REVIEW_STATUSES)),
    check('scrape_review_items_severity', oneOf(t.severity, SCRAPE_SEVERITIES)),
    check('scrape_review_items_resolved', sql`(${t.status} = 'open') = (${t.resolvedAt} IS NULL)`),
    check('scrape_review_items_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);

/** A result updates the ratings at most once per fixture key (inserted in the result's transaction). */
export const scrapeRatingApplied = pgTable('scrape_rating_applied', {
  fixtureKey: text('fixture_key').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Why the scraper keeps an event's markets suspended (rule A2): a re-price is held for a person, or
 * the market that priced the event has lapsed close to kickoff.
 */
export const SCRAPE_SUSPENSIONS = ['reprice_held', 'market_lapsed'] as const;
export type ScrapeSuspension = (typeof SCRAPE_SUSPENSIONS)[number];

/**
 * Which ratings an event's prices were computed from (rule O3, re-pricing).
 * `ratings_key` is the fingerprint of both teams' ratings behind the stored
 * prices (null: not known, an event created before this table existed);
 * `held_key` is the fingerprint of the last proposal a person was asked about,
 * so a held or dismissed proposal is not raised again until the ratings change.
 * `suspended_for` is the cause of the scraper's suspension of the event's markets (rule A2), null
 * when it has none: the scraper suspends once when a cause starts and re-opens once when it ends.
 * Existing bets are unaffected: a bet leg keeps the odds it was accepted at.
 */
export const scrapeEventPricing = pgTable(
  'scrape_event_pricing',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => events.id, { onDelete: 'cascade' }),
    ratingsKey: text('ratings_key'),
    pricedAt: timestamp('priced_at', { withTimezone: true }),
    heldKey: text('held_key'),
    suspendedFor: text('suspended_for').$type<ScrapeSuspension>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('scrape_event_pricing_suspended_for', oneOf(t.suspendedFor, SCRAPE_SUSPENSIONS))],
);

/**
 * Bookmaker prices a licensed market feed reported (data class `market_odds`, docs/scraper.md
 * 3.1). Never shown to players and never a price of ours: the pricing step reads them to check
 * and weight our own prices.
 *
 * ONE ROW PER (source, the source's key for the match, bookmaker, market, line, selection): the
 * state as of the latest fetch that listed it, rewritten by every sighting (`observed_at` moves,
 * the price and `price_updated_at` follow). The history of every page is in the raw archive and
 * can be re-parsed; this table is not evidence for anything. `observed_at` is when WE last saw the
 * price listed (the freshness the pricing step trusts); `price_updated_at` is when the bookmaker
 * last moved it. A book a later fetch no longer lists keeps its old `observed_at`, which is how
 * `latestMarketOdds` knows to leave it out.
 *
 * `event_id` is the catalogue event the match resolved to (null until it does); the resolved ids
 * next to it are what the re-link pass matches on. Rows older than the retention are pruned
 * (apps/scraper tasks/prune.ts).
 */
export const scrapeMarketOdds = pgTable(
  'scrape_market_odds',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => scrapeSources.id, { onDelete: 'restrict' }),
    /** The run that last saw the row. */
    runId: uuid('run_id')
      .notNull()
      .references(() => scrapeRuns.id, { onDelete: 'restrict' }),
    /** The snapshot it was last read from (no foreign key: snapshots are pruned). */
    rawId: uuid('raw_id'),
    /** The source's own id for the match (its event id), else competition, teams and day. */
    sourceKey: text('source_key').notNull(),
    sport: text('sport').notNull(),
    competitionRaw: text('competition_raw').notNull(),
    homeRaw: text('home_raw').notNull(),
    awayRaw: text('away_raw').notNull(),
    kickoff: timestamp('kickoff', { withTimezone: true }).notNull(),
    competitionId: uuid('competition_id').references(() => competitions.id, {
      onDelete: 'restrict',
    }),
    homeTeamId: uuid('home_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    awayTeamId: uuid('away_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    /** The event of the catalogue this match resolved to; null until it does. */
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    /** '1x2' | 'ou'. */
    market: text('market').notNull(),
    /** Null for the 1x2; the total as text for 'ou' ('2.5'). */
    line: text('line'),
    /** The line as a key: '' for the 1x2 (a unique index cannot hold a null). */
    lineKey: text('line_key').generatedAlwaysAs(sql`coalesce(line, '')`),
    /** '1' | 'X' | '2' | 'over' | 'under'. */
    selection: text('selection').notNull(),
    /** The bookmaker as the feed names it (an affiliate id). */
    bookmaker: text('bookmaker').notNull(),
    /** Decimal odds times 1000, rounded down. */
    priceMilli: integer('price_milli').notNull(),
    /** When the bookmaker last moved the price (the feed's own timestamp). */
    priceUpdatedAt: timestamp('price_updated_at', { withTimezone: true }).notNull(),
    /** When a fetch last listed this price. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('scrape_market_odds_key_uq').on(
      t.sourceId,
      t.sourceKey,
      t.bookmaker,
      t.market,
      t.lineKey,
      t.selection,
    ),
    index('scrape_market_odds_event_idx').on(t.eventId, t.market, t.line, t.observedAt),
    index('scrape_market_odds_observed_idx').on(t.observedAt),
    index('scrape_market_odds_unlinked_idx')
      .on(t.observedAt)
      .where(sql`${t.eventId} IS NULL`),
    index('scrape_market_odds_raw_idx').on(t.sourceId, t.rawId),
    check('scrape_market_odds_sport', oneOf(t.sport, SCRAPE_SPORTS)),
    check('scrape_market_odds_market', oneOf(t.market, SCRAPE_ODDS_MARKETS)),
    check('scrape_market_odds_selection', oneOf(t.selection, SCRAPE_ODDS_SELECTIONS)),
    check(
      'scrape_market_odds_market_selection',
      sql`(${t.market} = '1x2' AND ${t.selection} IN ('1', 'X', '2') AND ${t.line} IS NULL) OR (${t.market} = 'ou' AND ${t.selection} IN ('over', 'under') AND ${t.line} IS NOT NULL AND ${t.line} ~ '^[0-9]{1,2}(\\.[0-9]{1,2})?$')`,
    ),
    check('scrape_market_odds_price', sql`${t.priceMilli} BETWEEN 1010 AND 1000000`),
    check(
      'scrape_market_odds_teams_differ',
      sql`${t.homeTeamId} IS NULL OR ${t.awayTeamId} IS NULL OR ${t.homeTeamId} <> ${t.awayTeamId}`,
    ),
  ],
);
