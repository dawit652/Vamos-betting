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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { adminUsers, users } from './accounts';
import { paymentIntents, payouts } from './payments';

/**
 * SMS deposit rail (ported from Melabingo). Players transfer an exact amount
 * to a collection account; the collection handset forwards the confirmation
 * SMS, which is matched to the deposit by that amount.
 *
 * received_sms status:
 * - unparsed: no parser could read it (new message shape: add a fixture);
 * - unmatched: a credit that matches no open deposit (late, round amount,
 *   unknown payer), or whose deposit was already credited;
 * - ambiguous: it fits two open deposits (staff choose);
 * - matched: it credited `matched_intent_id`;
 * - flagged: it matched a deposit that was flagged instead of credited
 *   (another amount, a third-party payer): see the intent's flag;
 * - ignored_debit: money leaving a collection account that proposes no payout;
 * - settlement_proposed: an outgoing transfer that looks like it paid
 *   `proposed_payout_id` (staff confirm when settling);
 * - settled: the evidence of a settled manual payout;
 * - credited_by_staff: staff credited it to a player by hand;
 * - closed: staff closed it without crediting (with a note).
 */
export const SMS_STATUSES = [
  'unparsed',
  'unmatched',
  'ambiguous',
  'matched',
  'flagged',
  'ignored_debit',
  'settlement_proposed',
  'settled',
  'credited_by_staff',
  'closed',
] as const;

