import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { betChannel } from './betting';
import { events } from './catalog';

/**
 * Jackpots (Phase 8): Betika-style 1X2 pools. A round has a fixed list of
 * football games (each with its 1X2 market); a player's entry picks one,
 * two or three outcomes per game and pays for every combination. The
 * money logic is in packages/db/src/jackpots, the maths in @vamos/core
 * (jackpot.ts).
 *
 * Round lifecycle:
 * - scheduled: prepared but not taking entries yet (openJackpotRound);
 * - open: taking entries until `closes_at` (the first kick-off);
 * - closed: no more entries; waiting for every game's result;
 * - settled: prizes paid (the `settlement` summary is final);
 * - cancelled: void (more than half of the games cancelled, or never
 *   opened): every entry refunded.
 * The database refuses any other transition and keeps a settled or
 * cancelled round's terms and result final (migration
 * 0017_phase8_jackpot_guards).
 */
export const jackpotRoundStatus = pgEnum('jackpot_round_status', [
  'scheduled',
  'open',
  'closed',
  'settled',
  'cancelled',
]);

/** open until the round settles; then won (prize > 0), lost or void (refunded). */
export const jackpotEntryStatus = pgEnum('jackpot_entry_status', ['open', 'won', 'lost', 'void']);

/**
 * The terms a round was opened with, frozen (santim as decimal strings):
 * the template (game count, cost per combination, maximum combinations,
 * cancelled rule, prize tiers) and the winnings tax. Entry pricing and
 * settlement only ever use these, never the settings of the day.
 */
export interface JackpotRoundTermsJson {
  template: Record<string, unknown>;
  tax: Record<string, unknown>;
}

/** One prize tier as settled (TierPayout of @vamos/core; santim and counts as strings). */
export interface JackpotTierPayoutJson {
  correct: number;
  kind: 'shared' | 'fixed';
  winningCombinations: string;
  prizePerCombination: string;
  total: string;
  undistributed: string;
}

/** The settlement of a round (santim as decimal strings), written once when it settles or is voided. */
export interface JackpotSettlementJson {
  void: boolean;
  /** Why the round is void ('cancelled_games', 'not_opened', 'cancelled_by_staff'); null when settled. */
  voidReason: string | null;
  /** Each game's result ('1' | 'X' | '2' | 'cancelled'), in game order; [] if never opened or cancelled by staff. */
  results: string[];
  cancelledGames: number;
  entries: number;
  winners: number;
  stakes: string;
  gross: string;
  tax: string;
  net: string;
  refunds: string;
  undistributed: string;
  payouts: JackpotTierPayoutJson[];
}

