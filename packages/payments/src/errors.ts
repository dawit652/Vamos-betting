/** Base class of every error the payment adapters throw. */
export class PaymentProviderError extends Error {
  readonly provider: string;
  /**
   * true when the same call may be repeated safely (a timeout, a network
   * error, HTTP 429 or 5xx). Deposits and payouts carry our own reference, so
   * a retry never creates a second charge or transfer at the provider.
   */
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaymentProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The provider cannot be used: credentials are missing, or the adapter is a
 * skeleton waiting for merchant documents (CBE Birr, M-Pesa), or the
 * operation is not part of the merchant agreement (telebirr payouts).
 */
export class ProviderNotConfiguredError extends PaymentProviderError {
  /** Environment variables that are missing, when that is the reason. */
  readonly missing: readonly string[];

  constructor(provider: string, message: string, missing: readonly string[] = []) {
    super(provider, message);
    this.name = 'ProviderNotConfiguredError';
    this.missing = missing;
  }
}

export type WebhookRejection =
  'missing_signature' | 'bad_signature' | 'stale_timestamp' | 'malformed_payload';

/** A webhook failed verification. Answer 401 (signature) or 400 (payload) and record nothing. */
export class WebhookVerificationError extends PaymentProviderError {
  readonly reason: WebhookRejection;

  constructor(provider: string, reason: WebhookRejection, message: string) {
    super(provider, message);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

/** An HTTP call to the provider failed or was refused. */
export class ProviderRequestError extends PaymentProviderError {
  /** HTTP status, or null when no response arrived (network error, timeout). */
  readonly status: number | null;
  /** The provider's error body, when there was one (never contains our secrets). */
  readonly body: unknown;

  constructor(
    provider: string,
    message: string,
    options: { status: number | null; body?: unknown; retryable: boolean; cause?: unknown },
  ) {
    super(provider, message, { retryable: options.retryable, cause: options.cause });
    this.name = 'ProviderRequestError';
    this.status = options.status;
    this.body = options.body;
  }
}

/** A provider name that is not one of PAYMENT_PROVIDER_NAMES, or not enabled. */
export class UnknownPaymentProviderError extends PaymentProviderError {
  constructor(provider: string, message = `payment provider "${provider}" is not enabled`) {
    super(provider, message);
    this.name = 'UnknownPaymentProviderError';
  }
}
