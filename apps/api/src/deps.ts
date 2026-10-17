import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@vamos/config';
import { createDb, type Database } from '@vamos/db';
import { createPaymentProviders, type PaymentProviderRegistry } from '@vamos/payments';
import { Redis } from 'ioredis';
import { MockKycVerifier, type KycVerifier } from './providers/kyc';
import { MockSmsProvider, type SmsProvider } from './providers/sms';

/**
 * Everything the API needs from the outside world. Tests build their own
 * (throwaway database, prefixed Redis, fixed clock, mock providers).
 */
export interface AppDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  /** Current time. Business logic must use this rather than `new Date()`. */
  clock: () => Date;
  sms: SmsProvider;
  kyc: KycVerifier;
  /**
   * The enabled payment providers (PAYMENT_PROVIDERS). Demo mode allows only
   * the play-money mock provider (@vamos/config guard, and the factory refuses
   * the mock outside demo mode).
   */
  payments: PaymentProviderRegistry;
  /** Cryptographically secure random bytes (session and CSRF tokens). */
  randomBytes: (size: number) => Buffer;
  /**
   * Waits `ms` (default: a timer). Requests that must wait use it, such as an
   * in-play cash-out waiting the live bet delay; tests move their clock instead.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Redis channel of live deltas relayed by GET /live/stream (default LIVE_CHANNEL; tests use their own). */
  liveChannel?: string;
  /**
   * Prefix of the per-player Redis channels relayed by GET /me/stream
   * (default `vamos:user:`, see userChannel in @vamos/contracts; tests use
   * their own). The worker must publish under the same prefix.
   */
  userChannelPrefix?: string;
}

export interface DefaultDeps extends AppDeps {
  /** Closes the database pool and the Redis connection. */
  close: () => Promise<void>;
}

/** Thrown at startup when the configuration names a provider that has no adapter yet. */
export class ProviderNotImplementedError extends Error {
  constructor(kind: string, name: string) {
    super(
      `${kind}="${name}" is not implemented yet. ` +
        `Use the "mock" provider (demo mode) until its adapter is built.`,
    );
    this.name = 'ProviderNotImplementedError';
  }
}

export function createSmsProvider(config: AppConfig, db: Database): SmsProvider {
  switch (config.providers.sms) {
    case 'mock':
      return new MockSmsProvider(db);
    default:
      throw new ProviderNotImplementedError('SMS_PROVIDER', config.providers.sms);
  }
}

export function createKycVerifier(config: AppConfig): KycVerifier {
  switch (config.providers.kyc) {
    case 'mock':
      return new MockKycVerifier();
    default:
      throw new ProviderNotImplementedError('KYC_PROVIDER', config.providers.kyc);
  }
}

/**
 * The payment providers of PAYMENT_PROVIDERS, with the real fetch, clock and
 * random source. Throws ProviderNotConfiguredError / UnknownPaymentProviderError
 * (@vamos/payments) for a provider that cannot run, so the API refuses to start.
 */
export function createPaymentRegistry(config: AppConfig): PaymentProviderRegistry {
  return createPaymentProviders(config, {
    fetch: globalThis.fetch,
    clock: () => new Date(),
    randomBytes: (size) => randomBytes(size),
  });
}

/**
 * Production wiring used by `server.ts`. Throws on a provider that has no
 * adapter yet, and on a payment provider that is not configured.
 */
export function createDefaultDeps(config: AppConfig): DefaultDeps {
  const kyc = createKycVerifier(config);
  const payments = createPaymentRegistry(config);
  // The pool connects lazily, so nothing is open yet if the SMS provider is rejected.
  const handle = createDb(config.databaseUrl);
  let sms: SmsProvider;
  try {
    sms = createSmsProvider(config, handle.db);
  } catch (error) {
    void handle.close();
    throw error;
  }
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  return {
    config,
    db: handle.db,
    redis,
    clock: () => new Date(),
    sms,
    kyc,
    payments,
    randomBytes: (size) => randomBytes(size),
    close: async () => {
      await Promise.allSettled([handle.close(), redis.quit()]);
    },
  };
}
