import type { Santim } from '@vamos/core';

/**
 * Provider-neutral payment types. Amounts are bigint santim; each adapter
 * converts to and from the provider's own format (birr decimal strings).
 */

export const PAYMENT_PROVIDER_NAMES = [
  'mock',
  'chapa',
  'telebirr',
  'cbebirr',
  'mpesa-et',
  'sms',
] as const;

export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

export function isPaymentProviderName(value: string): value is PaymentProviderName {
  return (PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * How the player completes a deposit:
 * - push: a payment prompt on the player's phone (STK/USSD push, or the dev
 *   phone simulator for the mock provider);
 * - redirect: open `redirectUrl` (hosted checkout) and come back to `returnUrl`;
 * - ussd: dial the code in `instructions`;
 * - transfer: send the exact amount to a collection account (SMS rail).
 */
export type DepositInitiationKind = 'push' | 'redirect' | 'ussd' | 'transfer';

/** A status reported by a provider (webhook or status query). */
export type ProviderPaymentStatus = 'succeeded' | 'failed' | 'pending';

export interface InitiateDepositInput {
  /** Our payment_intents.id (a UUID). Providers use it to derive their order reference. */
  intentId: string;
  /** Santim, > 0. */
  amount: Santim;
  /** The payer's mobile number in E.164 (+2519…/+2517…). */
  phone: string;
  /** Where the provider sends its webhook (see `paymentWebhookUrl`). */
  callbackUrl: string;
  /** Where a redirect checkout sends the player back to. */
  returnUrl: string;
  /**
   * When our intent expires (payment_intents.expires_at). Providers that can
   * close an unpaid order themselves are asked to do so by then (telebirr
   * timeout_express), so a player cannot pay long after the deposit limit
   * stopped counting the intent.
   */
  expiresAt?: Date;
}

export interface DepositInitiation {
  kind: DepositInitiationKind;
  /**
   * The provider's reference for this deposit, unique per provider. Webhooks
   * and status queries name the deposit by it (payment_intents.provider_ref).
   */
  providerRef: string;
  /** kind = 'redirect': the hosted checkout page. */
  redirectUrl?: string;
  /** Plain-English instructions to show the player (kind = 'push' or 'ussd'). */
  instructions?: string;
}

/** The raw HTTP request of a webhook, exactly as received (do not re-serialise the body). */
export interface WebhookInput {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  rawBody: string | Uint8Array;
}

/** What a webhook is about. */
export type PaymentEventKind = 'deposit' | 'payout';

/** A webhook whose signature checked out, normalised. */
export interface VerifiedWebhookEvent {
  /**
   * Identifies this notification at the provider; a redelivery carries the
   * same id. Unique per provider (payment_events.provider_event_id).
   */
  providerEventId: string;
  kind: PaymentEventKind;
  /** DepositInitiation.providerRef or PayoutInitiation.providerRef. */
  providerRef: string;
  status: ProviderPaymentStatus;
  /** Santim, when the notification states the amount. */
  amount: Santim | null;
  /** ISO 4217 code as sent by the provider (Vamos only accepts 'ETB'). */
  currency: string | null;
  /** The parsed payload, for the payment_events audit row. */
  raw: unknown;
}

/** The result of a status query (queryDeposit / queryPayout). */
export interface ProviderStatusResult {
  providerRef: string;
  status: ProviderPaymentStatus;
  amount: Santim | null;
  currency: string | null;
  raw: unknown;
}

export interface InitiatePayoutInput {
  /**
   * Our payouts.id. Providers use it as the idempotent transfer reference, so
   * submitting the same payout again (after a timeout) never pays twice.
   */
  payoutId: string;
  /** Santim, > 0. */
  amount: Santim;
  /** The player's own registered mobile number in E.164. */
  phone: string;
  /** The account holder's name (the player's KYC-verified name). */
  name: string;
}

export interface PayoutInitiation {
  providerRef: string;
  /** 'pending' = accepted, final status follows by webhook or queryPayout. */
  status: ProviderPaymentStatus;
  raw?: unknown;
}

/** What a provider can be used for (the wallet pages list methods by these). */
export interface ProviderCapabilities {
  deposits: boolean;
  /** false: initiatePayout / queryPayout throw ProviderNotConfiguredError. */
  payouts: boolean;
  /**
   * The SMS rail: deposits are confirmed by forwarded SMS (no status
   * queries) and payouts are sent by hand by an operator (manual payouts:
   * the payout worker never takes them).
   */
  manual?: boolean;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly capabilities: ProviderCapabilities;
  /**
   * Starts a deposit. Calling it again for the same intentId does not
   * create a second charge. Throws PaymentProviderError (see `retryable`).
   */
  initiateDeposit(input: InitiateDepositInput): Promise<DepositInitiation>;
  /**
   * Checks the webhook's signature (constant-time) and parses it. Throws
   * WebhookVerificationError for a missing or bad signature, a stale
   * timestamp or a malformed payload; never returns an unverified event.
   * Providers whose documentation asks for it (Chapa, telebirr) also confirm the
   * outcome with their status endpoint first, and then throw a retryable
   * ProviderRequestError when it cannot be reached: answer 503 so the
   * provider delivers the webhook again.
   */
  verifyWebhook(input: WebhookInput): Promise<VerifiedWebhookEvent>;
  /** Asks the provider for the status of a deposit. */
  queryDeposit(providerRef: string): Promise<ProviderStatusResult>;
  /**
   * The reference the provider will know a payout by, when it is fixed
   * before the payout is sent (Chapa: our payout id). The payout worker
   * stores it before sending, so webhooks and status queries find the payout
   * even when the answer to the submission is lost. Providers that only
   * name a payout in their answer leave it out.
   */
  payoutReference?(payoutId: string): string;
  /**
   * Sends money to the player's own wallet. The payout id is the provider's
   * idempotency reference: submitting the same payout again never pays twice.
   * Prefer `attemptPayout`, which decides what an error means for the money.
   * Anything that happened on the wire is a ProviderRequestError (with the
   * HTTP status, or null when no answer arrived); a plain
   * PaymentProviderError or ProviderNotConfiguredError means the adapter
   * refused before sending anything.
   */
  initiatePayout(input: InitiatePayoutInput): Promise<PayoutInitiation>;
  /**
   * Asks the provider for the status of a payout. Throws PayoutNotFoundError
   * when the provider positively reports it has no payout under `providerRef`.
   */
  queryPayout(providerRef: string): Promise<ProviderStatusResult>;
}

/** Outside-world dependencies of the adapters (tests inject fakes). */
export interface ProviderDeps {
  fetch: typeof globalThis.fetch;
  clock: () => Date;
  /** Cryptographically secure random bytes (request nonces). */
  randomBytes: (size: number) => Uint8Array;
  /** Per-request timeout in milliseconds (default 15 s). */
  timeoutMs?: number;
}
