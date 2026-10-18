import { z } from 'zod';

/**
 * Runtime configuration shared by the API and the worker.
 *
 * Vamos runs in `demo` (play-money) mode by default. `licensed` mode handles
 * real money and is refused at startup unless every compliance prerequisite
 * is configured. All Ethiopian sports-betting licences were revoked on
 * 15 Dec 2025; real-money operation must wait for a licence under the new
 * Ethiopian Lottery Service framework.
 */

export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me-0123456789';

/**
 * HMAC key of the mock payment provider's webhooks (demo mode only: the
 * licensed-mode guard refuses the mock provider altogether).
 */
export const DEV_MOCK_PAYMENT_WEBHOOK_SECRET = 'dev-only-mock-payment-webhook-secret-0123456789';

/**
 * AES-256-GCM key (32 bytes, hex) that encrypts the back-office staff TOTP
 * secrets at rest (ADMIN_TOTP_KEY). Development and the demo only: production
 * and licensed mode refuse it.
 */
export const DEV_ADMIN_TOTP_KEY =
  'aed9c3710ea4fb29e5d03551229bacfb328e796012897a735bda51c7d3432e4e';

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
/** 32 bytes in base64 (standard or URL-safe alphabet, padding optional). */
const BASE64_KEY_RE = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * Decodes a 32-byte key written as 64 hex characters or as base64 (standard
 * or URL-safe, with or without the padding). Returns null for anything else.
 */
export function parseAdminTotpKey(value: string): Buffer | null {
  const text = value.trim();
  if (HEX_KEY_RE.test(text)) return Buffer.from(text, 'hex');
  if (!BASE64_KEY_RE.test(text)) return null;
  const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === 32 ? key : null;
}

/** True when `key` is the published development key, however it was written. */
export function isDevAdminTotpKey(key: Buffer): boolean {
  return key.equals(Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex'));
}

/** An optional secret: unset and blank both mean "not configured". */
const secret = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

/** A PEM key from the environment, where newlines are often written as "\n". */
const pem = secret.transform((value) => value?.replace(/\\n/g, '\n'));

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const bool = z.stringbool();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPERATING_MODE: z.enum(['demo', 'licensed']).default('demo'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
  ADMIN_WEB_URL: z.url().default('http://localhost:3001'),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1).default('postgres://vamos:vamos@localhost:5432/vamos'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** Key prefix of the worker's BullMQ queues (tests and parallel stacks use their own). */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "_" or "-" (at most 64)')
    .default('vamos'),
  SESSION_SECRET: z.string().min(32).default(DEV_SESSION_SECRET),
  /** Encrypts staff TOTP secrets at rest: 32 bytes as 64 hex characters or base64. */
  ADMIN_TOTP_KEY: z
    .string()
    .refine((value) => parseAdminTotpKey(value) !== null, {
      message: 'must be 32 bytes written as 64 hex characters or base64',
    })
    .default(DEV_ADMIN_TOTP_KEY),

  FEED_PROVIDER: z.enum(['mock', 'manual']).default('mock'),
  /** Simulated match minutes per real second for the mock live simulator. */
  SIM_SPEED: z.coerce.number().positive().default(1),
  /**
   * Rolling demo fixtures of the mock feed: one kicks off every N minutes
   * (whole minutes, at least 1), generated up to the horizon ahead. Lower
   * both (e.g. 1 and 10) so a fixture starts within a minute or two in e2e.
   */
  FEED_ROLLING_EVERY_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  FEED_ROLLING_HORIZON_MINUTES: z.coerce.number().int().min(0).max(4320).default(120),

  PAYMENT_PROVIDERS: csv.default(['mock']),
  /**
   * Public base URL of the API that payment providers call back (webhooks,
   * see paymentWebhookUrl in @vamos/payments); defaults to PUBLIC_API_URL.
   * A redirect checkout sends the player back to the web app instead
   * (PUBLIC_WEB_URL).
   */
  PAYMENT_CALLBACK_BASE_URL: z.url().optional(),
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(16).default(DEV_MOCK_PAYMENT_WEBHOOK_SECRET),
  CHAPA_BASE_URL: z.url().default('https://api.chapa.co/v1'),
  CHAPA_SECRET_KEY: secret,
  CHAPA_WEBHOOK_SECRET: secret,
  TELEBIRR_BASE_URL: z.url().optional(),
  TELEBIRR_CHECKOUT_URL: z.url().optional(),
  TELEBIRR_FABRIC_APP_ID: secret,
  TELEBIRR_APP_SECRET: secret,
  TELEBIRR_MERCHANT_APP_ID: secret,
  TELEBIRR_SHORT_CODE: secret,
  /** Our RSA private key (PEM) that signs telebirr requests. */
  TELEBIRR_PRIVATE_KEY: pem,
  /** telebirr's RSA public key (PEM) that verifies its notify_url callbacks. */
  TELEBIRR_PUBLIC_KEY: pem,
  KYC_PROVIDER: z.enum(['mock', 'fayda']).default('mock'),
  SMS_PROVIDER: z.enum(['mock', 'http']).default('mock'),

  ELS_LICENSE_NUMBER: z.string().trim().min(1).optional(),
  ELS_REPORTING: z.enum(['disabled', 'file', 'http']).default('file'),
  ELS_REPORT_DIR: z.string().default('./var/els-reports'),
  ELS_REPORT_URL: z.url().optional(),
  TAX_CONFIG_CONFIRMED: bool.default(false),

  FEATURE_CASINO: bool.default(false),
  FEATURE_VIRTUALS: bool.default(false),
  FEATURE_SMS_BETTING: bool.default(false),
  FEATURE_USSD: bool.default(false),
});

