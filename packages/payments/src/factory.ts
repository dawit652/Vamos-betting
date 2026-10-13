import type { AppConfig } from '@vamos/config';
import { ProviderNotConfiguredError, UnknownPaymentProviderError } from './errors';
import { ChapaProvider } from './providers/chapa';
import { MockPaymentProvider } from './providers/mock';
import { CbeBirrProvider, MpesaEthiopiaProvider } from './providers/skeleton';
import { TelebirrProvider } from './providers/telebirr';
import {
  isPaymentProviderName,
  type PaymentProvider,
  type PaymentProviderName,
  type ProviderDeps,
} from './types';
import { joinUrl } from './util';

export type PaymentsConfig = Pick<AppConfig, 'mode' | 'providers' | 'payments'>;

/** The enabled providers (PAYMENT_PROVIDERS), built once at startup. */
export interface PaymentProviderRegistry {
  /** Enabled provider names, in PAYMENT_PROVIDERS order. */
  readonly names: readonly PaymentProviderName[];
  /** The provider, or undefined when it is not enabled (e.g. a webhook for a disabled provider). */
  get(name: string): PaymentProvider | undefined;
  /** The provider, or UnknownPaymentProviderError when it is not enabled. */
  require(name: string): PaymentProvider;
}

function requireValues<K extends string>(
  provider: string,
  values: Record<K, string | undefined>,
): Record<K, string> {
  const missing = Object.entries(values)
    .filter(([, value]) => value === undefined || value === '')
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new ProviderNotConfiguredError(
      provider,
      `${provider} is enabled but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
      missing,
    );
  }
  return values as Record<K, string>;
}

/**
 * Shortest webhook HMAC secret accepted. A short secret could be guessed and
 * then used to sign webhooks that credit deposits.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

function requireStrongSecret(provider: string, name: string, value: string): void {
  if (value.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new ProviderNotConfiguredError(
      provider,
      `${name} must have at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
      [name],
    );
  }
}

/**
 * Builds one provider. Throws ProviderNotConfiguredError when its credentials
 * are missing (or a webhook secret is shorter than MIN_WEBHOOK_SECRET_LENGTH)
 * or it is a skeleton (cbebirr, mpesa-et), and refuses the mock
 * provider outside demo mode (on top of the @vamos/config guard).
 */
export function createPaymentProvider(
  name: string,
  config: PaymentsConfig,
  deps: ProviderDeps,
): PaymentProvider {
  if (!isPaymentProviderName(name)) {
    throw new UnknownPaymentProviderError(name, `unknown payment provider "${name}"`);
  }
  const p = config.payments;
  switch (name) {
    case 'mock':
      if (config.mode !== 'demo') {
        throw new ProviderNotConfiguredError(
          name,
          'the mock payment provider only runs in demo mode',
        );
      }
      return new MockPaymentProvider({ webhookSecret: p.mock.webhookSecret, clock: deps.clock });
    case 'chapa': {
      const v = requireValues(name, {
        CHAPA_SECRET_KEY: p.chapa.secretKey,
        CHAPA_WEBHOOK_SECRET: p.chapa.webhookSecret,
      });
      requireStrongSecret(name, 'CHAPA_WEBHOOK_SECRET', v.CHAPA_WEBHOOK_SECRET);
      return new ChapaProvider(
        {
          baseUrl: p.chapa.baseUrl,
          secretKey: v.CHAPA_SECRET_KEY,
          webhookSecret: v.CHAPA_WEBHOOK_SECRET,
        },
        deps,
      );
    }
    case 'telebirr': {
      const t = p.telebirr;
      const v = requireValues(name, {
        TELEBIRR_BASE_URL: t.baseUrl,
        TELEBIRR_CHECKOUT_URL: t.checkoutUrl,
        TELEBIRR_FABRIC_APP_ID: t.fabricAppId,
        TELEBIRR_APP_SECRET: t.appSecret,
        TELEBIRR_MERCHANT_APP_ID: t.merchantAppId,
        TELEBIRR_SHORT_CODE: t.shortCode,
        TELEBIRR_PRIVATE_KEY: t.privateKey,
        TELEBIRR_PUBLIC_KEY: t.publicKey,
      });
      return new TelebirrProvider(
        {
          baseUrl: v.TELEBIRR_BASE_URL,
          checkoutUrl: v.TELEBIRR_CHECKOUT_URL,
          fabricAppId: v.TELEBIRR_FABRIC_APP_ID,
          appSecret: v.TELEBIRR_APP_SECRET,
          merchantAppId: v.TELEBIRR_MERCHANT_APP_ID,
          shortCode: v.TELEBIRR_SHORT_CODE,
          privateKey: v.TELEBIRR_PRIVATE_KEY,
          publicKey: v.TELEBIRR_PUBLIC_KEY,
        },
        deps,
      );
    }
    case 'cbebirr':
      throw new CbeBirrProvider().notConfiguredError();
    case 'mpesa-et':
      throw new MpesaEthiopiaProvider().notConfiguredError();
  }
}

/**
 * Builds every provider in PAYMENT_PROVIDERS. Call it at startup (API and
 * worker) and refuse to start on ProviderNotConfiguredError /
 * UnknownPaymentProviderError, like the other provider factories.
 */
export function createPaymentProviders(
  config: PaymentsConfig,
  deps: ProviderDeps,
): PaymentProviderRegistry {
  const providers = new Map<PaymentProviderName, PaymentProvider>();
  for (const name of config.providers.payments) {
    const provider = createPaymentProvider(name, config, deps);
    providers.set(provider.name, provider);
  }
  const names = [...providers.keys()];
  return {
    names,
    get: (name) => (isPaymentProviderName(name) ? providers.get(name) : undefined),
    require: (name) => {
      const provider = isPaymentProviderName(name) ? providers.get(name) : undefined;
      if (provider === undefined) throw new UnknownPaymentProviderError(name);
      return provider;
    },
  };
}

/** Path of a provider's webhook route on the API. */
export function paymentWebhookPath(provider: PaymentProviderName): string {
  return `/payments/webhooks/${provider}`;
}

/** The URL a provider calls back: PAYMENT_CALLBACK_BASE_URL + paymentWebhookPath. */
export function paymentWebhookUrl(callbackBaseUrl: string, provider: PaymentProviderName): string {
  return joinUrl(callbackBaseUrl, paymentWebhookPath(provider));
}
