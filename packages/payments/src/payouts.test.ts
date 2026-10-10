import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeFetch } from '../test/fakes';
import { PaymentProviderError, ProviderNotConfiguredError, ProviderRequestError } from './errors';
import {
  attemptPayout,
  eventFromStatusQuery,
  payoutRetryDelayMs,
  type PayoutAttemptInput,
} from './payouts';
import { ChapaProvider } from './providers/chapa';
import { MockPaymentProvider } from './providers/mock';
import type {
  InitiatePayoutInput,
  PaymentProvider,
  PayoutInitiation,
  ProviderStatusResult,
} from './types';

const NOW = new Date('2026-10-10T09:00:00Z');
const mock = () =>
  new MockPaymentProvider({ webhookSecret: 'mock-webhook-secret-0123456789', clock: () => NOW });

const base: PayoutAttemptInput = {
  payoutId: '7f0e8a52-6a4c-4f0e-9d7a-2b1c3d4e5f60',
  amount: 5_000n,
  phone: '+251911223344',
  recipientName: 'Abebe Kebede',
  providerRef: null,
  attempts: 1,
};

/** A provider whose payout calls are scripted; it records what was called. */
function scripted(script: {
  initiate?: () => Promise<PayoutInitiation>;
  query?: () => Promise<ProviderStatusResult>;
}) {
  const calls: string[] = [];
  const provider: PaymentProvider = {
    name: 'chapa',
    capabilities: { deposits: true, payouts: true },
    initiateDeposit: () => Promise.reject(new Error('not used')),
    verifyWebhook: () => Promise.reject(new Error('not used')),
    queryDeposit: () => Promise.reject(new Error('not used')),
    initiatePayout: (input: InitiatePayoutInput) => {
      calls.push(`initiate:${input.payoutId}`);
      return script.initiate ? script.initiate() : Promise.reject(new Error('unexpected'));
    },
    queryPayout: (ref: string) => {
      calls.push(`query:${ref}`);
      return script.query ? script.query() : Promise.reject(new Error('unexpected'));
    },
  };
  return { provider, calls };
}

const status = (s: ProviderStatusResult['status'], amount: bigint | null = 5_000n) =>
  Promise.resolve<ProviderStatusResult>({
    providerRef: 'ref-1',
    status: s,
    amount,
    currency: 'ETB',
    raw: { s },
  });

const refused = () =>
  new ProviderRequestError('chapa', 'refused', { status: 400, body: {}, retryable: false });
const timeout = () =>
  new ProviderRequestError('chapa', 'no response', { status: null, retryable: true });

describe('attemptPayout: first submission', () => {
  it('reports the mock provider’s outcomes by phone number', async () => {
    expect(await attemptPayout(mock(), base)).toMatchObject({
      outcome: 'paid',
      providerRef: `mockpay_s_${base.payoutId}`,
    });
    expect(await attemptPayout(mock(), { ...base, phone: '+251911220000' })).toMatchObject({
      outcome: 'failed',
      reason: 'failed_at_provider',
    });
    expect(await attemptPayout(mock(), { ...base, phone: '+251911229999' })).toMatchObject({
      outcome: 'pending',
      providerRef: `mockpay_p_${base.payoutId}`,
    });
  });

  it('sends the payout with the KYC name and our payout id as the reference', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { status: 'success', message: 'Transfer queued' } },
    ]);
    const chapa = new ChapaProvider(
      { baseUrl: 'https://api.chapa.test/v1', secretKey: 'k', webhookSecret: 'w' },
      fakeDeps(fetch),
    );
    expect(await attemptPayout(chapa, base)).toMatchObject({
      outcome: 'pending',
      providerRef: base.payoutId,
    });
    expect(calls[0]?.body).toMatchObject({
      account_name: 'Abebe Kebede',
      account_number: '0911223344',
      amount: '50.00',
      reference: base.payoutId,
    });
  });

  it('retries after a timeout, network error, 429 or 5xx (nothing learned)', async () => {
    const { provider } = scripted({ initiate: () => Promise.reject(timeout()) });
    expect(await attemptPayout(provider, base)).toMatchObject({
      outcome: 'retry',
      providerRef: null,
    });
    expect(await attemptPayout(provider, { ...base, attempts: 4 })).toMatchObject({
      outcome: 'retry',
    });
  });

  it('fails a payout refused the first time it is sent (no money left)', async () => {
    const { provider } = scripted({ initiate: () => Promise.reject(refused()) });
    expect(await attemptPayout(provider, base)).toMatchObject({
      outcome: 'failed',
      providerRef: null,
      reason: 'refused_by_provider',
    });
  });

  it('fails a payout through a provider that cannot pay out (refused before sending)', async () => {
    const { provider } = scripted({
      initiate: () => Promise.reject(new ProviderNotConfiguredError('telebirr', 'no payouts')),
    });
    expect(await attemptPayout(provider, base)).toMatchObject({
      outcome: 'failed',
      reason: 'provider_not_configured',
    });
  });

  it('never fails a refused resubmission: an earlier attempt may have been paid', async () => {
    const { provider } = scripted({ initiate: () => Promise.reject(refused()) });
    expect(await attemptPayout(provider, { ...base, attempts: 2 })).toMatchObject({
      outcome: 'unknown',
      providerRef: null,
    });
    const notConfigured = scripted({
      initiate: () => Promise.reject(new ProviderNotConfiguredError('chapa', 'missing key')),
    });
    expect(await attemptPayout(notConfigured.provider, { ...base, attempts: 3 })).toMatchObject({
      outcome: 'unknown',
    });
  });

  it('handles a provider that is no longer enabled', async () => {
    expect(await attemptPayout(undefined, base)).toMatchObject({
      outcome: 'failed',
      reason: 'provider_not_enabled',
    });
    expect(await attemptPayout(undefined, { ...base, attempts: 2 })).toMatchObject({
      outcome: 'unknown',
    });
    expect(await attemptPayout(undefined, { ...base, providerRef: 'ref-1' })).toMatchObject({
      outcome: 'unknown',
      providerRef: 'ref-1',
    });
  });

  it('rethrows errors that are not provider errors (bugs)', async () => {
    const { provider } = scripted({ initiate: () => Promise.reject(new TypeError('boom')) });
    await expect(attemptPayout(provider, base)).rejects.toThrow(TypeError);
  });

  it('requires attempts to count this attempt', async () => {
    await expect(attemptPayout(mock(), { ...base, attempts: 0 })).rejects.toThrow(RangeError);
  });
});