export type OperatingMode = 'demo' | 'licensed';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  mode: OperatingMode;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  api: { host: string; port: number; publicUrl: string };
  web: { publicUrl: string; adminUrl: string };
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  sessionSecret: string;
  /** The back office (staff accounts). */
  admin: {
    /** AES-256-GCM key (32 bytes) of the staff TOTP secrets (ADMIN_TOTP_KEY). */
    totpKey: Buffer;
  };
  feed: {
    provider: 'mock' | 'manual';
    simSpeed: number;
    /** Rolling demo fixtures of the mock feed (FEED_ROLLING_*). */
    rolling: { everyMinutes: number; horizonMinutes: number };
  };
  providers: { payments: string[]; kyc: 'mock' | 'fayda'; sms: 'mock' | 'http' };
  /**
   * Payment provider settings (PAYMENT_*, MOCK_PAYMENT_*, CHAPA_*, TELEBIRR_*).
   * Which providers are enabled is `providers.payments`; credentials are
   * checked when a provider is built (@vamos/payments), not here.
   */
  payments: PaymentProvidersConfig;
  els: {
    licenseNumber: string | undefined;
    reporting: 'disabled' | 'file' | 'http';
    reportDir: string;
    reportUrl: string | undefined;
  };
  taxConfigConfirmed: boolean;
  features: { casino: boolean; virtuals: boolean; smsBetting: boolean; ussd: boolean };
}

