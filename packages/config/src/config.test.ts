import { describe, expect, it } from 'vitest';
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
  loadConfig,
  parseAdminTotpKey,
  parseTrustProxy,
} from './config';

/** A production-grade ADMIN_TOTP_KEY (any 32 bytes other than the development key). */
const PRODUCTION_TOTP_KEY = '7f'.repeat(32);
/** A production PASSWORD_PEPPER (32+ characters). */
const PRODUCTION_PEPPER = 'a-real-password-pepper-of-at-least-32-chars';

const LICENSED_ENV = {
  NODE_ENV: 'production',
  OPERATING_MODE: 'licensed',
  PAYMENT_PROVIDERS: 'telebirr,chapa',
  KYC_PROVIDER: 'fayda',
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

describe('loadConfig', () => {
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

  it('refuses licensed mode with mock payments, mock KYC, mock SMS, mock feed or unconfirmed tax', () => {
    const problems = problemsOf({
      ...LICENSED_ENV,
      PAYMENT_PROVIDERS: 'mock',
      KYC_PROVIDER: 'mock',
      SMS_PROVIDER: 'mock',
      FEED_PROVIDER: 'mock',
      TAX_CONFIG_CONFIRMED: 'false',
    }).join('\n');
    expect(problems).toMatch(/"mock" payment provider/);
    expect(problems).toMatch(/at least one real payment provider/);
    expect(problems).toMatch(/KYC_PROVIDER/);
    expect(problems).toMatch(/SMS_PROVIDER/);
    expect(problems).toMatch(/FEED_PROVIDER/);
    expect(problems).toMatch(/TAX_CONFIG_CONFIRMED/);
  });

  it('refuses licensed mode with casino enabled', () => {
    const problems = problemsOf({ ...LICENSED_ENV, FEATURE_CASINO: 'true' }).join('\n');
    expect(problems).toMatch(/casino/);
  });

  it('ignores the removed ELS reporting variables', () => {
    expect(
      problemsOf({ ...LICENSED_ENV, ELS_REPORTING_MODE: 'off', ELS_REPORT_DIR: './var/els' }),
    ).toEqual([]);
  });

  it('refuses licensed mode outside production or with the development secret', () => {
    const problems = problemsOf({
      ...LICENSED_ENV,
      NODE_ENV: 'development',
      SESSION_SECRET: DEV_SESSION_SECRET,
    }).join('\n');
    expect(problems).toMatch(/NODE_ENV=production/);
    expect(problems).toMatch(/SESSION_SECRET/);
  });

  it('refuses plain-http provider and callback URLs in licensed mode (review I4)', () => {
    for (const [name, url] of [
      ['PAYMENT_CALLBACK_BASE_URL', 'http://api.vamos.example'],
      ['CHAPA_BASE_URL', 'http://api.chapa.co/v1'],
      ['TELEBIRR_BASE_URL', 'http://telebirr.example/apiaccess'],
      ['TELEBIRR_CHECKOUT_URL', 'http://telebirr.example/checkout'],
      // Not even on loopback: provider calls carry secrets and must leave the host encrypted.
      ['CHAPA_BASE_URL', 'http://localhost:8080/v1'],
    ] as const) {
      const problems = problemsOf({ ...LICENSED_ENV, [name]: url }).join('\n');
      expect(problems, name).toMatch(new RegExp(`${name} must be an https URL in licensed mode`));
    }
    expect(
      problemsOf({
        ...LICENSED_ENV,
        PAYMENT_CALLBACK_BASE_URL: 'https://api.vamos.example',
        CHAPA_BASE_URL: 'https://api.chapa.co/v1',
        TELEBIRR_BASE_URL: 'https://telebirr.example/apiaccess',
        TELEBIRR_CHECKOUT_URL: 'https://telebirr.example/checkout',
      }),
    ).toEqual([]);
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
        PUBLIC_WEB_URL: 'https://vamos.et',
        ADMIN_WEB_URL: 'https://vamos.et/backoffice',
      }).join('\n'),
    ).toMatch(/ADMIN_WEB_URL/);
    expect(
      problemsOf({ PUBLIC_WEB_URL: 'https://vamos.et', ADMIN_WEB_URL: 'https://admin.vamos.et' }),
    ).toEqual([]);
  });

  it('requires PASSWORD_PEPPER (32+ characters, not the session secret) in production and licensed mode', () => {
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
    expect(problemsOf(licensed).join('\n')).toMatch(/PASSWORD_PEPPER is required in licensed mode/);
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

  it('refuses the development ADMIN_TOTP_KEY in production and in licensed mode', () => {
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
    expect(problemsOf(licensed).join('\n')).toMatch(
      /ADMIN_TOTP_KEY must be a unique key in licensed mode/,
    );
    const config = loadConfig(LICENSED_ENV);
    expect(
      licensedModeViolations({
        ...config,
        admin: { totpKey: Buffer.from(DEV_ADMIN_TOTP_KEY, 'hex') },
      }),
    ).toEqual([
      'ADMIN_TOTP_KEY must be a unique key in licensed mode (it encrypts the staff TOTP secrets)',
    ]);
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
    ).toEqual([
      'the "mock" payment provider is not allowed in licensed mode',
      'at least one real payment provider must be configured in PAYMENT_PROVIDERS',
    ]);
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

  it('refuses the demo "mock" aggregator in licensed mode while a channel is on', () => {
    const secrets = {
      SMS_WEBHOOK_SECRET: 'a-unique-production-sms-secret',
      USSD_SHARED_SECRET: 'a-unique-production-ussd-secret',
    };
    const both = problemsOf({
      ...LICENSED_ENV,
      ...secrets,
      SMS_BETTING_ENABLED: 'true',
      USSD_ENABLED: 'true',
    });
    expect(both).toEqual([
      'SMS_AGGREGATOR "mock" is not allowed in licensed mode (SMS betting needs a contracted aggregator)',
      'USSD_AGGREGATOR "mock" is not allowed in licensed mode (USSD needs a contracted aggregator)',
    ]);
    const smsOnly = problemsOf({ ...LICENSED_ENV, ...secrets, SMS_BETTING_ENABLED: 'true' });
    expect(smsOnly.join('\n')).toMatch(/SMS_AGGREGATOR "mock"/);
    expect(smsOnly.join('\n')).not.toMatch(/USSD_AGGREGATOR/);
    const ussdOnly = problemsOf({ ...LICENSED_ENV, ...secrets, FEATURE_USSD: 'true' });
    expect(ussdOnly.join('\n')).toMatch(/USSD_AGGREGATOR "mock"/);
    expect(ussdOnly.join('\n')).not.toMatch(/SMS_AGGREGATOR/);
    // Channels off: the mock aggregator is never used, so nothing changes.
    expect(licensedModeViolations(loadConfig(LICENSED_ENV))).toEqual([]);
    // The guard still refuses what it refused before, whatever the channels say.
    expect(
      problemsOf({ ...LICENSED_ENV, SMS_BETTING_ENABLED: 'true', SMS_PROVIDER: 'mock' }).join('\n'),
    ).toMatch(/SMS_PROVIDER must be a real SMS gateway/);
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
        PUBLIC_WEB_URL: 'https://vamos.et',
        ADMIN_WEB_URL: 'https://admin.vamos.et',
        PUBLIC_API_URL: 'https://api.vamos.et',
      }),
    ).toEqual([]);
    expect(
      problemsOf({
        ...production,
        PUBLIC_WEB_URL: 'http://vamos.et',
        ADMIN_WEB_URL: 'http://admin.vamos.et',
        PUBLIC_API_URL: 'http://api.vamos.et',
      }),
    ).toEqual([
      'PUBLIC_WEB_URL must be an https URL in production (got http://vamos.et)',
      'ADMIN_WEB_URL must be an https URL in production (got http://admin.vamos.et)',
      'PUBLIC_API_URL must be an https URL in production (got http://api.vamos.et)',
    ]);
    // Development keeps plain http.
    expect(problemsOf({ PUBLIC_WEB_URL: 'http://vamos.lan:3000' })).toEqual([]);
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

  it('refuses the simulated rail, a weak or reused secret and personal accounts in licensed mode', () => {
    const simulated = problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_RAIL_MODE: 'simulated' }).join(
      '\n',
    );
    expect(simulated).toMatch(/SMS_RAIL_MODE=live is required/);
    expect(
      problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_GATEWAY_SECRET: 'short' }).join('\n'),
    ).toMatch(/SMS_GATEWAY_SECRET must be set \(32\+ characters\)/);
    expect(
      problemsOf({
        ...LICENSED_ENV,
        ...LIVE_SMS,
        SMS_GATEWAY_SECRET: LICENSED_ENV.SESSION_SECRET,
      }).join('\n'),
    ).toMatch(/SMS_GATEWAY_SECRET must be its own secret/);
    const personal = JSON.stringify([
      { institution: 'telebirr', account: '0911000000', name: 'Abebe Kebede' },
    ]);
    expect(
      problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, SMS_COLLECTION_ACCOUNTS: personal }).join('\n'),
    ).toMatch(/not in OPERATOR_LEGAL_NAME \(personal accounts are not allowed\)/);
    const { OPERATOR_LEGAL_NAME: _name, ...noName } = LIVE_SMS;
    expect(problemsOf({ ...LICENSED_ENV, ...noName }).join('\n')).toMatch(
      /OPERATOR_LEGAL_NAME is required/,
    );
  });

  it('refuses the live rail without receipt audit or payout proof unless waived', () => {
    expect(problemsOf({ ...LICENSED_ENV, ...LIVE_SMS, RECEIPT_VERIFY: 'off' }).join('\n')).toMatch(
      /RECEIPT_VERIFY must be "audit"/,
    );
    const { PAYOUT_REQUIRE_PROOF: _proof, ...noProof } = LIVE_SMS;
    expect(problemsOf({ ...LICENSED_ENV, ...noProof }).join('\n')).toMatch(
      /PAYOUT_REQUIRE_PROOF=true is required/,
    );
    expect(problemsOf({ ...LICENSED_ENV, ...noProof, PAYOUT_PROOF_WAIVED: 'true' })).toEqual([]);
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
