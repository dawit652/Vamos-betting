import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '@vamos/config';
import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeFetch } from '../test/fakes';
import { ProviderNotConfiguredError, UnknownPaymentProviderError } from './errors';
import {
  createPaymentProvider,
  createPaymentProviders,
  paymentWebhookPath,
  paymentWebhookUrl,
} from './factory';
import { ChapaProvider } from './providers/chapa';
import { MockPaymentProvider } from './providers/mock';
import { CbeBirrProvider, MpesaEthiopiaProvider } from './providers/skeleton';
import { TelebirrProvider } from './providers/telebirr';

const deps = fakeDeps(fakeFetch([]).fetch);
const WEBHOOK_SECRET = 'whsec_0123456789abcdef0123456789abcdef';

const LICENSED = {
  NODE_ENV: 'production',
  OPERATING_MODE: 'licensed',
  KYC_PROVIDER: 'fayda',
  SMS_PROVIDER: 'http',
  FEED_PROVIDER: 'manual',
  TAX_CONFIG_CONFIRMED: 'true',
  SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-real-password-pepper-of-at-least-32-chars',
  ADMIN_TOTP_KEY: '7f'.repeat(32),
};

describe('createPaymentProviders', () => {
  it('builds the mock provider in demo mode', () => {
    const registry = createPaymentProviders(loadConfig({ OPERATING_MODE: 'demo' }), deps);
    expect(registry.names).toEqual(['mock']);
    expect(registry.require('mock')).toBeInstanceOf(MockPaymentProvider);
    expect(registry.require('mock').capabilities).toEqual({ deposits: true, payouts: true });
    expect(registry.get('chapa')).toBeUndefined();
    expect(registry.get('anything')).toBeUndefined();
    expect(() => registry.require('chapa')).toThrow(UnknownPaymentProviderError);
  });

  it('refuses the mock provider outside demo mode even if asked directly', () => {
    const config = loadConfig({
      ...LICENSED,
      PAYMENT_PROVIDERS: 'chapa',
      CHAPA_SECRET_KEY: 'k',
      CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(() => createPaymentProvider('mock', config, deps)).toThrow(ProviderNotConfiguredError);
  });

  it('builds Chapa in licensed mode and names missing credentials', () => {
    const config = loadConfig({ ...LICENSED, PAYMENT_PROVIDERS: 'chapa' });
    let error: unknown;
    try {
      createPaymentProviders(config, deps);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderNotConfiguredError);
    expect((error as ProviderNotConfiguredError).missing).toEqual([
      'CHAPA_SECRET_KEY',
      'CHAPA_WEBHOOK_SECRET',
    ]);
    const ok = loadConfig({
      ...LICENSED,
      PAYMENT_PROVIDERS: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK-live',
      CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const chapa = createPaymentProviders(ok, deps).require('chapa');
    expect(chapa).toBeInstanceOf(ChapaProvider);
    expect(chapa.capabilities).toEqual({ deposits: true, payouts: true });
  });

  it('refuses a Chapa webhook secret shorter than 32 characters', () => {
    const weak = loadConfig({
      ...LICENSED,
      PAYMENT_PROVIDERS: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK-live',
      CHAPA_WEBHOOK_SECRET: 'whsec',
    });
    let error: unknown;
    try {
      createPaymentProviders(weak, deps);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderNotConfiguredError);
    expect((error as ProviderNotConfiguredError).missing).toEqual(['CHAPA_WEBHOOK_SECRET']);
    expect((error as Error).message).toMatch(/at least 32 characters/);
    const justLongEnough = loadConfig({
      ...LICENSED,
      PAYMENT_PROVIDERS: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK-live',
      CHAPA_WEBHOOK_SECRET: 'w'.repeat(32),
    });
    expect(createPaymentProviders(justLongEnough, deps).require('chapa')).toBeInstanceOf(
      ChapaProvider,
    );
  });

  it('builds telebirr from PEM keys written with \\n escapes', () => {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const escape = (pem: string) => pem.replace(/\n/g, '\\n');
    const config = loadConfig({
      ...LICENSED,
      PAYMENT_PROVIDERS: 'telebirr',
      TELEBIRR_BASE_URL: 'https://telebirr.test/apiaccess',
      TELEBIRR_CHECKOUT_URL: 'https://telebirr.test/paygate',
      TELEBIRR_FABRIC_APP_ID: 'f',
      TELEBIRR_APP_SECRET: 's',
      TELEBIRR_MERCHANT_APP_ID: 'm',
      TELEBIRR_SHORT_CODE: '123456',
      TELEBIRR_PRIVATE_KEY: escape(keys.privateKey),
      TELEBIRR_PUBLIC_KEY: escape(keys.publicKey),
    });
    const telebirr = createPaymentProviders(config, deps).require('telebirr');
    expect(telebirr).toBeInstanceOf(TelebirrProvider);
    // telebirr B2C payouts need a separate agreement: deposits only.
    expect(telebirr.capabilities).toEqual({ deposits: true, payouts: false });
    const missing = loadConfig({ ...LICENSED, PAYMENT_PROVIDERS: 'telebirr' });
    expect(() => createPaymentProviders(missing, deps)).toThrow(/TELEBIRR_BASE_URL/);
  });

  it('refuses the skeleton providers and unknown names at startup', () => {
    for (const name of ['cbebirr', 'mpesa-et']) {
      const config = loadConfig({ ...LICENSED, PAYMENT_PROVIDERS: name });
      expect(() => createPaymentProviders(config, deps)).toThrow(ProviderNotConfiguredError);
    }
    const config = loadConfig({ ...LICENSED, PAYMENT_PROVIDERS: 'paypal' });
    expect(() => createPaymentProviders(config, deps)).toThrow(UnknownPaymentProviderError);
  });

  it('builds webhook URLs from the callback base URL', () => {
    expect(paymentWebhookPath('chapa')).toBe('/payments/webhooks/chapa');
    expect(paymentWebhookUrl('https://api.example.et/', 'mpesa-et')).toBe(
      'https://api.example.et/payments/webhooks/mpesa-et',
    );
  });
});

describe('skeleton providers', () => {
  it('throw ProviderNotConfiguredError from every call', async () => {
    for (const provider of [new CbeBirrProvider(), new MpesaEthiopiaProvider()]) {
      expect(provider.capabilities).toEqual({ deposits: false, payouts: false });
      await expect(provider.initiateDeposit()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
      await expect(provider.verifyWebhook()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
      await expect(provider.queryDeposit()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
      await expect(provider.initiatePayout()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
      await expect(provider.queryPayout()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    }
  });
});
