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
 * - cashed_out: closed early by a cash-out (Phase 7): final; carries the
 *   cash-out's gross, tax and net in settled_* (see bet_cashouts).
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
  // A shop ticket cancelled before its first kick-off: the stake went back (phase 3).
  'cancelled',
]);

/** OddsChangePolicy in @vamos/core. */
export const oddsChangePolicy = pgEnum('odds_change_policy', ['none', 'higher', 'any']);

// `shop`: a ticket sold at a shop's counter (docs/plans/agent-shops.md phase 3).
export const betChannel = pgEnum('bet_channel', ['web', 'sms', 'ussd', 'shop']);

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
    /**
     * Set while settled (won / lost / void; null when open again after a
     * correction) and for a cash-out (its gross, tax and net).
     */
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
    /**
     * Set while a result correction is blocked (its reversal would take the
     * player's cash below zero): the earliest time the settlement sweep tries
     * the bet again. Cleared once settlement goes through.
     */
    settlementRetryAt: timestamp('settlement_retry_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bets_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('bets_user_placed_idx').on(t.userId, t.placedAt, t.id),
    // Back-office bet search and dashboard (all players, by placement time).
    index('bets_placed_idx').on(t.placedAt, t.id),
    // Open liabilities and the risk views.
    index('bets_open_idx')
      .on(t.placedAt)
      .where(sql`${t.status} IN ('open', 'pending_acceptance')`),
    index('bets_pending_accept_idx')
      .on(t.acceptAfter)
      .where(sql`${t.status} = 'pending_acceptance'`),
    index('bets_settlement_retry_idx')
      .on(t.settlementRetryAt)
      .where(sql`${t.settlementRetryAt} IS NOT NULL`),
    check('bets_stake_positive', sql`${t.stake} > 0`),
    check('bets_total_odds_valid', sql`${t.totalOddsMilli} >= 1001`),
    check(
      'bets_potential_non_negative',
      sql`${t.potentialGrossPayout} >= 0 AND ${t.potentialBonus} >= 0 AND ${t.potentialTax} >= 0 AND ${t.potentialNetPayout} >= 0`,
    ),
    check('bets_settlement_version_non_negative', sql`${t.settlementVersion} >= 0`),
    check(
      'bets_settled_amounts',
      sql`(${t.status} NOT IN ('won', 'lost', 'void', 'cashed_out') OR (${t.settledGrossPayout} IS NOT NULL AND ${t.settledTax} IS NOT NULL AND ${t.settledNetPayout} IS NOT NULL AND ${t.settledAt} IS NOT NULL)) AND (${t.status} NOT IN ('pending_acceptance', 'open', 'rejected') OR (${t.settledGrossPayout} IS NULL AND ${t.settledTax} IS NULL AND ${t.settledNetPayout} IS NULL))`,
    ),
    check(
      'bets_settled_non_negative',
      sql`${t.settledNetPayout} >= 0 AND ${t.settledTax} >= 0 AND ${t.settledGrossPayout} >= 0`,
    ),
    check(
      'bets_cashed_out_amounts',
      sql`${t.status} <> 'cashed_out' OR (${t.settledGrossPayout} > 0 AND ${t.settledGrossPayout} = ${t.settledNetPayout} + ${t.settledTax})`,
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
    index('bet_legs_market_idx').on(t.marketId),
    check('bet_legs_odds_valid', sql`${t.oddsMilli} BETWEEN 1001 AND 1000000`),
    check('bet_legs_requested_odds_valid', sql`${t.requestedOddsMilli} BETWEEN 1001 AND 1000000`),
    check('bet_legs_position_non_negative', sql`${t.position} >= 0`),
  ],
);

/** One leg as a cash-out priced it (bet_cashouts.legs). */
export interface CashOutLegJson {
  legId: string;
  selectionId: string;
  /** The leg's state for pricing: its selection's result, else open. */
  state: 'open' | 'won' | 'lost' | 'void';
  placedOddsMilli: number;
  /** The live odds of an open leg (null when not bettable); null for decided legs. */
  currentOddsMilli: number | null;
}

/**
 * The record of a cash-out (Phase 7): one row per cashed-out bet, written in
 * the transaction that posts its `bet_cashout` ledger transaction (key
 * `cashout:<betId>`) and moves the bet to `cashed_out`. It keeps what the
 * player accepted (`quoted_gross`), what was paid, and the inputs the offer
 * was priced from, for support and disputes. Append-only; a bet only becomes
 * cashed out with this row and its posting in place, and stays final
 * (triggers in migration 0013_phase7_cashout_guards).
 */
export const betCashouts = pgTable(
  'bet_cashouts',
  {
    betId: uuid('bet_id')
      .primaryKey()
      .references(() => bets.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The client's Idempotency-Key, unique per player. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The gross offer the player accepted (sent by the client). */
    quotedGross: bigint('quoted_gross', { mode: 'bigint' }).notNull(),
    /** The fresh offer paid: gross = net + tax. */
    gross: bigint('gross', { mode: 'bigint' }).notNull(),
    tax: bigint('tax', { mode: 'bigint' }).notNull(),
    net: bigint('net', { mode: 'bigint' }).notNull(),
    /** The cash-out margin in force (settings `cash_out`). */
    marginBps: integer('margin_bps').notNull(),
    /** CashOutLegJson[], in leg order. */
    legs: jsonb('legs').$type<CashOutLegJson[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('bet_cashouts_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    check(
      'bet_cashouts_amounts',
      sql`${t.gross} > 0 AND ${t.tax} >= 0 AND ${t.net} >= 0 AND ${t.gross} = ${t.net} + ${t.tax}`,
    ),
    // Never pays less than the player accepted.
    check(
      'bet_cashouts_quote_honoured',
      sql`${t.quotedGross} > 0 AND ${t.gross} >= ${t.quotedGross}`,
    ),
    check('bet_cashouts_margin_valid', sql`${t.marginBps} BETWEEN 0 AND 10000`),
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
    /**
     * The stake a visitor chose (docs/plans/guest-slips-and-staff.md, GS3: a slip ID to pay at a
     * shop), santim; null for a shared slip without one. The shop fills it in; it is not money yet.
     */
    stake: bigint('stake', { mode: 'bigint' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('booking_codes_expires_idx').on(t.expiresAt),
    check('booking_codes_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
    check('booking_codes_stake_positive', sql`${t.stake} IS NULL OR ${t.stake} > 0`),
  ],
);
