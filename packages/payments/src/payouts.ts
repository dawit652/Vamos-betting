import {
  PaymentProviderError,
  PayoutNotFoundError,
  ProviderNotConfiguredError,
  ProviderRequestError,
} from './errors';
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
 * reported `failed` when we are certain no money left:
 * - the provider says so for this payout (a status query, or a synchronous
 *   answer to the submission);
 * - or the provider explicitly refused (HTTP 4xx other than 429) the very
 *   first submission (attempt 1), or the adapter refused it before sending
 *   anything (not configured, not a mobile number).
 * Anything that leaves open whether money left is `unknown`: an answer we
 * cannot read (any 2xx that is not a clear acceptance), a timeout, a network
 * error or a 5xx from a provider we can ask later, or a refusal of a
 * resubmission (it may be a duplicate of one that went through). The hold is
 * kept, the provider is asked about the payout again, and staff decide once
 * the retry budget runs out.
 *
 * From the second attempt on, an earlier attempt may have reached the
 * provider, so the provider is asked first (queryPayout under the payout's
 * reference) and the payout is sent again only when the provider clearly has
 * nothing under that reference (PayoutNotFoundError); the payout id is the
 * provider's idempotency reference, so even then it cannot pay twice.
 * `retry` means nothing was learned and nothing can have moved (429, a status
 * query that got no answer, or a timeout of a provider whose payouts cannot
 * be looked up before it answers): try again later.
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
  /**
   * payouts.provider_ref: the reference the provider knows (or will know) the
   * payout by: stored before the first submission when the provider fixes it
   * in advance (PaymentProvider.payoutReference), else from its answer.
   */
  providerRef: string | null;
  /**
   * payouts.attempts, counting this attempt: 1 = it was never handed to the
   * provider before; more = an earlier attempt may have reached it.
   */
  attempts: number;
}

/**
 * - paid: the provider confirmed the payout;
 * - failed: it failed and no money left; the hold can go back to the player;
 * - pending: the provider has it and has not finished; look again later;
 * - retry: nothing was learned; send or check again later;
 * - unknown: whether money left cannot be told yet; keep the hold, ask the
 *   provider again later (by `providerRef`), staff decide in the end.
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
 * What a failed submission means. `reference` is the reference the payout
 * was sent under, when known before the answer (null: the provider names
 * payouts only in its answer, so the payout cannot be looked up yet).
 */
function submissionError(
  error: PaymentProviderError,
  attempts: number,
  reference: string | null,
): PayoutAttemptResult {
  const first = attempts === 1;
  const detail = describe(error);
  const ambiguous = (): PayoutAttemptResult =>
    // No answer, or one we cannot read: it may have gone through. Ask about it
    // later; a provider we cannot ask is sent the same payout id again.
    reference !== null
      ? { outcome: 'unknown', providerRef: reference, error: detail }
      : { outcome: 'retry', providerRef: null, error: detail };
  const refusal = (reason: string): PayoutAttemptResult =>
    first
      ? { outcome: 'failed', providerRef: reference, reason, raw: { error: detail } }
      : // An earlier attempt may have reached the provider (this may be a duplicate).
        { outcome: 'unknown', providerRef: reference, error: detail };

  if (error instanceof ProviderRequestError) {
    const status = error.status;
    if (status !== null && status >= 200 && status < 300) {
      // A 2xx whose body is not a clear acceptance: the transfer may be out.
      return { outcome: 'unknown', providerRef: reference, error: detail };
    }
    if (status === 429) return { outcome: 'retry', providerRef: reference, error: detail };
    if (status !== null && status >= 400 && status < 500) return refusal('refused_by_provider');
    return ambiguous();
  }
  if (error instanceof ProviderNotConfiguredError) return refusal('provider_not_configured');
  // A plain adapter error: refused before anything was sent, unless it says to retry.
  return error.retryable ? ambiguous() : refusal('refused_by_provider');
}

/**
 * Sends the payout or, when an earlier attempt may have reached the provider,
 * first asks about it (see above). `provider` is undefined when the payout's
 * provider is no longer enabled (registry.get returned nothing). Errors other
 * than PaymentProviderError (bugs) are thrown.
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
    return input.attempts === 1
      ? {
          outcome: 'failed',
          providerRef: input.providerRef,
          reason: 'provider_not_enabled',
          raw: { error },
        }
      : { outcome: 'unknown', providerRef: input.providerRef, error };
  }
  const reference = input.providerRef ?? provider.payoutReference?.(input.payoutId) ?? null;

  if (input.attempts > 1 && reference !== null) {
    let status: ProviderStatusResult | null = null;
    try {
      status = await provider.queryPayout(reference);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      if (!(error instanceof PayoutNotFoundError)) {
        // Asking never moves money; a refusal to answer will not go away by itself.
        return error.retryable
          ? { outcome: 'retry', providerRef: reference, error: describe(error) }
          : { outcome: 'unknown', providerRef: reference, error: describe(error) };
      }
      // The provider has nothing under this reference: sending it is safe.
    }
    if (status !== null) {
      if (status.amount !== null && status.amount !== input.amount) {
        return {
          outcome: 'unknown',
          providerRef: reference,
          error: `provider reports amount ${status.amount} for a payout of ${input.amount}`,
        };
      }
      return fromStatus(reference, status.status, status.raw, 'failed_at_provider');
    }
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
    return submissionError(error, input.attempts, reference);
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
