import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeFetch } from '../../test/fakes';
import { ProviderRequestError, WebhookVerificationError } from '../errors';
import { hmacSha256Hex } from '../util';
import { ChapaProvider } from './chapa';

const WEBHOOK_SECRET = 'chapa-webhook-test-secret';
const INTENT = '5b1e0c2a-7f3d-4a8e-9b6c-1d2e3f4a5b6c';
const BODY =
  '{"event":"charge.success","tx_ref":"5b1e0c2a-7f3d-4a8e-9b6c-1d2e3f4a5b6c","reference":"APm1x2y3","status":"success","amount":"150.00","currency":"ETB"}';
// HMAC-SHA256(WEBHOOK_SECRET, BODY), computed independently with openssl.
const BODY_SIGNATURE = '37be198883ee44fd70d49f320b3a71cece7ec30a9a38ce5a78c023804d5a9f8c';

function chapa(fetch: typeof globalThis.fetch = fakeFetch([]).fetch) {
  return new ChapaProvider(
    {
      baseUrl: 'https://api.chapa.test/v1',
      secretKey: 'CHASECK_TEST-abc',
      webhookSecret: WEBHOOK_SECRET,
    },
    fakeDeps(fetch),
  );
}

async function rejection(promise: Promise<unknown>): Promise<WebhookVerificationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return error as WebhookVerificationError;
}

