import { PaymentProviderError, ProviderNotConfiguredError } from './errors';
import type {
  PaymentEventKind,
  PaymentProvider,
  ProviderPaymentStatus,
  ProviderStatusResult,
  VerifiedWebhookEvent,
} from './types';

/**
 * One payout attempt of the payout worker, and what its result means for the
 * money. The danger is a double payout: returning the hold to the player
 * (`markPayoutFailed`) while the provider still pays. So a payout is only
 * reported `failed` when no money can have left:
 * - the provider says so for this payout (a status query, or a synchronous
 *   answer to the submission);
 * - or the provider refused the very first submission (attempt 1), or the
 *   adapter refused it before sending anything (not configured).
 * Anything that leaves it open whether an earlier submission went through is
 * `unknown`, and staff decide. Timeouts, network errors, 429 and 5xx are
 * `retry`: the payout id is the provider's idempotency reference, so sending
 * the same payout again cannot pay twice.
 */

/** The payout as the worker holds it after `markPayoutProcessing` (a payouts row). */
export interface PayoutAttemptInput {
  payoutId: string;
  /** Santim. */
  amount: bigint;
  /** payouts.phone: the player's own registered number. */
  phone: string;
  /** payouts.recipient_name: the player's KYC-verified name. */
  recipientName: string;
  /** payouts.provider_ref: set once the provider accepted a submission. */
  providerRef: string | null;
  /** payouts.attempts, counting this attempt (1 = the first time it is sent). */
  attempts: number;
}

/**
 * - paid: the provider confirmed the payout;
 * - failed: it failed and no money left; the hold can go back to the player;
 * - pending: the provider has it and has not finished; look again later;
 * - retry: nothing was learned; send or check again later;
 * - unknown: whether money left cannot be told; staff must check.
 */
export type PayoutAttemptResult =
  | { outcome: 'paid'; providerRef: string; raw: unknown }
  | { outcome: 'failed'; providerRef: string | null; reason: string; raw: unknown }
  | { outcome: 'pending'; providerRef: string; raw: unknown }
  | { outcome: 'retry'; providerRef: string | null; error: string }
  | { outcome: 'unknown'; providerRef: string | null; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function fromStatus(
  providerRef: string,
  status: ProviderPaymentStatus,
  raw: unknown,
  failureReason: string,
): PayoutAttemptResult {
  switch (status) {
    case 'succeeded':
      return { outcome: 'paid', providerRef, raw };
    case 'failed':
      return { outcome: 'failed', providerRef, reason: failureReason, raw };
    case 'pending':
      return { outcome: 'pending', providerRef, raw };
  }
}

/**
 * Sends the payout (no provider reference yet) or asks for its status (a
 * reference is known: it is never sent again). `provider` is undefined when
 * the payout's provider is no longer enabled (registry.get returned
 * nothing). Errors other than PaymentProviderError (bugs) are thrown.
 */
export async function attemptPayout(
  provider: PaymentProvider | undefined,
  input: PayoutAttemptInput,
): Promise<PayoutAttemptResult> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new RangeError('attemptPayout: attempts must count this attempt (>= 1)');
  }
  if (provider === undefined) {
    const error = 'the payout provider is not enabled';
    return input.attempts === 1 && input.providerRef === null
      ? { outcome: 'failed', providerRef: null, reason: 'provider_not_enabled', raw: { error } }
      : { outcome: 'unknown', providerRef: input.providerRef, error };
  }
  if (input.providerRef !== null) {
    const providerRef = input.providerRef;
    let status: ProviderStatusResult;
    try {
      status = await provider.queryPayout(providerRef);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      // Asking never moves money; a refusal to answer will not go away by itself.
      return error.retryable
        ? { outcome: 'retry', providerRef, error: describe(error) }
        : { outcome: 'unknown', providerRef, error: describe(error) };
    }
    if (status.amount !== null && status.amount !== input.amount) {
      return {
        outcome: 'unknown',
        providerRef,
        error: `provider reports amount ${status.amount} for a payout of ${input.amount}`,
      };
    }
    return fromStatus(providerRef, status.status, status.raw, 'failed_at_provider');
  }

  try {
    const result = await provider.initiatePayout({
      payoutId: input.payoutId,
      amount: input.amount,
      phone: input.phone,
      name: input.recipientName,
    });
    return fromStatus(result.providerRef, result.status, result.raw ?? null, 'failed_at_provider');
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    if (error.retryable) return { outcome: 'retry', providerRef: null, error: describe(error) };
    if (input.attempts === 1) {
      // Refused the first time it was ever sent (or not sendable at all): nothing left.
      const reason =
        error instanceof ProviderNotConfiguredError
          ? 'provider_not_configured'
          : 'refused_by_provider';
      return { outcome: 'failed', providerRef: null, reason, raw: { error: describe(error) } };
    }
    // An earlier attempt may have reached the provider (this refusal may be a duplicate).
    return { outcome: 'unknown', providerRef: null, error: describe(error) };
  }
}

const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 6 * 60 * 60_000;

/**
 * How long to wait before looking at a payout again after attempt number
 * `attempts` (1, 2, 4, 8 … minutes, at most 6 hours). Use it for the
 * `checkAt` of markPayoutProcessing and the `retryAt` of applyPayoutAttempt.
 */
export function payoutRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('payoutRetryDelayMs: attempts must be a positive integer');
  }
  // 2^9 minutes already exceeds the cap; avoid huge exponents.
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10), RETRY_CAP_MS);
}

/**
 * A status-query result as a provider event, for pollers that feed
 * applyDepositEvent / applyPayoutEvent. The id is stable per (kind, status,
 * reference): polling the same status again is a harmless duplicate, and a
 * webhook and a poll that both report success still credit once (the
 * intent's status decides).
 */
export function eventFromStatusQuery(
  kind: PaymentEventKind,
  result: ProviderStatusResult,
): VerifiedWebhookEvent {
  return {
    providerEventId: `query:${kind}:${result.status}:${result.providerRef}`,
    kind,
    providerRef: result.providerRef,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    raw: result.raw,
  };
}
