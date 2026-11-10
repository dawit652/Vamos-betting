import { loadConfig } from '@vamos/config';
import { ProviderNotConfiguredError } from '@vamos/payments';
import { describe, expect, it } from 'vitest';
import { createDefaultDeps, ProviderNotImplementedError } from '../src/deps';

describe('createDefaultDeps', () => {
  it('wires mock providers in demo mode', async () => {
    const deps = createDefaultDeps(loadConfig({ OPERATING_MODE: 'demo', LOG_LEVEL: 'silent' }));
    try {
      expect(deps.sms.name).toBe('mock');
      expect(deps.kyc.name).toBe('mock');
      expect(deps.payments.names).toEqual(['mock']);
      expect(deps.payments.get('mock')?.capabilities).toEqual({ deposits: true, payouts: true });
      expect(deps.clock()).toBeInstanceOf(Date);
      expect(deps.randomBytes(32)).toHaveLength(32);
    } finally {
      await deps.close();
    }
  });

  it('refuses a payment provider that is not configured', () => {
    // CBE Birr is a skeleton until merchant documents exist (refused in demo mode by the config guard too).
    const config = loadConfig({ OPERATING_MODE: 'demo', LOG_LEVEL: 'silent' });
    expect(() =>
      createDefaultDeps({ ...config, providers: { ...config.providers, payments: ['cbebirr'] } }),
    ).toThrow(ProviderNotConfiguredError);
  });

  it.each([
    [{ SMS_PROVIDER: 'http' }, /SMS_PROVIDER="http" is not implemented yet/],
    [{ KYC_PROVIDER: 'fayda' }, /KYC_PROVIDER="fayda" is not implemented yet/],
  ])('refuses providers without an adapter (%o)', (env, message) => {
    const config = loadConfig({ OPERATING_MODE: 'demo', LOG_LEVEL: 'silent', ...env });
    expect(() => createDefaultDeps(config)).toThrow(ProviderNotImplementedError);
    expect(() => createDefaultDeps(config)).toThrow(message);
  });
});
