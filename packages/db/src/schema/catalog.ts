import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Localised display name: always English, Amharic when available. */
export interface LocalizedName {
  en: string;
  am?: string;
  om?: string;
  ti?: string;
}

export const eventStatus = pgEnum('event_status', [
  'scheduled',
  'live',
  'finished',
  'cancelled',
  'postponed',
  'abandoned',
]);

export const marketStatus = pgEnum('market_status', [
  'open',
  'suspended',
  'closed',
  'settled',
  'void',
]);

export const selectionStatus = pgEnum('selection_status', ['open', 'suspended', 'settled']);

export const selectionResult = pgEnum('selection_result', ['won', 'lost', 'void']);

/** 'football' | 'basketball' | 'tennis' | 'volleyball' (SportCode in @vamos/core). */
export const sports = pgTable('sports', {
  id: text('id').primaryKey(),
  name: jsonb('name').$type<LocalizedName>().notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

/** Countries / regions grouping competitions ("England", "Ethiopia", "Africa", "International"). */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    slug: text('slug').notNull(),
    name: jsonb('name').$type<LocalizedName>().notNull(),
    countryCode: text('country_code'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('categories_sport_slug_uq').on(t.sportId, t.slug)],
);

export const competitions = pgTable(
  'competitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    slug: text('slug').notNull(),
    name: jsonb('name').$type<LocalizedName>().notNull(),
    /** Featured competitions feed the Betika-style "Highlights" tab. */
    featured: boolean('featured').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('competitions_sport_slug_uq').on(t.sportId, t.slug)],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    name: jsonb('name').$type<LocalizedName>().notNull(),
    shortName: text('short_name').notNull(),
    countryCode: text('country_code'),
    /** Pricing inputs for the mock feed only (e.g. { attack, defence } or { rating }). */
    ratings: jsonb('ratings').$type<Record<string, number>>(),
  },
  (t) => [uniqueIndex('teams_sport_short_name_uq').on(t.sportId, t.shortName)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Betika-style numeric Game ID shown on every fixture (SMS/USSD/shop betting). */
    gameId: integer('game_id').notNull().unique(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    competitionId: uuid('competition_id')
      .notNull()
      .references(() => competitions.id),
    homeTeamId: uuid('home_team_id')
      .notNull()
      .references(() => teams.id),
    awayTeamId: uuid('away_team_id')
      .notNull()
      .references(() => teams.id),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    status: eventStatus('status').notNull().default('scheduled'),
    /** false = all markets of the event suspended (e.g. VAR, feed loss). */
    bettingOpen: boolean('betting_open').notNull().default(true),
    liveMinute: integer('live_minute'),
    /** '1H' | 'HT' | '2H' | 'FT' (football), 'Q1'…'Q4' | 'OT' (basketball), set numbers… */
    period: text('period'),
    scoreHome: integer('score_home'),
    scoreAway: integer('score_away'),
    htScoreHome: integer('ht_score_home'),
    htScoreAway: integer('ht_score_away'),
    feedProvider: text('feed_provider').notNull(),
    feedRef: text('feed_ref').notNull(),
    /**
     * Secret seed of the demo live simulator, drawn at kick-off, so simulated
     * results cannot be computed in advance from public data. Never exposed.
     */
    simSeed: text('sim_seed'),
    resultedAt: timestamp('resulted_at', { withTimezone: true }),
    /**
     * When a real feed last priced the event from a fresh market consensus
     * (null for the mock feed): the freshness of what players see.
     */
    oddsUpdatedAt: timestamp('odds_updated_at', { withTimezone: true }),
    /**
     * When the status, the betting switch or the score last changed (not the
     * match clock, which moves every tick): an in-play cash-out refuses when
     * it moved during the live delay (see prepareCashOut).
     */
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('events_feed_ref_uq').on(t.feedProvider, t.feedRef),
    index('events_status_start_idx').on(t.status, t.startTime),
    index('events_competition_start_idx').on(t.competitionId, t.startTime),
    index('events_sport_start_idx').on(t.sportId, t.startTime),
    // The settlement sweep looks at recently resulted events.
    index('events_resulted_idx').on(t.resultedAt),
    // The range of formatGameId / parseGameId in @vamos/core (3 to 6 digits).
    check('events_game_id_range', sql`${t.gameId} BETWEEN 100 AND 999999`),
  ],
);

/**
 * Who suspended a suspended market: 'feed' for automatic suspensions (the
 * feed or the demo live simulator, which re-opens only these), 'trader' for a
 * person in the back office (only a trader re-opens those).
 */
export const MARKET_SUSPENDED_BY = ['feed', 'trader'] as const;
export type MarketSuspendedBy = (typeof MARKET_SUSPENDED_BY)[number];

export const markets = pgTable(
  'markets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** MarketTypeCode from @vamos/core ('1x2', 'ou', …). */
    type: text('type').notNull(),
    /** Half-point line for line markets ('2.5'), else null. */
    line: text('line'),
    /** marketKey(type, line) – unique per event. */
    key: text('key').notNull(),
    status: marketStatus('status').notNull().default('open'),
    /** MarketSuspendedBy while suspended (null for suspensions made before it was recorded). */
    suspendedBy: text('suspended_by').$type<MarketSuspendedBy>(),
    sortOrder: integer('sort_order').notNull().default(0),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /**
     * Resulted early, in play, by resultMarket (its outcome was already certain).
     * Resulting the event as cancelled, abandoned or postponed leaves such a
     * market as it is, even as a correction (bets on a decided market stand);
     * a final-score correction that overturns its result clears the flag.
     */
    resultedInPlay: boolean('resulted_in_play').notNull().default(false),
    /**
     * Voided by a trader (voidMarket): every selection is void and stays void
     * whatever result the event gets later, corrections included.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('markets_event_key_uq').on(t.eventId, t.key),
    check('markets_voided_is_void', sql`${t.voidedAt} IS NULL OR ${t.status} = 'void'`),
    check(
      'markets_suspended_by_valid',
      sql`${t.suspendedBy} IS NULL OR (${t.suspendedBy} IN ('feed', 'trader') AND ${t.status} = 'suspended')`,
    ),
  ],
);

export const selections = pgTable(
  'selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    /** Selection code from selectionsFor(type): '1', 'X', '2', 'over', '2-1', … */
    code: text('code').notNull(),
    oddsMilli: integer('odds_milli').notNull(),
    status: selectionStatus('status').notNull().default('open'),
    result: selectionResult('result'),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Voided by a trader (voidSelection / voidMarket): the result is void and
     * stays void whatever result the market or event gets later.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('selections_market_code_uq').on(t.marketId, t.code),
    check(
      'selections_voided_is_void',
      sql`${t.voidedAt} IS NULL OR (${t.status} = 'settled' AND ${t.result} = 'void')`,
    ),
    // The settlement sweep looks for bets on recently voided selections.
    index('selections_voided_idx')
      .on(t.voidedAt)
      .where(sql`${t.voidedAt} IS NOT NULL`),
    // Odds are integer milli within 1.001..1000.000 (see @vamos/core odds.ts).
    check('selections_odds_range', sql`${t.oddsMilli} BETWEEN 1001 AND 1000000`),
  ],
);

/** Append-only odds movement history (audit, risk analysis). */
export const oddsHistory = pgTable(
  'odds_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    selectionId: uuid('selection_id')
      .notNull()
      .references(() => selections.id, { onDelete: 'cascade' }),
    oddsMilli: integer('odds_milli').notNull(),
    source: text('source').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('odds_history_selection_idx').on(t.selectionId, t.changedAt)],
);
