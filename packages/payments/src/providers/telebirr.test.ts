import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeFetch, type RecordedCall } from '../../test/fakes';
import { ProviderNotConfiguredError, WebhookVerificationError } from '../errors';
import {
  TelebirrProvider,
  telebirrCanonicalString,
  telebirrOrderId,
  telebirrSign,
  telebirrVerify,
} from './telebirr';

const pair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const merchant = pair(); // our key pair
const telebirr = pair(); // telebirr's key pair
const stranger = pair();

const INTENT = '5b1e0c2a-7f3d-4a8e-9b6c-1d2e3f4a5b6c';
const ORDER = telebirrOrderId(INTENT);

const OPTIONS = {
  baseUrl: 'https://telebirr.test/apiaccess',
  checkoutUrl: 'https://telebirr.test/payment/web/paygate',
  fabricAppId: 'fabric-app',
  appSecret: 'app-secret',
  merchantAppId: 'merchant-app',
  shortCode: '123456',
  privateKey: merchant.privateKey,
  publicKey: telebirr.publicKey,
};

function notification(overrides: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = {
    notify_url: 'https://api.example.et/payments/webhooks/telebirr',
    appid: 'merchant-app',
    notify_time: '1791622800000',
    merch_code: '123456',
    merch_order_id: ORDER,
    payment_order_id: '00801104C911443200001002',
    total_amount: '150.00',
    trans_id: '49485948475845',
    trans_currency: 'ETB',
    trade_status: 'Completed',
    trans_end_time: '1791622790000',
    ...overrides,
  };
  return { ...fields, sign: telebirrSign(fields, telebirr.privateKey), sign_type: 'SHA256WithRSA' };
}

async function rejection(promise: Promise<unknown>): Promise<WebhookVerificationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return error as WebhookVerificationError;
}

describe('telebirr signing', () => {
  it('builds the canonical string: biz_content lifted, excluded fields dropped, sorted', () => {
    expect(
      telebirrCanonicalString({
        timestamp: '1700000000',
        nonce_str: 'abc',
        method: 'payment.preorder',
        sign: 'x',
        sign_type: 'SHA256WithRSA',
        version: '1.0',
        empty: '',
        biz_content: { trade_type: 'Checkout', appid: 'a', total_amount: '10.00' },
      }),
    ).toBe(
      'appid=a&method=payment.preorder&nonce_str=abc&timestamp=1700000000&total_amount=10.00&trade_type=Checkout&version=1.0',
    );
  });

  it('verifies its own signatures and rejects tampering, another key and a missing sign', () => {
    const fields = { a: '1', b: '2' };
    const signed = { ...fields, sign: telebirrSign(fields, merchant.privateKey) };
    expect(telebirrVerify(signed, merchant.publicKey)).toBe(true);
    expect(telebirrVerify({ ...signed, b: '3' }, merchant.publicKey)).toBe(false);
    expect(telebirrVerify(signed, stranger.publicKey)).toBe(false);
    expect(telebirrVerify(fields, merchant.publicKey)).toBe(false);
    expect(telebirrVerify({ ...fields, sign: 'not base64 at all' }, merchant.publicKey)).toBe(
      false,
    );
  });

  it('supports PKCS#1 v1.5 accounts and keeps the schemes apart', () => {
    const fields = { a: '1' };
    const pkcs1 = { ...fields, sign: telebirrSign(fields, merchant.privateKey, 'pkcs1') };
    expect(telebirrVerify(pkcs1, merchant.publicKey, 'pkcs1')).toBe(true);
    expect(telebirrVerify(pkcs1, merchant.publicKey, 'pss')).toBe(false);
  });

  it('derives an alphanumeric merchant order id from the intent id', () => {
    expect(ORDER).toBe('5b1e0c2a7f3d4a8e9b6c1d2e3f4a5b6c');
  });
});

describe('telebirr notify_url', () => {
  const provider = () => new TelebirrProvider(OPTIONS, fakeDeps(fakeFetch([]).fetch));

  it('accepts a notification signed by telebirr', async () => {
    const body = notification();
    const event = await provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) });
    expect(event).toEqual({
      providerEventId: '00801104C911443200001002:Completed',
      kind: 'deposit',
      providerRef: ORDER,
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
      raw: body,
    });
  });

  it('maps failed and in-progress trade statuses', async () => {
    const failed = await provider().verifyWebhook({
      headers: {},
      rawBody: JSON.stringify(notification({ trade_status: 'Failure' })),
    });
    expect(failed.status).toBe('failed');
    const paying = await provider().verifyWebhook({
      headers: {},
      rawBody: JSON.stringify(notification({ trade_status: 'Paying' })),
    });
    expect(paying.status).toBe('pending');
    expect(paying.providerEventId).not.toBe(failed.providerEventId);
  });

  it('rejects a tampered amount', async () => {
    const body = { ...notification(), total_amount: '15000.00' };
    const error = await rejection(
      provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects a notification signed with another key (e.g. our own)', async () => {
    const fields = { merch_order_id: ORDER, trade_status: 'Completed', total_amount: '150.00' };
    const forged = { ...fields, sign: telebirrSign(fields, merchant.privateKey) };
    const error = await rejection(
      provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(forged) }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects an unsigned notification and malformed bodies', async () => {
    const { sign: _sign, ...unsigned } = notification();
    expect(
      (
        await rejection(
          provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(unsigned) }),
        )
      ).reason,
    ).toBe('missing_signature');
    expect(
      (await rejection(provider().verifyWebhook({ headers: {}, rawBody: '<xml/>' }))).reason,
    ).toBe('malformed_payload');
  });

  it('rejects a genuine notification for another merchant', async () => {
    const body = notification({ merch_code: '999999' });
    const error = await rejection(
      provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) }),
    );
    expect(error.reason).toBe('malformed_payload');
  });
});

