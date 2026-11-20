import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatDeskCode, newShopResetSecret, shopResetSecretHash } from './shop-reset';

describe('reset at a shop: the phone secret', () => {
  it('makes a 32-byte base64url secret, a new one each time', () => {
    const a = newShopResetSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newShopResetSecret()).not.toBe(a);
  });

  it('hashes like the API (SHA-256 of the UTF-8 text, hex)', async () => {
    const secret = newShopResetSecret();
    expect(await shopResetSecretHash(secret)).toBe(
      createHash('sha256').update(secret, 'utf8').digest('hex'),
    );
  });

  it('shows the desk code in two groups', () => {
    expect(formatDeskCode('12345678')).toBe('1234 5678');
    expect(formatDeskCode('123')).toBe('123');
  });
});
