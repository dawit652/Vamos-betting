import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  DEV_ADMIN_TOTP_KEY,
  DEV_MOCK_PAYMENT_WEBHOOK_SECRET,
  DEV_SESSION_SECRET,
  DEV_SMS_WEBHOOK_SECRET,
  DEV_USSD_SHARED_SECRET,
  isDemo,
  isDevAdminTotpKey,
  licensedModeViolations,
  loadConfig as loadConfigRaw,
  parseAdminTotpKey,
  parseTrustProxy,
  scraperUserAgent,
} from './config';

/** OPERATING_MODE defaults to licensed, so tests of the demo defaults say so; an explicit mode in `env` wins. */
function loadConfig(
  env: Record<string, string | undefined> = {},
): ReturnType<typeof loadConfigRaw> {
  return loadConfigRaw({ OPERATING_MODE: 'demo', ...env });
}

/** A production-grade ADMIN_TOTP_KEY (any 32 bytes other than the development key). */
const PRODUCTION_TOTP_KEY = '7f'.repeat(32);
/** A production PASSWORD_PEPPER (32+ characters). */
const PRODUCTION_PEPPER = 'a-real-password-pepper-of-at-least-32-chars';

const LICENSED_ENV = {
  NODE_ENV: 'production',
  OPERATING_MODE: 'licensed',
  PAYMENT_PROVIDERS: 'telebirr,chapa',
  KYC_PROVIDER: 'mock',
  SMS_PROVIDER: 'http',
  FEED_PROVIDER: 'manual',
  TAX_CONFIG_CONFIRMED: 'true',
  SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
  PASSWORD_PEPPER: PRODUCTION_PEPPER,
  ADMIN_TOTP_KEY: PRODUCTION_TOTP_KEY,
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

/** Runs loadConfig and returns what it logged with console.warn (the relaxed guard warns instead of refusing). */
function warningsOf(env: Record<string, string>): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    loadConfig(env);
    return warn.mock.calls
      .map((call) =>
        call.map((part) => (Array.isArray(part) ? part.join('\n') : String(part))).join(' '),
      )
      .join('\n');
  } finally {
    warn.mockRestore();
  }
}