describe('telebirr API calls', () => {
  function respond(call: RecordedCall) {
    if (call.url.endsWith('/payment/v1/token')) {
      return { status: 200, body: { token: 'Bearer tkn-1', expirationDate: '1791626400000' } };
    }
    if (call.url.endsWith('/payment/v1/merchant/preOrder')) {
      return {
        status: 200,
        body: {
          result: 'SUCCESS',
          code: '0',
          biz_content: { merch_order_id: ORDER, prepay_id: 'prepay-9' },
        },
      };
    }
    if (call.url.endsWith('/payment/v1/merchant/queryOrder')) {
      return {
        status: 200,
        body: {
          result: 'SUCCESS',
          biz_content: {
            order_status: 'PAY_SUCCESS',
            total_amount: '150.00',
            trans_currency: 'ETB',
          },
        },
      };
    }
    return { status: 404, body: {} };
  }

  it('gets a Fabric token, creates a signed order and returns a signed checkout URL', async () => {
    const { fetch, calls } = fakeFetch(respond);
    const deps = fakeDeps(fetch);
    const provider = new TelebirrProvider(OPTIONS, deps);
    const result = await provider.initiateDeposit({
      intentId: INTENT,
      amount: 15_000n,
      phone: '+251911234567',
      callbackUrl: 'https://api.example.et/payments/webhooks/telebirr',
      returnUrl: 'https://vamos.example.et/wallet',
    });

    expect(calls[0]).toMatchObject({
      url: 'https://telebirr.test/apiaccess/payment/v1/token',
      headers: { 'x-app-key': 'fabric-app' },
      body: { appSecret: 'app-secret' },
    });
    const order = calls[1]!;
    expect(order.headers).toMatchObject({
      'x-app-key': 'fabric-app',
      authorization: 'Bearer tkn-1',
    });
    const request = order.body as Record<string, unknown>;
    expect(request).toMatchObject({
      method: 'payment.preorder',
      version: '1.0',
      sign_type: 'SHA256WithRSA',
      biz_content: {
        notify_url: 'https://api.example.et/payments/webhooks/telebirr',
        merch_order_id: ORDER,
        total_amount: '150.00',
        trans_currency: 'ETB',
        merch_code: '123456',
      },
    });
    // The order request verifies under our public key (what telebirr checks).
    expect(telebirrVerify(request, merchant.publicKey)).toBe(true);

    expect(result.kind).toBe('redirect');
    expect(result.providerRef).toBe(ORDER);
    const url = new URL(result.redirectUrl!);
    expect(url.origin + url.pathname).toBe(OPTIONS.checkoutUrl);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      prepay_id: 'prepay-9',
      appid: 'merchant-app',
      trade_type: 'Checkout',
    });
    const { version: _v, trade_type: _t, ...signedRaw } = params;
    expect(telebirrVerify(signedRaw, merchant.publicKey)).toBe(true);

    // The token is cached until shortly before it expires.
    await provider.queryDeposit(ORDER);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    deps.now.value = new Date(1791626400000 - 30_000);
    await provider.queryDeposit(ORDER);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
  });

  it('queries an order', async () => {
    const provider = new TelebirrProvider(OPTIONS, fakeDeps(fakeFetch(respond).fetch));
    expect(await provider.queryDeposit(ORDER)).toMatchObject({
      providerRef: ORDER,
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
    });
  });

  it('does not offer payouts', async () => {
    const provider = new TelebirrProvider(OPTIONS, fakeDeps(fakeFetch([]).fetch));
    await expect(provider.initiatePayout()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(provider.queryPayout()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('refuses invalid keys at construction', () => {
    expect(
      () =>
        new TelebirrProvider(
          { ...OPTIONS, privateKey: 'not a key' },
          fakeDeps(fakeFetch([]).fetch),
        ),
    ).toThrow(ProviderNotConfiguredError);
  });
});
