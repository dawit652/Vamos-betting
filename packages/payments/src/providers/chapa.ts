import { mobileOperator, type MobileOperator } from '@vamos/core';
import { PaymentProviderError, ProviderRequestError, WebhookVerificationError } from '../errors';
import type {
  DepositInitiation,
  InitiateDepositInput,
  InitiatePayoutInput,
  PaymentEventKind,
  PaymentProvider,
  PayoutInitiation,
  ProviderDeps,
  ProviderPaymentStatus,
  ProviderStatusResult,
  VerifiedWebhookEvent,
  WebhookInput,
} from '../types';
import {
  assertOk,
  birrToSantim,
  headerValue,
  hexDigestEquals,
  hmacSha256Hex,
  isRecord,
  joinUrl,
  localMsisdn,
  parseJsonObject,
  rawBytes,
  sendJson,
  stringField,
  toBirrAmount,
} from '../util';

/**
 * Chapa (https://developer.chapa.co), a licensed Ethiopian payment gateway:
 * - deposits: POST /transaction/initialize returns a hosted checkout URL
 *   (telebirr, CBE Birr, M-Pesa, cards…); `tx_ref` is our intent id and is
 *   the providerRef. Status: GET /transaction/verify/{tx_ref}.
 * - payouts: POST /transfers to the player's mobile wallet with `reference`
 *   = our payout id (Chapa refuses a duplicate reference, so a retry never
 *   pays twice). Status: GET /transfers/verify/{reference}.
 * - webhooks: `x-chapa-signature` (or `chapa-signature`) is the hex
 *   HMAC-SHA256 of the raw request body under the webhook secret set in the
 *   Chapa dashboard. It is compared in constant time before the body is
 *   parsed. Chapa sends no timestamp, so redeliveries are made harmless by
 *   the event id (payment_events) rather than refused. Chapa recommends
 *   confirming a charge with the verify endpoint before giving value; the
 *   deposit service checks the amount and currency either way.
 */

const NAME = 'chapa';

/**
 * Chapa bank codes of the mobile-money wallets a payout can go to, by the
 * operator of the player's number. Confirm against GET /banks for the
 * merchant account before going live.
 */
export const CHAPA_WALLET_BANK_CODES: Readonly<Record<MobileOperator, number>> = {
  ethio_telecom: 855, // telebirr
  safaricom: 266, // M-Pesa Ethiopia
};

export interface ChapaOptions {
  baseUrl: string;
  secretKey: string;
  webhookSecret: string;
  walletBankCodes?: Readonly<Record<MobileOperator, number>>;
}

function mapStatus(value: string | undefined): ProviderPaymentStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'failed/cancelled':
    case 'cancelled':
    case 'canceled':
    case 'reversed':
    case 'refunded':
    case 'expired':
      return 'failed';
    default:
      return 'pending';
  }
}

export class ChapaProvider implements PaymentProvider {
  readonly name = NAME;
  private readonly options: ChapaOptions;
  private readonly deps: ProviderDeps;

