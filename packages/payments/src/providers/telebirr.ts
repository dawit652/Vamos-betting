import {
  constants,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  WebhookVerificationError,
} from '../errors';
import type {
  DepositInitiation,
  InitiateDepositInput,
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
  isRecord,
  joinUrl,
  parseJsonObject,
  rawBytes,
  sendJson,
  stringField,
  toBirrAmount,
} from '../util';

/**
 * telebirr H5 web checkout through Ethio Telecom's Fabric API:
 * 1. POST {base}/payment/v1/token (X-APP-Key = fabric app id, body
 *    { appSecret }) returns a token, cached until shortly before it expires;
 * 2. POST {base}/payment/v1/merchant/preOrder (X-APP-Key, Authorization =
 *    token) with a signed request whose biz_content names our notify_url
 *    and merch_order_id; it returns a prepay_id;
 * 3. the player is sent to the checkout URL with a signed raw request
 *    (appid, merch_code, nonce_str, prepay_id, timestamp);
 * 4. telebirr POSTs the result to notify_url, signed with its RSA key.
 *
 * Signing: every field except `sign`, `sign_type` and the excluded
 * containers, with biz_content's fields lifted to the top level, sorted by
 * key and joined as `k=v&k=v`, signed SHA256withRSA (RSA-PSS with MGF1
 * SHA-256 and a 32-byte salt, telebirr's "SHA256WithRSA"; `pkcs1` is
 * available for merchant accounts set up with PKCS#1 v1.5) and base64
 * encoded. A notification is accepted only when its signature verifies
 * under telebirr's public key (TELEBIRR_PUBLIC_KEY).
 *
 * The merchant order id is our intent id without dashes (telebirr allows
 * only letters, digits and underscores). B2C payouts need a separate
 * agreement with Ethio Telecom and are not available through this adapter.
 */

const NAME = 'telebirr';

export type TelebirrSignatureScheme = 'pss' | 'pkcs1';

export interface TelebirrOptions {
  baseUrl: string;
  checkoutUrl: string;
  fabricAppId: string;
  appSecret: string;
  merchantAppId: string;
  shortCode: string;
  /** Our RSA private key (PEM). */
  privateKey: string;
  /** telebirr's RSA public key (PEM). */
  publicKey: string;
  signatureScheme?: TelebirrSignatureScheme;
}

/** Fields never included in the signed string. */
const UNSIGNED_FIELDS = new Set([
  'sign',
  'sign_type',
  'header',
  'refund_info',
  'openType',
  'raw_request',
  'biz_content',
  'wallet_reference_data',
]);

/** Refresh the token this long before telebirr says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Assumed lifetime when telebirr does not state an expiry. */
const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;

/**
 * The string telebirr signs: biz_content's fields lifted to the top level,
 * excluded fields and empty values dropped, sorted by key (code point order)
 * and joined as `k=v&…`.
 */
export function telebirrCanonicalString(fields: Readonly<Record<string, unknown>>): string {
  const flat = new Map<string, string>();
  const add = (key: string, value: unknown) => {
    if (UNSIGNED_FIELDS.has(key) || value === undefined || value === null) return;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    if (text.length > 0) flat.set(key, text);
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'biz_content' && isRecord(value)) {
      for (const [bizKey, bizValue] of Object.entries(value)) add(bizKey, bizValue);
    } else {
      add(key, value);
    }
  }
  return [...flat.keys()]
    .sort()
    .map((key) => `${key}=${flat.get(key) ?? ''}`)
    .join('&');
}

function padding(scheme: TelebirrSignatureScheme) {
  return scheme === 'pss'
    ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
    : { padding: constants.RSA_PKCS1_PADDING };
}

/** Base64 SHA256withRSA signature of the canonical string of `fields`. */
export function telebirrSign(
  fields: Readonly<Record<string, unknown>>,
  privateKey: KeyObject | string,
  scheme: TelebirrSignatureScheme = 'pss',
): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const data = Buffer.from(telebirrCanonicalString(fields), 'utf8');
  return sign('sha256', data, { key, ...padding(scheme) }).toString('base64');
}

