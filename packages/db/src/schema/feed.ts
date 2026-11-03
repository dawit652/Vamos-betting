import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { competitions, events, sports, teams } from './catalog';

/**
 * Real odds feeds (FEED_PROVIDER=theoddsapi, docs/odds-api-integration-plan.md):
 * the leagues a provider offers and our polling state for each, the names it
 * uses for teams, the credit log of its API and the results it reported.
 */

/**
 * One row per provider league (an Odds API sport key). The provider-side
 * fields (title, active, …) are refreshed by the catalogue sync; `enabled`,
 * `margin_bps` and the competition are ours and never overwritten by it.
 */
export const feedLeagues = pgTable(
  'feed_leagues',
  {
    provider: text('provider').notNull(),
    /** The provider's key ('soccer_epl'). */
    sportKey: text('sport_key').notNull(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    /** The catalogue competition its events go to (set when the league is first used). */
    competitionId: uuid('competition_id').references(() => competitions.id),
    /** The provider's group ('Soccer') and names. */
    sportGroup: text('sport_group').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** The provider currently has events for it. */
    active: boolean('active').notNull(),
    /** We poll it and show its events (staff switch it in the back office). */
    enabled: boolean('enabled').notNull(),
    /** Knockout competition: licensed mode has staff confirm its results. */
    cup: boolean('cup').notNull().default(false),
    /** Registry tier: 1 on by default, 2 well covered, 3 unknown key. */
    tier: integer('tier').notNull(),
    /** Our main-market margin for this league in basis points (null: the default). */
    marginBps: integer('margin_bps'),
    /** From the free events endpoint: the next start time and how many events there are. */
    nextStartAt: timestamp('next_start_at', { withTimezone: true }),
    eventCount: integer('event_count').notNull().default(0),
    liveCount: integer('live_count').notNull().default(0),
    lastEventsAt: timestamp('last_events_at', { withTimezone: true }),
    lastOddsAt: timestamp('last_odds_at', { withTimezone: true }),
    lastScoresAt: timestamp('last_scores_at', { withTimezone: true }),
    /** When the poller next reads the league's odds and scores (null: as soon as possible). */
    nextOddsAt: timestamp('next_odds_at', { withTimezone: true }),
    nextScoresAt: timestamp('next_scores_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.sportKey] }),
    index('feed_leagues_due_odds_idx').on(t.provider, t.enabled, t.nextOddsAt),
    check('feed_leagues_tier_valid', sql`${t.tier} BETWEEN 1 AND 3`),
    check(
      'feed_leagues_margin_valid',
      sql`${t.marginBps} IS NULL OR ${t.marginBps} BETWEEN 0 AND 3000`,
    ),
    check('feed_leagues_counts_valid', sql`${t.eventCount} >= 0 AND ${t.liveCount} >= 0`),
  ],
);

/**
 * A provider's name for a team (or player) → our team. Created on first
 * sight; staff can point a name at another team to merge duplicates.
 */
export const feedTeamAliases = pgTable(
  'feed_team_aliases',
  {
    provider: text('provider').notNull(),
    sportId: text('sport_id')
      .notNull()
      .references(() => sports.id),
    externalName: text('external_name').notNull(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.sportId, t.externalName] })],
);

/** Every call to a feed API with its credit cost, for the budget governor and the back office. */
export const feedApiCalls = pgTable(
  'feed_api_calls',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    provider: text('provider').notNull(),
    /** 'sports' | 'events' | 'odds' | 'event_odds' | 'scores' | 'participants'. */
    endpoint: text('endpoint').notNull(),
    sportKey: text('sport_key'),
    /** HTTP status; null when no response came back. */
    status: integer('status'),
    /** Credits the call cost (the provider's x-requests-last). */
    cost: integer('cost').notNull().default(0),
    /** Credits left and used afterwards, as the provider reported them. */
    remaining: integer('remaining'),
    used: integer('used'),
    /** OddsApiError kind of a failed call. */
    errorKind: text('error_kind'),
    calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('feed_api_calls_provider_time_idx').on(t.provider, t.calledAt),
    check('feed_api_calls_cost_valid', sql`${t.cost} >= 0`),
  ],
);

/**
 * The final score a feed reported for an event. It is applied (resultEvent)
 * once it has stood unchanged for the confirmation wait, unless
 * `review_reason` says staff must confirm it first ('cup', 'tennis',
 * 'overdue').
 */
export const feedResults = pgTable(
  'feed_results',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => events.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    scoreHome: integer('score_home'),
    scoreAway: integer('score_away'),
    /** When the feed first reported this score as final (reset when the score changes). */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    reviewReason: text('review_reason'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('feed_results_pending_idx')
      .on(t.provider, t.firstSeenAt)
      .where(sql`${t.appliedAt} IS NULL`),
    check(
      'feed_results_scores_valid',
      sql`(${t.scoreHome} IS NULL) = (${t.scoreAway} IS NULL) AND (${t.scoreHome} IS NULL OR (${t.scoreHome} >= 0 AND ${t.scoreAway} >= 0))`,
    ),
    check(
      'feed_results_review_reason_valid',
      sql`${t.reviewReason} IS NULL OR ${t.reviewReason} IN ('cup', 'tennis', 'overdue', 'unreadable')`,
    ),
  ],
);
