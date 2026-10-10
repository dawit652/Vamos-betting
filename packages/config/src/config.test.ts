import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SESSION_SECRET, isDemo, loadConfig } from './config';

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
