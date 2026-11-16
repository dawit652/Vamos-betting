import { isIP } from 'node:net';
import { z } from 'zod';

export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me-0123456789';

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

/** An E.164 number: a plus, then 8 to 15 digits, the first not 0. */
const OWNER_ALERT_PHONE_RE = /^\+[1-9]\d{7,14}$/;
const TELEGRAM_CHAT_ID_RE = /^-?[1-9]\d{0,14}$/;

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
  OPERATING_MODE: z.enum(['demo', 'licensed']).default('licensed'),
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
  /**
   * Seconds the API keeps the answers of the public catalogue lists (sports,
   * competitions, event lists) per distinct query. 0 turns the cache off.
   * Never applies to event pages, search, anything per player or betting.
   */
  /**
   * Which routes this API process serves: `all` (everything, the default),
   * `streams` (only /health, GET /live/stream and GET /me/stream) or
   * `no-streams` (everything else). The roles run the same code, so open
   * streams can sit on processes of their own behind a proxy that routes the
   * two stream paths to them (docs/deployment.md, "Live streams on their own processes").
   */
  API_ROLE: z.enum(['all', 'streams', 'no-streams']).default('all'),
  CATALOG_CACHE_SECONDS: z.coerce.number().int().min(0).max(30).default(2),
  /**
   * How long a player stays signed in after signing in (hours; default a year). The owner's choice
   * (16 Nov 2026): a player stays signed in until they sign out. Signing out, a password change or
   * reset, self-exclusion or a disabled account still end every session at once. Staff sessions
   * are not affected (12 hours, 30 minutes idle).
   */
  PLAYER_SESSION_HOURS: z.coerce.number().int().min(1).max(17_520).default(8_760),
  /** Minutes without a request after which a player session ends; 0 (default): never. */
  PLAYER_SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).max(525_600).default(0),
  PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
  ADMIN_WEB_URL: z.url().default('http://localhost:3001'),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1).default('postgres://vamos:vamos@localhost:5432/vamos'),
  /** Connections one API process keeps open (the worker and the other tools size their own pools). */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
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
  /**
   * Bearer token of GET /metrics (Prometheus). Unset: the route answers 404 as if it did
   * not exist. Its own secret: it only reads counters, so it is not shared with anything else.
   */
  METRICS_TOKEN: secret.refine((value) => value === undefined || value.length >= 32, {
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
  /**
   * Rule O6 (docs/scraper.md 6.5, S-2 of docs/feed-quality-plan.md): `all` offers the half-time
   * markets on every scraped football event (as before); `covered` offers them only in a
   * competition where an enabled source gives half-time scores, so a result there needs no half
   * time. Existing events keep the half-time markets they have either way.
   */
  SCRAPER_HALF_TIME_MARKETS: z.enum(['all', 'covered']).default('all'),
  /**
   * Rule N4 (docs/scraper.md 6.4, U-4 of docs/feed-quality-plan.md): `on` applies a strong
   * fixture-context suggestion for an unknown team name as an alias for THAT source only (audited
   * `scrape.alias.auto`), and only in a competition whose results two independent full-time
   * upstreams protect (rule R2). `off` (the default) only suggests.
   */
  SCRAPER_AUTO_ALIAS: z.enum(['off', 'on']).default('off'),
  /**
   * C-2 of docs/feed-quality-plan.md: catalogue slugs of the `priority` competitions, comma
   * separated (e.g. premier-league,la-liga). Their odds keep the 10 min / 30 min / 2 h / 6 h
   * schedule; every other competition's odds read 30 min / 2 h / 170 min / 6 h. Unset or empty (the
   * default): every competition is priority, as before.
   */
  SCRAPER_PRIORITY_COMPETITIONS: csv
    .refine((slugs) => slugs.every((slug) => /^[a-z0-9][a-z0-9-]*$/i.test(slug)), {
      message: 'must be comma-separated competition slugs (letters, digits, hyphens)',
    })
    .optional(),
  /**
   * C-2: `on` stops reading a metered scores source (The Odds API) in a competition where two
   * other enabled, healthy full-time upstreams (one with half time) already meet rule R2. `off`
   * (the default) reads every scores source as before.
   */
  SCRAPER_SKIP_REDUNDANT_SCORES: z.enum(['off', 'on']).default('off'),
  /**
   * Rule O7 (docs/scraper.md 6.5, P-3 of docs/feed-quality-plan.md): `on` caps every selection of
   * the 1X2 and the over/under lines the books quote at the best fresh book price; `off` (default)
   * leaves the prices as they are. Either way a selection priced above the best book price is
   * flagged (`source_broken`, reason `odds_out_of_line`), so the setting is switched on after
   * measurement.
   */
  SCRAPER_CAP_AT_BEST_PRICE: z.enum(['off', 'on']).default('off'),
  /**
   * Price expiry, rule P7 (plan task 1.10, docs/plans/hulusport-parity-plan.md 4.5): each
   * scraper re-price stamps its markets valid for this many minutes, and bet placement refuses
   * an expired price, so betting closes by itself when the scraper goes dark. 0 (default): off,
   * prices never expire. Set it above the slowest re-price interval of an open event (prematch
   * reads are every 30 minutes in the last 24 hours), e.g. 90.
   */
  SCRAPER_PRICE_EXPIRY_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),
  /**
   * Plan task 2.3: `on` adds the market factory's football markets (about 190 lines) to the
   * events the scraper prices from the market, from the same fitted expected goals. `off`
   * (default): only today's markets. They stay hidden from players until
   * FEATURE_FACTORY_MARKETS is on ("priced but hidden" first).
   */
  SCRAPER_FACTORY_MARKETS: z.enum(['off', 'on']).default('off'),

  /**
   * Plan task 1.11: the owner's phone numbers (E.164, comma separated, at most 10) that get a short
   * SMS when an automatic safeguard acts (a source broken or stale, the credit budget, the ladder
   * shadow, the SMS rail). Unset or empty (the default): no alert is raised or sent.
   */
  OWNER_ALERT_PHONES: csv
    .refine((phones) => phones.every((phone) => OWNER_ALERT_PHONE_RE.test(phone)), {
      message: 'must be comma-separated E.164 phone numbers (+251911234567)',
    })
    .refine((phones) => phones.length <= 10, { message: 'at most 10 numbers' })
    .default([]),
  /** The same owner alert (same key) is texted at most once per this many minutes. */
  OWNER_ALERT_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  /**
   * The Telegram bot (create it with @BotFather). Unset (the default): no bot. With a token the
   * worker (a) sends the owner alerts to TELEGRAM_OWNER_CHAT_IDS next to the SMS and (b) answers
   * players' read-only questions (matches and odds) when TELEGRAM_PLAYER_MENU is on. The bot
   * never moves money and never sees an account. Never log it.
   */
  TELEGRAM_BOT_TOKEN: secret,
  /**
   * Chat ids (integers; a group's id is negative, at most 10) that get the owner alerts and may use
   * the owner commands (/status). Ask the bot `/id` to learn a chat's id. Use private chats: every
   * member of a group chat listed here may run the owner commands.
   */
  TELEGRAM_OWNER_CHAT_IDS: csv
    .refine((ids) => ids.every((id) => TELEGRAM_CHAT_ID_RE.test(id)), {
      message:
        'must be comma-separated Telegram chat ids (integers such as 123456789 or -1001234567890)',
    })
    .refine((ids) => ids.length <= 10, { message: 'at most 10 chat ids' })
    .default([]),
  /** `on` (default with a token): players may ask the bot for matches and odds. `off`: alerts only. */
  TELEGRAM_PLAYER_MENU: z.enum(['on', 'off']).default('on'),
  /**
   * Where the worker reads the public catalogue for the bot (the API over the private network,
   * e.g. http://api:4000). Default: PUBLIC_API_URL.
   */
  API_INTERNAL_URL: z.url().optional(),

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
  /**
   * SMS deposit rail (PAYMENT_PROVIDERS includes `sms`). `simulated`: only
   * the dev SMS simulator feeds it, against demo collection accounts (play
   * money, demo mode). `live`: the collection handset forwards real SMS to
   * /payments/webhooks/sms (licensed mode only).
   */
  SMS_RAIL_MODE: z.enum(['simulated', 'live']).default('simulated'),
  /** Shared secret of the SMS forwarder on the collection handset (header or body). */
  SMS_GATEWAY_SECRET: secret,
  /** Client addresses the gateway may post from (comma-separated IPs; empty: any). */
  SMS_GATEWAY_ALLOWLIST: csv.default([]),
  /**
   * The collection accounts players pay into, as JSON:
   * [{"institution":"telebirr","account":"0911…","name":"…","hint":"…"}].
   */
  SMS_COLLECTION_ACCOUNTS: secret,
  /** The operator's legal name: every live collection account must be in it. */
  OPERATOR_LEGAL_NAME: secret,
  /**
   * Receipt verification of credited SMS against the institution's receipt
   * page (telebirr): `audit` checks every credit out of band and raises a
   * contradiction to the top of the review queue; `off` does not check.
   */
  RECEIPT_VERIFY: z.enum(['off', 'audit']).default('audit'),
  RECEIPT_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(6_000),
  /**
   * Payout float forecast (plan task C10): the share of the possible payouts of open bets that end
   * within the horizon that players are expected to withdraw, and the alarm `payout_float_low`
   * when a collection account's last known balance is below it.
   */
  FLOAT_FORECAST_HORIZON_HOURS: z.coerce.number().int().min(1).max(48).default(6),
  FLOAT_FORECAST_WITHDRAWN_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
  /** How long a match is assumed to last from its start (the catalogue has no end time). */
  FLOAT_FORECAST_EVENT_MINUTES: z.coerce.number().int().min(30).max(600).default(120),
  /**
   * How long a collection handset's forwarder may go without a heartbeat before the worker raises
   * `sms_handset_heartbeat_missed`. Only an account that has sent a heartbeat is judged.
   */
  SMS_HEARTBEAT_ALARM_MINUTES: z.coerce.number().int().min(5).max(1440).default(20),
  /** Settle a manual payout only against the collection account's outgoing SMS. */
  PAYOUT_REQUIRE_PROOF: bool.default(false),
  /** Licensed mode without PAYOUT_REQUIRE_PROOF: an explicit, logged waiver. */
  PAYOUT_PROOF_WAIVED: bool.default(false),
  KYC_PROVIDER: z.enum(['mock']).default('mock'),
  /**
   * `off`: a new player is not sent an SMS code at registration; the API hands the code back in the
   * response and the web app confirms it by itself, so the phone number is NOT proven to be theirs.
   * For a deployment with no SMS gateway. Never applies to password-reset or payout-account codes.
   */
  REGISTRATION_SMS_VERIFICATION: z.enum(['required', 'off']).default('required'),
  SMS_PROVIDER: z.enum(['mock', 'http']).default('mock'),

  TAX_CONFIG_CONFIRMED: bool.default(false),

  FEATURE_CASINO: bool.default(false),
  /** Plan task 2.4: the catalogue shows the market factory's markets (default false: hidden). */
  FEATURE_FACTORY_MARKETS: bool.default(false),
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

/** Which routes an API process serves (API_ROLE). */
export type ApiRole = 'all' | 'streams' | 'no-streams';

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
    /** API_ROLE: which routes this process serves (all, streams only, or all but streams). */
    role: ApiRole;
    /** API_INTERNAL_URL (default publicUrl): where the worker reads the catalogue for the bot. */
    internalUrl: string;
    /** CATALOG_CACHE_SECONDS: how long catalogue list answers are reused (0 = off). */
    catalogCacheSeconds: number;
    /** PLAYER_SESSION_*: how long a player session lasts, and its idle limit (null: none). */
    playerSession: { absoluteMs: number; idleMs: number | null };
  };
  /** The worker's health server (WORKER_HEALTH_*; port 0 = off). */
  worker: { healthHost: string; healthPort: number };
  /** OpenTelemetry tracing: on only when `otlpEndpoint` is set. */
  telemetry: { otlpEndpoint: string | undefined; serviceName: string | undefined };
  web: { publicUrl: string; adminUrl: string };
  databaseUrl: string;
  /** DB_POOL_MAX: the size of one API process's database pool. */
  dbPoolMax: number;
  redisUrl: string;
  queuePrefix: string;
  sessionSecret: string;
  /** PASSWORD_PEPPER: argon2's secret key for player and staff passwords (unset: none). */
  passwordPepper: string | undefined;
  /** METRICS_TOKEN: bearer token of GET /metrics (unset: the route is off). */
  metricsToken: string | undefined;
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
  providers: { payments: string[]; kyc: 'mock'; sms: 'mock' | 'http' };
  /**
   * Payment provider settings (PAYMENT_*, MOCK_PAYMENT_*, CHAPA_*, TELEBIRR_*).
   * Which providers are enabled is `providers.payments`; credentials are
   * checked when a provider is built (@vamos/payments), not here.
   */
  payments: PaymentProvidersConfig;
  taxConfigConfirmed: boolean;
  /** `smsBetting` and `ussd` mirror channels.sms.enabled and channels.ussd.enabled. */
  features: {
    casino: boolean;
    virtuals: boolean;
    smsBetting: boolean;
    ussd: boolean;
    /** FEATURE_FACTORY_MARKETS: the catalogue shows the market factory's markets. */
    factoryMarkets: boolean;
  };
  /** REGISTRATION_SMS_VERIFICATION: `off` registers a player without proving the phone by SMS code. */
  registration: { smsVerification: 'required' | 'off' };
  /**
   * SMS and USSD betting (Phase 11), off by default and kept off until the
   * regulator approves the channel. While a channel is off its inbound route
   * answers 404 and nothing else changes.
   */
  channels: ChannelsConfig;
  /** OWNER_ALERT_*: short SMS alerts to the owner (plan task 1.11), off by default. */
  ownerAlerts: OwnerAlertsConfig;
  /** TELEGRAM_*: the Telegram bot (none without a token). */
  telegram: TelegramConfig;
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
  /** SCRAPER_HALF_TIME_MARKETS: rule O6, `all` (default) or `covered`. */
  halfTimeMarkets: 'all' | 'covered';
  /** SCRAPER_AUTO_ALIAS=on: rule N4 auto-applies strong fixture-context suggestions (default off). */
  autoAlias: boolean;
  /** SCRAPER_PRIORITY_COMPETITIONS (C-2), lower-cased slugs; null (unset or empty): all priority. */
  priorityCompetitions: string[] | null;
  /** SCRAPER_SKIP_REDUNDANT_SCORES=on (C-2): skip a scores source that is a third upstream (default off). */
  skipRedundantScores: boolean;
  /** SCRAPER_CAP_AT_BEST_PRICE: rule O7, true for `on` (default `off`: flag only). */
  capAtBestPrice: boolean;
  /** SCRAPER_PRICE_EXPIRY_MINUTES: rule P7 price expiry in minutes; 0 (default) is off. */
  priceExpiryMinutes: number;
  /** SCRAPER_FACTORY_MARKETS=on: market-priced events also get the factory's markets (default off). */
  factoryMarkets: boolean;
}

