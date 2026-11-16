import { sql } from 'drizzle-orm';
import {
  bigint,
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { payoutAccounts, receivedSms } from './smsrail';

/**
 * Deposit intent lifecycle:
 * - created: the row exists; the provider has not been asked yet (or the
 *   call is in flight);
 * - pending: the provider accepted it and the player is paying;
 * - succeeded: a verified provider event confirmed it and the player's cash
 *   account was credited (exactly once);
 * - failed: the provider declined it, or initiating it failed;
 * - expired: not completed within the TTL. A late verified success still
 *   credits an expired intent (the money did move).
 */
export const paymentIntentStatus = pgEnum('payment_intent_status', [
  'created',
  'pending',
  'succeeded',
  'failed',
  'expired',
]);

/**
 * Withdrawal (payout) lifecycle. The amount leaves the player's cash account
 * when the payout is requested (held in house_withdrawals_pending):
 * - requested: waiting for manual review (at or above the auto-approval
 *   threshold, or the player is under an exclusion);
 * - approved: by staff or automatically; waiting for the payout worker;
 * - processing: submitted to the provider;
 * - paid: the provider confirmed it (terminal);
 * - failed: the provider refused it, or it ran out of attempts; the hold is
 *   returned to the player (terminal);
 * - rejected: refused in review; the hold is returned (terminal);
 * - cancelled: withdrawn by the player before it was sent; the hold is
 *   returned (terminal).
 * A flagged payout (flag_reason) waits for staff whatever its status.
 */
export const payoutStatus = pgEnum('payout_status', [
  'requested',
  'approved',
  'processing',
  'paid',
  'failed',
  'rejected',
  'cancelled',
]);

export const depositInitiationKind = pgEnum('deposit_initiation_kind', [
  'push',
  'redirect',
  'ussd',
  'transfer',
]);

export const paymentEventKind = pgEnum('payment_event_kind', ['deposit', 'payout']);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Provider name; the ledger's rule for PSP clearing accounts (^[a-z0-9_-]{2,32}$). */
    provider: text('provider').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('ETB'),
    /**
     * SMS rail: the amount the player asked to deposit. `amount` is then the
     * exact amount they were told to send (requested + 1–99 santim, unique
     * among open SMS deposits: the santim are the payment reference). Null
     * for other providers.
     */
    requestedAmount: bigint('requested_amount', { mode: 'bigint' }),
    /** The paying number (E.164): the player's registered phone. */
    phone: text('phone').notNull(),
    status: paymentIntentStatus('status').notNull().default('created'),
    /** The provider's reference (DepositInitiation.providerRef); unique per provider. */
    providerRef: text('provider_ref'),
    /**
     * SMS rail: the collection account (SMS_COLLECTION_ACCOUNTS id) the player was told to pay.
     * Each account has its own space of exact amounts. Null: a deposit from before accounts were
     * recorded (an SMS on any account can still pay it).
     */
    collectionAccount: text('collection_account'),
    initiationKind: depositInitiationKind('initiation_kind'),
    redirectUrl: text('redirect_url'),
    instructions: text('instructions'),
    /** The client's idempotency key, unique per player. */
    idempotencyKey: text('idempotency_key').notNull(),
    failureReason: text('failure_reason'),
    /**
     * Set when a provider event cannot be applied automatically (amount or
     * currency mismatch, success after a failure…): nothing is credited, the
     * intent ignores further events and waits for the back office
     * (resolveFlaggedDeposit clears it). Flagged intents never expire.
     */
    flagReason: text('flag_reason'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    /** The `deposit` ledger transaction, once credited. */
    ledgerTransactionId: uuid('ledger_transaction_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * The deposit reconciliation's next status query (null = as soon as it
     * is old enough); pushed back after each answer that settles nothing.
     */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('payment_intents_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    uniqueIndex('payment_intents_provider_ref_uq').on(t.provider, t.providerRef),
    index('payment_intents_user_created_idx').on(t.userId, t.createdAt),
    // Dashboard: deposits that succeeded in a window.
    index('payment_intents_succeeded_idx')
      .on(t.completedAt)
      .where(sql`${t.status} = 'succeeded'`),
    index('payment_intents_open_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} IN ('created', 'pending') AND ${t.flaggedAt} IS NULL`),
    index('payment_intents_flagged_idx')
      .on(t.flaggedAt)
      .where(sql`${t.flaggedAt} IS NOT NULL`),
    index('payment_intents_poll_idx')
      .on(t.nextPollAt)
      .where(
        sql`${t.status} IN ('pending', 'expired') AND ${t.flaggedAt} IS NULL AND ${t.providerRef} IS NOT NULL`,
      ),
    // SMS rail: the exact amount is the payment reference, so no two open
    // SMS deposits may share one (allocateSmsAmount also keeps it reserved
    // for a while after expiry; this is the backstop).
    // One exact amount per collection account (null counts as one account of its own).
    uniqueIndex('payment_intents_sms_amount_open_uq')
      .on(sql`coalesce(${t.collectionAccount}, '')`, t.amount)
      .where(sql`${t.provider} = 'sms' AND ${t.status} IN ('created', 'pending')`),
    index('payment_intents_sms_open_idx')
      .on(t.amount)
      .where(sql`${t.provider} = 'sms' AND ${t.status} IN ('created', 'pending', 'expired')`),
    check('payment_intents_amount_positive', sql`${t.amount} > 0`),
    check(
      'payment_intents_requested_amount',
      sql`${t.requestedAmount} IS NULL OR (${t.requestedAmount} > 0 AND ${t.requestedAmount} <= ${t.amount})`,
    ),
    check('payment_intents_provider_name', sql`${t.provider} ~ '^[a-z0-9_-]{2,32}$'`),
    check(
      'payment_intents_succeeded_ledger',
      sql`(${t.status} = 'succeeded') = (${t.ledgerTransactionId} IS NOT NULL)`,
    ),
    check('payment_intents_flag', sql`(${t.flagReason} IS NULL) = (${t.flaggedAt} IS NULL)`),
  ],
);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('ETB'),
    /** The player's own registered phone (E.164); payouts never go anywhere else. */
    phone: text('phone').notNull(),
    /** The player's KYC-verified name, sent to the provider as the account holder. */
    recipientName: text('recipient_name').notNull(),
    status: payoutStatus('status').notNull(),
    /** Why the payout needs review, or why it was rejected. */
    reviewReason: text('review_reason'),
    /** 'system:auto' for automatic approval, else the admin user id. */
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Admin user id (rejected) or the player's id (cancelled). */
    closedBy: text('closed_by'),
    /**
     * The provider's reference; unique per provider. Stored before the first
     * submission when the provider fixes it in advance (Chapa: the payout id),
     * else from its answer (PayoutInitiation.providerRef).
     */
    providerRef: text('provider_ref'),
    /**
     * Times the payout worker took the payout (to send it or ask about it).
     * Each claim counts one; a result is applied only by the claim that is
     * still current (applyPayoutAttempt `attempt`).
     */
    attempts: integer('attempts').notNull().default(0),
    /**
     * Consecutive attempts that got no answer (timeouts, unreadable answers,
     * errors); reset by any real answer and when staff clear a flag. The
     * payout is flagged once it reaches settings.payments.payoutMaxAttempts.
     */
    unansweredAttempts: integer('unanswered_attempts').notNull().default(0),
    /** approved / processing: the payout worker's next look at it (null = now). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    failureReason: text('failure_reason'),
    /**
     * Set when staff must look before anything else happens:
     * `ambiguous_result` (the provider's answer leaves open whether money
     * left), `attempts_exhausted` (retries ran out without an answer),
     * `pending_too_long` (the provider has kept it pending for too long),
     * `staff_review` (staff took it over) or `provider_conflict` (a provider
     * event contradicts the payout). The
     * payout worker skips flagged payouts; a provider event that settles the
     * payout, or the back office (markPayoutPaid / markPayoutFailed /
     * clearPayoutFlag), clears it.
     */
    flagReason: text('flag_reason'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    /** The client's idempotency key, unique per player. */
    idempotencyKey: text('idempotency_key').notNull(),
    holdLedgerTransactionId: uuid('hold_ledger_transaction_id').notNull(),
    /**
     * Paid by hand by an operator (SMS rail) rather than by a provider API:
     * the payout worker never takes it, staff claim and settle it
     * (claimManualPayout / settleManualPayout) under the four-eyes rule.
     */
    manual: boolean('manual').notNull().default(false),
    /** Manual payouts: the saved payout account it goes to. */
    payoutAccountId: uuid('payout_account_id').references((): AnyPgColumn => payoutAccounts.id, {
      onDelete: 'restrict',
    }),
    /**
     * Manual payouts: the destination as the player authorised it, copied at
     * request time so a later edit of the account cannot redirect it.
     */
    destinationInstitution: text('destination_institution'),
    destinationAccount: text('destination_account'),
    destinationName: text('destination_name'),
    /** Manual payouts: the operator who claimed it to send the money (processing). */
    payingBy: text('paying_by'),
    /** Manual payouts: the operator who recorded it as paid (never the approver). */
    settledBy: text('settled_by'),
    /** Manual payouts: the institution's reference of the transfer that paid it. */
    settlementReference: text('settlement_reference'),
    /** Manual payouts: the outgoing confirmation SMS that evidences it, when there is one. */
    settlementSmsId: uuid('settlement_sms_id').references((): AnyPgColumn => receivedSms.id, {
      onDelete: 'restrict',
    }),
    /**
     * Manual bank payouts: the settler confirmed the bank showed the player's
     * own name as the account holder before sending.
     */
    holderNameConfirmed: boolean('holder_name_confirmed').notNull().default(false),
    /** paid: the posting that moved the hold to the provider's clearing account. */
    paidLedgerTransactionId: uuid('paid_ledger_transaction_id'),
    /** failed / rejected / cancelled: the posting that returned the hold. */
    reversalLedgerTransactionId: uuid('reversal_ledger_transaction_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    processingAt: timestamp('processing_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('payouts_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    uniqueIndex('payouts_provider_ref_uq').on(t.provider, t.providerRef),
    index('payouts_user_requested_idx').on(t.userId, t.requestedAt),
    // Back office: every withdrawal, newest first.
    index('payouts_requested_idx').on(t.requestedAt, t.id),
    // Dashboard: withdrawals paid in a window.
    index('payouts_paid_idx')
      .on(t.completedAt)
      .where(sql`${t.status} = 'paid'`),
    index('payouts_review_idx')
      .on(t.requestedAt)
      .where(sql`${t.status} = 'requested'`),
    index('payouts_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('approved', 'processing') AND ${t.flaggedAt} IS NULL`),
    index('payouts_flagged_idx')
      .on(t.flaggedAt)
      .where(sql`${t.flaggedAt} IS NOT NULL`),
    check('payouts_amount_positive', sql`${t.amount} > 0`),
    check('payouts_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('payouts_unanswered_attempts_non_negative', sql`${t.unansweredAttempts} >= 0`),
    check('payouts_provider_name', sql`${t.provider} ~ '^[a-z0-9_-]{2,32}$'`),
    check(
      'payouts_paid_ledger',
      sql`(${t.status} = 'paid') = (${t.paidLedgerTransactionId} IS NOT NULL)`,
    ),
    check(
      'payouts_reversal_ledger',
      sql`(${t.status} IN ('failed', 'rejected', 'cancelled')) = (${t.reversalLedgerTransactionId} IS NOT NULL)`,
    ),
    check(
      'payouts_approved',
      sql`${t.status} IN ('requested', 'rejected', 'cancelled') OR ${t.approvedAt} IS NOT NULL`,
    ),
    check('payouts_flag', sql`(${t.flagReason} IS NULL) = (${t.flaggedAt} IS NULL)`),
    // Manual payouts: the person who approved it never pays it.
    check(
      'payouts_manual_four_eyes',
      sql`(${t.payingBy} IS NULL OR ${t.approvedBy} IS NULL OR ${t.payingBy} <> ${t.approvedBy}) AND (${t.settledBy} IS NULL OR ${t.approvedBy} IS NULL OR ${t.settledBy} <> ${t.approvedBy})`,
    ),
    check(
      'payouts_manual_destination',
      sql`NOT ${t.manual} OR (${t.destinationInstitution} IS NOT NULL AND ${t.destinationAccount} IS NOT NULL AND ${t.payoutAccountId} IS NOT NULL)`,
    ),
    check(
      'payouts_manual_paid',
      sql`NOT ${t.manual} OR ${t.status} <> 'paid' OR (${t.settledBy} IS NOT NULL AND ${t.settlementReference} IS NOT NULL)`,
    ),
    check(
      'payouts_manual_processing',
      sql`NOT ${t.manual} OR (${t.status} = 'processing') = (${t.payingBy} IS NOT NULL)`,
    ),
    // One transfer reference settles one payout.
    uniqueIndex('payouts_settlement_reference_uq')
      .on(t.settlementReference)
      .where(sql`${t.settlementReference} IS NOT NULL`),
    index('payouts_manual_queue_idx')
      .on(t.approvedAt)
      .where(sql`${t.manual} AND ${t.status} IN ('approved', 'processing')`),
  ],
);

/**
 * Every verified provider notification, recorded once: the unique
 * (provider, provider_event_id) makes webhook redeliveries no-ops.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    kind: paymentEventKind('kind').notNull(),
    providerRef: text('provider_ref').notNull(),
    /** succeeded | failed | pending, as reported. */
    status: text('status').notNull(),
    amount: bigint('amount', { mode: 'bigint' }),
    currency: text('currency'),
    intentId: uuid('intent_id').references(() => paymentIntents.id, { onDelete: 'restrict' }),
    payoutId: uuid('payout_id').references(() => payouts.id, { onDelete: 'restrict' }),
    /** What applying it did (credited, flagged, duplicate_status, unknown_reference…). */
    outcome: text('outcome').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('payment_events_provider_event_uq').on(t.provider, t.providerEventId),
    index('payment_events_intent_idx').on(t.intentId),
    index('payment_events_payout_idx').on(t.payoutId),
    check('payment_events_target', sql`${t.intentId} IS NULL OR ${t.payoutId} IS NULL`),
  ],
);
