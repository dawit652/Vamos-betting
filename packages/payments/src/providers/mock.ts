import { normalizeEthiopianMsisdn } from '@vamos/core';
import { PaymentProviderError, WebhookVerificationError } from '../errors';
import type {
  DepositInitiation,
  InitiateDepositInput,
  InitiatePayoutInput,
  PaymentEventKind,
  PaymentProvider,
  PayoutInitiation,
  ProviderPaymentStatus,
  ProviderStatusResult,
  VerifiedWebhookEvent,
  WebhookInput,
} from '../types';
import {
  headerValue,
  hexDigestEquals,
  hmacSha256Hex,
  parseJsonObject,
  rawBytes,
  stringField,
} from '../util';

/**
 * The play-money provider of demo mode. Deposits are "pushed" to a dev phone
 * simulator page where the player approves (with the PIN) or declines; the
 * simulator then delivers a signed webhook built by `simulateDepositDecision`.
 * Payouts complete at once, with outcomes chosen by the phone number (like
 * the mock KYC verifier):
 * - a number ending in 0000 fails;
 * - a number ending in 9999 stays pending until the first status query
 *   (`queryPayout`), which reports it paid;
 * - any other number is paid immediately.
 *
 * Webhooks carry `x-mock-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>">` under MOCK_PAYMENT_WEBHOOK_SECRET and are refused when
 * the timestamp is more than `toleranceMs` away from the clock.
 */

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
/** The PIN the dev phone simulator accepts. */
export const MOCK_PROVIDER_PIN = '1234';
export const MOCK_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const NAME = 'mock';
const DEPOSIT_REF_PREFIX = 'mockdep_';
const PAYOUT_REF_RE = /^mockpay_([spf])_(.+)$/;

/** The simulator was given a wrong PIN; nothing was sent. */
export class MockPinError extends PaymentProviderError {
  constructor() {
    super(NAME, 'wrong PIN');
    this.name = 'MockPinError';
  }
}

export interface MockProviderOptions {
  webhookSecret: string;
  clock: () => Date;
  pin?: string;
  toleranceMs?: number;
}

/** Body of a mock webhook (santim as a decimal string). */
interface MockWebhookBody {
  id: string;
  type: PaymentEventKind;
  providerRef: string;
  status: ProviderPaymentStatus;
  amount: string;
  currency: string;
}

const STATUSES: readonly ProviderPaymentStatus[] = ['succeeded', 'failed', 'pending'];

export class MockPaymentProvider implements PaymentProvider {
  readonly name = NAME;
  private readonly secret: string;
  private readonly clock: () => Date;
  private readonly pin: string;
  private readonly toleranceMs: number;

  constructor(options: MockProviderOptions) {
    if (options.webhookSecret.length < 16) {
      throw new PaymentProviderError(
        NAME,
        'the mock webhook secret must have at least 16 characters',
      );
    }
    this.secret = options.webhookSecret;
    this.clock = options.clock;
    this.pin = options.pin ?? MOCK_PROVIDER_PIN;
    this.toleranceMs = options.toleranceMs ?? MOCK_WEBHOOK_TOLERANCE_MS;
  }

