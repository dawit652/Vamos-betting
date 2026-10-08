import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@vamos/config';
import { createDb, type Database } from '@vamos/db';
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
  /** Cryptographically secure random bytes (session and CSRF tokens). */
  randomBytes: (size: number) => Buffer;
  /** Redis channel of live deltas relayed by GET /live/stream (default LIVE_CHANNEL; tests use their own). */
  liveChannel?: string;
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

/** Production wiring used by `server.ts`. Throws on a provider that has no adapter yet. */
export function createDefaultDeps(config: AppConfig): DefaultDeps {
  const kyc = createKycVerifier(config);
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
    randomBytes: (size) => randomBytes(size),
    close: async () => {
      await Promise.allSettled([handle.close(), redis.quit()]);
    },
  };
}
