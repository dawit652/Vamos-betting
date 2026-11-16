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
  meetsPasswordPolicy,
  passwordWeakness,
  pinWeakness,
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

  it('hands the registration code back, and only that code, when REGISTRATION_SMS_VERIFICATION=off', () => {
    const otp = { code: '123456', expiresAt: new Date('2026-10-08T10:05:00.000Z') };
    const mock: SmsProvider = { name: 'mock', send: async () => ({ id: '1' }) };
    const licensed = {
      OPERATING_MODE: 'licensed',
      PAYMENT_PROVIDERS: 'sms',
      LOG_LEVEL: 'silent',
    } as const;
    const off = {
      config: loadConfig({ ...licensed, REGISTRATION_SMS_VERIFICATION: 'off' }),
      sms: mock,
    };
    expect(otpSentBody(off, '+251911234567', otp, 'register')).toEqual({
      otpSentTo: expect.any(String),
      otpExpiresAt: '2026-10-08T10:05:00.000Z',
      demoOtp: '123456',
      registrationWithoutSms: true,
    });
    // Never the codes that protect an existing account or a payout destination.
    expect(otpSentBody(off, '+251911234567', otp, 'password_reset')).not.toHaveProperty('demoOtp');
    expect(otpSentBody(off, '+251911234567', otp, 'payout_account')).not.toHaveProperty('demoOtp');
    // The default (SMS required) sends the code and shows nothing, licensed mode or not.
    const required = { config: loadConfig(licensed), sms: mock };
    expect(otpSentBody(required, '+251911234567', otp, 'register')).toEqual({
      otpSentTo: expect.any(String),
      otpExpiresAt: '2026-10-08T10:05:00.000Z',
    });
  });

  it('are echoed on screen only for registration, and only in demo mode with the mock SMS', () => {
    const otp = { code: '123456', expiresAt: new Date('2026-10-08T10:05:00.000Z') };
    const gateway = (name: string): SmsProvider => ({ name, send: async () => ({ id: '1' }) });
    const demo = {
      config: loadConfig({ OPERATING_MODE: 'demo', LOG_LEVEL: 'silent' }),
      sms: gateway('mock'),
    };
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
      'Nahubet: የማረጋገጫ ኮድዎ 123456 ነው። Your code is 123456. Valid 5 min. Never share it.',
    );
    expect(otpSmsBody('654321', 'en')).toBe(
      'Nahubet: Your code is 654321. Valid 5 min. Never share it. የማረጋገጫ ኮድዎ 654321 ነው።',
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

  it('takes a 4-digit PIN for new passwords, while any password still logs in', () => {
    const register = { phone: '0911234567', acceptTerms: true } as const;
    for (const pin of ['4826', '0397', '9150']) {
      expect(RegisterRequest.safeParse({ ...register, password: pin }).success, pin).toBe(true);
    }
    for (const bad of ['482', '48260', 'abcd', '48 2', '４８２６', '', 'Abebe-bikila-1960']) {
      expect(RegisterRequest.safeParse({ ...register, password: bad }).success, bad).toBe(false);
    }
    const reset = { phone: '0911234567', code: '123456' };
    expect(ResetPasswordRequest.safeParse({ ...reset, newPassword: '4826' }).success).toBe(true);
    expect(ResetPasswordRequest.safeParse({ ...reset, newPassword: 'Ab3$xy7q' }).success).toBe(
      false,
    );
    // A password chosen under an older rule keeps working at login.
    expect(LoginRequest.safeParse({ phone: '0911234567', password: 'Ab3$xy' }).success).toBe(true);
  });

  it('refuses only the easiest PINs: one digit four times, runs, the end of the phone', () => {
    const phone = '+251911234567';
    for (const pin of ['0000', '1111', '9999']) {
      expect(pinWeakness(pin, phone), pin).toMatch(/same digit/);
    }
    for (const pin of ['0123', '1234', '6789', '9876', '3210', '4321', '7890']) {
      expect(pinWeakness(pin, phone), pin).toMatch(/in a row/);
    }
    expect(pinWeakness('0397', '+251911200397')).toMatch(/last 4 digits of your phone number/);
    expect(pinWeakness('3456', '+251911203456')).toMatch(/in a row/);
    // Allowed (owner, 16 Nov 2026): years, pairs, mirrors, keypad shapes, other digits of the number.
    for (const pin of ['1950', '1987', '1990', '2016', '1212', '6969', '1122', '1221', '2000']) {
      expect(pinWeakness(pin, phone), pin).toBeNull();
    }
    for (const pin of ['2580', '1004', '1470', '1112', '0911', '9112', '4826', '9150', '7031']) {
      expect(pinWeakness(pin, phone), pin).toBeNull();
    }
    // passwordWeakness sends a PIN to these rules, and assertPasswordAcceptable throws on them.
    expect(passwordWeakness('1234', phone)).toMatch(/in a row/);
    expect(() => assertPasswordAcceptable('0000', phone)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'weak_password' }),
    );
    expect(() => assertPasswordAcceptable('1212', phone)).not.toThrow();
  });

  it('lets a good PIN or an older long password keep signing in, nothing weaker', () => {
    const phone = '+251911234567';
    expect(meetsPasswordPolicy('4826', phone)).toBe(true);
    expect(meetsPasswordPolicy('1234', phone)).toBe(false);
    expect(meetsPasswordPolicy('4567', phone)).toBe(false);
    // Made under the 12-character rule: no forced reset.
    expect(meetsPasswordPolicy('Abebe-bikila-1960', phone)).toBe(true);
    // Shorter than that, common, or the phone: reset with an SMS code first.
    expect(meetsPasswordPolicy('Ab3$xy7q', phone)).toBe(false);
    expect(meetsPasswordPolicy('123456789012', phone)).toBe(false);
    expect(meetsPasswordPolicy('0911234567', phone)).toBe(false);
  });

  it('every non-weak PIN is a valid new password, and the weak ones are a small share', () => {
    const phone = '+251911234567';
    let weak = 0;
    for (let n = 0; n < 10_000; n += 1) {
      const pin = String(n).padStart(4, '0');
      expect(
        RegisterRequest.safeParse({ phone: '0911234567', password: pin, acceptTerms: true })
          .success,
      ).toBe(true);
      if (pinWeakness(pin, phone) !== null) weak += 1;
    }
    // Repeats (10) and runs (20, also round the 0); this number's end (4567) is a run already.
    expect(weak).toBe(30);
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
  it('starts in licensed mode without extra production requirements (relaxed guard)', () => {
    const licensedEnv = {
      LOG_LEVEL: 'silent',
      OPERATING_MODE: 'licensed',
      PAYMENT_PROVIDERS: 'telebirr',
      KYC_PROVIDER: 'mock',
      SMS_PROVIDER: 'http',
      FEED_PROVIDER: 'manual',
      TAX_CONFIG_CONFIRMED: 'true',
      ADMIN_TOTP_KEY: '7f'.repeat(32),
    } as const;
    // Licensed mode no longer demands NODE_ENV=production or a unique SESSION_SECRET.
    const config = loadConfig(licensedEnv);
    expect(config.mode).toBe('licensed');
    expect(apiConfigProblems(config)).toEqual([]);
    expect(
      apiConfigProblems({ ...config, nodeEnv: 'development', sessionSecret: DEV_SESSION_SECRET }),
    ).toEqual([]);
    // Demo mode keeps working with the development defaults.
    expect(apiConfigProblems(loadConfig({ OPERATING_MODE: 'demo', LOG_LEVEL: 'silent' }))).toEqual(
      [],
    );
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