describe('attemptPayout: a payout the provider already has', () => {
  const known = { ...base, providerRef: 'ref-1', attempts: 3 };

  it('only asks for the status, never sends it again', async () => {
    for (const [reported, outcome] of [
      ['succeeded', 'paid'],
      ['failed', 'failed'],
      ['pending', 'pending'],
    ] as const) {
      const { provider, calls } = scripted({ query: () => status(reported) });
      expect(await attemptPayout(provider, known)).toMatchObject({
        outcome,
        providerRef: 'ref-1',
      });
      expect(calls).toEqual(['query:ref-1']);
    }
  });

  it('treats another amount as unknown', async () => {
    const { provider } = scripted({ query: () => status('succeeded', 50_000n) });
    expect(await attemptPayout(provider, known)).toMatchObject({ outcome: 'unknown' });
    const noAmount = scripted({ query: () => status('succeeded', null) });
    expect(await attemptPayout(noAmount.provider, known)).toMatchObject({ outcome: 'paid' });
  });

  it('retries a status query that got no answer; a refusal to answer is unknown', async () => {
    const down = scripted({ query: () => Promise.reject(timeout()) });
    expect(await attemptPayout(down.provider, known)).toMatchObject({
      outcome: 'retry',
      providerRef: 'ref-1',
    });
    const refusing = scripted({
      query: () => Promise.reject(new PaymentProviderError('chapa', 'unknown reference')),
    });
    expect(await attemptPayout(refusing.provider, known)).toMatchObject({ outcome: 'unknown' });
  });

  it('asks the mock provider about a pending payout', async () => {
    const result = await attemptPayout(mock(), {
      ...base,
      providerRef: `mockpay_p_${base.payoutId}`,
      attempts: 2,
    });
    expect(result).toMatchObject({ outcome: 'paid' });
  });
});

describe('payoutRetryDelayMs', () => {
  it('doubles from one minute and stops at six hours', () => {
    expect([1, 2, 3, 4, 5].map(payoutRetryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(payoutRetryDelayMs(9)).toBe(256 * 60_000);
    expect(payoutRetryDelayMs(10)).toBe(6 * 3_600_000);
    expect(payoutRetryDelayMs(1_000)).toBe(6 * 3_600_000);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => payoutRetryDelayMs(bad)).toThrow(RangeError);
    }
  });
});

describe('eventFromStatusQuery', () => {
  it('builds an event whose id is stable per kind, status and reference', () => {
    const result: ProviderStatusResult = {
      providerRef: 'tx-1',
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
      raw: { a: 1 },
    };
    const event = eventFromStatusQuery('deposit', result);
    expect(event).toEqual({
      providerEventId: 'query:deposit:succeeded:tx-1',
      kind: 'deposit',
      providerRef: 'tx-1',
      status: 'succeeded',
      amount: 15_000n,
      currency: 'ETB',
      raw: { a: 1 },
    });
    expect(eventFromStatusQuery('deposit', result).providerEventId).toBe(event.providerEventId);
    expect(eventFromStatusQuery('deposit', { ...result, status: 'pending' }).providerEventId).toBe(
      'query:deposit:pending:tx-1',
    );
    expect(eventFromStatusQuery('payout', result).providerEventId).toBe(
      'query:payout:succeeded:tx-1',
    );
  });
});
