import { DEV_SESSION_SECRET, loadConfig } from '@vamos/config';
import { LoginRequest, RegisterRequest, ResetPasswordRequest } from '@vamos/contracts';
import { isOfAge } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../src/lib/background';
import { clientAddressKey } from '../src/lib/client-address';
import { hmacSha256Hex, randomToken, safeEqualHex, sha256Hex } from '../src/lib/crypto';
import { generateOtpCode, hashOtpCode, otpSentBody } from '../src/lib/otp';
import {
  assertPasswordAcceptable,
  hashPassword,
  passwordWeakness,
  verifyPassword,
} from '../src/lib/passwords';
import { MockKycVerifier } from '../src/providers/kyc';
import { otpSmsBody, type SmsProvider } from '../src/providers/sms';
import { apiConfigProblems } from '../src/startup';
import { dobForAge } from './helpers';

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

  it('are echoed on screen only for registration, and only in demo mode with the mock SMS', () => {
    const otp = { code: '123456', expiresAt: new Date('2026-10-08T10:05:00.000Z') };
    const gateway = (name: string): SmsProvider => ({ name, send: async () => ({ id: '1' }) });
    const demo = { config: loadConfig({ LOG_LEVEL: 'silent' }), sms: gateway('mock') };
    expect(otpSentBody(demo, '+251911234567', otp, 'register')).toEqual({
      otpSentTo: expect.any(String),
      otpExpiresAt: '2026-10-08T10:05:00.000Z',
      demoOtp: '123456',
    });
    expect(otpSentBody(demo, '+251911234567', otp, 'password_reset')).not.toHaveProperty('demoOtp');
    expect(
      otpSentBody({ ...demo, sms: gateway('http') }, '+251911234567', otp, 'register'),
    ).not.toHaveProperty('demoOtp');
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
    for (const password of ['123456789012', 'Password1234', ' qwertyuiop12 ', '000000000000']) {
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
    expect(() => assertPasswordAcceptable('password1234', phone)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'weak_password' }),
    );
  });

  it('refuses the common passwords of a 10,000-entry list, case-insensitively (review A4)', () => {
    const phone = '+251911234567';
    for (const password of [
      'iloveyou1234',
      'Football1234',
      'SUNSHINE1234',
      '1q2w3e4r5t6y',
      'baseball1234',
      'princess1234',
    ]) {
      expect(passwordWeakness(password, phone)).toMatch(/too common/);
    }
    expect(passwordWeakness('Abebe-bikila-1960', phone)).toBeNull();
  });

  it('needs at least 12 characters for new passwords, but existing ones still log in (ASVS 2.1.1)', () => {
    const register = {
      phone: '0911234567',
      dateOfBirth: '1990-01-01',
      acceptTerms: true,
    } as const;
    expect(RegisterRequest.safeParse({ ...register, password: 'Ab3$xy7q-9k' }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...register, password: 'Ab3$xy7q-9kz' }).success).toBe(true);
    // A run of spaces counts once.
    expect(RegisterRequest.safeParse({ ...register, password: 'Ab3$  xy7q-9' }).success).toBe(
      false,
    );
    const reset = { phone: '0911234567', code: '123456' };
    expect(ResetPasswordRequest.safeParse({ ...reset, newPassword: 'Ab3$xy7q' }).success).toBe(
      false,
    );
    // A 6-character password chosen under the old rule keeps working.
    expect(LoginRequest.safeParse({ phone: '0911234567', password: 'Ab3$xy' }).success).toBe(true);
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

describe('dobForAge (test helper)', () => {
  it('gives an exact 21st birthday today and a not-yet-21 date, even on 29 February', () => {
    for (const today of [
      '2026-10-08T12:00:00Z',
      '2028-02-29T12:00:00Z',
      '2028-02-28T12:00:00Z',
      '2029-02-28T12:00:00Z',
      '2027-12-31T23:59:00Z',
    ]) {
      const now = new Date(today);
      expect(isOfAge(dobForAge(now, 21), 21, now), today).toBe(true);
      expect(isOfAge(dobForAge(now, 21, 1), 21, now), today).toBe(false);
    }
    expect(dobForAge(new Date('2028-02-29T12:00:00Z'), 21)).toBe('2007-02-28');
    expect(dobForAge(new Date('2028-02-29T12:00:00Z'), 21, 1)).toBe('2007-03-01');
    expect(dobForAge(new Date('2026-10-08T12:00:00Z'), 21)).toBe('2005-10-08');
  });
});

describe('client address keys', () => {
  it('keeps IPv4 addresses and groups IPv6 addresses by /64', () => {
    expect(clientAddressKey('203.0.113.5')).toBe('203.0.113.5');
    expect(clientAddressKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(clientAddressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:0db8:0001:0002::')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(clientAddressKey('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientAddressKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(clientAddressKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('startup checks', () => {
  it('refuses licensed mode without NODE_ENV=production and a unique SESSION_SECRET', () => {
    const licensedEnv = {
      LOG_LEVEL: 'silent',
      OPERATING_MODE: 'licensed',
      PAYMENT_PROVIDERS: 'telebirr',
      KYC_PROVIDER: 'fayda',
      SMS_PROVIDER: 'http',
      FEED_PROVIDER: 'manual',
      TAX_CONFIG_CONFIRMED: 'true',
      ADMIN_TOTP_KEY: '7f'.repeat(32),
      ELS_REPORT_DIR: '/var/lib/vamos/els',
    } as const;
    // loadConfig itself now refuses these (packages/config licensedModeViolations); the API
    // check stays as defence in depth for configs built by other means.
    expect(() => loadConfig(licensedEnv)).toThrow(/NODE_ENV=production/);
    const production = loadConfig({
      ...licensedEnv,
      NODE_ENV: 'production',
      PASSWORD_PEPPER: 'a-unique-password-pepper-0123456789abcdef',
      SESSION_SECRET: 'a-unique-production-secret-0123456789abcdef',
    });
    const devDefaults = {
      ...production,
      nodeEnv: 'development' as const,
      sessionSecret: DEV_SESSION_SECRET,
    };
    expect(apiConfigProblems(devDefaults)).toEqual([
      expect.stringMatching(/NODE_ENV=production is required/),
      expect.stringMatching(/SESSION_SECRET must be set/),
    ]);
    expect(
      apiConfigProblems(
        loadConfig({
          ...licensedEnv,
          NODE_ENV: 'production',
          PASSWORD_PEPPER: 'a-unique-password-pepper-0123456789abcdef',
          SESSION_SECRET: 'a-unique-production-secret-0123456789abcdef',
        }),
      ),
    ).toEqual([]);
    // Demo mode keeps working with the development defaults.
    expect(apiConfigProblems(loadConfig({ LOG_LEVEL: 'silent' }))).toEqual([]);
  });
});

describe('BackgroundTasks', () => {
  it('runs tasks without blocking, logs failures and waits for all of them when idle', async () => {
    const errors: unknown[] = [];
    const tasks = new BackgroundTasks({ error: (...args: unknown[]) => void errors.push(args) });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tasks.run('slow', async () => {
      await gate;
      order.push('slow');
      tasks.run('follow-up', async () => {
        order.push('follow-up');
      });
    });
    tasks.run('failing', async () => {
      throw new Error('gateway down');
    });
    order.push('caller');
    const idle = tasks.idle();
    release();
    await idle;
    expect(order).toEqual(['caller', 'slow', 'follow-up']);
    expect(errors).toHaveLength(1);
    await expect(tasks.idle()).resolves.toBeUndefined();
  });
});
