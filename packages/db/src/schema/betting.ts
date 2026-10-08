import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { users } from './accounts';
import { selections } from './catalog';

export const betType = pgEnum('bet_type', ['single', 'multi']);

/**
 * - pending_acceptance: has a live leg; waits `live_bet_delay_ms` before it is
 *   accepted (→ open) or rejected (→ rejected, stake refunded).
 * - open: accepted, not settled yet.
 * - won / lost / void: settled (void = every leg void, stake refunded).
 * - cashed_out: closed early by a cash-out (Phase 7).
 * - rejected: refused after the live delay, stake refunded.
 */
export const betStatus = pgEnum('bet_status', [
  'pending_acceptance',
  'open',
  'won',
  'lost',
  'void',
  'cashed_out',
  'rejected',
]);

/** OddsChangePolicy in @vamos/core. */
export const oddsChangePolicy = pgEnum('odds_change_policy', ['none', 'higher', 'any']);

export const betChannel = pgEnum('bet_channel', ['web', 'sms', 'ussd']);

/** LegState in @vamos/core. */
export const betLegState = pgEnum('bet_leg_state', ['open', 'won', 'lost', 'void']);

/**
 * The pricing terms a bet was placed under (business settings at placement,
 * santim as decimal strings). Settlement, re-settlement after a correction
 * and live acceptance always use these, never the settings of the day.
 */
export interface BetTermsJson {
  betRules: Record<string, unknown>;
  multiBonus: Record<string, unknown>;
  tax: Record<string, unknown>;
}

export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** BET_SHORT_ID_LENGTH symbols of CODE_ALPHABET, shown to the player and support. */
    shortId: text('short_id').notNull().unique(),
    betType: betType('bet_type').notNull(),
    stake: bigint('stake', { mode: 'bigint' }).notNull(),
    /** Product of the accepted leg odds (milli, rounded down). */
    totalOddsMilli: bigint('total_odds_milli', { mode: 'bigint' }).notNull(),
    /** The quote at acceptance: gross payout (return + bonus, capped), bonus, tax and net. */
    potentialGrossPayout: bigint('potential_gross_payout', { mode: 'bigint' }).notNull(),
    potentialBonus: bigint('potential_bonus', { mode: 'bigint' }).notNull(),
    potentialTax: bigint('potential_tax', { mode: 'bigint' }).notNull(),
    potentialNetPayout: bigint('potential_net_payout', { mode: 'bigint' }).notNull(),
    bonusPercentBps: integer('bonus_percent_bps').notNull().default(0),
    status: betStatus('status').notNull(),
    oddsChangePolicy: oddsChangePolicy('odds_change_policy').notNull(),
    channel: betChannel('channel').notNull().default('web'),
    /** The client's idempotency key, unique per player. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** BetTermsJson. */
    terms: jsonb('terms').$type<BetTermsJson>().notNull(),
    /** Number of settlement reversals so far; keys the next settle:/reverse: posting. */
    settlementVersion: integer('settlement_version').notNull().default(0),
    /** Set while settled (won / lost / void); null when open again after a correction. */
    settledGrossPayout: bigint('settled_gross_payout', { mode: 'bigint' }),
    settledTax: bigint('settled_tax', { mode: 'bigint' }),
    settledNetPayout: bigint('settled_net_payout', { mode: 'bigint' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    /** pending_acceptance only: the earliest time the bet may be accepted. */
    acceptAfter: timestamp('accept_after', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** Why a pending bet was rejected ('selection_unavailable', 'odds_changed', …). */
    rejectReason: text('reject_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bets_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('bets_user_placed_idx').on(t.userId, t.placedAt, t.id),
    index('bets_pending_accept_idx')
      .on(t.acceptAfter)
      .where(sql`${t.status} = 'pending_acceptance'`),
    check('bets_stake_positive', sql`${t.stake} > 0`),
    check('bets_total_odds_valid', sql`${t.totalOddsMilli} >= 1001`),
    check(
      'bets_potential_non_negative',
      sql`${t.potentialGrossPayout} >= 0 AND ${t.potentialBonus} >= 0 AND ${t.potentialTax} >= 0 AND ${t.potentialNetPayout} >= 0`,
    ),
    check('bets_settlement_version_non_negative', sql`${t.settlementVersion} >= 0`),
    check(
      'bets_settled_amounts',
      sql`(${t.status} NOT IN ('won', 'lost', 'void') OR (${t.settledGrossPayout} IS NOT NULL AND ${t.settledTax} IS NOT NULL AND ${t.settledNetPayout} IS NOT NULL AND ${t.settledAt} IS NOT NULL)) AND (${t.status} NOT IN ('pending_acceptance', 'open', 'rejected') OR (${t.settledGrossPayout} IS NULL AND ${t.settledTax} IS NULL AND ${t.settledNetPayout} IS NULL))`,
    ),
    check(
      'bets_settled_non_negative',
      sql`${t.settledNetPayout} >= 0 AND ${t.settledTax} >= 0 AND ${t.settledGrossPayout} >= 0`,
    ),
    check(
      'bets_pending_accept_after',
      sql`${t.status} <> 'pending_acceptance' OR ${t.acceptAfter} IS NOT NULL`,
    ),
  ],
);

/**
 * One selection of a bet. `event_id` and `market_id` are copies of the
 * selection's market and event, kept without foreign keys on purpose: a
 * foreign-key check takes FOR KEY SHARE on the referenced row, which would
 * wait for the live simulator's and resulting's FOR UPDATE on events/markets
 * while bet placement holds selections FOR SHARE, i.e. a lock-order deadlock.
 * The selection's own foreign key keeps the catalogue row from being deleted.
 */
export const betLegs = pgTable(
  'bet_legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id')
      .notNull()
      .references(() => bets.id, { onDelete: 'restrict' }),
    /** 0-based order on the slip. */
    position: integer('position').notNull(),
    eventId: uuid('event_id').notNull(),
    marketId: uuid('market_id').notNull(),
    selectionId: uuid('selection_id')
      .notNull()
      .references(() => selections.id, { onDelete: 'restrict' }),
    /** The odds the leg is priced at (accepted under the odds-change policy). */
    oddsMilli: integer('odds_milli').notNull(),
    /** The odds the client sent with the slip. */
    requestedOddsMilli: integer('requested_odds_milli').notNull(),
    /** The event was live at placement (the bet needed delayed acceptance). */
    isLive: boolean('is_live').notNull(),
    state: betLegState('state').notNull().default('open'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bet_legs_bet_selection_uq').on(t.betId, t.selectionId),
    uniqueIndex('bet_legs_bet_position_uq').on(t.betId, t.position),
    index('bet_legs_selection_idx').on(t.selectionId),
    index('bet_legs_event_idx').on(t.eventId),
    check('bet_legs_odds_valid', sql`${t.oddsMilli} BETWEEN 1001 AND 1000000`),
    check('bet_legs_requested_odds_valid', sql`${t.requestedOddsMilli} BETWEEN 1001 AND 1000000`),
    check('bet_legs_position_non_negative', sql`${t.position} >= 0`),
  ],
);

/** A shareable betslip (Betika-style booking code). */
export const bookingCodes = pgTable(
  'booking_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** BOOKING_CODE_LENGTH symbols of CODE_ALPHABET. */
    code: text('code').notNull().unique(),
    legs: jsonb('legs').$type<Array<{ selectionId: string }>>().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('booking_codes_expires_idx').on(t.expiresAt),
    check('booking_codes_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
