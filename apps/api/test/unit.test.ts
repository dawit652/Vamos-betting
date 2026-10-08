import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, randomToken, safeEqualHex, sha256Hex } from '../src/lib/crypto';
import { generateOtpCode, hashOtpCode } from '../src/lib/otp';
import {
  assertPasswordAcceptable,
  hashPassword,
  passwordWeakness,
  verifyPassword,
} from '../src/lib/passwords';
import { MockKycVerifier } from '../src/providers/kyc';
import { otpSmsBody } from '../src/providers/sms';

describe('crypto helpers', () => {
  it('hashes and compares digests in constant time', () => {
    const digest = sha256Hex('token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(safeEqualHex(digest, sha256Hex('token'))).toBe(true);
    expect(safeEqualHex(digest, sha256Hex('other'))).toBe(false);
    expect(safeEqualHex(digest, digest.slice(2))).toBe(false);
    expect(safeEqualHex('zz', 'zz')).toBe(false);
    expect(hmacSha256Hex('secret', 'value')).not.toBe(hmacSha256Hex('other', 'value'));
  });

  it('makes base64url tokens from the injected random source', () => {
    const token = randomToken((size) => Buffer.alloc(size, 0xff));
    expect(token).toBe(Buffer.alloc(32, 0xff).toString('base64url'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('OTP codes', () => {
  it('are six digits', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('are stored as an HMAC bound to phone and purpose', () => {
    const hash = hashOtpCode('secret', '+251911234567', 'register', '123456');
    expect(hash).toBe(hmacSha256Hex('secret', '+251911234567:register:123456'));
    expect(hashOtpCode('secret', '+251911234567', 'password_reset', '123456')).not.toBe(hash);
    expect(hashOtpCode('secret', '+251911234568', 'register', '123456')).not.toBe(hash);
  });

  it('are sent in Amharic and English', () => {
    expect(otpSmsBody('123456', 'am')).toBe(
      'Vamos: የማረጋገጫ ኮድዎ 123456 ነው። Your code is 123456. Valid 5 min. Never share it.',
    );
    expect(otpSmsBody('654321', 'en')).toBe(
      'Vamos: Your code is 654321. Valid 5 min. Never share it. የማረጋገጫ ኮድዎ 654321 ነው።',
    );
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const stored = await hashPassword('Kenenisa-Bekele-2004');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(stored, 'Kenenisa-Bekele-2004')).toBe(true);
    expect(await verifyPassword(stored, 'kenenisa-bekele-2004')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('rejects common passwords and the phone number', () => {
    const phone = '+251911234567';
    for (const password of ['123456', 'Password', ' qwerty ', '000000']) {
      expect(passwordWeakness(password, phone)).toMatch(/too common/);
    }
    for (const password of [
      '0911234567',
      '0911 234 567',
      '+251911234567',
      '251911234567',
      '911234567',
    ]) {
      expect(passwordWeakness(password, phone)).toMatch(/phone number/);
    }
    expect(passwordWeakness('0911234568', phone)).toBeNull();
    expect(() => assertPasswordAcceptable('password', phone)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'weak_password' }),
    );
  });
});

describe('MockKycVerifier', () => {
  const kyc = new MockKycVerifier();
  const request = { fullName: 'Abebe Bikila', dateOfBirth: '1932-08-07' };

  it('rejects IDs ending in 0000', async () => {
    expect(await kyc.verify({ ...request, idNumber: '123456780000' })).toEqual({
      status: 'rejected',
      reason: 'ID not found in the Fayda registry (mock)',
    });
  });

  it('leaves IDs ending in 9999 pending', async () => {
    expect(await kyc.verify({ ...request, idNumber: '1234567812349999' })).toEqual({
      status: 'pending',
      reference: 'mock-9999',
    });
  });

  it('verifies everything else with the submitted details', async () => {
    expect(await kyc.verify({ ...request, idNumber: '123456781234' })).toEqual({
      status: 'verified',
      verifiedName: 'Abebe Bikila',
      verifiedDateOfBirth: '1932-08-07',
      reference: 'mock-1234',
    });
  });
});