  constructor(options: ChapaOptions, deps: ProviderDeps) {
    this.options = options;
    this.deps = deps;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.options.secretKey}` };
  }

  async initiateDeposit(input: InitiateDepositInput): Promise<DepositInitiation> {
    const response = await sendJson(NAME, this.deps, {
      method: 'POST',
      url: joinUrl(this.options.baseUrl, '/transaction/initialize'),
      headers: this.auth(),
      body: {
        amount: toBirrAmount(input.amount),
        currency: 'ETB',
        tx_ref: input.intentId,
        phone_number: localMsisdn(NAME, input.phone),
        callback_url: input.callbackUrl,
        return_url: input.returnUrl,
        customization: { title: 'Vamos deposit', description: 'Vamos wallet deposit' },
      },
    });
    assertOk(NAME, 'transaction initialize', response);
    const body = response.body;
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const checkoutUrl = data === undefined ? undefined : stringField(data, 'checkout_url');
    if (!isRecord(body) || body.status !== 'success' || checkoutUrl === undefined) {
      throw new ProviderRequestError(NAME, 'chapa did not return a checkout URL', {
        status: response.status,
        body,
        retryable: false,
      });
    }
    return { kind: 'redirect', providerRef: input.intentId, redirectUrl: checkoutUrl };
  }

  async verifyWebhook(input: WebhookInput): Promise<VerifiedWebhookEvent> {
    const signature =
      headerValue(input.headers, 'x-chapa-signature') ??
      headerValue(input.headers, 'chapa-signature');
    if (signature === undefined) {
      throw new WebhookVerificationError(NAME, 'missing_signature', 'missing x-chapa-signature');
    }
    const body = rawBytes(input.rawBody);
    const expected = hmacSha256Hex(this.options.webhookSecret, body);
    if (!hexDigestEquals(expected, signature)) {
      throw new WebhookVerificationError(NAME, 'bad_signature', 'signature does not match');
    }

    const payload = parseJsonObject(NAME, body);
    const event = stringField(payload, 'event');
    const type = stringField(payload, 'type');
    const kind: PaymentEventKind =
      type?.toLowerCase() === 'payout' || event?.toLowerCase().startsWith('payout.') === true
        ? 'payout'
        : 'deposit';
    // Deposits are named by our tx_ref; transfers by the reference we sent.
    const providerRef =
      kind === 'deposit' ? stringField(payload, 'tx_ref') : stringField(payload, 'reference');
    const status = stringField(payload, 'status');
    if (providerRef === undefined || status === undefined) {
      throw new WebhookVerificationError(
        NAME,
        'malformed_payload',
        'webhook has no reference or status',
      );
    }
    const chapaRef =
      stringField(payload, 'reference') ?? stringField(payload, 'chapa_reference') ?? '';
    return {
      providerEventId: `${event ?? `${kind}.${status}`}:${providerRef}:${chapaRef}`,
      kind,
      providerRef,
      status: mapStatus(status),
      amount: birrToSantim(NAME, payload.amount),
      currency: stringField(payload, 'currency') ?? null,
      raw: payload,
    };
  }

  private async verify(path: string, providerRef: string): Promise<ProviderStatusResult> {
    const response = await sendJson(NAME, this.deps, {
      method: 'GET',
      url: joinUrl(this.options.baseUrl, `${path}/${encodeURIComponent(providerRef)}`),
      headers: this.auth(),
    });
    // Chapa answers 404 for a payment the payer has not completed yet.
    if (response.status === 404) {
      return { providerRef, status: 'pending', amount: null, currency: null, raw: response.body };
    }
    assertOk(NAME, 'verify', response);
    const data = isRecord(response.body) && isRecord(response.body.data) ? response.body.data : {};
    try {
      return {
        providerRef,
        status: mapStatus(stringField(data, 'status')),
        amount: birrToSantim(NAME, data.amount),
        currency: stringField(data, 'currency') ?? null,
        raw: response.body,
      };
    } catch (error) {
      throw new PaymentProviderError(NAME, 'chapa verify returned an invalid amount', {
        cause: error,
      });
    }
  }

  async queryDeposit(providerRef: string): Promise<ProviderStatusResult> {
    return this.verify('/transaction/verify', providerRef);
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutInitiation> {
    const operator = mobileOperator(input.phone);
    if (operator === null) throw new PaymentProviderError(NAME, 'not an Ethiopian mobile number');
    const bankCode = (this.options.walletBankCodes ?? CHAPA_WALLET_BANK_CODES)[operator];
    const response = await sendJson(NAME, this.deps, {
      method: 'POST',
      url: joinUrl(this.options.baseUrl, '/transfers'),
      headers: this.auth(),
      body: {
        account_name: input.name,
        account_number: localMsisdn(NAME, input.phone),
        amount: toBirrAmount(input.amount),
        currency: 'ETB',
        reference: input.payoutId,
        bank_code: bankCode,
      },
    });
    assertOk(NAME, 'transfer', response);
    if (!isRecord(response.body) || response.body.status !== 'success') {
      throw new ProviderRequestError(NAME, 'chapa did not accept the transfer', {
        status: response.status,
        body: response.body,
        retryable: false,
      });
    }
    // Transfers are queued at Chapa; the result follows by webhook or verify.
    return { providerRef: input.payoutId, status: 'pending', raw: response.body };
  }

  async queryPayout(providerRef: string): Promise<ProviderStatusResult> {
    return this.verify('/transfers/verify', providerRef);
  }
}