describe('loadConfig', () => {
  it('defaults to licensed mode, which refuses the mock payment provider that is the default', () => {
    expect(() => loadConfigRaw({})).toThrow(
      /"mock" payment provider is not allowed in licensed mode/,
    );
    expect(problemsOf({ OPERATING_MODE: 'licensed' })).toEqual([
      'the "mock" payment provider is not allowed in licensed mode',
    ]);
  });

  it('defaults to demo mode with mock providers', () => {
    const config = loadConfig({});
    expect(config.mode).toBe('demo');
    expect(isDemo(config)).toBe(true);
    expect(config.providers.payments).toEqual(['mock']);
    expect(config.api.port).toBe(4000);
    expect(config.features).toEqual({
      casino: false,
      virtuals: false,
      smsBetting: false,
      ussd: false,
    });
  });

  it('accepts a fully configured licensed environment', () => {
    const config = loadConfig(LICENSED_ENV);
    expect(config.mode).toBe('licensed');
    expect(config.providers.payments).toEqual(['telebirr', 'chapa']);
    expect(config.taxConfigConfirmed).toBe(true);
  });

  it('sends the registration SMS code unless REGISTRATION_SMS_VERIFICATION=off', () => {
    expect(loadConfig({}).registration.smsVerification).toBe('required');
    expect(loadConfig({ REGISTRATION_SMS_VERIFICATION: 'off' }).registration.smsVerification).toBe(
      'off',
    );
    expect(problemsOf({ REGISTRATION_SMS_VERIFICATION: 'maybe' }).join(' ')).toMatch(
      /REGISTRATION_SMS_VERIFICATION/,
    );
  });

  it('no longer accepts KYC_PROVIDER=fayda: mock is the only KYC provider', () => {
    expect(problemsOf({ KYC_PROVIDER: 'fayda' }).join('\n')).toMatch(/KYC_PROVIDER/);
    expect(loadConfig({ KYC_PROVIDER: 'mock' }).providers.kyc).toBe('mock');
    expect(loadConfig({}).providers.kyc).toBe('mock');
  });

  it('refuses only the mock payment provider in licensed mode', () => {
    const problems = problemsOf({
      ...LICENSED_ENV,
      PAYMENT_PROVIDERS: 'mock',
      MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-webhook-secret-for-the-demo',
    }).join('\n');
    expect(problems).toMatch(/"mock" payment provider is not allowed in licensed mode/);
    // The other mocks (KYC, SMS, feed) and an unconfirmed tax setup no longer block startup.
    expect(
      problemsOf({
        ...LICENSED_ENV,
        KYC_PROVIDER: 'mock',
        SMS_PROVIDER: 'mock',
        FEED_PROVIDER: 'mock',
        TAX_CONFIG_CONFIRMED: 'false',
      }),
    ).toEqual([]);
  });

  it('ignores the removed ELS reporting variables', () => {
    expect(
      problemsOf({ ...LICENSED_ENV, ELS_REPORTING_MODE: 'off', ELS_REPORT_DIR: './var/els' }),
    ).toEqual([]);
  });

  it('does not require production settings just because the mode is licensed', () => {
    expect(
      problemsOf({ ...LICENSED_ENV, NODE_ENV: 'development', SESSION_SECRET: DEV_SESSION_SECRET }),
    ).toEqual([]);
  });

  it('warns about plain-http provider and callback URLs in licensed mode without refusing them', () => {
    for (const [name, url] of [
      ['PAYMENT_CALLBACK_BASE_URL', 'http://api.nahubet.example'],
      ['CHAPA_BASE_URL', 'http://api.chapa.co/v1'],
      ['TELEBIRR_BASE_URL', 'http://telebirr.example/apiaccess'],
      ['TELEBIRR_CHECKOUT_URL', 'http://telebirr.example/checkout'],
    ] as const) {
      expect(warningsOf({ ...LICENSED_ENV, [name]: url }), name).toContain(
        `Non-HTTPS URL detected for ${name}: ${url}`,
      );
    }
    expect(
      warningsOf({
        ...LICENSED_ENV,
        PAYMENT_CALLBACK_BASE_URL: 'https://api.nahubet.example',
        CHAPA_BASE_URL: 'https://api.chapa.co/v1',
        TELEBIRR_BASE_URL: 'https://telebirr.example/apiaccess',
        TELEBIRR_CHECKOUT_URL: 'https://telebirr.example/checkout',
      }),
    ).not.toContain('Non-HTTPS URL');
    // Demo mode keeps accepting local http stand-ins.
    expect(problemsOf({ CHAPA_BASE_URL: 'http://localhost:8080/v1' })).toEqual([]);
  });

  it('refuses real payment providers in demo mode', () => {
    expect(problemsOf({ PAYMENT_PROVIDERS: 'mock,telebirr' }).join('\n')).toMatch(
      /demo mode only allows/,
    );
  });

  it('refuses a back office URL on the same origin as the player web app', () => {
    // CORS lets each origin reach only its own routes (/admin or the rest).
    expect(
      problemsOf({
        PUBLIC_WEB_URL: 'https://nahubet.com',
        ADMIN_WEB_URL: 'https://nahubet.com/backoffice',
      }).join('\n'),
    ).toMatch(/ADMIN_WEB_URL/);
    expect(
      problemsOf({
        PUBLIC_WEB_URL: 'https://nahubet.com',
        ADMIN_WEB_URL: 'https://admin.nahubet.com',
      }),
    ).toEqual([]);
  });

  it('requires PASSWORD_PEPPER (32+ characters, not the session secret) in production', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
      MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-webhook-secret-for-the-demo',
      ADMIN_TOTP_KEY: PRODUCTION_TOTP_KEY,
    };
    expect(problemsOf(production)).toEqual([
      'PASSWORD_PEPPER must be set in production (32+ characters)',
    ]);
    expect(problemsOf({ ...production, PASSWORD_PEPPER: 'too-short' }).join('\n')).toMatch(
      /PASSWORD_PEPPER: must have at least 32 characters/,
    );
    expect(
      problemsOf({ ...production, PASSWORD_PEPPER: production.SESSION_SECRET }).join('\n'),
    ).toMatch(/PASSWORD_PEPPER must differ from SESSION_SECRET/);
    expect(problemsOf({ ...production, PASSWORD_PEPPER: PRODUCTION_PEPPER })).toEqual([]);
    expect(loadConfig({ ...production, PASSWORD_PEPPER: PRODUCTION_PEPPER }).passwordPepper).toBe(
      PRODUCTION_PEPPER,
    );
    // Development and tests run without one.
    expect(loadConfig({}).passwordPepper).toBeUndefined();
    const { PASSWORD_PEPPER: _omit, ...licensed } = LICENSED_ENV;
    // Licensed mode adds no rule of its own; in production the production rule applies.
    expect(problemsOf(licensed)).toEqual([
      'PASSWORD_PEPPER must be set in production (32+ characters)',
    ]);
    expect(problemsOf({ ...licensed, NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses the development session secret in production', () => {
    expect(
      problemsOf({ NODE_ENV: 'production', SESSION_SECRET: DEV_SESSION_SECRET }).join('\n'),
    ).toMatch(/SESSION_SECRET/);
  });

  it('refuses the development mock payment webhook secret in production', () => {
    const problems = problemsOf({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
      PASSWORD_PEPPER: PRODUCTION_PEPPER,
    }).join('\n');
    expect(problems).toMatch(/MOCK_PAYMENT_WEBHOOK_SECRET/);
    expect(
      problemsOf({
        NODE_ENV: 'production',
        SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
        PASSWORD_PEPPER: PRODUCTION_PEPPER,
        MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-webhook-secret-for-the-demo',
        ADMIN_TOTP_KEY: PRODUCTION_TOTP_KEY,
      }),
    ).toEqual([]);
  });

  it('reads ADMIN_TOTP_KEY as 32 bytes of hex or base64, the development key by default', () => {
    const fallback = loadConfig({}).admin.totpKey;
    expect(fallback.equals(Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex'))).toBe(true);
    expect(isDevAdminTotpKey(fallback)).toBe(true);
    const bytes = Buffer.from(PRODUCTION_TOTP_KEY, 'hex');
    for (const written of [
      PRODUCTION_TOTP_KEY,
      PRODUCTION_TOTP_KEY.toUpperCase(),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      ` ${bytes.toString('base64').replace(/=$/, '')} `,
    ]) {
      const key = loadConfig({ ADMIN_TOTP_KEY: written }).admin.totpKey;
      expect(key.equals(bytes), written).toBe(true);
      expect(isDevAdminTotpKey(key)).toBe(false);
    }
    // The development key is recognised however it is written.
    const devBase64 = Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex').toString('base64');
    expect(isDevAdminTotpKey(loadConfig({ ADMIN_TOTP_KEY: devBase64 }).admin.totpKey)).toBe(true);
  });

  it('refuses an ADMIN_TOTP_KEY that is not exactly 32 bytes', () => {
    for (const bad of [
      '',
      'short',
      '7f'.repeat(31),
      '7f'.repeat(33),
      `${'7f'.repeat(31)}zz`,
      Buffer.alloc(31, 1).toString('base64'),
      Buffer.alloc(33, 1).toString('base64'),
      `${Buffer.alloc(32, 1).toString('base64').slice(0, 42)}!=`,
    ]) {
      expect(parseAdminTotpKey(bad), bad).toBeNull();
      expect(problemsOf({ ADMIN_TOTP_KEY: bad }).join('\n'), bad).toMatch(/ADMIN_TOTP_KEY/);
    }
  });

  it('refuses the development ADMIN_TOTP_KEY in production', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
      PASSWORD_PEPPER: PRODUCTION_PEPPER,
      MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-webhook-secret-for-the-demo',
    };
    expect(problemsOf(production)).toEqual([
      'ADMIN_TOTP_KEY must be set to a unique key in production',
    ]);
    expect(
      problemsOf({
        ...production,
        ADMIN_TOTP_KEY: Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex').toString('base64'),
      }),
    ).toEqual(['ADMIN_TOTP_KEY must be set to a unique key in production']);
    // Demo mode in development keeps the default.
    expect(problemsOf({})).toEqual([]);

    const { ADMIN_TOTP_KEY: _omit, ...licensed } = LICENSED_ENV;
    expect(problemsOf(licensed)).toEqual([
      'ADMIN_TOTP_KEY must be set to a unique key in production',
    ]);
    // Licensed mode adds no rule of its own.
    const config = loadConfig(LICENSED_ENV);
    expect(
      licensedModeViolations({
        ...config,
        admin: { totpKey: Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex') },
      }),
    ).toEqual([]);
  });

  it('reads the payment provider settings with demo-safe defaults', () => {
    const config = loadConfig({});
    expect(config.payments).toEqual({
      callbackBaseUrl: 'http://localhost:4000',
      sms: {
        mode: 'simulated',
        gatewaySecret: undefined,
        gatewayAllowlist: [],
        collectionAccounts: [
          { institution: 'telebirr', account: '0900000000', name: 'Vamos Demo' },
          { institution: 'cbe', account: '1000000000000', name: 'Vamos Demo' },
        ],
        operatorLegalName: undefined,
        receiptVerify: 'audit',
        receiptVerifyTimeoutMs: 6000,
        requirePayoutProof: false,
        payoutProofWaived: false,
      },
      mock: { webhookSecret: DEV_MOCK_PAYMENT_WEBHOOK_SECRET },
      chapa: { baseUrl: 'https://api.chapa.co/v1', secretKey: undefined, webhookSecret: undefined },
      telebirr: {
        baseUrl: undefined,
        checkoutUrl: undefined,
        fabricAppId: undefined,
        appSecret: undefined,
        merchantAppId: undefined,
        shortCode: undefined,
        privateKey: undefined,
        publicKey: undefined,
      },
    });
    const custom = loadConfig({
      PAYMENT_CALLBACK_BASE_URL: 'https://pay.example.et',
      CHAPA_SECRET_KEY: ' CHASECK_TEST-abc ',
      CHAPA_WEBHOOK_SECRET: '',
      TELEBIRR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    expect(custom.payments.callbackBaseUrl).toBe('https://pay.example.et');
    expect(custom.payments.chapa.secretKey).toBe('CHASECK_TEST-abc');
    expect(custom.payments.chapa.webhookSecret).toBeUndefined();
    expect(custom.payments.telebirr.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    );
  });

  it('keeps the licensed-mode guard independent of provider credentials', () => {
    // Credentials are checked when a provider is built; the guard itself is unchanged.
    const config = loadConfig(LICENSED_ENV);
    expect(licensedModeViolations(config)).toEqual([]);
    expect(
      licensedModeViolations({ ...config, providers: { ...config.providers, payments: ['mock'] } }),
    ).toEqual(['the "mock" payment provider is not allowed in licensed mode']);
  });

  it('reads the simulator speed and the rolling-fixture knobs', () => {
    expect(loadConfig({}).feed).toEqual({
      provider: 'mock',
      simSpeed: 1,
      rolling: { everyMinutes: 5, horizonMinutes: 120 },
    });
    const fast = loadConfig({
      SIM_SPEED: '60',
      FEED_ROLLING_EVERY_MINUTES: '1',
      FEED_ROLLING_HORIZON_MINUTES: '10',
    });
    expect(fast.feed.simSpeed).toBe(60);
    expect(fast.feed.rolling).toEqual({ everyMinutes: 1, horizonMinutes: 10 });
    expect(loadConfig({ FEED_ROLLING_HORIZON_MINUTES: '0' }).feed.rolling.horizonMinutes).toBe(0);
  });

  it('refuses rolling intervals that are not whole positive minutes', () => {
    for (const value of ['0', '-5', '1.5', 'soon', '1441']) {
      expect(problemsOf({ FEED_ROLLING_EVERY_MINUTES: value }).join('\n')).toMatch(
        /FEED_ROLLING_EVERY_MINUTES/,
      );
    }
    for (const value of ['-1', '2.5', '4321']) {
      expect(problemsOf({ FEED_ROLLING_HORIZON_MINUTES: value }).join('\n')).toMatch(
        /FEED_ROLLING_HORIZON_MINUTES/,
      );
    }
  });

  it('reports invalid values', () => {
    expect(problemsOf({ API_PORT: 'not-a-port' }).join('\n')).toMatch(/API_PORT/);
    expect(problemsOf({ OPERATING_MODE: 'live' }).join('\n')).toMatch(/OPERATING_MODE/);
  });

  it('keeps SMS and USSD betting off by default with demo-only aggregator settings', () => {
    const config = loadConfig({});
    expect(config.channels).toEqual({
      sms: {
        enabled: false,
        aggregator: 'mock',
        webhookSecret: DEV_SMS_WEBHOOK_SECRET,
        shortCode: '8123',
      },
      ussd: {
        enabled: false,
        aggregator: 'mock',
        sharedSecret: DEV_USSD_SHARED_SECRET,
        serviceCode: '*123#',
      },
    });
    expect(config.features.smsBetting).toBe(false);
    expect(config.features.ussd).toBe(false);
  });

  it('reads the channel switches under their names and the legacy FEATURE_* spellings', () => {
    const on = loadConfig({ SMS_BETTING_ENABLED: 'true', USSD_ENABLED: 'true' });
    expect(on.channels.sms.enabled).toBe(true);
    expect(on.channels.ussd.enabled).toBe(true);
    expect(on.features).toMatchObject({ smsBetting: true, ussd: true });
    const legacy = loadConfig({ FEATURE_SMS_BETTING: 'true', FEATURE_USSD: 'false' });
    expect(legacy.channels.sms.enabled).toBe(true);
    expect(legacy.channels.ussd.enabled).toBe(false);
    expect(
      loadConfig({ SMS_BETTING_ENABLED: 'true', FEATURE_SMS_BETTING: 'true' }).channels.sms,
    ).toMatchObject({ enabled: true });
    expect(
      problemsOf({ SMS_BETTING_ENABLED: 'false', FEATURE_SMS_BETTING: 'true' }).join('\n'),
    ).toMatch(/SMS_BETTING_ENABLED=false contradicts the legacy FEATURE_SMS_BETTING=true/);
    expect(problemsOf({ USSD_ENABLED: 'true', FEATURE_USSD: 'false' }).join('\n')).toMatch(
      /USSD_ENABLED=true contradicts the legacy FEATURE_USSD=false/,
    );
    expect(problemsOf({ USSD_ENABLED: 'maybe' }).join('\n')).toMatch(/USSD_ENABLED/);
  });

  it('validates the aggregator settings', () => {
    const config = loadConfig({
      SMS_SHORT_CODE: '7000',
      USSD_SERVICE_CODE: '*700*1#',
      SMS_WEBHOOK_SECRET: 'a-long-enough-sms-secret',
      USSD_SHARED_SECRET: 'a-long-enough-ussd-secret',
    });
    expect(config.channels.sms).toMatchObject({
      shortCode: '7000',
      webhookSecret: 'a-long-enough-sms-secret',
    });
    expect(config.channels.ussd).toMatchObject({
      serviceCode: '*700*1#',
      sharedSecret: 'a-long-enough-ussd-secret',
    });
    expect(problemsOf({ SMS_SHORT_CODE: '12' }).join('\n')).toMatch(/SMS_SHORT_CODE/);
    expect(problemsOf({ USSD_SERVICE_CODE: '123' }).join('\n')).toMatch(/USSD_SERVICE_CODE/);
    expect(problemsOf({ SMS_WEBHOOK_SECRET: 'short' }).join('\n')).toMatch(/SMS_WEBHOOK_SECRET/);
    expect(problemsOf({ USSD_SHARED_SECRET: 'short' }).join('\n')).toMatch(/USSD_SHARED_SECRET/);
    expect(problemsOf({ SMS_AGGREGATOR: 'africastalking' }).join('\n')).toMatch(/SMS_AGGREGATOR/);
  });

  it('refuses the development channel secrets in production only while the channel is on', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
      PASSWORD_PEPPER: PRODUCTION_PEPPER,
      ADMIN_TOTP_KEY: PRODUCTION_TOTP_KEY,
      MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-payment-secret',
    };
    // Off (the default): the secrets are not used, so nothing changes.
    expect(problemsOf(production)).toEqual([]);
    const problems = problemsOf({
      ...production,
      SMS_BETTING_ENABLED: 'true',
      USSD_ENABLED: 'true',
    }).join('\n');
    expect(problems).toMatch(/SMS_WEBHOOK_SECRET must be set to a unique secret in production/);
    expect(problems).toMatch(/USSD_SHARED_SECRET must be set to a unique secret in production/);
    expect(
      problemsOf({
        ...production,
        SMS_BETTING_ENABLED: 'true',
        USSD_ENABLED: 'true',
        SMS_WEBHOOK_SECRET: 'a-unique-production-sms-secret',
        USSD_SHARED_SECRET: 'a-unique-production-ussd-secret',
      }),
    ).toEqual([]);
    // Development keeps the defaults usable.
    expect(problemsOf({ SMS_BETTING_ENABLED: 'true', USSD_ENABLED: 'true' })).toEqual([]);
  });
});

describe('operations settings (Phase 12)', () => {
  it('reads TRUST_PROXY into the config and never trusts every hop', () => {
    expect(loadConfig({}).api.trustProxy).toBe(false);
    for (const off of ['', ' ', 'false', '0']) {
      expect(parseTrustProxy(off)).toBe(false);
      expect(loadConfig({ TRUST_PROXY: off }).api.trustProxy).toBe(false);
    }
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.10 ,fd00::/8,loopback' }).api).toEqual(
      expect.objectContaining({
        trustProxy: ['10.0.0.0/8', '192.168.1.10', 'fd00::/8', 'loopback'],
      }),
    );
    for (const bad of ['true', '1', '2', 'proxy.local', '10.0.0.0/33', '1.2.3.4/8/9', ',']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(ConfigError);
      expect(problemsOf({ TRUST_PROXY: bad }).join('\n'), bad).toMatch(/TRUST_PROXY/);
    }
  });

  it('reads the worker health server and OpenTelemetry settings (tracing off by default)', () => {
    const defaults = loadConfig({});
    expect(defaults.worker).toEqual({ healthHost: '0.0.0.0', healthPort: 4100 });
    expect(defaults.telemetry).toEqual({ otlpEndpoint: undefined, serviceName: undefined });
    // A blank value (as in .env.example) leaves tracing off.
    expect(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }).telemetry.otlpEndpoint).toBeUndefined();
    const set = loadConfig({
      WORKER_HEALTH_PORT: '0',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      OTEL_SERVICE_NAME: 'vamos-api-et',
    });
    expect(set.worker.healthPort).toBe(0);
    expect(set.telemetry).toEqual({
      otlpEndpoint: 'http://otel-collector:4318',
      serviceName: 'vamos-api-et',
    });
    expect(problemsOf({ WORKER_HEALTH_PORT: '70000' }).join('\n')).toMatch(/WORKER_HEALTH_PORT/);
    expect(problemsOf({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }).join('\n')).toMatch(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });

  it('requires https public URLs in production (CORS origins and Secure cookies)', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
      PASSWORD_PEPPER: PRODUCTION_PEPPER,
      ADMIN_TOTP_KEY: PRODUCTION_TOTP_KEY,
      MOCK_PAYMENT_WEBHOOK_SECRET: 'a-unique-mock-webhook-secret',
    };
    // Local production builds (e2e, compose smoke tests) on loopback are fine.
    expect(problemsOf(production)).toEqual([]);
    expect(
      problemsOf({
        ...production,
        PUBLIC_WEB_URL: 'https://nahubet.com',
        ADMIN_WEB_URL: 'https://admin.nahubet.com',
        PUBLIC_API_URL: 'https://api.nahubet.com',
      }),
    ).toEqual([]);
    expect(
      problemsOf({
        ...production,
        PUBLIC_WEB_URL: 'http://nahubet.com',
        ADMIN_WEB_URL: 'http://admin.nahubet.com',
        PUBLIC_API_URL: 'http://api.nahubet.com',
      }),
    ).toEqual([
      'PUBLIC_WEB_URL must be an https URL in production (got http://nahubet.com)',
      'ADMIN_WEB_URL must be an https URL in production (got http://admin.nahubet.com)',
      'PUBLIC_API_URL must be an https URL in production (got http://api.nahubet.com)',
    ]);
    // Development keeps plain http.
    expect(problemsOf({ PUBLIC_WEB_URL: 'http://vamos.lan:3000' })).toEqual([]);
  });
});

