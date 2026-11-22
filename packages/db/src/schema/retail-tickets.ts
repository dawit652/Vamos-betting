import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './accounts';
import { bets } from './betting';
import { cashierShifts, cashierShops } from './cashier';
import { agents } from './retail';

/**
 * Tickets sold at a shop's counter (docs/plans/agent-shops.md phase 3). A ticket is a bet of the
 * agent's counter bettor (`agents.counter_user_id`): its legs, odds, terms, status and settlement
 * live in `bets`; this row says where it was sold and by whom, and its life at the shop. The
 * ticket's number and barcode are the bet's short id. Never deleted.
 *
 * status: sold (the stake left the agent's balance, or entered HQ's retail cash), cancelled (before
 * its first kick-off; the stake went back). Phase 4 adds paid and expired.
 */
export const retailTicketStatus = pgEnum('retail_ticket_status', [
  'sold',
  'cancelled',
  // Phase 4: paid to its holder at the shop that sold it; or not paid in time.
  'paid',
  'expired',
]);

export const retailTickets = pgTable(
  'retail_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id')
      .notNull()
      .references(() => bets.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => cashierShops.id, { onDelete: 'restrict' }),
    /** The cashier who sold it. */
    staffId: uuid('staff_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    /** The cashier's shift: its expected cash counts the ticket. */
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => cashierShifts.id, { onDelete: 'restrict' }),
    /** The customer's phone when they gave it (optional: a ticket pays whoever holds it). */
    customerPhone: text('customer_phone'),
    /**
     * The booking code the player brought (docs/plans/counter-codes-and-deposit-recovery.md, G2),
     * printed on the ticket; null when the ticket was not built from one. Not an identifier: one
     * code can be bought many times, and the barcode (the bet's short id) is what pays.
     */
    bookingCode: text('booking_code'),
    /**
     * The payout code printed on the customer's ticket at sale (docs/plans/
     * counter-codes-and-deposit-recovery.md, G3), kept only as `<salt hex>:<sha256 hex>`; null for a
     * ticket sold before the code existed, or one HQ waived it for. Paying asks for it.
     */
    payoutCodeHash: text('payout_code_hash'),
    /** Wrong codes since the last unlock; PAYOUT_CODE_ATTEMPTS of them lock the ticket. */
    payoutCodeAttempts: integer('payout_code_attempts').notNull().default(0),
    /** Locked by wrong codes until HQ unlocks it; null when not locked. */
    payoutCodeLockedAt: timestamp('payout_code_locked_at', { withTimezone: true }),
    stake: bigint('stake', { mode: 'bigint' }).notNull(),
    status: retailTicketStatus('status').notNull().default('sold'),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    /** The original's first print; later prints are counted copies. */
    originalPrintedAt: timestamp('original_printed_at', { withTimezone: true }),
    reprints: integer('reprints').notNull().default(0),
    /** Paid to its holder (phase 4): when, by whom, in which shift, how much and the posting. */
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    paidShiftId: uuid('paid_shift_id').references(() => cashierShifts.id, { onDelete: 'restrict' }),
    paidAmount: bigint('paid_amount', { mode: 'bigint' }),
    payoutTransactionId: uuid('payout_transaction_id'),
    /** The desk's key of the payout: the same key again answers with the same payout. */
    payoutIdempotencyKey: text('payout_idempotency_key'),
    /** Above the agent's HQ limit a payout waits for an admin (four eyes against the asker). */
    approvalRequestedAt: timestamp('approval_requested_at', { withTimezone: true }),
    approvalRequestedBy: uuid('approval_requested_by').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    /** Not paid within the agent's expiry days after its last match. */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('retail_tickets_bet_uq').on(t.betId),
    index('retail_tickets_shift_idx').on(t.shiftId),
    index('retail_tickets_agent_sold_idx').on(t.agentId, t.soldAt),
    index('retail_tickets_shop_sold_idx').on(t.shopId, t.soldAt),
    // The live monitor (phase 5): every shop's newest tickets and the day's counters.
    index('retail_tickets_sold_at_idx').on(t.soldAt),
    index('retail_tickets_cancelled_at_idx')
      .on(t.cancelledAt)
      .where(sql`${t.cancelledAt} IS NOT NULL`),
    index('retail_tickets_paid_at_idx')
      .on(t.paidAt)
      .where(sql`${t.paidAt} IS NOT NULL`),
    check('retail_tickets_stake_positive', sql`${t.stake} > 0`),
    check('retail_tickets_reprints_non_negative', sql`${t.reprints} >= 0`),
    check('retail_tickets_payout_attempts_non_negative', sql`${t.payoutCodeAttempts} >= 0`),
    // New enum values are compared as text: they cannot be used in the migration that adds them.
    check(
      'retail_tickets_paid',
      sql`(${t.status}::text = 'paid') = (${t.paidAt} IS NOT NULL AND ${t.paidBy} IS NOT NULL AND ${t.paidShiftId} IS NOT NULL AND ${t.paidAmount} IS NOT NULL AND ${t.payoutTransactionId} IS NOT NULL)`,
    ),
    check('retail_tickets_paid_amount', sql`${t.paidAmount} IS NULL OR ${t.paidAmount} > 0`),
    check(
      'retail_tickets_expired',
      sql`(${t.status}::text = 'expired') = (${t.expiredAt} IS NOT NULL)`,
    ),
    check(
      'retail_tickets_approval_four_eyes',
      sql`${t.approvedBy} IS NULL OR ${t.approvalRequestedBy} IS NULL OR ${t.approvedBy} <> ${t.approvalRequestedBy}`,
    ),
    uniqueIndex('retail_tickets_payout_key_uq')
      .on(t.payoutIdempotencyKey)
      .where(sql`${t.payoutIdempotencyKey} IS NOT NULL`),
    index('retail_tickets_approval_idx')
      .on(t.approvalRequestedAt)
      .where(sql`${t.approvalRequestedAt} IS NOT NULL AND ${t.approvedAt} IS NULL`),
    check(
      'retail_tickets_cancelled',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledBy} IS NOT NULL)`,
    ),
  ],
);