/** The User-Agent header sent to sources: `NahubetBot/1.0 (+ops@example.com)` when a contact is set. */
export function scraperUserAgent(scraper: Pick<ScraperConfig, 'userAgent' | 'contact'>): string {
  return scraper.contact === undefined
    ? scraper.userAgent
    : `${scraper.userAgent} (+${scraper.contact})`;
}

/** Who gets owner alerts: phone numbers (SMS) and Telegram chats. */
export interface OwnerAlertTargets {
  phones: readonly string[];
  telegramChatIds?: readonly number[];
}

/** How many places an owner alert goes to; 0 means alerts are off. */
export function ownerAlertTargetCount(alerts: OwnerAlertTargets): number {
  return alerts.phones.length + (alerts.telegramChatIds?.length ?? 0);
}

/** The Telegram bot (TELEGRAM_*). */
export interface TelegramConfig {
  /** TELEGRAM_BOT_TOKEN: undefined means no bot. */
  botToken: string | undefined;
  /** TELEGRAM_OWNER_CHAT_IDS: the owner alert chats (also the owner commands' audience). */
  ownerChatIds: number[];
  /** TELEGRAM_PLAYER_MENU: players may ask for matches and odds. */
  playerMenu: boolean;
}

/**
 * Alerts to the owner (plan task 1.11), by SMS and by Telegram. Off while there is no number and
 * no chat id.
 */
