import { OtpSentResponse, RegisterResponse } from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, post, type TestContext } from './helpers';

/**
 * The live server's registration (owner's report of 16 Nov 2026): licensed mode, the mock SMS
 * gateway and REGISTRATION_SMS_VERIFICATION=off. The API hands the code back and the web form
 * confirms it itself (RegisterForm), so a 4-digit PIN registers and signs in without an SMS.
 */
describe('registration without SMS in licensed mode', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      OPERATING_MODE: 'licensed',
      PAYMENT_PROVIDERS: 'sms',
      REGISTRATION_SMS_VERIFICATION: 'off',
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const register = (phone: string, password: string) =>
    post(ctx, '/auth/register', { phone, password, locale: 'am', acceptTerms: true });

  it('registers with a 4-digit PIN and signs in with the code the API handed back', async () => {
    const phone = '0911234567';
    const registered = await register(phone, '4071');
    expect(registered.statusCode, registered.body).toBe(201);
    const body = RegisterResponse.parse(registered.json());
    expect(body.registrationWithoutSms).toBe(true);
    expect(body.demoOtp).toMatch(/^\d{6}$/);

    const verified = await post(ctx, '/auth/verify-otp', {
      phone,
      code: body.demoOtp,
      purpose: 'register',
      registrationToken: body.registrationToken,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.cookies.some((cookie) => cookie.value !== '')).toBe(true);

    // Signing in again later with the same PIN works.
    const login = await post(ctx, '/auth/login', { phone, password: '4071' });
    expect(login.statusCode, login.body).toBe(200);
  });

  it('says why an easy PIN is refused', async () => {
    for (const pin of ['1234', '1990', '1111', '4567']) {
      const response = await register('0911234568', pin);
      expect(response.statusCode, pin).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'weak_password' } });
    }
    const ok = await register('0911234568', '3829');
    expect(ok.statusCode, ok.body).toBe(201);
    OtpSentResponse.parse(ok.json());
  });
});