export const receivedSms = pgTable(
  'received_sms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * gateway: forwarded by the collection handset; simulator: the dev SMS
     * simulator (demo only); receipt: a player pasted a reference the
     * handset never forwarded and the institution's receipt page confirmed it.
     */
    source: text('source').notNull(),
    /** The SMS sender address as forwarded ("telebirr", "CBE"). */
    sender: text('sender'),
    /** The message as received (receipt rows: a summary of the receipt). */
    rawText: text('raw_text').notNull(),
    /** sha256 of sender and text: a forwarder's retries are the same message. */
    textHash: text('text_hash').notNull(),
    /** Parsed fields (null when unparsed). */
    institution: text('institution'),
    direction: text('direction'),
    amount: bigint('amount', { mode: 'bigint' }),
    /** The institution's transaction reference; unique (one SMS, one use). */
    reference: text('reference'),
    counterpartyName: text('counterparty_name'),
    counterpartyPhone: text('counterparty_phone'),
    /** The collection account's balance after this transaction, as reported. */
    balance: bigint('balance', { mode: 'bigint' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    /** When the api received it (our clock: the matching and audit clock). */
    /** The collection account (SMS_COLLECTION_ACCOUNTS id) the message arrived on; null: not known. */
    collectionAccount: text('collection_account'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** When the handset says it received it (informational). */
    deviceReceivedAt: timestamp('device_received_at', { withTimezone: true }),
    status: text('status').notNull(),
    /** Why it did not credit (the matcher's reason), or a staff note. */
    statusReason: text('status_reason'),
    matchedIntentId: uuid('matched_intent_id').references((): AnyPgColumn => paymentIntents.id, {
      onDelete: 'restrict',
    }),
    /**
     * The deposit it matched when that deposit was flagged instead of
     * credited (status `flagged`); staff then credit the SMS by hand and
     * `matched_intent_id` names the deposit that was credited.
     */
    flaggedIntentId: uuid('flagged_intent_id').references((): AnyPgColumn => paymentIntents.id, {
      onDelete: 'restrict',
    }),
    matchedUserId: uuid('matched_user_id').references(() => users.id, { onDelete: 'restrict' }),
    proposedPayoutId: uuid('proposed_payout_id').references((): AnyPgColumn => payouts.id, {
      onDelete: 'restrict',
    }),
    /**
     * Receipt verification (RECEIPT_VERIFY): verified | rejected |
     * indeterminate | skipped. `rejected` on a credited message is the
     * forgery alarm: it stays credited (no automatic reversal) and waits for
     * staff at the top of the review queue.
     */
    receiptStatus: text('receipt_status'),
    receiptReason: text('receipt_reason'),
    receiptCheckedAt: timestamp('receipt_checked_at', { withTimezone: true }),
    receiptAttempts: integer('receipt_attempts').notNull().default(0),
    receiptReceiver: text('receipt_receiver'),
    receiptPayer: text('receipt_payer'),
    /** The first 4 KB the institution served (the next fixture is written from it). */
    receiptRaw: text('receipt_raw'),
    /** Staff who resolved it (credited, closed or acknowledged a receipt alarm). */
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('received_sms_text_hash_uq').on(t.textHash),
    uniqueIndex('received_sms_reference_uq')
      .on(t.reference)
      .where(sql`${t.reference} IS NOT NULL`),
    uniqueIndex('received_sms_matched_intent_uq')
      .on(t.matchedIntentId)
      .where(sql`${t.matchedIntentId} IS NOT NULL`),
    uniqueIndex('received_sms_proposed_payout_uq')
      .on(t.proposedPayoutId)
      .where(sql`${t.proposedPayoutId} IS NOT NULL`),
    index('received_sms_received_idx').on(t.receivedAt),
    index('received_sms_review_idx')
      .on(t.receivedAt)
      .where(
        sql`${t.resolvedAt} IS NULL AND (${t.status} IN ('unparsed', 'unmatched', 'ambiguous', 'flagged') OR ${t.receiptStatus} = 'rejected')`,
      ),
    index('received_sms_balance_chain_idx')
      .on(t.institution, t.receivedAt)
      .where(sql`${t.balance} IS NOT NULL`),
    index('received_sms_receipt_due_idx')
      .on(t.receivedAt)
      .where(sql`${t.receiptStatus} IS NULL AND ${t.status} = 'matched'`),
    check('received_sms_source', sql`${t.source} IN ('gateway', 'simulator', 'receipt')`),
    check(
      'received_sms_status',
      sql`${t.status} IN ('unparsed', 'unmatched', 'ambiguous', 'matched', 'flagged', 'ignored_debit', 'settlement_proposed', 'settled', 'credited_by_staff', 'closed')`,
    ),
    check(
      'received_sms_direction',
      sql`${t.direction} IS NULL OR ${t.direction} IN ('credit', 'debit')`,
    ),
    check('received_sms_amount_positive', sql`${t.amount} IS NULL OR ${t.amount} > 0`),
    check(
      'received_sms_parsed',
      sql`(${t.status} = 'unparsed') = (${t.reference} IS NULL) AND (${t.reference} IS NULL) = (${t.amount} IS NULL) AND (${t.reference} IS NULL) = (${t.direction} IS NULL)`,
    ),
    check(
      'received_sms_receipt_status',
      sql`${t.receiptStatus} IS NULL OR ${t.receiptStatus} IN ('verified', 'rejected', 'indeterminate', 'skipped')`,
    ),
    // Only an inbound message can credit a deposit.
    check(
      'received_sms_credit_only_credits',
      sql`${t.matchedIntentId} IS NULL OR ${t.direction} = 'credit'`,
    ),
    check(
      'received_sms_debit_only_proposes',
      sql`${t.proposedPayoutId} IS NULL OR ${t.direction} = 'debit'`,
    ),
    check('received_sms_raw_length', sql`length(${t.rawText}) <= 4000`),
  ],
);

/**
 * Where a player's manual (SMS rail) payouts may go. A withdrawal names one
 * of these, never a typed account. Payouts only go to the player:
 * - a wallet must be the player's registered phone (verified at sign-up, so
 *   it is verified at once);
 * - a bank account must carry the player's KYC name, is confirmed by an OTP
 *   to the registered phone, and the operator confirms the bank shows that
 *   name as the holder before sending.
 */
export const payoutAccounts = pgTable(
  'payout_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Institution id (core INSTITUTIONS). */
    institution: text('institution').notNull(),
    /** E.164 for a wallet, the cleaned account number for a bank. */
    account: text('account').notNull(),
    /** The account holder's name as the player typed it (matches the KYC name). */
    accountName: text('account_name').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('payout_accounts_user_account_uq')
      .on(t.userId, t.institution, t.account)
      .where(sql`${t.removedAt} IS NULL`),
    index('payout_accounts_user_idx').on(t.userId, t.createdAt),
  ],
);

export const collectionAccountStatus = pgEnum('collection_account_status', [
  'pending',
  'active',
  'rejected',
  'deleted',
]);

/**
 * The SMS rail's collection accounts (where players send deposits), managed in the back office.
 * An admin adds one (pending); a second person approves it before any player is shown it, or
 * rejects it (four eyes: a new account sends player money somewhere new). Its institution and
 * number never change, since deposits, SMS and the handset's forwarder name it by `account_id`;
 * the holder name and hint may. Deleting stops new deposits on it at once, while SMS, receipts and
 * open deposits on it still count for a week (@vamos/db loadRailAccounts). Rows are never removed.
 * SMS_COLLECTION_ACCOUNTS fills an empty table once (created_by null).
 */
export const collectionAccounts = pgTable(
  'collection_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The rail's id of the account (`<institution>:<number>`): deposits and SMS carry it. */
    accountId: text('account_id').notNull(),
    institution: text('institution').notNull(),
    /** The number players send to: a wallet's phone number or a bank account number. */
    account: text('account').notNull(),
    /** The holder's name as players see it (licensed: the operator's legal name). */
    name: text('name').notNull(),
    hint: text('hint'),
    status: collectionAccountStatus('status').notNull().default('pending'),
    /** Who added it (null: filled from SMS_COLLECTION_ACCOUNTS). */
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** The second person, who approved or rejected it. */
    decidedBy: uuid('decided_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // One live row per account: by id, and by institution and number (one account, one space of
    // exact amounts).
    uniqueIndex('collection_accounts_account_id_uq')
      .on(t.accountId)
      .where(sql`${t.status} IN ('pending', 'active')`),
    uniqueIndex('collection_accounts_number_uq')
      .on(t.institution, t.account)
      .where(sql`${t.status} IN ('pending', 'active')`),
    check(
      'collection_accounts_four_eyes',
      sql`${t.decidedBy} IS NULL OR ${t.createdBy} IS NULL OR ${t.decidedBy} <> ${t.createdBy}`,
    ),
    check(
      'collection_accounts_decided',
      sql`${t.status} NOT IN ('active', 'rejected') OR ${t.createdBy} IS NULL OR ${t.decidedAt} IS NOT NULL`,
    ),
    check(
      'collection_accounts_pending',
      sql`${t.status} <> 'pending' OR (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    check(
      'collection_accounts_deleted',
      sql`(${t.status} = 'deleted') = (${t.deletedAt} IS NOT NULL)`,
    ),
  ],
);
