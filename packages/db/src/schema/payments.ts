import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
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
    /** The paying number (E.164): the player's registered phone. */
    phone: text('phone').notNull(),
    status: paymentIntentStatus('status').notNull().default('created'),
    /** The provider's reference (DepositInitiation.providerRef); unique per provider. */
    providerRef: text('provider_ref'),
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
    check('payment_intents_amount_positive', sql`${t.amount} > 0`),
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
