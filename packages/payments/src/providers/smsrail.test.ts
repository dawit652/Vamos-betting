import { DEMO_COLLECTION_ACCOUNTS, loadConfig } from '@vamos/config';
import { describe, expect, it } from 'vitest';
import { ProviderNotConfiguredError, WebhookVerificationError } from '../errors';
import { createPaymentProviders } from '../factory';
import { SmsRailProvider } from './smsrail';

const deps = {
  fetch: globalThis.fetch,
  clock: () => new Date('2026-10-10T09:00:00Z'),
  randomBytes: (n: number) => new Uint8Array(n),
};
const SECRET = 's'.repeat(40);

describe('SmsRailProvider', () => {
  it('opens deposits as transfers keyed by the intent and never sends payouts', async () => {
    const provider = new SmsRailProvider({
      mode: 'simulated',
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
    });
    expect(provider.capabilities).toEqual({ deposits: true, payouts: true, manual: true });
    await expect(
      provider.initiateDeposit({
        intentId: 'intent-1',
        amount: 10037n,
        phone: '+251911000000',
        callbackUrl: '',
        returnUrl: '',
      }),
    ).resolves.toEqual({ kind: 'transfer', providerRef: 'intent-1' });
    await expect(provider.initiatePayout()).rejects.toThrow(/by hand/);
    await expect(provider.verifyWebhook()).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(provider.queryDeposit('intent-1')).resolves.toMatchObject({ status: 'pending' });
  });

  it('accepts the gateway secret only on the live rail, in constant time', () => {
    const live = new SmsRailProvider({
      mode: 'live',
      gatewaySecret: SECRET,
      collectionAccounts: [
        {
          id: 'telebirr:0911000000',
          institution: 'telebirr',
          account: '0911000000',
          name: 'Vamos Betting PLC',
        },
      ],
    });
    expect(live.gatewaySecretMatches(SECRET)).toBe(true);
    expect(live.gatewaySecretMatches(`${SECRET}x`)).toBe(false);
    expect(live.gatewaySecretMatches(undefined)).toBe(false);
    expect(live.gatewaySecretMatches('')).toBe(false);
    const simulated = new SmsRailProvider({
      mode: 'simulated',
      gatewaySecret: SECRET,
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
    });
    expect(simulated.gatewaySecretMatches(SECRET)).toBe(false);
  });

  it('applies the gateway address allowlist', () => {
    const open = new SmsRailProvider({
      mode: 'simulated',
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
    });
    expect(open.gatewayAddressAllowed('10.0.0.1')).toBe(true);
    const locked = new SmsRailProvider({
      mode: 'simulated',
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
      gatewayAllowlist: ['196.188.1.2'],
    });
    expect(locked.gatewayAddressAllowed('196.188.1.2')).toBe(true);
    expect(locked.gatewayAddressAllowed('10.0.0.1')).toBe(false);
  });

  it('refuses unknown institutions and a weak live secret; no accounts is allowed', () => {
    expect(
      () =>
        new SmsRailProvider({
          mode: 'simulated',
          collectionAccounts: [
            { id: 'nosuchbank:12345', institution: 'nosuchbank', account: '12345', name: 'X' },
          ],
        }),
    ).toThrow(ProviderNotConfiguredError);
    // The back office's list may hold the accounts instead of SMS_COLLECTION_ACCOUNTS.
    expect(
      new SmsRailProvider({ mode: 'simulated', collectionAccounts: [] }).collectionAccounts,
    ).toEqual([]);
    expect(
      () =>
        new SmsRailProvider({
          mode: 'live',
          gatewaySecret: 'short',
          collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
        }),
    ).toThrow(/SMS_GATEWAY_SECRET/);
  });

  it('lists our accounts at an institution (the receipt receivers)', () => {
    const provider = new SmsRailProvider({
      mode: 'simulated',
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
    });
    expect(provider.collectionAccountsAt('telebirr')).toEqual(['0900000000']);
    expect(provider.collectionAccountsAt('awash')).toEqual([]);
  });

  it('takes the back office list: active ones are offered, deleted ones still count for SMS', () => {
    const provider = new SmsRailProvider({
      mode: 'simulated',
      collectionAccounts: DEMO_COLLECTION_ACCOUNTS,
    });
    const awash = {
      id: 'awash:01320000001',
      institution: 'awash',
      account: '01320000001',
      name: 'A',
    };
    const old = {
      id: 'cbe:1000000000099',
      institution: 'cbe',
      account: '1000000000099',
      name: 'B',
    };
    const unknown = {
      id: 'nosuchbank:12345',
      institution: 'nosuchbank',
      account: '12345',
      name: 'X',
    };
    provider.setCollectionAccounts({ active: [awash, unknown], known: [old, awash] });
    expect(provider.configuredAccounts).toHaveLength(DEMO_COLLECTION_ACCOUNTS.length);
    expect(provider.collectionAccounts.map((a) => a.id)).toEqual([awash.id]);
    expect(provider.knownCollectionAccounts.map((a) => a.id)).toEqual([awash.id, old.id]);
    expect(provider.collectionAccountIds).toEqual([awash.id, old.id]);
    expect(provider.collectionAccountsAt('cbe')).toEqual(['1000000000099']);
    expect(provider.collectionAccountIdAt('cbe')).toBe(old.id);
    expect(provider.collectionAccountsAt('telebirr')).toEqual([]);
  });

  it('is built by the factory from the config (simulated in demo mode)', () => {
    const config = loadConfig({ OPERATING_MODE: 'demo', PAYMENT_PROVIDERS: 'mock,sms' });
    const registry = createPaymentProviders(config, deps);
    const sms = registry.require('sms');
    expect(sms).toBeInstanceOf(SmsRailProvider);
    expect((sms as SmsRailProvider).mode).toBe('simulated');
  });
});
