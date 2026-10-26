import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS, isCommonPassword } from './common-passwords';

describe('common passwords (ASVS 2.1.7)', () => {
  it('holds 10,000 distinct lowercased printable entries that a new password could be', () => {
    expect(COMMON_PASSWORDS).toHaveLength(10_000);
    expect(new Set(COMMON_PASSWORDS).size).toBe(10_000);
    for (const password of COMMON_PASSWORDS) {
      expect(password.length, password).toBeGreaterThanOrEqual(12);
      expect(password.length, password).toBeLessThanOrEqual(128);
      expect(password, password).toMatch(/^[\x20-\x7e]+$/);
      expect(password, password).toBe(password.toLowerCase());
    }
  });

  it('matches case-insensitively and ignores surrounding spaces', () => {
    expect(isCommonPassword('qwerty123456')).toBe(true);
    expect(isCommonPassword('QWERTY123456')).toBe(true);
    expect(isCommonPassword('  Qwerty123456 ')).toBe(true);
    expect(isCommonPassword('1qaz2wsx3edc')).toBe(true);
    expect(isCommonPassword('Abebe-bikila-1960')).toBe(false);
    expect(isCommonPassword('tej-and-injera-at-noon')).toBe(false);
  });
});
