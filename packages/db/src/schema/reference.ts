import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { events } from './catalog';

/**
 * Market reference data from a licensed odds provider (TheRundown,
 * docs/therundown-plan). On TheRundown's Starter licence nothing taken from it
 * may be kept longer than 24 hours, so every table holding its data
 * (`reference_event_map`, `reference_book_prices`, `reference_consensus`) is
 * pruned by age (THERUNDOWN_RETENTION_HOURS); `reference_budget` and
 * `reference_poll_state` hold only our own meters and timers. None of these
 * tables is catalogue data: prices shown to players never come from here
 * while the licence is `internal`.
 */

/** Providers a reference row can come from. */
export const REFERENCE_PROVIDERS = ['therundown'] as const;
export type ReferenceProvider = (typeof REFERENCE_PROVIDERS)[number];

export const REFERENCE_CONFIDENCES = ['high', 'normal', 'low'] as const;
export const REFERENCE_BUDGET_LEVELS = ['unknown', 'green', 'amber', 'red'] as const;

/** `column IN ('a', 'b', …)` from a closed set of constants (never user input). */
function oneOf(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  )})`;
}

const providerCheck = (name: string, column: AnyColumn) =>
  check(name, oneOf(column, REFERENCE_PROVIDERS));

/**
 * Which provider event one of our events is matched to (rule M1: same
 * competition, home and away team, kickoff within the tolerance). One provider
 * event per event and one event per provider event. `kickoff` and `status`
 * are what the provider said at `last_seen_at`.
 */
export const referenceEventMap = pgTable(
  'reference_event_map',
  {
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    providerSportId: integer('provider_sport_id').notNull(),
    homeTeamRef: integer('home_team_ref').notNull(),
    awayTeamRef: integer('away_team_ref').notNull(),
    kickoff: timestamp('kickoff', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'reference_event_map_pk', columns: [t.provider, t.providerEventId] }),
    uniqueIndex('reference_event_map_event_uq').on(t.provider, t.eventId),
    index('reference_event_map_seen_idx').on(t.lastSeenAt),
    providerCheck('reference_event_map_provider', t.provider),
  ],
);

/**
 * The provider's prices, per book and outcome, as last fetched (only open,
 * valid prices on allow-listed markets: rules P1 to P3). `market_key` and
 * `outcome` are ours ('1x2' / '1', 'ou:2.5' / 'over'); `as_of` is the fetch
 * time minus the server's data delay.
 */
export const referenceBookPrices = pgTable(
  'reference_book_prices',
  {
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    marketKey: text('market_key').notNull(),
    outcome: text('outcome').notNull(),
    bookId: integer('book_id').notNull(),
    american: integer('american').notNull(),
    oddsMilli: integer('odds_milli').notNull(),
    vendorUpdatedAt: timestamp('vendor_updated_at', { withTimezone: true }).notNull(),
    liquidityUsd: doublePrecision('liquidity_usd'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'reference_book_prices_pk',
      columns: [t.provider, t.providerEventId, t.marketKey, t.outcome, t.bookId],
    }),
    index('reference_book_prices_fetched_idx').on(t.fetchedAt),
    providerCheck('reference_book_prices_provider', t.provider),
    check('reference_book_prices_odds', sql`${t.oddsMilli} BETWEEN 1001 AND 1000000`),
    check('reference_book_prices_american', sql`abs(${t.american}) >= 100`),
  ],
);

/**
 * The consensus of one of our markets (rule P5): fair probability per
 * selection code (`fair`), the books behind it, their dispersion and the
 * confidence. Derived from the provider's data, so pruned like it.
 */
export const referenceConsensus = pgTable(
  'reference_consensus',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    marketKey: text('market_key').notNull(),
    fair: jsonb('fair').$type<Record<string, number>>().notNull(),
    booksUsed: jsonb('books_used').$type<number[]>().notNull(),
    dispersion: doublePrecision('dispersion').notNull(),
    confidence: text('confidence').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'reference_consensus_pk', columns: [t.eventId, t.provider, t.marketKey] }),
    index('reference_consensus_computed_idx').on(t.computedAt),
    providerCheck('reference_consensus_provider', t.provider),
    check('reference_consensus_confidence', oneOf(t.confidence, REFERENCE_CONFIDENCES)),
    check('reference_consensus_dispersion', sql`${t.dispersion} >= 0 AND ${t.dispersion} <= 1`),
  ],
);

/**
 * The provider's data-point meters as last seen (rule A3), and what we spent
 * on `spent_day` (UTC). Our own bookkeeping: not pruned.
 */
export const referenceBudget = pgTable(
  'reference_budget',
  {
    provider: text('provider').primaryKey(),
    used: bigint('used', { mode: 'number' }),
    remaining: bigint('remaining', { mode: 'number' }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    spentDay: date('spent_day', { mode: 'string' }).notNull(),
    spentToday: bigint('spent_today', { mode: 'number' }).notNull().default(0),
    /** The effective data delay last used (rule A1), seconds. */
    delaySeconds: integer('delay_seconds'),
    rateLimit: integer('rate_limit'),
    level: text('level').notNull().default('unknown'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    providerCheck('reference_budget_provider', t.provider),
    check('reference_budget_level', oneOf(t.level, REFERENCE_BUDGET_LEVELS)),
    check('reference_budget_spent', sql`${t.spentToday} >= 0`),
  ],
);

/**
 * When each request kind was last made (`request_key`, e.g.
 * `day:11:2026-11-01` or `event:<provider event id>`), so the poller keeps its
 * cadence across restarts. Our own timers: rows unused for 8 days are pruned.
 */
export const referencePollState = pgTable(
  'reference_poll_state',
  {
    provider: text('provider').notNull(),
    requestKey: text('request_key').notNull(),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }).notNull(),
    lastOutcome: text('last_outcome').notNull(),
    lastCost: integer('last_cost'),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ name: 'reference_poll_state_pk', columns: [t.provider, t.requestKey] }),
    index('reference_poll_state_fetched_idx').on(t.lastFetchedAt),
    providerCheck('reference_poll_state_provider', t.provider),
  ],
);
