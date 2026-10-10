import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../errors';
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, MockPinError, mockDepositRef } from './mock';

const SECRET = 'mock-webhook-secret-0123456789';
const INTENT = '5b1e0c2a-7f3d-4a8e-9b6c-1d2e3f4a5b6c';

function provider(now: { value: Date } = { value: new Date('2026-10-10T09:00:00Z') }) {
  return new MockPaymentProvider({ webhookSecret: SECRET, clock: () => now.value });
}

async function rejection(promise: Promise<unknown>): Promise<WebhookVerificationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return error as WebhookVerificationError;
}

describe('MockPaymentProvider deposits', () => {
  it('pushes the deposit to the simulator', async () => {
    const result = await provider().initiateDeposit({
      intentId: INTENT,
      amount: 10_000n,
      phone: '0911234567',
      callbackUrl: 'http://localhost:4000/payments/webhooks/mock',
      returnUrl: 'http://localhost:3000/wallet',
    });
    expect(result).toEqual({
      kind: 'push',
      providerRef: mockDepositRef(INTENT),
      instructions: expect.stringContaining('simulator') as string,
    });
  });

  it('refuses a non-Ethiopian phone and a non-positive amount', async () => {
    const base = { intentId: INTENT, callbackUrl: 'x', returnUrl: 'y' };
    await expect(
      provider().initiateDeposit({ ...base, amount: 100n, phone: '+254711234567' }),
    ).rejects.toThrow(/Ethiopian/);
    await expect(
      provider().initiateDeposit({ ...base, amount: 0n, phone: '0911234567' }),
    ).rejects.toThrow(RangeError);
  });

  it('approves with the right PIN and produces a verifiable, signed webhook', async () => {
    const p = provider();
    const webhook = p.simulateDepositDecision({
      providerRef: mockDepositRef(INTENT),
      amount: 10_000n,
      decision: 'approve',
      pin: '1234',
    });
    const event = await p.verifyWebhook(webhook);
    expect(event).toMatchObject({
      kind: 'deposit',
      providerRef: mockDepositRef(INTENT),
      status: 'succeeded',
      amount: 10_000n,
      currency: 'ETB',
    });
    // Delivering the same decision twice carries the same event id (idempotent replay).
    const again = p.simulateDepositDecision({
      providerRef: mockDepositRef(INTENT),
      amount: 10_000n,
      decision: 'approve',
      pin: '1234',
    });
    expect((await p.verifyWebhook(again)).providerEventId).toBe(event.providerEventId);
  });

  it('refuses a wrong PIN and declines without one', async () => {
    const p = provider();
    const ref = mockDepositRef(INTENT);
    expect(() =>
      p.simulateDepositDecision({ providerRef: ref, amount: 1n, decision: 'approve', pin: '0000' }),
    ).toThrow(MockPinError);
    expect(() =>
      p.simulateDepositDecision({ providerRef: ref, amount: 1n, decision: 'approve' }),
    ).toThrow(MockPinError);
    const declined = await p.verifyWebhook(
      p.simulateDepositDecision({ providerRef: ref, amount: 500n, decision: 'decline' }),
    );
    expect(declined.status).toBe('failed');
  });

  it('reports deposits as pending when queried (the simulator decides)', async () => {
    expect((await provider().queryDeposit('mockdep_x')).status).toBe('pending');
  });
});

