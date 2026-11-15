import { constants, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeFetch, type RecordedCall } from '../../test/fakes';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  WebhookVerificationError,
} from '../errors';
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
  /** Signature and payload checks only (no queryOrder confirmation). */
  const provider = () =>
    new TelebirrProvider({ ...OPTIONS, confirmWebhooks: false }, fakeDeps(fakeFetch([]).fetch));

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

  it('accepts a notification whose empty fields were signed as "k=" (reference signer)', async () => {
    const fields: Record<string, unknown> = {
      appid: 'merchant-app',
      merch_code: '123456',
      merch_order_id: ORDER,
      payment_order_id: '00801104C911443200001003',
      total_amount: '150.00',
      trans_currency: 'ETB',
      trade_status: 'Completed',
      trans_end_time: '',
    };
    const canonical = telebirrCanonicalString(fields, { keepEmpty: true });
    expect(canonical).toContain('&trans_end_time=');
    expect(telebirrCanonicalString(fields)).not.toContain('trans_end_time');
    const signature = sign('sha256', Buffer.from(canonical, 'utf8'), {
      key: createPrivateKey(telebirr.privateKey),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('base64');
    const body = { ...fields, sign: signature, sign_type: 'SHA256WithRSA' };
    const event = await provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) });
    expect(event).toMatchObject({ status: 'succeeded', amount: 15_000n, providerRef: ORDER });
    // The empty field cannot be turned into a value under the same signature.
    const filled = { ...body, trans_end_time: '1791622790000' };
    const error = await rejection(
      provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(filled) }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects a genuine notification for another merchant', async () => {
    const body = notification({ merch_code: '999999' });
    const error = await rejection(
      provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) }),
    );
    expect(error.reason).toBe('malformed_payload');
  });

  it('rejects a genuine notification whose signed fields were moved into biz_content', async () => {
    // Someone else's genuine, telebirr-signed notification of a failed 1-birr order.
    const { sign, sign_type, ...genuine } = notification({
      merch_code: '999999',
      appid: 'another-app',
      merch_order_id: 'ffffffffffffffffffffffffffffffff',
      payment_order_id: 'P-OTHER-1',
      total_amount: '1.00',
      trade_status: 'Failure',
    });
    // The signed fields move into biz_content (lifted last, so the signed string is
    // unchanged) and forged values take their place at the top level.
    const forged = {
      ...genuine,
      merch_code: '123456',
      appid: 'merchant-app',
      merch_order_id: ORDER,
      payment_order_id: 'P-FORGED-2',
      total_amount: '150.00',
      trade_status: 'Completed',
      biz_content: genuine,
      sign,
      sign_type,
    };
    expect(telebirrVerify(forged, telebirr.publicKey)).toBe(true);
    for (const target of [provider(), confirming(fakeFetch([]).fetch)]) {
      const error = await rejection(
        target.verifyWebhook({ headers: {}, rawBody: JSON.stringify(forged) }),
      );
      expect(error.reason).toBe('malformed_payload');
    }
    // A nested object in any signed field is refused the same way.
    const nested = notification({ trans_id: { a: '1' } });
    expect(
      (await rejection(provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(nested) })))
        .reason,
    ).toBe('malformed_payload');
  });

  it('requires our merchant code and app id in every notification', async () => {
    const full: Record<string, unknown> = notification();
    const { merch_code: _code, ...withoutCode } = full;
    const unsignedCode = {
      ...withoutCode,
      sign: telebirrSign(
        Object.fromEntries(
          Object.entries(withoutCode).filter(([key]) => key !== 'sign' && key !== 'sign_type'),
        ),
        telebirr.privateKey,
      ),
    };
    const { appid: _appid, ...noAppFields } = full;
    const noApp = {
      ...noAppFields,
      sign: telebirrSign(
        Object.fromEntries(
          Object.entries(noAppFields).filter(([key]) => key !== 'sign' && key !== 'sign_type'),
        ),
        telebirr.privateKey,
      ),
    };
    for (const body of [unsignedCode, noApp, notification({ appid: 'another-app' })]) {
      const error = await rejection(
        provider().verifyWebhook({ headers: {}, rawBody: JSON.stringify(body) }),
      );
      expect(error.reason).toBe('malformed_payload');
    }
  });
});

/** A provider that confirms successful notifications with queryOrder (the default). */
function confirming(fetch: typeof globalThis.fetch) {
  return new TelebirrProvider(OPTIONS, fakeDeps(fetch));
}

