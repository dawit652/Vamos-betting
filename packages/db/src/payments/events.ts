/**
 * Outbox event types written by the payment services. Aggregate type
 * 'payment_intent' for deposits and 'payout' for withdrawals; payload money
 * values are santim strings.
 */

/** A deposit was credited. Payload { intentId, userId, provider, amount, providerRef }. */
export const DEPOSIT_SUCCEEDED = 'payment.deposit_succeeded';
/** The provider declined a deposit. Payload { intentId, userId, provider, amount, reason }. */
export const DEPOSIT_FAILED = 'payment.deposit_failed';
/**
 * A provider event could not be applied automatically (amount or currency
 * mismatch, success after failure, failure after success); nothing was
 * credited. Payload { intentId, userId, provider, reason, amount, reportedAmount, reportedCurrency, providerEventId }.
 */
export const DEPOSIT_FLAGGED = 'payment.deposit_flagged';

/** A withdrawal was requested (status approved when auto-approved, else requested). */
export const WITHDRAWAL_REQUESTED = 'payment.withdrawal_requested';
/** A withdrawal was approved (automatically or by staff): the payout worker's cue. */
export const WITHDRAWAL_APPROVED = 'payment.withdrawal_approved';
/** Staff rejected a withdrawal; the hold went back to the player. */
export const WITHDRAWAL_REJECTED = 'payment.withdrawal_rejected';
/** The player cancelled a withdrawal before it was processed; the hold went back. */
export const WITHDRAWAL_CANCELLED = 'payment.withdrawal_cancelled';
/** The provider paid the withdrawal out. */
export const WITHDRAWAL_PAID = 'payment.withdrawal_paid';
/** The payout failed; the hold went back to the player. */
export const WITHDRAWAL_FAILED = 'payment.withdrawal_failed';
/**
 * A provider event contradicts the payout's state (paid after it was
 * reversed, failed after it was paid, another amount); needs the back office.
 */
export const WITHDRAWAL_CONFLICT = 'payment.withdrawal_conflict';
