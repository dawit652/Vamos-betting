import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_ADMIN_TOTP_KEY,
  DEV_MOCK_PAYMENT_WEBHOOK_SECRET,
  DEV_SESSION_SECRET,
  isDemo,
  isDevAdminTotpKey,
  licensedModeViolations,
  loadConfig,
  parseAdminTotpKey,
} from './config';

/** A production-grade ADMIN_TOTP_KEY (any 32 bytes other than the development key). */
const PRODUCTION_TOTP_KEY = '7f'.repeat(32);

const LICENSED_ENV = {
  NODE_ENV: 'production',
  OPERATING_MODE: 'licensed',
  ELS_LICENSE_NUMBER: 'ELS/SB/0001',
  ELS_REPORTING: 'file',
  PAYMENT_PROVIDERS: 'telebirr,chapa',
  KYC_PROVIDER: 'fayda',
  SMS_PROVIDER: 'http',
  FEED_PROVIDER: 'manual',
  TAX_CONFIG_CONFIRMED: 'true',
  SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
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

  it('refuses licensed mode without a licence number', () => {
    const { ELS_LICENSE_NUMBER: _omit, ...env } = LICENSED_ENV;
    expect(problemsOf(env).join('\n')).toMatch(/ELS_LICENSE_NUMBER/);
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

  it('refuses licensed mode with reporting disabled or casino enabled', () => {
    const problems = problemsOf({
      ...LICENSED_ENV,
      ELS_REPORTING: 'disabled',
      FEATURE_CASINO: 'true',
    }).join('\n');
    expect(problems).toMatch(/ELS_REPORTING/);
    expect(problems).toMatch(/casino/);
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

  it('requires a report URL for http reporting', () => {
    expect(problemsOf({ ...LICENSED_ENV, ELS_REPORTING: 'http' }).join('\n')).toMatch(
      /ELS_REPORT_URL/,
    );
  });

  it('refuses real payment providers in demo mode', () => {
    expect(problemsOf({ PAYMENT_PROVIDERS: 'mock,telebirr' }).join('\n')).toMatch(
      /demo mode only allows/,
    );
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
    }).join('\n');
    expect(problems).toMatch(/MOCK_PAYMENT_WEBHOOK_SECRET/);
    expect(
      problemsOf({
        NODE_ENV: 'production',
        SESSION_SECRET: 'a-real-production-secret-of-at-least-32-chars',
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
});