export interface OwnerAlertsConfig {
  /** OWNER_ALERT_PHONES: E.164 numbers, no duplicates; empty (default) turns the SMS off. */
  phones: string[];
  /** TELEGRAM_OWNER_CHAT_IDS when TELEGRAM_BOT_TOKEN is set, else empty (absent: none). */
  telegramChatIds?: number[];
  /** OWNER_ALERT_MIN_INTERVAL_MINUTES: the same alert key is sent at most once per interval. */
  minIntervalMinutes: number;
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

/** A collection account of the SMS rail (what players pay into). */
export interface CollectionAccount {
  /**
   * Stable id of this account: the handset that receives its SMS sends it, and every
   * SMS deposit records it (each account has its own space of exact amounts). Default
   * `<institution>:<account>`. Never change it while deposits are open.
   */
  id: string;
  /** Institution id (core INSTITUTIONS: telebirr, cbe…). */
  institution: string;
  /** The number or account players send to, as they type it. */
  account: string;
  /** The account holder's name as the player's app shows it. */
  name: string;
  /** Optional extra instruction ("telebirr app or *127#"). */
  hint?: string;
}

/**
 * The demo collection accounts of the simulated rail (no money moves: the
 * dev simulator composes the SMS).
 */
export const DEMO_COLLECTION_ACCOUNTS: readonly CollectionAccount[] = [
  { id: 'telebirr:0900000000', institution: 'telebirr', account: '0900000000', name: 'Vamos Demo' },
  { id: 'cbe:1000000000000', institution: 'cbe', account: '1000000000000', name: 'Vamos Demo' },
];

export interface SmsRailConfig {
  mode: 'simulated' | 'live';
  gatewaySecret: string | undefined;
  gatewayAllowlist: string[];
  collectionAccounts: CollectionAccount[];
  operatorLegalName: string | undefined;
  receiptVerify: 'off' | 'audit';
  receiptVerifyTimeoutMs: number;
  /** FLOAT_FORECAST_*: the assumptions of the payout float forecast (same shape as core's rules). */
  floatForecast: { eventDurationMs: number; horizonMs: number; withdrawnShareBps: number };
  /** SMS_HEARTBEAT_ALARM_MINUTES, in milliseconds. */
  heartbeatAlarmMs: number;
  requirePayoutProof: boolean;
  payoutProofWaived: boolean;
}

export interface PaymentProvidersConfig {
  /** Base URL of the provider webhooks (PAYMENT_CALLBACK_BASE_URL, else PUBLIC_API_URL). */
  callbackBaseUrl: string;
  /** The SMS deposit rail (`sms` provider): see SMS_RAIL_MODE. */
  sms: SmsRailConfig;
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