describe('telebirr notify_url confirmation (queryOrder)', () => {
  const token = { status: 200, body: { token: 'Bearer tkn-1', expirationDate: '1791626400000' } };
  const order = (status: string, amount = '150.00') => ({
    status: 200,
    body: {
      result: 'SUCCESS',
      biz_content: { order_status: status, total_amount: amount, trans_currency: 'ETB' },
    },
  });

  it('confirms a successful payment with queryOrder and reports what telebirr confirms', async () => {
    const { fetch, calls } = fakeFetch([token, order('PAY_SUCCESS', '150.00')]);
    const body = notification();
    const event = await confirming(fetch).verifyWebhook({
      headers: {},
      rawBody: JSON.stringify(body),
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://telebirr.test/apiaccess/payment/v1/token',
      'https://telebirr.test/apiaccess/payment/v1/merchant/queryOrder',
    ]);
    expect((calls[1]?.body as { biz_content: unknown }).biz_content).toMatchObject({
      merch_order_id: ORDER,
      merch_code: '123456',
    });
    expect(event).toMatchObject({
      providerEventId: '00801104C911443200001002:Completed',
      kind: 'deposit',
      providerRef: ORDER,
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
    });
    expect(event.raw).toMatchObject({ webhook: body });

    const contradicted = fakeFetch([token, order('PAY_FAILED')]);
    expect(
      (
        await confirming(contradicted.fetch).verifyWebhook({
          headers: {},
          rawBody: JSON.stringify(notification()),
        })
      ).status,
    ).toBe('failed');
  });

  it('throws a retryable error while queryOrder does not confirm the payment yet', async () => {
    for (const responses of [
      [token, order('PAYING')],
      [token, { status: 502, body: 'down' }],
    ]) {
      const error = await confirming(fakeFetch(responses).fetch)
        .verifyWebhook({ headers: {}, rawBody: JSON.stringify(notification()) })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).retryable).toBe(true);
    }
  });

  it('does not ask about a failed payment (nothing is given away)', async () => {
    const { fetch, calls } = fakeFetch([]);
    const event = await confirming(fetch).verifyWebhook({
      headers: {},
      rawBody: JSON.stringify(notification({ trade_status: 'Failure' })),
    });
    expect(event.status).toBe('failed');
    expect(calls).toHaveLength(0);
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
      returnUrl: 'https://nahubet.example.com/wallet',
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

  it('asks telebirr to close the order when the intent expires (timeout_express)', async () => {
    const { fetch, calls } = fakeFetch(respond);
    const deps = fakeDeps(fetch);
    await new TelebirrProvider(OPTIONS, deps).initiateDeposit({
      intentId: INTENT,
      amount: 15_000n,
      phone: '+251911234567',
      callbackUrl: 'https://api.example.et/payments/webhooks/telebirr',
      returnUrl: 'https://nahubet.example.com/wallet',
      expiresAt: new Date(deps.now.value.getTime() + 15 * 60_000),
    });
    const request = calls.find((c) => c.url.endsWith('/preOrder'))?.body as {
      biz_content: Record<string, unknown>;
    };
    expect(request.biz_content.timeout_express).toBe('15m');
  });

  it('gets a new token and tries once more when telebirr answers 401', async () => {
    let tokens = 0;
    let orders = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/payment/v1/token')) {
        tokens += 1;
        return { status: 200, body: { token: `Bearer tkn-${tokens}` } };
      }
      if (call.url.endsWith('/payment/v1/merchant/preOrder')) {
        orders += 1;
        return call.headers.authorization === 'Bearer tkn-1'
          ? { status: 401, body: { message: 'token expired' } }
          : respond(call);
      }
      return respond(call);
    });
    const deposit = {
      intentId: INTENT,
      amount: 15_000n,
      phone: '+251911234567',
      callbackUrl: 'https://api.example.et/payments/webhooks/telebirr',
      returnUrl: 'https://nahubet.example.com/wallet',
    };
    const result = await new TelebirrProvider(OPTIONS, fakeDeps(fetch)).initiateDeposit(deposit);
    expect(result.providerRef).toBe(ORDER);
    expect(tokens).toBe(2);
    expect(orders).toBe(2);
    expect(
      calls.filter((c) => c.url.endsWith('/preOrder')).map((c) => c.headers.authorization),
    ).toEqual(['Bearer tkn-1', 'Bearer tkn-2']);

    // Refused again with a fresh token: an outage on telebirr's side, worth retrying later.
    const always401 = fakeFetch((call) =>
      call.url.endsWith('/payment/v1/token')
        ? { status: 200, body: { token: 'Bearer tkn-x' } }
        : { status: 401, body: {} },
    );
    const error = await new TelebirrProvider(OPTIONS, fakeDeps(always401.fetch))
      .initiateDeposit(deposit)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).retryable).toBe(true);
    expect(always401.calls.filter((c) => c.url.endsWith('/preOrder'))).toHaveLength(2);
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
