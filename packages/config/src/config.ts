import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Runtime configuration shared by the API and the worker.
 *
 * Nahubet runs in `demo` (play-money) mode by default. `licensed` mode handles
 * real money and is refused at startup unless every compliance prerequisite
 * is configured.
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

/**
 * HMAC key of the mock SMS aggregator's inbound webhooks (SMS_WEBHOOK_SECRET).
 * Development and the demo only: production refuses it while SMS betting is on.
 */
export const DEV_SMS_WEBHOOK_SECRET = 'dev-only-sms-aggregator-webhook-secret-0123456789';

/**
 * Shared secret the mock USSD aggregator sends with every callback
 * (USSD_SHARED_SECRET). Development and the demo only: production refuses it
 * while USSD is on.
 */
export const DEV_USSD_SHARED_SECRET = 'dev-only-ussd-aggregator-shared-secret-0123456789';

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

/** Fastify `trustProxy`: false, or the addresses / CIDRs of the trusted proxies. */
export type TrustProxySetting = false | string[];

/** Address ranges proxy-addr knows by name. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrCidr(value: string): boolean {
  if (NAMED_RANGES.has(value)) return true;
  const [address = '', prefix, ...rest] = value.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * Parses TRUST_PROXY, which says whose X-Forwarded-For may set the client
 * address of an API request (used for rate limits, sessions and the audit log):
 * - unset, empty, `false` or `0`: nobody. The address is the TCP peer.
 * - a comma-separated list of the proxies' addresses or CIDRs (or
 *   `loopback`, `linklocal`, `uniquelocal`), e.g. `10.0.0.0/8` for the load
 *   balancer subnet. X-Forwarded-For is then read right to left, skipping
 *   those proxies.
 *
 * `true` is refused: it would trust every hop, so any client could choose its
 * own address and escape every per-address limit. A hop count is refused too,
 * because it cannot check who the immediate peer is (Fastify ignores it).
 * Throws ConfigError.
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const text = value?.trim() ?? '';
  if (text === '' || text === 'false' || text === '0') return false;
  if (text === 'true' || /^\d+$/.test(text)) {
    throw new ConfigError([
      `TRUST_PROXY=${text} cannot tell a proxy from a client that sends X-Forwarded-For itself. ` +
        'List the addresses or CIDRs of the proxies in front of the API instead (e.g. 10.0.0.0/8).',
    ]);
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalid = entries.filter((entry) => !isAddressOrCidr(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new ConfigError([
      `TRUST_PROXY must be false or proxy addresses/CIDRs (invalid: ${invalid.join(', ') || text})`,
    ]);
  }
  return entries;
}

/** Hosts a browser treats as a secure context over plain http (local stacks only). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a public URL is safe for production: https, or http on a loopback host. */
function isProductionSafeUrl(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Whether a path is absolute in POSIX form (`/var/scraper`) or Windows form
 * (`C:\scraper`, `C:/scraper`, `\\server\share`). A drive-relative `C:scraper` is not.
 */
function isAbsolutePath(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** A header value: printable characters only (no control characters or line breaks). */
const HEADER_TEXT_RE = /^[\u0020-\u007e]+$/;

/** A contact that sources can write to: an http(s) URL or an email address. */
function isScraperContact(value: string): boolean {
  // It goes into the User-Agent header, inside parentheses: printable ASCII, no spaces or brackets.
  if (!HEADER_TEXT_RE.test(value) || /[\s()]/.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    if (protocol === 'http:' || protocol === 'https:') return true;
  } catch {
    // not a URL: it may still be an email address
  }
  return /^[^@\s()<>]+@[^@\s()<>]+\.[^@\s()<>]+$/.test(value);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPERATING_MODE: z.enum(['demo', 'licensed']).default('demo'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  /** Whose X-Forwarded-For the API trusts (see parseTrustProxy); default nobody. */
  TRUST_PROXY: z.string().optional(),
  /** Port of the worker's /health and /ready server (0 turns it off). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  WORKER_HEALTH_HOST: z.string().default('0.0.0.0'),
  /**
   * OpenTelemetry: traces are exported (OTLP over HTTP) only when this is
   * set; otherwise tracing is a no-op and its packages are never loaded.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: secret.pipe(z.url().optional()),
  /** Overrides the service name of the exported traces (default vamos-api / vamos-worker). */
  OTEL_SERVICE_NAME: secret,
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
  /**
   * The secret key every password hash also depends on (argon2's secret, a
   * "pepper", ASVS 2.4.5), kept outside the database: a copy of the database
   * alone cannot be cracked offline. Required in production; unset in
   * development and tests.
   */
  PASSWORD_PEPPER: secret.refine((value) => value === undefined || value.length >= 32, {
    message: 'must have at least 32 characters',
  }),
  /** Encrypts staff TOTP secrets at rest: 32 bytes as 64 hex characters or base64. */
  ADMIN_TOTP_KEY: z
    .string()
    .refine((value) => parseAdminTotpKey(value) !== null, {
      message: 'must be 32 bytes written as 64 hex characters or base64',
    })
    .default(DEV_ADMIN_TOTP_KEY),

  FEED_PROVIDER: z.enum(['mock', 'manual', 'scraped']).default('mock'),
  /** Simulated match minutes per real second for the mock live simulator. */
  SIM_SPEED: z.coerce.number().positive().default(1),
  /**
   * Rolling demo fixtures of the mock feed: one kicks off every N minutes
   * (whole minutes, at least 1), generated up to the horizon ahead. Lower
   * both (e.g. 1 and 10) so a fixture starts within a minute or two in e2e.
   */
  FEED_ROLLING_EVERY_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  FEED_ROLLING_HORIZON_MINUTES: z.coerce.number().int().min(0).max(4320).default(120),

  /**
   * The data scraper (docs/scraper.md, section 7). There is deliberately no
   * setting for how many independent sources a result needs: that is the
   * constant MIN_INDEPENDENT_SOURCES in @vamos/scraper.
   */
  /** Where raw snapshots are stored; must be an absolute path in licensed mode. */
  SCRAPER_ARCHIVE_DIR: z.string().trim().min(1).default('./var/scraper'),
  /** Identifies us to the sources (printable ASCII, no line breaks). */
  SCRAPER_USER_AGENT: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(HEADER_TEXT_RE, 'printable ASCII only')
    .default('NahubetBot/1.0'),
  /** URL or email appended to the user agent; required for FEED_PROVIDER=scraped in licensed mode. */
  SCRAPER_CONTACT: secret.refine((value) => value === undefined || isScraperContact(value), {
    message: 'must be an http(s) URL or an email address',
  }),
  /** `off` ignores robots.txt and is refused in licensed mode. */
  SCRAPER_ROBOTS: z.enum(['enforce', 'off']).default('enforce'),
  /** Port of the scraper's /health and /ready server (0 turns it off). */
  SCRAPER_PORT: z.coerce.number().int().min(0).max(65535).default(4200),
  /** Hosts fetched in parallel. */
  SCRAPER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** How long an agreed result must stay unchanged before it is applied (rule R4). */
  SCRAPER_RESULT_CONFIRM_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  /** Rated matches a team needs before real bets are priced from its ratings (rule O1). */
  SCRAPER_MIN_RATING_MATCHES: z.coerce.number().int().min(1).max(10_000).default(8),

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

  TAX_CONFIG_CONFIRMED: bool.default(false),

  FEATURE_CASINO: bool.default(false),
  FEATURE_VIRTUALS: bool.default(false),

  /**
   * SMS and USSD betting (Phase 11). Both stay off until the regulator
   * approves the channel; while off, the inbound routes answer 404.
   * FEATURE_SMS_BETTING / FEATURE_USSD are read as legacy spellings.
   */
  SMS_BETTING_ENABLED: bool.optional(),
  USSD_ENABLED: bool.optional(),
  FEATURE_SMS_BETTING: bool.optional(),
  FEATURE_USSD: bool.optional(),
  /** The SMS aggregator delivering players' texts; only the demo `mock` exists until one is contracted. */
  SMS_AGGREGATOR: z.enum(['mock']).default('mock'),
  /** HMAC-SHA256 key of the inbound SMS webhooks (signature over the raw body). */
  SMS_WEBHOOK_SECRET: z.string().min(16).default(DEV_SMS_WEBHOOK_SECRET),
  /** The short code players text (shown in help texts and the dev simulator). */
  SMS_SHORT_CODE: z
    .string()
    .regex(/^\d{3,8}$/, '3 to 8 digits')
    .default('8123'),
  /** The USSD aggregator calling back; only the demo `mock` exists until one is contracted. */
  USSD_AGGREGATOR: z.enum(['mock']).default('mock'),
  /** Shared secret the USSD aggregator sends in a header with every callback. */
  USSD_SHARED_SECRET: z.string().min(16).default(DEV_USSD_SHARED_SECRET),
  /** The USSD code players dial, e.g. *123#. */
  USSD_SERVICE_CODE: z
    .string()
    .regex(/^\*\d{2,6}(\*\d{1,6})*#$/, 'a USSD code such as *123# or *123*4#')
    .default('*123#'),
});

export type OperatingMode = 'demo' | 'licensed';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  mode: OperatingMode;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  api: {
    host: string;
    port: number;
    publicUrl: string;
    /** TRUST_PROXY: whose X-Forwarded-For may set the client address (false: nobody). */
    trustProxy: TrustProxySetting;
  };
  /** The worker's health server (WORKER_HEALTH_*; port 0 = off). */
  worker: { healthHost: string; healthPort: number };
  /** OpenTelemetry tracing: on only when `otlpEndpoint` is set. */
  telemetry: { otlpEndpoint: string | undefined; serviceName: string | undefined };
  web: { publicUrl: string; adminUrl: string };
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  sessionSecret: string;
  /** PASSWORD_PEPPER: argon2's secret key for player and staff passwords (unset: none). */
  passwordPepper: string | undefined;
  /** The back office (staff accounts). */
  admin: {
    /** AES-256-GCM key (32 bytes) of the staff TOTP secrets (ADMIN_TOTP_KEY). */
    totpKey: Buffer;
  };
  feed: {
    provider: 'mock' | 'manual' | 'scraped';
    simSpeed: number;
    /** Rolling demo fixtures of the mock feed (FEED_ROLLING_*). */
    rolling: { everyMinutes: number; horizonMinutes: number };
  };
  /** The data scraper (SCRAPER_*, docs/scraper.md section 7). */
  scraper: ScraperConfig;
  providers: { payments: string[]; kyc: 'mock' | 'fayda'; sms: 'mock' | 'http' };
  /**
   * Payment provider settings (PAYMENT_*, MOCK_PAYMENT_*, CHAPA_*, TELEBIRR_*).
   * Which providers are enabled is `providers.payments`; credentials are
   * checked when a provider is built (@vamos/payments), not here.
   */
  payments: PaymentProvidersConfig;
  taxConfigConfirmed: boolean;
  /** `smsBetting` and `ussd` mirror channels.sms.enabled and channels.ussd.enabled. */
  features: { casino: boolean; virtuals: boolean; smsBetting: boolean; ussd: boolean };
  /**
   * SMS and USSD betting (Phase 11), off by default and kept off until the
   * regulator approves the channel. While a channel is off its inbound route
   * answers 404 and nothing else changes.
   */
  channels: ChannelsConfig;
}

export interface ScraperConfig {
  /** SCRAPER_ARCHIVE_DIR: raw snapshot store (absolute in licensed mode). */
  archiveDir: string;
  /** SCRAPER_USER_AGENT: the product token; see scraperUserAgent for the header sent. */
  userAgent: string;
  /** SCRAPER_CONTACT: URL or email appended to the user agent (unset: none). */
  contact: string | undefined;
  /** SCRAPER_ROBOTS: `off` is refused in licensed mode. */
  robots: 'enforce' | 'off';
  /** SCRAPER_PORT: health server (0 = off). */
  port: number;
  /** SCRAPER_MAX_CONCURRENCY: hosts fetched in parallel. */
  maxConcurrency: number;
  /** SCRAPER_RESULT_CONFIRM_MINUTES (at least 5): rule R4. */
  resultConfirmMinutes: number;
  /** SCRAPER_MIN_RATING_MATCHES (at least 1): rule O1. */
  minRatingMatches: number;
}

/** The User-Agent header sent to sources: `NahubetBot/1.0 (+ops@example.com)` when a contact is set. */
export function scraperUserAgent(scraper: Pick<ScraperConfig, 'userAgent' | 'contact'>): string {
  return scraper.contact === undefined
    ? scraper.userAgent
    : `${scraper.userAgent} (+${scraper.contact})`;
}

export interface ChannelsConfig {
  sms: {
    /** SMS_BETTING_ENABLED (legacy FEATURE_SMS_BETTING). */
    enabled: boolean;
    aggregator: 'mock';
    /** HMAC-SHA256 key of the inbound webhooks (SMS_WEBHOOK_SECRET). */
    webhookSecret: string;
    shortCode: string;
  };
  ussd: {
    /** USSD_ENABLED (legacy FEATURE_USSD). */
    enabled: boolean;
    aggregator: 'mock';
    /** USSD_SHARED_SECRET, sent by the aggregator in a header with every callback. */
    sharedSecret: string;
    serviceCode: string;
  };
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
  if (config.passwordPepper === undefined) {
    problems.push(
      'PASSWORD_PEPPER is required in licensed mode (the secret key of every password hash, kept outside the database)',
    );
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
  if (config.feed.provider === 'scraped') {
    if (!isAbsolutePath(config.scraper.archiveDir)) {
      problems.push(
        `SCRAPER_ARCHIVE_DIR must be an absolute path in licensed mode (got ${config.scraper.archiveDir}); it holds the evidence behind settled results`,
      );
    }
    if (config.scraper.contact === undefined) {
      problems.push(
        'SCRAPER_CONTACT is required in licensed mode when FEED_PROVIDER=scraped (a URL or email that sources can reach us at)',
      );
    }
    if (config.scraper.robots !== 'enforce') {
      problems.push(
        'SCRAPER_ROBOTS must be "enforce" in licensed mode (robots.txt is always obeyed)',
      );
    }
  }
  // The mock aggregators' webhook schemes are demo-only (no replay protection
  // or IP allowlist for USSD): a channel needs a contracted aggregator first.
  if (config.channels.sms.enabled && config.channels.sms.aggregator === 'mock') {
    problems.push(
      'SMS_AGGREGATOR "mock" is not allowed in licensed mode (SMS betting needs a contracted aggregator)',
    );
  }
  if (config.channels.ussd.enabled && config.channels.ussd.aggregator === 'mock') {
    problems.push(
      'USSD_AGGREGATOR "mock" is not allowed in licensed mode (USSD needs a contracted aggregator)',
    );
  }
  if (!config.taxConfigConfirmed) {
    problems.push(
      'TAX_CONFIG_CONFIRMED=true is required after the winnings-tax settings are confirmed with counsel',
    );
  }
  if (config.features.casino || config.features.virtuals) {
    problems.push('casino and virtual games are excluded by policy');
  }
  // Provider calls carry our credentials (Chapa's bearer secret, telebirr's signed requests) and
  // provider webhooks carry player and money data: never over plain http, not even to a
  // loopback stand-in. An unset PAYMENT_CALLBACK_BASE_URL is PUBLIC_API_URL, which
  // the production rules already require to be https.
  const { payments } = config;
  for (const [name, url] of [
    [
      'PAYMENT_CALLBACK_BASE_URL',
      payments.callbackBaseUrl === config.api.publicUrl ? undefined : payments.callbackBaseUrl,
    ],
    ['CHAPA_BASE_URL', payments.chapa.baseUrl],
    ['TELEBIRR_BASE_URL', payments.telebirr.baseUrl],
    ['TELEBIRR_CHECKOUT_URL', payments.telebirr.checkoutUrl],
  ] as const) {
    if (url !== undefined && !isHttpsUrl(url)) {
      problems.push(`${name} must be an https URL in licensed mode (got ${url})`);
    }
  }
  return problems;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
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
  const smsEnabled = channelFlag(
    'SMS_BETTING_ENABLED',
    e.SMS_BETTING_ENABLED,
    e.FEATURE_SMS_BETTING,
  );
  const ussdEnabled = channelFlag('USSD_ENABLED', e.USSD_ENABLED, e.FEATURE_USSD);

  const config: AppConfig = {
    nodeEnv: e.NODE_ENV,
    mode: e.OPERATING_MODE,
    logLevel: e.LOG_LEVEL,
    api: {
      host: e.API_HOST,
      port: e.API_PORT,
      publicUrl: e.PUBLIC_API_URL,
      trustProxy: parseTrustProxy(e.TRUST_PROXY),
    },
    worker: { healthHost: e.WORKER_HEALTH_HOST, healthPort: e.WORKER_HEALTH_PORT },
    telemetry: { otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME },
    web: { publicUrl: e.PUBLIC_WEB_URL, adminUrl: e.ADMIN_WEB_URL },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    queuePrefix: e.QUEUE_PREFIX,
    sessionSecret: e.SESSION_SECRET,
    passwordPepper: e.PASSWORD_PEPPER,
    admin: { totpKey: adminTotpKeyOf(e.ADMIN_TOTP_KEY) },
    feed: {
      provider: e.FEED_PROVIDER,
      simSpeed: e.SIM_SPEED,
      rolling: {
        everyMinutes: e.FEED_ROLLING_EVERY_MINUTES,
        horizonMinutes: e.FEED_ROLLING_HORIZON_MINUTES,
      },
    },
    scraper: {
      archiveDir: e.SCRAPER_ARCHIVE_DIR,
      userAgent: e.SCRAPER_USER_AGENT,
      contact: e.SCRAPER_CONTACT,
      robots: e.SCRAPER_ROBOTS,
      port: e.SCRAPER_PORT,
      maxConcurrency: e.SCRAPER_MAX_CONCURRENCY,
      resultConfirmMinutes: e.SCRAPER_RESULT_CONFIRM_MINUTES,
      minRatingMatches: e.SCRAPER_MIN_RATING_MATCHES,
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
    taxConfigConfirmed: e.TAX_CONFIG_CONFIRMED,
    features: {
      casino: e.FEATURE_CASINO,
      virtuals: e.FEATURE_VIRTUALS,
      smsBetting: smsEnabled,
      ussd: ussdEnabled,
    },
    channels: {
      sms: {
        enabled: smsEnabled,
        aggregator: e.SMS_AGGREGATOR,
        webhookSecret: e.SMS_WEBHOOK_SECRET,
        shortCode: e.SMS_SHORT_CODE,
      },
      ussd: {
        enabled: ussdEnabled,
        aggregator: e.USSD_AGGREGATOR,
        sharedSecret: e.USSD_SHARED_SECRET,
        serviceCode: e.USSD_SERVICE_CODE,
      },
    },
  };

  const problems: string[] = [];
  if (new URL(config.web.adminUrl).origin === new URL(config.web.publicUrl).origin) {
    // CORS gives the back office origin /admin/* and the player origin the rest, so a script on
    // the player site cannot drive the staff API. One shared origin would undo that.
    problems.push('ADMIN_WEB_URL must be on a different origin from PUBLIC_WEB_URL');
  }
  if (config.nodeEnv === 'production') {
    // CORS allows exactly these origins with credentials, and the session cookies are Secure in
    // production: plain http would leak them (and browsers drop Secure cookies over http).
    for (const [name, url] of [
      ['PUBLIC_WEB_URL', config.web.publicUrl],
      ['ADMIN_WEB_URL', config.web.adminUrl],
      ['PUBLIC_API_URL', config.api.publicUrl],
    ] as const) {
      if (!isProductionSafeUrl(url)) {
        problems.push(`${name} must be an https URL in production (got ${url})`);
      }
    }
  }
  if (config.nodeEnv === 'production' && config.sessionSecret === DEV_SESSION_SECRET) {
    problems.push('SESSION_SECRET must be set to a unique secret in production');
  }
  if (config.nodeEnv === 'production' && isDevAdminTotpKey(config.admin.totpKey)) {
    // The development key is public: staff TOTP secrets would be readable from a database copy.
    problems.push('ADMIN_TOTP_KEY must be set to a unique key in production');
  }
  if (config.nodeEnv === 'production' && config.passwordPepper === undefined) {
    // Without it a copy of the database is all an offline password-cracking attack needs.
    problems.push('PASSWORD_PEPPER must be set in production (32+ characters)');
  }
  if (config.passwordPepper !== undefined && config.passwordPepper === config.sessionSecret) {
    problems.push('PASSWORD_PEPPER must differ from SESSION_SECRET (one key, one purpose)');
  }
  if (
    config.nodeEnv === 'production' &&
    config.providers.payments.includes('mock') &&
    config.payments.mock.webhookSecret === DEV_MOCK_PAYMENT_WEBHOOK_SECRET
  ) {
    // Anyone could forge the public demo's mock deposit webhooks otherwise.
    problems.push('MOCK_PAYMENT_WEBHOOK_SECRET must be set to a unique secret in production');
  }
  if (
    config.nodeEnv === 'production' &&
    config.channels.sms.enabled &&
    config.channels.sms.webhookSecret === DEV_SMS_WEBHOOK_SECRET
  ) {
    // The development key is public: anyone could forge players' texts (and bets) otherwise.
    problems.push('SMS_WEBHOOK_SECRET must be set to a unique secret in production');
  }
  if (
    config.nodeEnv === 'production' &&
    config.channels.ussd.enabled &&
    config.channels.ussd.sharedSecret === DEV_USSD_SHARED_SECRET
  ) {
    problems.push('USSD_SHARED_SECRET must be set to a unique secret in production');
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

/**
 * A channel switch given under its current name and/or its legacy FEATURE_*
 * spelling: off unless set; both may be set only to the same value.
 */
function channelFlag(
  name: string,
  value: boolean | undefined,
  legacy: boolean | undefined,
): boolean {
  if (value !== undefined && legacy !== undefined && value !== legacy) {
    const legacyName = name === 'USSD_ENABLED' ? 'FEATURE_USSD' : 'FEATURE_SMS_BETTING';
    throw new ConfigError([
      `${name}=${String(value)} contradicts the legacy ${legacyName}=${String(legacy)}; set only ${name}`,
    ]);
  }
  return value ?? legacy ?? false;
}

export function isDemo(config: Pick<AppConfig, 'mode'>): boolean {
  return config.mode === 'demo';
}
