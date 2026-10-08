import { loadConfig } from '@vamos/config';
import { describe, expect, it } from 'vitest';
import { createDefaultDeps, ProviderNotImplementedError } from '../src/deps';

describe('createDefaultDeps', () => {
  it('wires mock providers in demo mode', async () => {
    const deps = createDefaultDeps(loadConfig({ LOG_LEVEL: 'silent' }));
    try {
      expect(deps.sms.name).toBe('mock');
      expect(deps.kyc.name).toBe('mock');
      expect(deps.clock()).toBeInstanceOf(Date);
      expect(deps.randomBytes(32)).toHaveLength(32);
    } finally {
      await deps.close();
    }
  });

  it.each([
    [{ SMS_PROVIDER: 'http' }, /SMS_PROVIDER="http" is not implemented yet/],
    [{ KYC_PROVIDER: 'fayda' }, /KYC_PROVIDER="fayda" is not implemented yet/],
  ])('refuses providers without an adapter (%o)', (env, message) => {
    const config = loadConfig({ LOG_LEVEL: 'silent', ...env });
    expect(() => createDefaultDeps(config)).toThrow(ProviderNotImplementedError);
    expect(() => createDefaultDeps(config)).toThrow(message);
  });
});