  // Mock deposits are credited by a webhook signed with a public dev secret: never with real money.
  if (config.providers.payments.includes('mock')) {
    problems.push('the "mock" payment provider is not allowed in licensed mode');
  }

  const smsProblems = smsRailLicensedViolations(config);
  if (smsProblems.length > 0) {
    console.warn('[vamos-config] SMS Rail compliance notes (non-blocking):', smsProblems);
  }

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
      console.warn(`[vamos-config] Non-HTTPS URL detected for ${name}: ${url}`);
    }
  }

  return problems;
}

/** Case, spacing and punctuation do not distinguish two spellings of one legal name. */
function normalizeLegalName(name: string): string {
  return name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What the SMS rail needs to take real money (licensed mode). */
function smsRailLicensedViolations(_config: AppConfig): string[] {
  const problems: string[] = [];
  const sms = _config.payments.sms;
  if (sms.mode !== 'live') {
    problems.push('SMS_RAIL_MODE=live is required for the sms payment provider in licensed mode');
  }
  const secret = sms.gatewaySecret ?? '';
  if (secret.length < 32) {
    problems.push('SMS_GATEWAY_SECRET must be set (32+ characters) for the live SMS rail');
  } else if (
    [
      _config.sessionSecret,
      _config.passwordPepper,
      _config.payments.mock.webhookSecret,
      _config.payments.chapa.webhookSecret,
      _config.channels.sms.webhookSecret,
      _config.channels.ussd.sharedSecret,
    ].includes(secret)
  ) {
    problems.push('SMS_GATEWAY_SECRET must be its own secret (it alone can credit deposits)');
  }
  if (!sms.operatorLegalName?.trim()) {
    problems.push(
      'OPERATOR_LEGAL_NAME is required: live collection accounts must be in the operator’s name',
    );
  }
  if (sms.collectionAccounts.length === 0) {
    problems.push('SMS_COLLECTION_ACCOUNTS must list the live collection accounts');
  }
  const legal = normalizeLegalName(sms.operatorLegalName ?? '');
  for (const account of sms.collectionAccounts) {
    if (legal.length > 0 && normalizeLegalName(account.name) !== legal) {
      problems.push(
        `SMS_COLLECTION_ACCOUNTS: the ${account.institution} account ${account.account} is not in OPERATOR_LEGAL_NAME (personal accounts are not allowed)`,
      );
    }
  }
  if (sms.receiptVerify === 'off') {
    problems.push('RECEIPT_VERIFY must be "audit" for the live SMS rail (it catches forged SMS)');
  }
  if (!sms.requirePayoutProof && !sms.payoutProofWaived) {
    problems.push(
      'PAYOUT_REQUIRE_PROOF=true is required for manual payouts in licensed mode (or waive it explicitly with PAYOUT_PROOF_WAIVED=true)',
    );
  }
  return problems;
}

/** The id of a collection account that names none: `<institution>:<account>`. */
export function defaultCollectionAccountId(institution: string, account: string): string {
  return `${institution}:${account}`;
}

const COLLECTION_ACCOUNTS_SCHEMA = z
  .array(
    z.object({
      id: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9:_+.-]{1,64}$/, 'an id of letters, digits and : _ + . -')
        .optional(),
      institution: z
        .string()
        .regex(/^[a-z]{2,20}$/, 'an institution id such as "telebirr" or "cbe"'),
      account: z
        .string()
        .trim()
        .regex(/^\+?[0-9A-Za-z -]{5,30}$/, 'a phone or account number'),
      name: z.string().trim().min(2).max(120),
      hint: z.string().trim().max(120).optional(),
    }),
  )
  .max(10);

