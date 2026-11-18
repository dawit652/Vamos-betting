import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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
import { adminUsers, users } from './accounts';
import { paymentIntents, payouts } from './payments';

/**
 * Cashier desk (owner, 17 Nov 2026; docs/plans/cashier-dashboard.md). Staff in a betting shop take
 * cash deposits for players and pay cash withdrawals, during a shift that opens with a counted
 * float and closes with a cash count, and print a receipt for every operation.
 *
 * Cash is a payment provider named `cash`: a cash deposit is a payment intent of provider `cash`
 * credited at once (its ledger posting is the ordinary deposit, `house:psp:cash` -amount, player
 * cash +amount), a cash withdrawal an ordinary payout of provider `cash` paid at the desk. So
 * deposit limits, AML, the player's history, notifications and reconciliation treat cash like any
 * other provider. These tables add what only the desk knows: the shop, the shift and the receipt.
 */

export const cashShiftStatus = pgEnum('cash_shift_status', ['open', 'closed']);
export const cashOperationKind = pgEnum('cash_operation_kind', ['deposit', 'withdrawal']);

/** A betting shop: its receipt header and its desk parameters. */
export const cashierShops = pgTable(
  'cashier_shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short stable name (receipts, reports). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    /** Receipt paper width in millimetres (thermal printers: 80 or 58). */
    receiptWidthMm: integer('receipt_width_mm').notNull().default(80),
    /**
     * Above this amount (santim) a cashier may not take a deposit or pay a withdrawal alone: a
     * supervisor (finance or admin) does it. Default ETB 10,000.
     */
    approvalThreshold: bigint('approval_threshold', { mode: 'bigint' })
      .notNull()
      .default(sql`1000000`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cashier_shops_code_uq').on(t.code),
    check('cashier_shops_code_format', sql`${t.code} ~ '^[a-z0-9-]{2,32}$'`),
    check('cashier_shops_receipt_width', sql`${t.receiptWidthMm} IN (58, 80)`),
    check('cashier_shops_threshold_positive', sql`${t.approvalThreshold} > 0`),
  ],
);

/**
 * One staff member's time at a shop's desk. Expected cash = opening float + deposits − withdrawals
 * of the shift; the close stores the count and the expected figure (the difference is the
 * variance, reviewed by finance).
 */
export const cashierShifts = pgTable(
  'cashier_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => cashierShops.id, { onDelete: 'restrict' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    status: cashShiftStatus('status').notNull().default('open'),
    /** Cash counted into the drawer when the shift opened (santim). */
    openingFloat: bigint('opening_float', { mode: 'bigint' }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Cash counted at the close (santim). */
    countedCash: bigint('counted_cash', { mode: 'bigint' }),
    /** Opening float + deposits − withdrawals of the shift, fixed at the close (santim). */
    expectedCash: bigint('expected_cash', { mode: 'bigint' }),
    closeNote: text('close_note'),
  },
  (t) => [
    // A staff member works one desk at a time.
    uniqueIndex('cashier_shifts_open_staff_uq')
      .on(t.staffId)
      .where(sql`${t.status} = 'open'`),
    index('cashier_shifts_shop_opened_idx').on(t.shopId, t.openedAt),
    check('cashier_shifts_float_non_negative', sql`${t.openingFloat} >= 0`),
    check(
      'cashier_shifts_count_non_negative',
      sql`${t.countedCash} IS NULL OR ${t.countedCash} >= 0`,
    ),
    check(
      'cashier_shifts_closed',
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL AND ${t.countedCash} IS NOT NULL AND ${t.expectedCash} IS NOT NULL)`,
    ),
  ],
);

/** Every cash operation at a desk: its receipt. The money moved through the intent or payout. */
export const cashOperations = pgTable(
  'cash_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The receipt number printed on the receipt. */
    receiptNo: bigserial('receipt_no', { mode: 'number' }).notNull(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => cashierShifts.id, { onDelete: 'restrict' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => cashierShops.id, { onDelete: 'restrict' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: cashOperationKind('kind').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    /** Deposits: the `cash` payment intent credited by this operation. */
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntents.id, {
      onDelete: 'restrict',
    }),
    /** Withdrawals: the `cash` payout paid by this operation. */
    payoutId: uuid('payout_id').references(() => payouts.id, { onDelete: 'restrict' }),
    /** The desk's key for this operation (one per receipt): a replay returns the same receipt. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Times the receipt was printed after the first print (reprints say COPY). */
    reprints: integer('reprints').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('cash_operations_receipt_no_uq').on(t.receiptNo),
    uniqueIndex('cash_operations_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('cash_operations_intent_uq')
      .on(t.paymentIntentId)
      .where(sql`${t.paymentIntentId} IS NOT NULL`),
    uniqueIndex('cash_operations_payout_uq')
      .on(t.payoutId)
      .where(sql`${t.payoutId} IS NOT NULL`),
    index('cash_operations_shift_idx').on(t.shiftId, t.createdAt),
    index('cash_operations_user_idx').on(t.userId, t.createdAt),
    check('cash_operations_amount_positive', sql`${t.amount} > 0`),
    check('cash_operations_reprints_non_negative', sql`${t.reprints} >= 0`),
    check(
      'cash_operations_money_row',
      sql`(${t.kind} = 'deposit' AND ${t.paymentIntentId} IS NOT NULL AND ${t.payoutId} IS NULL) OR (${t.kind} = 'withdrawal' AND ${t.payoutId} IS NOT NULL AND ${t.paymentIntentId} IS NULL)`,
    ),
  ],
);

/**
 * One-time codes a player makes on their own phone to withdraw cash at a shop's desk (the cashier
 * never learns a PIN). Only an HMAC of the code is stored; a newer code retires the older ones; a
 * code dies after its expiry, its use, or too many wrong tries (attempts are counted in their own
 * transaction, so a failed withdrawal cannot hide them).
 */
export const cashWithdrawalCodes = pgTable(
  'cash_withdrawal_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('cash_withdrawal_codes_user_idx').on(t.userId, t.createdAt),
    check('cash_withdrawal_codes_attempts', sql`${t.attempts} >= 0`),
  ],
);