describe('data scraper settings (docs/scraper.md section 7)', () => {
  const SCRAPED_LICENSED = {
    ...LICENSED_ENV,
    FEED_PROVIDER: 'scraped',
    SCRAPER_ARCHIVE_DIR: '/var/lib/vamos/scraper',
    SCRAPER_CONTACT: 'https://nahubet.com/bot',
  };

  it('has safe defaults and exposes them on config.scraper', () => {
    expect(loadConfig({}).scraper).toEqual({
      archiveDir: './var/scraper',
      userAgent: 'NahubetBot/1.0',
      contact: undefined,
      robots: 'enforce',
      port: 4200,
      maxConcurrency: 4,
      resultConfirmMinutes: 15,
      minRatingMatches: 8,
      halfTimeMarkets: 'all',
      autoAlias: false,
      priorityCompetitions: null,
      skipRedundantScores: false,
    });
    // There is no setting for the number of sources a result needs (MIN_INDEPENDENT_SOURCES).
    expect(Object.keys(loadConfig({}).scraper)).not.toContain('minSources');
  });

  it('reads every setting', () => {
    const config = loadConfig({
      SCRAPER_ARCHIVE_DIR: ' /data/scraper ',
      SCRAPER_USER_AGENT: 'NahubetBot/2.0',
      SCRAPER_CONTACT: ' ops@nahubet.com ',
      SCRAPER_ROBOTS: 'off',
      SCRAPER_PORT: '0',
      SCRAPER_MAX_CONCURRENCY: '8',
      SCRAPER_RESULT_CONFIRM_MINUTES: '5',
      SCRAPER_MIN_RATING_MATCHES: '1',
      SCRAPER_HALF_TIME_MARKETS: 'covered',
      SCRAPER_AUTO_ALIAS: 'on',
      SCRAPER_PRIORITY_COMPETITIONS: ' Premier-League, la-liga,,premier-league ',
      SCRAPER_SKIP_REDUNDANT_SCORES: 'on',
    });
    expect(config.scraper).toEqual({
      archiveDir: '/data/scraper',
      userAgent: 'NahubetBot/2.0',
      contact: 'ops@nahubet.com',
      robots: 'off',
      port: 0,
      maxConcurrency: 8,
      resultConfirmMinutes: 5,
      minRatingMatches: 1,
      halfTimeMarkets: 'covered',
      autoAlias: true,
      priorityCompetitions: ['premier-league', 'la-liga'],
      skipRedundantScores: true,
    });
    // A blank contact (as in an env file) is "not set".
    expect(loadConfig({ SCRAPER_CONTACT: '' }).scraper.contact).toBeUndefined();
    // A blank priority list (as in an env file) is "not set": every competition is priority.
    expect(
      loadConfig({ SCRAPER_PRIORITY_COMPETITIONS: ' , ' }).scraper.priorityCompetitions,
    ).toBeNull();
  });

  it('refuses values out of range or of the wrong kind', () => {
    for (const [name, values] of [
      ['SCRAPER_RESULT_CONFIRM_MINUTES', ['4', '0', '-1', '15.5', 'soon', '1441']],
      ['SCRAPER_MIN_RATING_MATCHES', ['0', '-3', '2.5', 'many']],
      ['SCRAPER_MAX_CONCURRENCY', ['0', '-1', '1.5', 'x', '65']],
      ['SCRAPER_PORT', ['-1', '70000', '42.5', 'x']],
      ['SCRAPER_ROBOTS', ['maybe', 'ON', 'false']],
      ['SCRAPER_HALF_TIME_MARKETS', ['some', 'COVERED', 'true', '']],
      ['SCRAPER_AUTO_ALIAS', ['true', 'ON', '1', '']],
      ['SCRAPER_PRIORITY_COMPETITIONS', ['premier league', 'epl;la-liga', '-x']],
      ['SCRAPER_SKIP_REDUNDANT_SCORES', ['true', 'ON', '1', '']],
      ['SCRAPER_ARCHIVE_DIR', ['   ']],
      ['SCRAPER_USER_AGENT', ['   ', 'Bot\r\nX-Evil: 1', 'Bøt/1.0']],
      [
        'SCRAPER_CONTACT',
        ['not a contact', 'ftp://nahubet.com', 'a@b', 'ops@nahubet.com)\r\nX: y'],
      ],
    ] as const) {
      for (const value of values) {
        expect(problemsOf({ [name]: value }).join('\n'), `${name}=${value}`).toMatch(
          new RegExp(name),
        );
      }
    }
  });

  it('builds the User-Agent with the contact when there is one', () => {
    expect(scraperUserAgent(loadConfig({}).scraper)).toBe('NahubetBot/1.0');
    expect(scraperUserAgent(loadConfig({ SCRAPER_CONTACT: 'ops@nahubet.com' }).scraper)).toBe(
      'NahubetBot/1.0 (+ops@nahubet.com)',
    );
    expect(
      scraperUserAgent({ userAgent: 'NahubetBot/2.0', contact: 'https://nahubet.com/bot' }),
    ).toBe('NahubetBot/2.0 (+https://nahubet.com/bot)');
  });

  it('accepts FEED_PROVIDER=scraped on its own in demo mode, whatever the scraper settings', () => {
    expect(problemsOf({ FEED_PROVIDER: 'scraped' })).toEqual([]);
    expect(loadConfig({ FEED_PROVIDER: 'scraped' }).feed.provider).toBe('scraped');
    // The strict checks apply to licensed mode only.
    expect(
      problemsOf({
        FEED_PROVIDER: 'scraped',
        SCRAPER_ROBOTS: 'off',
        SCRAPER_ARCHIVE_DIR: 'relative/dir',
      }),
    ).toEqual([]);
    expect(problemsOf({ FEED_PROVIDER: 'robot' }).join('\n')).toMatch(/FEED_PROVIDER/);
  });

  it('accepts a fully configured licensed environment with scraped fixtures', () => {
    const config = loadConfig(SCRAPED_LICENSED);
    expect(config.feed.provider).toBe('scraped');
    expect(licensedModeViolations(config)).toEqual([]);
    for (const archiveDir of [
      '/srv/scraper',
      'C:\\scraper',
      'D:/scraper',
      '\\\\nas\\share\\scraper',
    ]) {
      expect(
        problemsOf({ ...SCRAPED_LICENSED, SCRAPER_ARCHIVE_DIR: archiveDir }),
        archiveDir,
      ).toEqual([]);
    }
  });

  it('does not ask for scraper settings in licensed mode unless the feed is scraped', () => {
    expect(problemsOf({ ...LICENSED_ENV, SCRAPER_ROBOTS: 'off' })).toEqual([]);
    expect(problemsOf({ ...LICENSED_ENV, FEED_PROVIDER: 'manual', SCRAPER_ROBOTS: 'off' })).toEqual(
      [],
    );
  });

  it('does not refuse the mock feed or scraper settings in licensed mode', () => {
    expect(problemsOf({ ...SCRAPED_LICENSED, FEED_PROVIDER: 'mock' })).toEqual([]);
    const config = loadConfig(SCRAPED_LICENSED);
    expect(
      licensedModeViolations({
        ...config,
        scraper: { ...config.scraper, archiveDir: 'x', contact: undefined, robots: 'off' },
      }),
    ).toEqual([]);
  });
});