describe('Chapa webhooks', () => {
  it('accepts the fixed vector under x-chapa-signature and Chapa-Signature', async () => {
    for (const header of ['x-chapa-signature', 'Chapa-Signature']) {
      const event = await chapa().verifyWebhook({
        headers: { [header]: BODY_SIGNATURE },
        rawBody: BODY,
      });
      expect(event).toEqual({
        providerEventId: `charge.success:${INTENT}:APm1x2y3`,
        kind: 'deposit',
        providerRef: INTENT,
        status: 'succeeded',
        amount: 15_000n,
        currency: 'ETB',
        raw: JSON.parse(BODY) as unknown,
      });
    }
    expect(hmacSha256Hex(WEBHOOK_SECRET, BODY)).toBe(BODY_SIGNATURE);
  });

  it('rejects a missing signature', async () => {
    expect((await rejection(chapa().verifyWebhook({ headers: {}, rawBody: BODY }))).reason).toBe(
      'missing_signature',
    );
  });

  it('rejects a tampered body', async () => {
    const tampered = BODY.replace('150.00', '15000.00');
    const error = await rejection(
      chapa().verifyWebhook({
        headers: { 'x-chapa-signature': BODY_SIGNATURE },
        rawBody: tampered,
      }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects a signature made with another secret', async () => {
    const forged = hmacSha256Hex('not-the-webhook-secret', BODY);
    const error = await rejection(
      chapa().verifyWebhook({ headers: { 'x-chapa-signature': forged }, rawBody: BODY }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects the signature of the secret itself (not bound to the body)', async () => {
    const secretOnly = hmacSha256Hex(WEBHOOK_SECRET, WEBHOOK_SECRET);
    const error = await rejection(
      chapa().verifyWebhook({ headers: { 'chapa-signature': secretOnly }, rawBody: BODY }),
    );
    expect(error.reason).toBe('bad_signature');
  });

  it('maps transfer webhooks to payout events by our reference', async () => {
    const body = JSON.stringify({
      event: 'payout.failed',
      type: 'Payout',
      reference: 'payout-123',
      status: 'failed',
      amount: 70.5,
      currency: 'ETB',
    });
    const event = await chapa().verifyWebhook({
      headers: { 'x-chapa-signature': hmacSha256Hex(WEBHOOK_SECRET, body) },
      rawBody: body,
    });
    expect(event).toMatchObject({
      kind: 'payout',
      providerRef: 'payout-123',
      status: 'failed',
      amount: 7_050n,
    });
  });

  it('rejects a signed body without a reference or with a bad amount', async () => {
    for (const body of [
      '{"event":"charge.success","status":"success"}',
      '{"event":"charge.success","tx_ref":"x","status":"success","amount":"1.001"}',
      'garbage',
    ]) {
      const error = await rejection(
        chapa().verifyWebhook({
          headers: { 'x-chapa-signature': hmacSha256Hex(WEBHOOK_SECRET, body) },
          rawBody: body,
        }),
      );
      expect(error.reason).toBe('malformed_payload');
    }
  });
});

describe('Chapa API calls', () => {
  it('initializes a hosted checkout with our intent id as tx_ref', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: { status: 'success', data: { checkout_url: 'https://checkout.chapa.co/x' } },
      },
    ]);
    const result = await chapa(fetch).initiateDeposit({
      intentId: INTENT,
      amount: 15_050n,
      phone: '+251911234567',
      callbackUrl: 'https://api.example.et/payments/webhooks/chapa',
      returnUrl: 'https://vamos.example.et/wallet',
    });
    expect(result).toEqual({
      kind: 'redirect',
      providerRef: INTENT,
      redirectUrl: 'https://checkout.chapa.co/x',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.chapa.test/v1/transaction/initialize',
      method: 'POST',
      headers: { authorization: 'Bearer CHASECK_TEST-abc' },
      body: {
        amount: '150.50',
        currency: 'ETB',
        tx_ref: INTENT,
        phone_number: '0911234567',
        callback_url: 'https://api.example.et/payments/webhooks/chapa',
        return_url: 'https://vamos.example.et/wallet',
      },
    });
  });

  it('classifies failures as retryable or not', async () => {
    const attempt = async (response: Parameters<typeof fakeFetch>[0]) => {
      const error = await chapa(fakeFetch(response).fetch)
        .initiateDeposit({
          intentId: INTENT,
          amount: 100n,
          phone: '0911234567',
          callbackUrl: 'c',
          returnUrl: 'r',
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ProviderRequestError);
      return error as ProviderRequestError;
    };
    expect((await attempt([new TypeError('fetch failed')])).retryable).toBe(true);
    expect((await attempt([{ status: 503, body: 'down' }])).retryable).toBe(true);
    expect((await attempt([{ status: 429, body: {} }])).retryable).toBe(true);
    const refused = await attempt([{ status: 400, body: { message: 'Invalid currency' } }]);
    expect(refused.retryable).toBe(false);
    expect(refused.message).toMatch(/Invalid currency/);
    expect((await attempt([{ status: 200, body: { status: 'failed' } }])).retryable).toBe(false);
  });

  it('verifies a deposit, treating 404 as not paid yet', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: { status: 'success', data: { status: 'success', amount: '150.00', currency: 'ETB' } },
      },
      { status: 404, body: { message: 'Transaction not found' } },
    ]);
    const provider = chapa(fetch);
    expect(await provider.queryDeposit(INTENT)).toMatchObject({
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
    });
    expect(calls[0]?.url).toBe(`https://api.chapa.test/v1/transaction/verify/${INTENT}`);
    expect((await provider.queryDeposit(INTENT)).status).toBe('pending');
  });

  it('sends payouts to the wallet of the phone operator with our payout id as reference', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { status: 'success', message: 'Transfer queued', data: 'payout-1' } },
      { status: 200, body: { status: 'success', message: 'Transfer queued', data: 'payout-2' } },
      { status: 200, body: { status: 'success', data: { status: 'failed', amount: '50.00' } } },
    ]);
    const provider = chapa(fetch);
    const first = await provider.initiatePayout({
      payoutId: 'payout-1',
      amount: 5_000n,
      phone: '+251911234567',
      name: 'Abebe Kebede',
    });
    expect(first).toMatchObject({ providerRef: 'payout-1', status: 'pending' });
    expect(calls[0]?.body).toEqual({
      account_name: 'Abebe Kebede',
      account_number: '0911234567',
      amount: '50.00',
      currency: 'ETB',
      reference: 'payout-1',
      bank_code: 855,
    });
    await provider.initiatePayout({
      payoutId: 'payout-2',
      amount: 5_000n,
      phone: '+251711234567',
      name: 'Abebe Kebede',
    });
    expect((calls[1]?.body as { bank_code: number }).bank_code).toBe(266);
    expect(await provider.queryPayout('payout-1')).toMatchObject({
      status: 'failed',
      amount: 5_000n,
    });
    expect(calls[2]?.url).toBe('https://api.chapa.test/v1/transfers/verify/payout-1');
  });
});