export interface PaymentProvidersConfig {
  /** Base URL of the provider webhooks (PAYMENT_CALLBACK_BASE_URL, else PUBLIC_API_URL). */
  callbackBaseUrl: string;
  mock: { webhookSecret: string };
  chapa: { baseUrl: string; secretKey: string | undefined; webhookSecret: string | undefined };
  telebirr: {
    baseUrl: string | undefined;
    checkoutUrl: string | undefined;
    fabricAppId: string | undefined;
    appSecret: string | undefined;
    merchantAppId: string | undefined;
    shortCode: string | undefined;
    privateKey: string | undefined;
    publicKey: string | undefined;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Returns every reason the given config may not run in `licensed` mode.
 * An empty array means licensed mode is permitted.
 */
export function licensedModeViolations(config: AppConfig): string[] {
  const problems: string[] = [];
  if (config.nodeEnv !== 'production') {
    problems.push(
      'NODE_ENV=production is required in licensed mode (Secure cookies, no dev tools)',
    );
  }
  if (config.sessionSecret === DEV_SESSION_SECRET) {
    problems.push(
      'SESSION_SECRET must be a unique secret in licensed mode (it keys OTP and ID hashes)',
    );
  }
  if (isDevAdminTotpKey(config.admin.totpKey)) {
    problems.push(
      'ADMIN_TOTP_KEY must be a unique key in licensed mode (it encrypts the staff TOTP secrets)',
    );
  }
  if (!config.els.licenseNumber) {
    problems.push(
      'ELS_LICENSE_NUMBER is required: real-money betting needs an Ethiopian Lottery Service licence',
    );
  }
  if (config.els.reporting === 'disabled') {
    problems.push('ELS_REPORTING must be "file" or "http" in licensed mode');
  }
  if (config.els.reporting === 'http' && !config.els.reportUrl) {
    problems.push('ELS_REPORT_URL is required when ELS_REPORTING=http');
  }
  const realPaymentProviders = config.providers.payments.filter((p) => p !== 'mock');
  if (config.providers.payments.includes('mock')) {
    problems.push('the "mock" payment provider is not allowed in licensed mode');
  }
  if (realPaymentProviders.length === 0) {
    problems.push('at least one real payment provider must be configured in PAYMENT_PROVIDERS');
  }
  if (config.providers.kyc === 'mock') {
    problems.push('KYC_PROVIDER must be a real identity provider (e.g. "fayda") in licensed mode');
  }
  if (config.providers.sms === 'mock') {
    problems.push('SMS_PROVIDER must be a real SMS gateway in licensed mode');
  }
  if (config.feed.provider === 'mock') {
    problems.push('FEED_PROVIDER "mock" (simulated odds) is not allowed in licensed mode');
  }
  if (!config.taxConfigConfirmed) {
    problems.push(
      'TAX_CONFIG_CONFIRMED=true is required after the winnings-tax settings are confirmed with counsel',
    );
  }
  if (config.features.casino || config.features.virtuals) {
    problems.push('casino and virtual games are not licensable under the current ELS stance');
  }
  return problems;
}

/** The decoded ADMIN_TOTP_KEY (the schema has already checked it). */
function adminTotpKeyOf(value: string): Buffer {
  const key = parseAdminTotpKey(value);
  if (key === null) {
    throw new ConfigError([
      'ADMIN_TOTP_KEY: must be 32 bytes written as 64 hex characters or base64',
    ]);
  }
  return key;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;

  const config: AppConfig = {
    nodeEnv: e.NODE_ENV,
    mode: e.OPERATING_MODE,
    logLevel: e.LOG_LEVEL,
    api: { host: e.API_HOST, port: e.API_PORT, publicUrl: e.PUBLIC_API_URL },
    web: { publicUrl: e.PUBLIC_WEB_URL, adminUrl: e.ADMIN_WEB_URL },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    queuePrefix: e.QUEUE_PREFIX,
    sessionSecret: e.SESSION_SECRET,
    admin: { totpKey: adminTotpKeyOf(e.ADMIN_TOTP_KEY) },
    feed: {
      provider: e.FEED_PROVIDER,
      simSpeed: e.SIM_SPEED,
      rolling: {
        everyMinutes: e.FEED_ROLLING_EVERY_MINUTES,
        horizonMinutes: e.FEED_ROLLING_HORIZON_MINUTES,
      },
    },
    providers: { payments: e.PAYMENT_PROVIDERS, kyc: e.KYC_PROVIDER, sms: e.SMS_PROVIDER },
    payments: {
      callbackBaseUrl: e.PAYMENT_CALLBACK_BASE_URL ?? e.PUBLIC_API_URL,
      mock: { webhookSecret: e.MOCK_PAYMENT_WEBHOOK_SECRET },
      chapa: {
        baseUrl: e.CHAPA_BASE_URL,
        secretKey: e.CHAPA_SECRET_KEY,
        webhookSecret: e.CHAPA_WEBHOOK_SECRET,
      },
      telebirr: {
        baseUrl: e.TELEBIRR_BASE_URL,
        checkoutUrl: e.TELEBIRR_CHECKOUT_URL,
        fabricAppId: e.TELEBIRR_FABRIC_APP_ID,
        appSecret: e.TELEBIRR_APP_SECRET,
        merchantAppId: e.TELEBIRR_MERCHANT_APP_ID,
        shortCode: e.TELEBIRR_SHORT_CODE,
        privateKey: e.TELEBIRR_PRIVATE_KEY,
        publicKey: e.TELEBIRR_PUBLIC_KEY,
      },
    },
    els: {
      licenseNumber: e.ELS_LICENSE_NUMBER,
      reporting: e.ELS_REPORTING,
      reportDir: e.ELS_REPORT_DIR,
      reportUrl: e.ELS_REPORT_URL,
    },
    taxConfigConfirmed: e.TAX_CONFIG_CONFIRMED,
    features: {
      casino: e.FEATURE_CASINO,
      virtuals: e.FEATURE_VIRTUALS,
      smsBetting: e.FEATURE_SMS_BETTING,
      ussd: e.FEATURE_USSD,
    },
  };

  const problems: string[] = [];
  if (new URL(config.web.adminUrl).origin === new URL(config.web.publicUrl).origin) {
    // CORS gives the back office origin /admin/* and the player origin the rest, so a script on
    // the player site cannot drive the staff API. One shared origin would undo that.
    problems.push('ADMIN_WEB_URL must be on a different origin from PUBLIC_WEB_URL');
  }
  if (config.nodeEnv === 'production' && config.sessionSecret === DEV_SESSION_SECRET) {
    problems.push('SESSION_SECRET must be set to a unique secret in production');
  }
  if (config.nodeEnv === 'production' && isDevAdminTotpKey(config.admin.totpKey)) {
    // The development key is public: staff TOTP secrets would be readable from a database copy.
    problems.push('ADMIN_TOTP_KEY must be set to a unique key in production');
  }
  if (
    config.nodeEnv === 'production' &&
    config.providers.payments.includes('mock') &&
    config.payments.mock.webhookSecret === DEV_MOCK_PAYMENT_WEBHOOK_SECRET
  ) {
    // Anyone could forge the public demo's mock deposit webhooks otherwise.
    problems.push('MOCK_PAYMENT_WEBHOOK_SECRET must be set to a unique secret in production');
  }
  if (config.mode === 'demo') {
    const nonMock = config.providers.payments.filter((p) => p !== 'mock');
    if (nonMock.length > 0) {
      problems.push(
        `demo mode only allows the "mock" payment provider (got: ${nonMock.join(', ')}); real payments require licensed mode`,
      );
    }
  } else {
    problems.push(...licensedModeViolations(config));
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return config;
}

export function isDemo(config: Pick<AppConfig, 'mode'>): boolean {
  return config.mode === 'demo';
}