/** Parses SMS_COLLECTION_ACCOUNTS (JSON); a ConfigError for anything else. */
function parseCollectionAccounts(raw: string | undefined): CollectionAccount[] {
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigError(['SMS_COLLECTION_ACCOUNTS: must be a JSON array']);
  }
  const parsed = COLLECTION_ACCOUNTS_SCHEMA.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) => `SMS_COLLECTION_ACCOUNTS.${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  const accounts: CollectionAccount[] = parsed.data.map((a) => ({
    id: a.id ?? defaultCollectionAccountId(a.institution, a.account),
    institution: a.institution,
    account: a.account,
    name: a.name,
    ...(a.hint === undefined ? {} : { hint: a.hint }),
  }));
  const ids = accounts.map((a) => a.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new ConfigError([`SMS_COLLECTION_ACCOUNTS: the id "${duplicate}" is used twice`]);
  }
  return accounts;
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
      role: e.API_ROLE,
      internalUrl: e.API_INTERNAL_URL ?? e.PUBLIC_API_URL,
      catalogCacheSeconds: e.CATALOG_CACHE_SECONDS,
      playerSession: {
        absoluteMs: e.PLAYER_SESSION_HOURS * 3_600_000,
        idleMs: e.PLAYER_SESSION_IDLE_MINUTES === 0 ? null : e.PLAYER_SESSION_IDLE_MINUTES * 60_000,
      },
    },
    worker: { healthHost: e.WORKER_HEALTH_HOST, healthPort: e.WORKER_HEALTH_PORT },
    telemetry: { otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME },
    web: { publicUrl: e.PUBLIC_WEB_URL, adminUrl: e.ADMIN_WEB_URL },
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    redisUrl: e.REDIS_URL,
    queuePrefix: e.QUEUE_PREFIX,
    sessionSecret: e.SESSION_SECRET,
    passwordPepper: e.PASSWORD_PEPPER,
    metricsToken: e.METRICS_TOKEN,
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
      halfTimeMarkets: e.SCRAPER_HALF_TIME_MARKETS,
      autoAlias: e.SCRAPER_AUTO_ALIAS === 'on',
      priorityCompetitions:
        e.SCRAPER_PRIORITY_COMPETITIONS === undefined ||
        e.SCRAPER_PRIORITY_COMPETITIONS.length === 0
          ? null
          : [...new Set(e.SCRAPER_PRIORITY_COMPETITIONS.map((slug) => slug.toLowerCase()))],
      skipRedundantScores: e.SCRAPER_SKIP_REDUNDANT_SCORES === 'on',
      capAtBestPrice: e.SCRAPER_CAP_AT_BEST_PRICE === 'on',
      priceExpiryMinutes: e.SCRAPER_PRICE_EXPIRY_MINUTES,
      factoryMarkets: e.SCRAPER_FACTORY_MARKETS === 'on',
    },
    providers: { payments: e.PAYMENT_PROVIDERS, kyc: e.KYC_PROVIDER, sms: e.SMS_PROVIDER },
    ownerAlerts: {
      phones: [...new Set(e.OWNER_ALERT_PHONES)],
      telegramChatIds:
        e.TELEGRAM_BOT_TOKEN === undefined
          ? []
          : [...new Set(e.TELEGRAM_OWNER_CHAT_IDS.map(Number))],
      minIntervalMinutes: e.OWNER_ALERT_MIN_INTERVAL_MINUTES,
    },
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      ownerChatIds: [...new Set(e.TELEGRAM_OWNER_CHAT_IDS.map(Number))],
      playerMenu: e.TELEGRAM_PLAYER_MENU === 'on',
    },
    payments: {
      callbackBaseUrl: e.PAYMENT_CALLBACK_BASE_URL ?? e.PUBLIC_API_URL,
      sms: {
        mode: e.SMS_RAIL_MODE,
        gatewaySecret: e.SMS_GATEWAY_SECRET,
        gatewayAllowlist: e.SMS_GATEWAY_ALLOWLIST,
        // Demo accounts only for the simulated rail: the live rail never shows them to players.
        collectionAccounts:
          e.SMS_RAIL_MODE === 'simulated' && e.SMS_COLLECTION_ACCOUNTS === undefined
            ? DEMO_COLLECTION_ACCOUNTS.map((a) => ({ ...a }))
            : parseCollectionAccounts(e.SMS_COLLECTION_ACCOUNTS),
        operatorLegalName: e.OPERATOR_LEGAL_NAME,
        receiptVerify: e.RECEIPT_VERIFY,
        receiptVerifyTimeoutMs: e.RECEIPT_VERIFY_TIMEOUT_MS,
        floatForecast: {
          eventDurationMs: e.FLOAT_FORECAST_EVENT_MINUTES * 60_000,
          horizonMs: e.FLOAT_FORECAST_HORIZON_HOURS * 3_600_000,
          withdrawnShareBps: e.FLOAT_FORECAST_WITHDRAWN_PERCENT * 100,
        },
        heartbeatAlarmMs: e.SMS_HEARTBEAT_ALARM_MINUTES * 60_000,
        requirePayoutProof: e.PAYOUT_REQUIRE_PROOF,
        payoutProofWaived: e.PAYOUT_PROOF_WAIVED,
      },
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
    registration: { smsVerification: e.REGISTRATION_SMS_VERIFICATION },
    features: {
      casino: e.FEATURE_CASINO,
      virtuals: e.FEATURE_VIRTUALS,
      smsBetting: smsEnabled,
      ussd: ussdEnabled,
      factoryMarkets: e.FEATURE_FACTORY_MARKETS,
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
    // The simulated SMS rail is play money too: only the dev simulator feeds it.
    const smsSimulated = config.payments.sms.mode === 'simulated';
    const real = config.providers.payments.filter(
      (p) => p !== 'mock' && !(p === 'sms' && smsSimulated),
    );
    if (real.length > 0) {
      problems.push(
        `demo mode only allows the "mock" payment provider and the simulated SMS rail (got: ${real.join(', ')}); real payments require licensed mode`,
      );
    }
    if (smsSimulated && e.SMS_COLLECTION_ACCOUNTS !== undefined) {
      problems.push(
        'SMS_COLLECTION_ACCOUNTS is for the live SMS rail (licensed mode); the simulated rail uses demo accounts',
      );
    }
  } else {
    problems.push(...licensedModeViolations(config));
  }
  if (e.TELEGRAM_BOT_TOKEN === undefined && e.TELEGRAM_OWNER_CHAT_IDS.length > 0) {
    problems.push('TELEGRAM_OWNER_CHAT_IDS needs TELEGRAM_BOT_TOKEN (a bot to send from)');
  }
  if (
    e.TELEGRAM_BOT_TOKEN !== undefined &&
    !/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(e.TELEGRAM_BOT_TOKEN)
  ) {
    // Never echo the value: it is a secret.
    problems.push('TELEGRAM_BOT_TOKEN is not a bot token (BotFather gives <digits>:<letters>)');
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
