import { domainBadRequest } from '../errors';
import type { paymentIntents, payouts } from '../schema/payments';

export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentIntentStatus = PaymentIntent['status'];
export type Payout = typeof payouts.$inferSelect;
export type PayoutStatus = Payout['status'];

/** Payout statuses that still hold the player's money (house_withdrawals_pending). */
export const OPEN_PAYOUT_STATUSES = ['requested', 'approved', 'processing'] as const;
/** Payout statuses whose hold went back to the player. */
export const REVERSED_PAYOUT_STATUSES = ['failed', 'rejected', 'cancelled'] as const;

/**
 * A verified provider notification or status-query result. Structurally the
 * same as VerifiedWebhookEvent in @vamos/payments (this package does not
 * depend on it).
 */
export interface ProviderEventInput {
  /** Unique per provider; a redelivery carries the same id. */
  providerEventId: string;
  /** Defaults to what the function handles; a mismatch is refused. */
  kind?: 'deposit' | 'payout';
  providerRef: string;
  status: 'succeeded' | 'failed' | 'pending';
  /** Santim, when reported. */
  amount: bigint | null;
  currency: string | null;
  /** Stored in payment_events.payload (bigint/Date made JSON-safe). */
  raw?: unknown;
}

/** DepositInitiation in @vamos/payments. */
export interface DepositInitiationInput {
  kind: 'push' | 'redirect' | 'ussd';
  providerRef: string;
  redirectUrl?: string;
  instructions?: string;
}

const PROVIDER_RE = /^[a-z0-9_-]{2,32}$/;

/** 400 `invalid_provider` unless `provider` is a valid provider name. */
export function assertProviderName(provider: string): void {
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) {
    throw domainBadRequest('invalid_provider', 'Unknown payment provider.');
  }
}

/** RangeError unless `amount` is a positive bigint (callers validate input first). */
export function assertAmount(amount: unknown, label: string): asserts amount is bigint {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new RangeError(`${label} must be a positive bigint santim amount`);
  }
}
