/**
 * Outbox event types written by the payment services. Aggregate type
 * 'payment_intent' for deposits and 'payout' for withdrawals; payload money
 * values are santim strings (enqueueOutbox makes bigint JSON-safe).
 */

/** A deposit was credited. Payload { intentId, userId, provider, amount, providerRef }. */
export const DEPOSIT_SUCCEEDED = 'payment.deposit_succeeded';
/**
 * The provider declined a deposit, or staff closed a flagged one. Payload
 * { intentId, userId, provider, amount, reason }.
 */
export const DEPOSIT_FAILED = 'payment.deposit_failed';
/**
 * A provider event could not be applied automatically (amount or currency
 * mismatch, success after failure, failure after success); nothing was
 * credited and the intent waits for staff (resolveFlaggedDeposit). Payload
 * { intentId, userId, provider, reason, amount, reportedAmount,
 * reportedCurrency, providerEventId }.
 */
export const DEPOSIT_FLAGGED = 'payment.deposit_flagged';

/**
 * A withdrawal was requested; the hold is taken. Payload { payoutId, userId,
 * provider, amount, status (approved when auto-approved, else requested),
 * reviewReason }.
 */
export const WITHDRAWAL_REQUESTED = 'payment.withdrawal_requested';
/**
 * A withdrawal was approved (automatically or by staff): the payout
 * worker's cue. Payload { payoutId, userId, provider, amount, approvedBy }.
 */
export const WITHDRAWAL_APPROVED = 'payment.withdrawal_approved';
/** Staff rejected a withdrawal; the hold went back. Payload { payoutId, userId, amount, reason }. */
export const WITHDRAWAL_REJECTED = 'payment.withdrawal_rejected';
/** The player cancelled a withdrawal before it was sent; the hold went back. Payload { payoutId, userId, amount }. */
export const WITHDRAWAL_CANCELLED = 'payment.withdrawal_cancelled';
/** The provider paid the withdrawal out. Payload { payoutId, userId, provider, amount, providerRef }. */
export const WITHDRAWAL_PAID = 'payment.withdrawal_paid';
/** The payout failed; the hold went back to the player. Payload { payoutId, userId, amount, reason }. */
export const WITHDRAWAL_FAILED = 'payment.withdrawal_failed';
/**
 * A payout needs staff (see PayoutFlagReason): the worker stopped touching
 * it. Payload { payoutId, userId, provider, amount, status, reason, … the
 * reported details }.
 */
export const WITHDRAWAL_FLAGGED = 'payment.withdrawal_flagged';