/** True when `fields.sign` is a valid signature of the other fields under `publicKey`. */
export function telebirrVerify(
  fields: Readonly<Record<string, unknown>>,
  publicKey: KeyObject | string,
  scheme: TelebirrSignatureScheme = 'pss',
): boolean {
  const signature = fields.sign;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  const data = Buffer.from(telebirrCanonicalString(fields), 'utf8');
  try {
    return verify('sha256', data, { key, ...padding(scheme) }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** telebirr's merch_order_id for an intent: the UUID without dashes. */
export function telebirrOrderId(intentId: string): string {
  return intentId.replace(/-/g, '');
}

function tradeStatus(value: string | undefined): ProviderPaymentStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'completed':
    case 'success':
    case 'pay_success':
      return 'succeeded';
    case 'failure':
    case 'failed':
    case 'pay_failed':
    case 'expired':
    case 'order_closed':
    case 'closed':
      return 'failed';
    default:
      return 'pending';
  }
}

export class TelebirrProvider implements PaymentProvider {
  readonly name = NAME;
  private readonly options: TelebirrOptions;
  private readonly deps: ProviderDeps;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly scheme: TelebirrSignatureScheme;
  private token: { value: string; refreshAt: number } | null = null;

  constructor(options: TelebirrOptions, deps: ProviderDeps) {
    this.options = options;
    this.deps = deps;
    this.scheme = options.signatureScheme ?? 'pss';
    try {
      this.privateKey = createPrivateKey(options.privateKey);
      this.publicKey = createPublicKey(options.publicKey);
    } catch {
      throw new ProviderNotConfiguredError(
        NAME,
        'TELEBIRR_PRIVATE_KEY / TELEBIRR_PUBLIC_KEY are not valid PEM RSA keys',
        ['TELEBIRR_PRIVATE_KEY', 'TELEBIRR_PUBLIC_KEY'],
      );
    }
  }

  private nonce(): string {
    return Buffer.from(this.deps.randomBytes(16)).toString('hex');
  }

  private timestamp(): string {
    return Math.floor(this.deps.clock().getTime() / 1000).toString();
  }

  /** The Fabric token, fetched again shortly before it expires. */
  async fabricToken(): Promise<string> {
    const now = this.deps.clock().getTime();
    if (this.token !== null && now < this.token.refreshAt) return this.token.value;
    const response = await sendJson(NAME, this.deps, {
      method: 'POST',
      url: joinUrl(this.options.baseUrl, '/payment/v1/token'),
      headers: { 'X-APP-Key': this.options.fabricAppId },
      body: { appSecret: this.options.appSecret },
    });
    assertOk(NAME, 'token', response);
    const token = isRecord(response.body) ? stringField(response.body, 'token') : undefined;
    if (token === undefined) {
      throw new ProviderRequestError(NAME, 'telebirr returned no token', {
        status: response.status,
        retryable: true,
      });
    }
    const expiration = isRecord(response.body)
      ? stringField(response.body, 'expirationDate')
      : undefined;
    const expiresAt = parseTelebirrTime(expiration) ?? now + DEFAULT_TOKEN_TTL_MS;
    this.token = { value: token, refreshAt: Math.max(now, expiresAt - TOKEN_REFRESH_MARGIN_MS) };
    return token;
  }

  private async signedCall(path: string, method: string, bizContent: Record<string, unknown>) {
    const token = await this.fabricToken();
    const request: Record<string, unknown> = {
      timestamp: this.timestamp(),
      nonce_str: this.nonce(),
      method,
      version: '1.0',
      biz_content: bizContent,
    };
    request.sign = telebirrSign(request, this.privateKey, this.scheme);
    request.sign_type = 'SHA256WithRSA';
    const response = await sendJson(NAME, this.deps, {
      method: 'POST',
      url: joinUrl(this.options.baseUrl, path),
      headers: { 'X-APP-Key': this.options.fabricAppId, Authorization: token },
      body: request,
    });
    if (response.status === 401) this.token = null;
    assertOk(NAME, method, response);
    const body = response.body;
    if (!isRecord(body) || (body.result !== undefined && body.result !== 'SUCCESS')) {
      throw new ProviderRequestError(NAME, `telebirr ${method} was refused`, {
        status: response.status,
        body,
        retryable: false,
      });
    }
    return isRecord(body.biz_content) ? body.biz_content : {};
  }

  async initiateDeposit(input: InitiateDepositInput): Promise<DepositInitiation> {
    const orderId = telebirrOrderId(input.intentId);
    const biz = await this.signedCall('/payment/v1/merchant/preOrder', 'payment.preorder', {
      notify_url: input.callbackUrl,
      redirect_url: input.returnUrl,
      appid: this.options.merchantAppId,
      merch_code: this.options.shortCode,
      merch_order_id: orderId,
      trade_type: 'Checkout',
      title: 'Vamos deposit',
      total_amount: toBirrAmount(input.amount),
      trans_currency: 'ETB',
      timeout_express: '30m',
      business_type: 'BuyGoods',
      payee_identifier: this.options.shortCode,
      payee_identifier_type: '04',
      payee_type: '5000',
    });
    const prepayId = stringField(biz, 'prepay_id');
    if (prepayId === undefined) {
      throw new ProviderRequestError(NAME, 'telebirr returned no prepay_id', {
        status: 200,
        body: biz,
        retryable: false,
      });
    }
    const raw: Record<string, string> = {
      appid: this.options.merchantAppId,
      merch_code: this.options.shortCode,
      nonce_str: this.nonce(),
      prepay_id: prepayId,
      timestamp: this.timestamp(),
    };
    const query = new URLSearchParams({
      ...raw,
      sign: telebirrSign(raw, this.privateKey, this.scheme),
      sign_type: 'SHA256WithRSA',
      version: '1.0',
      trade_type: 'Checkout',
    });
    const separator = this.options.checkoutUrl.includes('?') ? '&' : '?';
    return {
      kind: 'redirect',
      providerRef: orderId,
      redirectUrl: `${this.options.checkoutUrl}${separator}${query.toString()}`,
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<VerifiedWebhookEvent> {
    const body = rawBytes(input.rawBody);
    const payload = parseJsonObject(NAME, body);
    if (typeof payload.sign !== 'string' || payload.sign.length === 0) {
      throw new WebhookVerificationError(NAME, 'missing_signature', 'notification is not signed');
    }
    if (!telebirrVerify(payload, this.publicKey, this.scheme)) {
      throw new WebhookVerificationError(NAME, 'bad_signature', 'signature does not verify');
    }
    const orderId = stringField(payload, 'merch_order_id');
    const status = stringField(payload, 'trade_status');
    if (orderId === undefined || status === undefined) {
      throw new WebhookVerificationError(
        NAME,
        'malformed_payload',
        'notification has no order or status',
      );
    }
    if (
      stringField(payload, 'merch_code') !== undefined &&
      payload.merch_code !== this.options.shortCode
    ) {
      throw new WebhookVerificationError(
        NAME,
        'malformed_payload',
        'notification is for another merchant',
      );
    }
    const paymentOrderId = stringField(payload, 'payment_order_id') ?? orderId;
    return {
      providerEventId: `${paymentOrderId}:${status}`,
      kind: 'deposit',
      providerRef: orderId,
      status: tradeStatus(status),
      amount: birrToSantim(NAME, payload.total_amount),
      currency: stringField(payload, 'trans_currency') ?? null,
      raw: payload,
    };
  }

  async queryDeposit(providerRef: string): Promise<ProviderStatusResult> {
    const biz = await this.signedCall('/payment/v1/merchant/queryOrder', 'payment.queryorder', {
      appid: this.options.merchantAppId,
      merch_code: this.options.shortCode,
      merch_order_id: providerRef,
    });
    let amount: bigint | null;
    try {
      amount = birrToSantim(NAME, biz.total_amount);
    } catch (error) {
      throw new PaymentProviderError(NAME, 'telebirr queryOrder returned an invalid amount', {
        cause: error,
      });
    }
    return {
      providerRef,
      status: tradeStatus(stringField(biz, 'order_status') ?? stringField(biz, 'trade_status')),
      amount,
      currency: stringField(biz, 'trans_currency') ?? null,
      raw: biz,
    };
  }

  async initiatePayout(): Promise<PayoutInitiation> {
    throw payoutsUnavailable();
  }

  async queryPayout(): Promise<ProviderStatusResult> {
    throw payoutsUnavailable();
  }
}

function payoutsUnavailable(): ProviderNotConfiguredError {
  return new ProviderNotConfiguredError(
    NAME,
    'telebirr B2C payouts need a separate merchant agreement; pay out through another provider',
  );
}

/** telebirr times are epoch milliseconds or seconds as strings, or "yyyyMMddHHmmss" (UTC+3). */
function parseTelebirrTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (/^\d{13}$/.test(value)) return Number(value);
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(y, mo - 1, d, h - 3, mi, s);
}
