import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from './csp';

describe('content security policy (ASVS 14.4.3)', () => {
  it('allows only nonce scripts, its own origin and the API, and no framing', () => {
    const policy = contentSecurityPolicy({
      nonce: 'abc123',
      apiUrl: 'https://api.nahubet.com',
      dev: false,
    });
    const directives = new Map(
      policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
    );
    expect(directives.get('script-src')).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(directives.get('connect-src')).toBe("'self' https://api.nahubet.com");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'self'");
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy).not.toContain('unsafe-eval');
    expect(directives.get('script-src')).not.toContain('unsafe-inline');
  });

  it('allows eval only for next dev, and upgrades requests only over https', () => {
    const local = contentSecurityPolicy({
      nonce: 'n',
      apiUrl: 'http://localhost:4000',
      dev: true,
    });
    expect(local).toContain("'unsafe-eval'");
    expect(local).toContain("connect-src 'self' http://localhost:4000");
    expect(local).not.toContain('upgrade-insecure-requests');
  });

  it('allows only its own origin when the API is forwarded through this origin', () => {
    const policy = contentSecurityPolicy({ nonce: 'n', apiUrl: '/_api', dev: false });
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('makes a fresh 128-bit nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});