export const jackpotRounds = pgTable(
  'jackpot_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The template's code ('daily9', 'weekly13'). */
    templateCode: text('template_code').notNull(),
    status: jackpotRoundStatus('status').notNull(),
    /** Copies of the frozen terms, for constraints and queries. */
    gameCount: integer('game_count').notNull(),
    costPerCombination: bigint('cost_per_combination', { mode: 'bigint' }).notNull(),
    maxCombinations: integer('max_combinations').notNull(),
    /** The advertised jackpot: the amount of the first (most correct) prize tier. */
    pool: bigint('pool', { mode: 'bigint' }).notNull(),
    /** JackpotRoundTermsJson. */
    terms: jsonb('terms').$type<JackpotRoundTermsJson>().notNull(),
    /** Entries close here: the earliest kick-off of the round's games. */
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** When the round stopped taking entries (closed, or cancelled before opening). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** When it was settled or voided. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** JackpotSettlementJson, once settled or cancelled. */
    settlement: jsonb('settlement').$type<JackpotSettlementJson>(),
    /**
     * Set when a game's result changed after the round was settled (a
     * result correction). Settled rounds are never paid again: the flag and
     * the `jackpot.result_mismatch` event are for the back office.
     */
    resultsFlaggedAt: timestamp('results_flagged_at', { withTimezone: true }),
    /**
     * The discrepancy last flagged, by game: the catalogue result where it
     * differed from the settled one, else null. A new `jackpot.result_mismatch`
     * is written whenever the discrepancy differs from this (a further
     * correction, or a revert); results_flagged_at keeps the first flag's time.
     */
    resultsFlagged: jsonb('results_flagged').$type<(string | null)[]>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jackpot_rounds_status_closes_idx').on(t.status, t.closesAt),
    index('jackpot_rounds_template_status_idx').on(t.templateCode, t.status, t.closesAt),
    check('jackpot_rounds_template_code', sql`${t.templateCode} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('jackpot_rounds_game_count', sql`${t.gameCount} BETWEEN 1 AND 30`),
    check('jackpot_rounds_cost_positive', sql`${t.costPerCombination} > 0`),
    check('jackpot_rounds_max_combinations', sql`${t.maxCombinations} >= 1`),
    check('jackpot_rounds_pool_non_negative', sql`${t.pool} >= 0`),
    check(
      'jackpot_rounds_closed_at',
      sql`(${t.status} IN ('scheduled', 'open')) = (${t.closedAt} IS NULL)`,
    ),
    check(
      'jackpot_rounds_final',
      sql`(${t.status} IN ('settled', 'cancelled')) = (${t.settledAt} IS NOT NULL AND ${t.settlement} IS NOT NULL)`,
    ),
  ],
);

/**
 * One game of a round: the event and its 1X2 market with the three
 * selections ('1', 'X', '2'), in game order. `result` is recorded as the
 * games finish ('cancelled' for a void market or a cancelled, abandoned or
 * postponed match) and is final once the round is settled.
 *
 * Only `event_id` has a foreign key (round creation locks the events FOR
 * SHARE anyway); the market and selection ids are copies of the event's
 * rows, kept without foreign keys like bet_legs' market id, so that no
 * FOR KEY SHARE lock on a market or selection row is ever taken here while
 * the catalogue's writers hold or wait for theirs. Events cannot be deleted
 * while a game references them, and markets and selections are only ever
 * deleted with their event.
 */
export const jackpotGames = pgTable(
  'jackpot_games',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => jackpotRounds.id, { onDelete: 'restrict' }),
    /** 0-based game order (picks are given in this order). */
    position: integer('position').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    /** The event's '1x2' market. */
    marketId: uuid('market_id').notNull(),
    homeSelectionId: uuid('home_selection_id').notNull(),
    drawSelectionId: uuid('draw_selection_id').notNull(),
    awaySelectionId: uuid('away_selection_id').notNull(),
    /** '1' | 'X' | '2' | 'cancelled' (JackpotGameResult), null until known. */
    result: text('result').$type<'1' | 'X' | '2' | 'cancelled'>(),
    resultedAt: timestamp('resulted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'jackpot_games_pk', columns: [t.roundId, t.position] }),
    uniqueIndex('jackpot_games_round_event_uq').on(t.roundId, t.eventId),
    index('jackpot_games_event_idx').on(t.eventId),
    index('jackpot_games_market_idx').on(t.marketId),
    check('jackpot_games_position', sql`${t.position} >= 0`),
    check(
      'jackpot_games_result',
      sql`${t.result} IS NULL OR ${t.result} IN ('1', 'X', '2', 'cancelled')`,
    ),
    check('jackpot_games_resulted_at', sql`(${t.result} IS NULL) = (${t.resultedAt} IS NULL)`),
  ],
);

/**
 * A player's entry in a round: one array of picks per game (in game
 * order, each a non-empty set of '1' / 'X' / '2' in that order), priced at
 * combinations × the round's cost per combination and paid with a
 * `jackpot_entry` ledger transaction (key `jackpot_entry:<userId>:<key>`)
 * in the same transaction. Settlement records the correct distribution
 * (`correct[k]` = combinations with exactly k correct, decimal strings) and
 * the prize: gross = net + tax, paid by a `jackpot_prize` transaction (key
 * `jackpot_prize:<entryId>`); a void round refunds the cost (`jackpot_entry`
 * reversal, key `jackpot_refund:<entryId>`), with a prize of 0.
 */
export const jackpotEntries = pgTable(
  'jackpot_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => jackpotRounds.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Outcome1X2[][] in canonical order. */
    picks: jsonb('picks').$type<Array<Array<'1' | 'X' | '2'>>>().notNull(),
    combinations: integer('combinations').notNull(),
    cost: bigint('cost', { mode: 'bigint' }).notNull(),
    channel: betChannel('channel').notNull().default('web'),
    /** The client's idempotency key, unique per player. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: jackpotEntryStatus('status').notNull().default('open'),
    /** The correct distribution once settled (won / lost), decimal strings. */
    correct: jsonb('correct').$type<string[]>(),
    /** The most correct predictions of any combination, once settled (won / lost). */
    bestCorrect: integer('best_correct'),
    /** The prize (0 when lost or void), set at settlement: gross = net + tax. */
    prizeGross: bigint('prize_gross', { mode: 'bigint' }),
    prizeTax: bigint('prize_tax', { mode: 'bigint' }),
    prizeNet: bigint('prize_net', { mode: 'bigint' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jackpot_entries_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('jackpot_entries_user_placed_idx').on(t.userId, t.placedAt, t.id),
    index('jackpot_entries_round_status_idx').on(t.roundId, t.status),
    // Dashboard windows (entries placed, entries settled).
    index('jackpot_entries_placed_idx').on(t.placedAt),
    index('jackpot_entries_settled_idx')
      .on(t.settledAt)
      .where(sql`${t.settledAt} IS NOT NULL`),
    check('jackpot_entries_cost_positive', sql`${t.cost} > 0`),
    check('jackpot_entries_combinations', sql`${t.combinations} >= 1`),
    check('jackpot_entries_settled_at', sql`(${t.status} = 'open') = (${t.settledAt} IS NULL)`),
    check(
      'jackpot_entries_prize',
      sql`(${t.status} = 'open' AND ${t.prizeGross} IS NULL AND ${t.prizeTax} IS NULL AND ${t.prizeNet} IS NULL) OR (${t.status} <> 'open' AND ${t.prizeTax} >= 0 AND ${t.prizeNet} >= 0 AND ${t.prizeGross} = ${t.prizeNet} + ${t.prizeTax})`,
    ),
    check(
      'jackpot_entries_prize_status',
      sql`(${t.status} <> 'won' OR ${t.prizeGross} > 0) AND (${t.status} NOT IN ('lost', 'void') OR ${t.prizeGross} = 0)`,
    ),
    check(
      'jackpot_entries_correct',
      sql`(${t.status} IN ('won', 'lost')) = (${t.correct} IS NOT NULL AND ${t.bestCorrect} IS NOT NULL)`,
    ),
  ],
);