describe('the SMS deposit rail', () => {
  const LIVE_ACCOUNTS = JSON.stringify([
    { institution: 'telebirr', account: '0911000000', name: 'Vamos Betting PLC' },
    { institution: 'cbe', account: '1000123456789', name: 'VAMOS BETTING P.L.C.' },
  ]);
  const LIVE_SMS = {
    PAYMENT_PROVIDERS: 'sms',
    SMS_RAIL_MODE: 'live',
    SMS_GATEWAY_SECRET: 'g'.repeat(40),
    SMS_COLLECTION_ACCOUNTS: LIVE_ACCOUNTS,
    OPERATOR_LEGAL_NAME: 'Vamos Betting P.L.C',
    PAYOUT_REQUIRE_PROOF: 'true',
  };

  it('runs simulated in demo mode, on the demo collection accounts', () => {
    const config = loadConfig({ PAYMENT_PROVIDERS: 'mock,sms' });
    expect(config.payments.sms.mode).toBe('simulated');
    expect(config.payments.sms.collectionAccounts.map((a) => a.institution)).toEqual([
      'telebirr',
      'cbe',
    ]);
  });

  it('refuses the live rail and real collection accounts in demo mode', () => {
    expect(problemsOf({ PAYMENT_PROVIDERS: 'sms', SMS_RAIL_MODE: 'live' }).join('\n')).toMatch(
      /demo mode only allows the "mock" payment provider and the simulated SMS rail \(got: sms\)/,
    );
    expect(
      problemsOf({ PAYMENT_PROVIDERS: 'sms', SMS_COLLECTION_ACCOUNTS: LIVE_ACCOUNTS }).join('\n'),
    ).toMatch(/SMS_COLLECTION_ACCOUNTS is for the live SMS rail/);
  });

  it('accepts a fully configured live rail in licensed mode', () => {
    const config = loadConfig({ ...LICENSED_ENV, ...LIVE_SMS });
    expect(config.payments.sms).toMatchObject({
      mode: 'live',
      receiptVerify: 'audit',
      requirePayoutProof: true,
    });
    expect(config.payments.sms.collectionAccounts).toHaveLength(2);
  });

  it('reports SMS rail problems as warnings in licensed mode, not as errors', () => {
    const simulated = warningsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_RAIL_MODE: 'simulated' });
    expect(simulated).toContain('SMS Rail compliance notes (non-blocking)');
    expect(simulated).toMatch(/SMS_RAIL_MODE=live is required/);
    expect(warningsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_GATEWAY_SECRET: 'short' })).toMatch(
      /SMS_GATEWAY_SECRET must be set \(32\+ characters\)/,
    );
    expect(
      warningsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_GATEWAY_SECRET: LICENSED_ENV.SESSION_SECRET }),
    ).toMatch(/SMS_GATEWAY_SECRET must be its own secret/);
    const personal = JSON.stringify([
      { institution: 'telebirr', account: '0911000000', name: 'Abebe Kebede' },
    ]);
    expect(warningsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_COLLECTION_ACCOUNTS: personal })).toMatch(
      /not in OPERATOR_LEGAL_NAME \(personal accounts are not allowed\)/,
    );
    // None of these stop the config from loading.
    expect(problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_RAIL_MODE: 'simulated' })).toEqual([]);
    // A fully configured live rail has nothing to report.
    expect(warningsOf({ ...LICENSED_ENV, ...LIVE_SMS })).not.toContain('SMS Rail compliance notes');
  });

  it('warns when the live rail has no receipt audit or payout proof unless waived', () => {
    expect(warningsOf({ ...LICENSED_ENV, ...LIVE_SMS, RECEIPT_VERIFY: 'off' })).toMatch(
      /RECEIPT_VERIFY must be "audit"/,
    );
    const { PAYOUT_REQUIRE_PROOF: _proof, ...noProof } = LIVE_SMS;
    expect(warningsOf({ ...LICENSED_ENV, ...noProof })).toMatch(
      /PAYOUT_REQUIRE_PROOF=true is required/,
    );
    expect(warningsOf({ ...LICENSED_ENV, ...noProof, PAYOUT_PROOF_WAIVED: 'true' })).not.toContain(
      'SMS Rail compliance notes',
    );
  });

  it('rejects malformed collection accounts', () => {
    expect(
      problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_COLLECTION_ACCOUNTS: 'not json' }).join('\n'),
    ).toMatch(/SMS_COLLECTION_ACCOUNTS: must be a JSON array/);
    expect(
      problemsOf({
        ...LICENSED_ENV,
        ...LIVE_SMS,
        SMS_COLLECTION_ACCOUNTS: JSON.stringify([
          { institution: 'Tele Birr', account: '1', name: 'x' },
        ]),
      }).join('\n'),
    ).toMatch(/SMS_COLLECTION_ACCOUNTS\.0\.institution/);
  });
});