describe('MockPaymentProvider webhook signatures', () => {
  const body = '{"id":"evt1"}';
  const t = 1_791_622_800;
  // HMAC-SHA256("mock-webhook-secret-0123456789", "1791622800.{"id":"evt1"}"), computed with openssl.
  const vector = '37de05d4ee94c9cdd084c1a0d7824ddc59694dc184e1e82e460304e992291f6d';

  it('signs "<t>.<body>" with the webhook secret (fixed vector)', () => {
    const p = provider();
    const signed = p.signWebhook(body, new Date(t * 1000));
    expect(signed.headers[MOCK_SIGNATURE_HEADER]).toBe(`t=${t},v1=${vector}`);
  });

  const valid = () => {
    const p = provider();
    return {
      p,
      webhook: p.simulateDepositDecision({
        providerRef: 'mockdep_a',
        amount: 2_500n,
        decision: 'approve',
        pin: '1234',
      }),
    };
  };

  it('rejects a missing or malformed signature header', async () => {
    const { p, webhook } = valid();
    expect(
      (await rejection(p.verifyWebhook({ headers: {}, rawBody: webhook.rawBody }))).reason,
    ).toBe('missing_signature');
    const malformed = { headers: { [MOCK_SIGNATURE_HEADER]: 'v1=abc' }, rawBody: webhook.rawBody };
    expect((await rejection(p.verifyWebhook(malformed))).reason).toBe('missing_signature');
  });

  it('rejects a tampered body', async () => {
    const { p, webhook } = valid();
    const tampered = String(webhook.rawBody).replace('"2500"', '"250000"');
    expect(tampered).not.toBe(webhook.rawBody);
    const error = await rejection(p.verifyWebhook({ headers: webhook.headers, rawBody: tampered }));
    expect(error.reason).toBe('bad_signature');
  });

  it('rejects a webhook signed with another secret', async () => {
    const { p } = valid();
    const other = new MockPaymentProvider({
      webhookSecret: 'another-secret-0123456789',
      clock: () => new Date('2026-10-10T09:00:00Z'),
    });
    const forged = other.simulateDepositDecision({
      providerRef: 'mockdep_a',
      amount: 2_500n,
      decision: 'approve',
      pin: '1234',
    });
    expect((await rejection(p.verifyWebhook(forged))).reason).toBe('bad_signature');
  });

  it('rejects a replayed timestamp outside the tolerance but accepts one inside it', async () => {
    const now = { value: new Date('2026-10-10T09:00:00Z') };
    const p = provider(now);
    const webhook = p.simulateDepositDecision({
      providerRef: 'mockdep_a',
      amount: 2_500n,
      decision: 'approve',
      pin: '1234',
    });
    now.value = new Date('2026-10-10T09:04:59Z');
    await expect(p.verifyWebhook(webhook)).resolves.toMatchObject({ status: 'succeeded' });
    now.value = new Date('2026-10-10T09:05:01Z');
    expect((await rejection(p.verifyWebhook(webhook))).reason).toBe('stale_timestamp');
    // Moving the timestamp forward breaks the signature.
    const header = String(webhook.headers[MOCK_SIGNATURE_HEADER]);
    const refreshed = header.replace(/t=\d+/, `t=${Math.floor(now.value.getTime() / 1000)}`);
    const replay = { headers: { [MOCK_SIGNATURE_HEADER]: refreshed }, rawBody: webhook.rawBody };
    expect((await rejection(p.verifyWebhook(replay))).reason).toBe('bad_signature');
  });

  it('rejects a correctly signed but malformed body', async () => {
    const p = provider();
    for (const body of ['not json', '[]', '{"id":"x","type":"deposit"}']) {
      const error = await rejection(p.verifyWebhook(p.signWebhook(body)));
      expect(error.reason).toBe('malformed_payload');
    }
  });

  it('accepts a Uint8Array body', async () => {
    const { p, webhook } = valid();
    const bytes = new TextEncoder().encode(String(webhook.rawBody));
    await expect(
      p.verifyWebhook({ headers: webhook.headers, rawBody: bytes }),
    ).resolves.toMatchObject({ amount: 2_500n });
  });
});

describe('MockPaymentProvider payouts', () => {
  const payout = (phone: string) =>
    provider().initiatePayout({ payoutId: 'p-1', amount: 5_000n, phone, name: 'Abebe Kebede' });

  it('pays, fails or stays pending by the phone number', async () => {
    expect(await payout('+251911223344')).toMatchObject({ status: 'succeeded' });
    expect(await payout('+251911220000')).toMatchObject({ status: 'failed' });
    const pending = await payout('+251911229999');
    expect(pending.status).toBe('pending');
    expect((await provider().queryPayout(pending.providerRef)).status).toBe('succeeded');
    const failed = await payout('+251911220000');
    expect((await provider().queryPayout(failed.providerRef)).status).toBe('failed');
    await expect(provider().queryPayout('nope')).rejects.toThrow(/unknown/);
  });

  it('builds verifiable payout webhooks', async () => {
    const p = provider();
    const event = await p.verifyWebhook(
      p.simulatePayoutResult({ providerRef: 'mockpay_p_x', amount: 700n, status: 'failed' }),
    );
    expect(event).toMatchObject({ kind: 'payout', providerRef: 'mockpay_p_x', status: 'failed' });
  });

  it('refuses a short secret', () => {
    expect(
      () => new MockPaymentProvider({ webhookSecret: 'short', clock: () => new Date() }),
    ).toThrow(/16/);
  });
});
