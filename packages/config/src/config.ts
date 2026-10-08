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
  SESSION_SECRET: z.string().min(32).default(DEV_SESSION_SECRET),

  FEED_PROVIDER: z.enum(['mock', 'manual']).default('mock'),
  /** Simulated match minutes per real second for the mock live simulator. */
  SIM_SPEED: z.coerce.number().positive().default(1),

  PAYMENT_PROVIDERS: csv.default(['mock']),
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
  sessionSecret: string;
  feed: { provider: 'mock' | 'manual'; simSpeed: number };
  providers: { payments: string[]; kyc: 'mock' | 'fayda'; sms: 'mock' | 'http' };
  els: {
    licenseNumber: string | undefined;
    reporting: 'disabled' | 'file' | 'http';
    reportDir: string;
    reportUrl: string | undefined;
  };
  taxConfigConfirmed: boolean;
  features: { casino: boolean; virtuals: boolean; smsBetting: boolean; ussd: boolean };
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
    sessionSecret: e.SESSION_SECRET,
    feed: { provider: e.FEED_PROVIDER, simSpeed: e.SIM_SPEED },
    providers: { payments: e.PAYMENT_PROVIDERS, kyc: e.KYC_PROVIDER, sms: e.SMS_PROVIDER },
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
  if (config.nodeEnv === 'production' && config.sessionSecret === DEV_SESSION_SECRET) {
    problems.push('SESSION_SECRET must be set to a unique secret in production');
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