  async initiateDeposit(input: InitiateDepositInput): Promise<DepositInitiation> {
    assertAmount(input.amount);
    if (normalizeEthiopianMsisdn(input.phone) === null) {
      throw new PaymentProviderError(NAME, 'not an Ethiopian mobile number');
    }
    return {
      kind: 'push',
      providerRef: mockDepositRef(input.intentId),
      instructions: 'Open the dev phone simulator and approve the payment with your PIN.',
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<VerifiedWebhookEvent> {
    const header = headerValue(input.headers, MOCK_SIGNATURE_HEADER);
    if (header === undefined) {
      throw new WebhookVerificationError(
        NAME,
        'missing_signature',
        `missing ${MOCK_SIGNATURE_HEADER}`,
      );
    }
    const parts = new Map<string, string>();
    for (const part of header.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) parts.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const t = parts.get('t');
    const v1 = parts.get('v1');
    if (t === undefined || v1 === undefined || !/^\d{1,12}$/.test(t)) {
      throw new WebhookVerificationError(NAME, 'missing_signature', 'malformed signature header');
    }
    const body = rawBytes(input.rawBody);
    const expected = hmacSha256Hex(this.secret, Buffer.concat([Buffer.from(`${t}.`), body]));
    if (!hexDigestEquals(expected, v1)) {
      throw new WebhookVerificationError(NAME, 'bad_signature', 'signature does not match');
    }
    // Checked after the signature, so the timestamp is known to be genuine.
    const skew = Math.abs(this.clock().getTime() - Number(t) * 1000);
    if (skew > this.toleranceMs) {
      throw new WebhookVerificationError(NAME, 'stale_timestamp', 'webhook timestamp is too old');
    }

    const payload = parseJsonObject(NAME, body);
    const id = stringField(payload, 'id');
    const type = stringField(payload, 'type');
    const providerRef = stringField(payload, 'providerRef');
    const status = stringField(payload, 'status');
    const amount = stringField(payload, 'amount');
    if (
      id === undefined ||
      (type !== 'deposit' && type !== 'payout') ||
      providerRef === undefined ||
      status === undefined ||
      !(STATUSES as readonly string[]).includes(status) ||
      amount === undefined ||
      !/^\d{1,18}$/.test(amount)
    ) {
      throw new WebhookVerificationError(NAME, 'malformed_payload', 'unexpected mock webhook body');
    }
    return {
      providerEventId: id,
      kind: type,
      providerRef,
      status: status as ProviderPaymentStatus,
      amount: BigInt(amount),
      currency: stringField(payload, 'currency') ?? null,
      raw: payload,
    };
  }

  async queryDeposit(providerRef: string): Promise<ProviderStatusResult> {
    // Stateless: only the simulator knows the decision, and it reports by webhook.
    return { providerRef, status: 'pending', amount: null, currency: null, raw: { providerRef } };
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutInitiation> {
    assertAmount(input.amount);
    const phone = normalizeEthiopianMsisdn(input.phone);
    if (phone === null) throw new PaymentProviderError(NAME, 'not an Ethiopian mobile number');
    const outcome = phone.endsWith('0000') ? 'f' : phone.endsWith('9999') ? 'p' : 's';
    const providerRef = `mockpay_${outcome}_${input.payoutId}`;
    const status: ProviderPaymentStatus =
      outcome === 'f' ? 'failed' : outcome === 'p' ? 'pending' : 'succeeded';
    return { providerRef, status, raw: { providerRef, status } };
  }

  async queryPayout(providerRef: string): Promise<ProviderStatusResult> {
    const match = PAYOUT_REF_RE.exec(providerRef);
    if (match === null) throw new PaymentProviderError(NAME, 'unknown mock payout reference');
    const status: ProviderPaymentStatus = match[1] === 'f' ? 'failed' : 'succeeded';
    return { providerRef, status, amount: null, currency: null, raw: { providerRef, status } };
  }

  /** Signs a webhook body the way the mock provider does (for the simulator and tests). */
  signWebhook(body: string, at: Date = this.clock()): WebhookInput {
    const t = Math.floor(at.getTime() / 1000).toString();
    const v1 = hmacSha256Hex(this.secret, `${t}.${body}`);
    return {
      headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${v1}` },
      rawBody: body,
    };
  }

  /**
   * The dev phone simulator's answer to a deposit push: approving needs the
   * PIN (MockPinError otherwise), declining does not. Returns the signed
   * webhook to deliver to the deposit webhook route. The event id is fixed
   * per (deposit, decision), so delivering it twice is a harmless replay.
   * `amount` is normally the intent's amount; tests pass another to simulate
   * a provider reporting a different amount.
   */
  simulateDepositDecision(input: {
    providerRef: string;
    amount: bigint;
    decision: 'approve' | 'decline';
    pin?: string;
  }): WebhookInput {
    if (input.decision === 'approve' && input.pin !== this.pin) throw new MockPinError();
    const status: ProviderPaymentStatus = input.decision === 'approve' ? 'succeeded' : 'failed';
    return this.signWebhook(webhookBody('deposit', input.providerRef, status, input.amount));
  }

  /** A signed payout status webhook (the mock's equivalent of a transfer callback). */
  simulatePayoutResult(input: {
    providerRef: string;
    amount: bigint;
    status: ProviderPaymentStatus;
  }): WebhookInput {
    return this.signWebhook(webhookBody('payout', input.providerRef, input.status, input.amount));
  }
}

/** providerRef of a mock deposit. */
export function mockDepositRef(intentId: string): string {
  return `${DEPOSIT_REF_PREFIX}${intentId}`;
}

function webhookBody(
  type: PaymentEventKind,
  providerRef: string,
  status: ProviderPaymentStatus,
  amount: bigint,
): string {
  assertAmount(amount);
  const body: MockWebhookBody = {
    id: `mockevt_${type}_${providerRef}_${status}`,
    type,
    providerRef,
    status,
    amount: amount.toString(),
    currency: 'ETB',
  };
  return JSON.stringify(body);
}

function assertAmount(amount: unknown): void {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new RangeError('payment amounts must be positive bigint santim');
  }
}
