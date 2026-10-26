import { randomUUID } from 'node:crypto';
import { maskMsisdn } from '@vamos/core';
import {
  ApiErrorSchema,
  OkResponse,
  OtpSentResponse,
  RegisterResponse,
  SessionResponse,
} from '@vamos/contracts';
import {
  auditLog,
  otpChallenges,
  rgExclusions,
  sessions,
  smsMessages,
  users,
} from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { sha256Hex } from '../src/lib/crypto';
import { hashPassword } from '../src/lib/passwords';
import { OTP_HOURLY_PHONE_CEILING, OTP_TTL_MS } from '../src/lib/otp';
import { DEFAULT_AUTH_LIMITS } from '../src/lib/rate-limits';
import type { DevSmsResponse } from '../src/modules/dev/routes';
import { assertCanGamble, getActiveExclusion } from '../src/modules/rg/guard';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  csrfTokenFor,
  secureCookies,
  type SessionUser,
} from '../src/plugins/session';
import type { SmsMessage, SmsProvider } from '../src/providers/sms';
import {
  ADULT_DOB,
  TEST_PASSWORD,
  cookieHeader,
  createTestContext,
  dobForAge,
  latestOtp,
  post,
  randomPhone,
  registerAndLogin,
  type TestContext,
} from './helpers';

const DAY_MS = 24 * 60 * 60_000;

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Local form of an E.164 number: +251911234567 -> 0911234567. */
const localForm = (phone: string) => `0${phone.slice(4)}`;

function registerPayload(phone: string, overrides: Record<string, unknown> = {}) {
  return {
    phone,
    password: TEST_PASSWORD,
    dateOfBirth: ADULT_DOB,
    fullName: 'Tirunesh Dibaba',
    locale: 'am',
    acceptTerms: true,
    ...overrides,
  };
}

class RecordingSms implements SmsProvider {
  readonly name = 'test-gateway';
  readonly sent: SmsMessage[] = [];
  async send(message: SmsMessage) {
    this.sent.push(message);
    return { id: String(this.sent.length) };
  }
}

/** A gateway that holds every message until `release()` (a slow network). */
class BlockingSms implements SmsProvider {
  readonly name = 'blocking-gateway';
  readonly started: SmsMessage[] = [];
  readonly delivered: SmsMessage[] = [];
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  release() {
    this.open();
  }
  async send(message: SmsMessage) {
    this.started.push(message);
    await this.gate;
    this.delivered.push(message);
    return { id: String(this.delivered.length) };
  }
}

describe('auth', () => {
  let ctx: TestContext;
  /** Same deps plus a GET /test/whoami route that exposes request.user. */
  let probe: FastifyInstance;

  beforeAll(async () => {
    ctx = await createTestContext();
    probe = buildApp(ctx.deps, { logger: false, rateLimitNameSpace: `probe-${Date.now()}:` });
    void probe.register(async (instance) => {
      instance.get('/test/whoami', { preHandler: instance.requireAuth }, async (request) => ({
        user: request.user,
      }));
    });
    await probe.ready();
  });

  afterAll(async () => {
    await probe?.close();
    await ctx?.close();
  });

  async function whoami(headers: Record<string, string>) {
    const response = await probe.inject({ method: 'GET', url: '/test/whoami', headers });
    return {
      statusCode: response.statusCode,
      user: response.statusCode === 200 ? response.json<{ user: SessionUser }>().user : null,
    };
  }

  async function findUser(phone: string) {
    const [user] = await ctx.db.db.select().from(users).where(eq(users.phone, phone));
    return user;
  }

  /** POST /auth/register; expects 201 and returns the parsed body. */
  async function register(phone: string, overrides: Record<string, unknown> = {}) {
    const response = await post(ctx, '/auth/register', registerPayload(phone, overrides));
    expect(response.statusCode, response.body).toBe(201);
    return RegisterResponse.parse(response.json());
  }

  function verify(phone: string, code: string, registrationToken: string) {
    return post(ctx, '/auth/verify-otp', { phone, code, purpose: 'register', registrationToken });
  }

  async function auditActions(userId: string) {
    const rows = await ctx.db.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.actorId, userId));
    return rows;
  }

  describe('POST /auth/register', () => {
    it('creates a pending user and sends a bilingual OTP (shown on screen in demo mode)', async () => {
      const phone = randomPhone();
      const response = await post(ctx, '/auth/register', registerPayload(localForm(phone)));
      expect(response.statusCode).toBe(201);
      const body = RegisterResponse.parse(response.json());
      expect(body.otpSentTo).toBe(maskMsisdn(phone));
      expect(new Date(body.otpExpiresAt).getTime()).toBe(ctx.clock.now.getTime() + OTP_TTL_MS);
      expect(body.demoOtp).toMatch(/^\d{6}$/);
      expect(await latestOtp(ctx, phone)).toBe(body.demoOtp);
      // The account id is not disclosed before the phone is verified.
      expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
        'demoOtp',
        'otpExpiresAt',
        'otpSentTo',
        'registrationToken',
      ]);
      expect(body.registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const user = await findUser(phone);
      expect(user).toMatchObject({
        status: 'pending_verification',
        // Only a hash of the registration token is stored.
        registrationTokenHash: sha256Hex(body.registrationToken),
        fullName: 'Tirunesh Dibaba',
        dateOfBirth: ADULT_DOB,
        locale: 'am',
        phoneVerifiedAt: null,
      });
      expect(user!.termsAcceptedAt).toBeInstanceOf(Date);
      expect(user!.passwordHash).toMatch(/^\$argon2id\$/);

      const [sms] = await ctx.db.db.select().from(smsMessages).where(eq(smsMessages.to, phone));
      expect(sms).toMatchObject({ provider: 'mock', status: 'sent', template: 'otp_register' });
      expect(sms!.sentAt).toBeInstanceOf(Date);
      expect(sms!.body).toContain('የማረጋገጫ ኮድዎ');
      expect(sms!.body).toContain(`Your code is ${body.demoOtp}`);

      const [challenge] = await ctx.db.db
        .select()
        .from(otpChallenges)
        .where(eq(otpChallenges.phone, phone));
      expect(challenge).toMatchObject({ purpose: 'register', attempts: 0, maxAttempts: 5 });
      expect(challenge!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(challenge!.codeHash).not.toContain(body.demoOtp!);

      expect((await auditActions(user!.id)).map((row) => row.action)).toContain('user.registered');
    });

    it('rejects numbers that are not Ethiopian mobiles', async () => {
      const response = await post(ctx, '/auth/register', registerPayload('0111234567'));
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('invalid_phone');
    });

    it('validates the body with the contract', async () => {
      const response = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { acceptTerms: false, dateOfBirth: '17/05/1990' }),
      );
      expect(response.statusCode).toBe(400);
      const error = apiError(response);
      expect(error.code).toBe('validation_error');
      expect(error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'acceptTerms' }),
          expect.objectContaining({ path: 'dateOfBirth' }),
        ]),
      );
    });

    it('rejects impossible dates of birth', async () => {
      const response = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { dateOfBirth: '1990-02-30' }),
      );
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('invalid_date_of_birth');
    });

    it('rejects anyone under 21 without creating the user', async () => {
      const phone = randomPhone();
      const response = await post(
        ctx,
        '/auth/register',
        registerPayload(phone, { dateOfBirth: dobForAge(ctx.clock.now, 21, 1) }),
      );
      expect(response.statusCode).toBe(422);
      expect(apiError(response)).toMatchObject({ code: 'underage', details: { minAge: 21 } });
      expect(await findUser(phone)).toBeUndefined();
      const sent = await ctx.db.db.select().from(smsMessages).where(eq(smsMessages.to, phone));
      expect(sent).toHaveLength(0);
    });

    it('accepts someone who turns 21 today', async () => {
      const response = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { dateOfBirth: dobForAge(ctx.clock.now, 21) }),
      );
      expect(response.statusCode).toBe(201);
    });

    it.each(['qwerty123456', 'PASSWORD1234', 'Iloveyou1234', ' 1qaz2wsx3edc '])(
      'rejects the common password %s',
      async (pw) => {
        const response = await post(
          ctx,
          '/auth/register',
          registerPayload(randomPhone(), { password: pw }),
        );
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('weak_password');
      },
    );

    it('rejects the phone number as password', async () => {
      const phone = randomPhone();
      for (const password of [phone, phone.slice(1), `00${phone.slice(1)}`]) {
        const response = await post(ctx, '/auth/register', registerPayload(phone, { password }));
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('weak_password');
      }
      // The shorter forms fail the length rule first.
      for (const password of [localForm(phone), phone.slice(4)]) {
        const response = await post(ctx, '/auth/register', registerPayload(phone, { password }));
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('validation_error');
      }
    });

    it('needs 12 characters, counting a run of spaces once (ASVS 2.1.1)', async () => {
      for (const password of ['Abebe-bik-1', 'Abebe     bik-1']) {
        const response = await post(
          ctx,
          '/auth/register',
          registerPayload(randomPhone(), { password }),
        );
        expect(response.statusCode, password).toBe(400);
        expect(apiError(response).code).toBe('validation_error');
      }
      const twelve = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { password: 'Abebe-bik-19' }),
      );
      expect(twelve.statusCode).toBe(201);
      // Any characters, including Ethiopic and spaces, up to 128.
      const ethiopic = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { password: 'ሰላም ለኢትዮጵያ ሀገሬ' }),
      );
      expect(ethiopic.statusCode).toBe(201);
      const tooLong = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { password: 'x'.repeat(129) }),
      );
      expect(apiError(tooLong).code).toBe('validation_error');
    });

    it('returns 409 phone_taken for a number with an account', async () => {
      const player = await registerAndLogin(ctx);
      const response = await post(ctx, '/auth/register', registerPayload(player.phone));
      expect(response.statusCode).toBe(409);
      expect(apiError(response).code).toBe('phone_taken');

      await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.id, player.userId));
      const suspended = await post(ctx, '/auth/register', registerPayload(player.phone));
      expect(suspended.statusCode).toBe(409);
      expect(apiError(suspended).code).toBe('phone_taken');
    });

    it('lets a pending number register again, replacing its details, code and token', async () => {
      const phone = randomPhone();
      const first = await register(phone);

      // Within the resend cooldown nothing changes.
      const tooSoon = await post(
        ctx,
        '/auth/register',
        registerPayload(phone, { fullName: 'Someone Else' }),
      );
      expect(tooSoon.statusCode).toBe(429);
      expect(apiError(tooSoon)).toMatchObject({
        code: 'otp_cooldown',
        details: { retryAfterSeconds: 60 },
      });
      expect((await findUser(phone))!.fullName).toBe('Tirunesh Dibaba');

      ctx.clock.advance(61_000);
      const newPassword = 'Derartu-Tulu-1992';
      const second = await register(phone, {
        password: newPassword,
        fullName: 'Derartu Tulu',
        dateOfBirth: '1972-03-21',
        locale: 'en',
      });
      expect(second.registrationToken).not.toBe(first.registrationToken);
      expect(await findUser(phone)).toMatchObject({
        fullName: 'Derartu Tulu',
        dateOfBirth: '1972-03-21',
        locale: 'en',
        status: 'pending_verification',
      });

      // The first code was retired by the new challenge, and the first token too.
      if (first.demoOtp !== second.demoOtp) {
        const stale = await verify(phone, first.demoOtp!, second.registrationToken);
        expect(apiError(stale).code).toBe('otp_invalid');
      }
      const verified = await verify(phone, second.demoOtp!, second.registrationToken);
      expect(verified.statusCode).toBe(200);
      expect(SessionResponse.parse(verified.json()).user.locale).toBe('en');

      const oldLogin = await post(ctx, '/auth/login', { phone, password: TEST_PASSWORD });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await post(ctx, '/auth/login', { phone, password: newPassword });
      expect(newLogin.statusCode).toBe(200);
    });

    it('never lets a re-registration plant its password on the account the owner verifies', async () => {
      // A real gateway: codes reach only the phone, never the HTTP response.
      const gateway = new RecordingSms();
      const app = buildApp(
        { ...ctx.deps, sms: gateway },
        { logger: false, rateLimitNameSpace: `takeover-${randomUUID()}:` },
      );
      try {
        const send = (url: string, payload: Record<string, unknown>, remoteAddress: string) =>
          app.inject({ method: 'POST', url, payload, remoteAddress });
        const codeSentTo = (phone: string) =>
          /\b(\d{6})\b/.exec(gateway.sent.filter((m) => m.to === phone).at(-1)!.body)![1]!;
        const phone = randomPhone();
        const ownerPassword = 'Victim-Secret-2024';
        const attackerPassword = 'Attacker-Knows-This-1';

        const owner = RegisterResponse.parse(
          (
            await send(
              '/auth/register',
              registerPayload(phone, { password: ownerPassword }),
              '198.51.100.1',
            )
          ).json(),
        );
        ctx.clock.advance(61_000);
        const attackerResponse = await send(
          '/auth/register',
          registerPayload(phone, {
            password: attackerPassword,
            fullName: 'Attacker Name',
            dateOfBirth: '1980-01-01',
          }),
          '203.0.113.66',
        );
        expect(attackerResponse.statusCode).toBe(201);
        const attacker = RegisterResponse.parse(attackerResponse.json());
        expect(attacker.demoOtp).toBeUndefined();
        expect(attackerResponse.json()).not.toHaveProperty('userId');

        // The owner types the newest code from their phone: refused, loudly.
        const newestCode = codeSentTo(phone);
        const ownerVerify = await send(
          '/auth/verify-otp',
          {
            phone,
            code: newestCode,
            purpose: 'register',
            registrationToken: owner.registrationToken,
          },
          '198.51.100.1',
        );
        expect(ownerVerify.statusCode).toBe(400);
        expect(apiError(ownerVerify).code).toBe('registration_expired');
        expect((await findUser(phone))!.status).toBe('pending_verification');

        // The attacker has the token but not the code.
        const guess = newestCode === '000000' ? '111111' : '000000';
        const attackerVerify = await send(
          '/auth/verify-otp',
          {
            phone,
            code: guess,
            purpose: 'register',
            registrationToken: attacker.registrationToken,
          },
          '203.0.113.66',
        );
        expect(apiError(attackerVerify).code).toBe('otp_invalid');

        // The owner registers again; now their password is the one activated.
        ctx.clock.advance(61_000);
        const again = RegisterResponse.parse(
          (
            await send(
              '/auth/register',
              registerPayload(phone, { password: ownerPassword }),
              '198.51.100.1',
            )
          ).json(),
        );
        const stale = await send(
          '/auth/verify-otp',
          {
            phone,
            code: codeSentTo(phone),
            purpose: 'register',
            registrationToken: attacker.registrationToken,
          },
          '203.0.113.66',
        );
        expect(apiError(stale).code).toBe('registration_expired');
        const activated = await send(
          '/auth/verify-otp',
          {
            phone,
            code: codeSentTo(phone),
            purpose: 'register',
            registrationToken: again.registrationToken,
          },
          '198.51.100.1',
        );
        expect(activated.statusCode).toBe(200);
        expect(await findUser(phone)).toMatchObject({
          status: 'active',
          fullName: 'Tirunesh Dibaba',
          registrationTokenHash: null,
        });

        const attackerLogin = await post(ctx, '/auth/login', { phone, password: attackerPassword });
        expect(attackerLogin.statusCode).toBe(401);
        const ownerLogin = await post(ctx, '/auth/login', { phone, password: ownerPassword });
        expect(ownerLogin.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /auth/verify-otp', () => {
    it('activates the account and opens a cookie + bearer session', async () => {
      const phone = randomPhone();
      const registered = await register(phone);
      const response = await verify(
        localForm(phone),
        await latestOtp(ctx, phone),
        registered.registrationToken,
      );
      expect(response.statusCode).toBe(200);
      const body = SessionResponse.parse(response.json());
      const userId = (await findUser(phone))!.id;
      expect(body.user).toEqual({
        id: userId,
        phone,
        status: 'active',
        locale: 'am',
      });
      expect(new Date(body.expiresAt).getTime()).toBe(
        ctx.clock.now.getTime() + SESSION_ABSOLUTE_MS,
      );
      expect(new Date(body.idleExpiresAt).getTime()).toBe(
        ctx.clock.now.getTime() + SESSION_IDLE_MS,
      );
      // The CSRF token is derived from the session token, so GET /auth/session can hand it out.
      expect(body.csrfToken).toBe(csrfTokenFor(body.sessionToken));

      const sessionCookie = response.cookies.find((c) => c.name === 'vamos_session');
      const csrfCookie = response.cookies.find((c) => c.name === 'vamos_csrf');
      expect(sessionCookie).toMatchObject({
        value: body.sessionToken,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      });
      expect(sessionCookie!.secure).toBeFalsy();
      expect(csrfCookie).toMatchObject({ value: body.csrfToken, sameSite: 'Lax', path: '/' });
      expect(csrfCookie!.httpOnly).toBeFalsy();

      const user = await findUser(phone);
      expect(user!.status).toBe('active');
      expect(user!.phoneVerifiedAt).toBeInstanceOf(Date);
      expect(user!.registrationTokenHash).toBeNull();

      // Only hashes of the tokens are stored.
      const [stored] = await ctx.db.db.select().from(sessions).where(eq(sessions.userId, userId));
      expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored!.tokenHash).not.toBe(body.sessionToken);
      expect(stored!.csrfHash).not.toBe(body.csrfToken);

      const me = await whoami({ cookie: cookieHeader(response) });
      expect(me.user).toMatchObject({
        id: userId,
        phone,
        status: 'active',
        locale: 'am',
        sessionId: stored!.id,
        csrfToken: body.csrfToken,
      });

      // The session works: log out with it.
      const logout = await post(
        ctx,
        '/auth/logout',
        {},
        { headers: { cookie: cookieHeader(response), 'x-csrf-token': body.csrfToken } },
      );
      expect(logout.statusCode).toBe(200);
      expect(OkResponse.parse(logout.json())).toEqual({ ok: true });
    });

    it('counts wrong codes and kills the challenge after 5 attempts', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const code = await latestOtp(ctx, phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (const attemptsLeft of [4, 3, 2, 1, 0]) {
        const response = await verify(phone, wrong, registrationToken);
        expect(response.statusCode).toBe(400);
        expect(apiError(response)).toMatchObject({
          code: 'otp_invalid',
          details: { attemptsLeft },
        });
      }
      const dead = await verify(phone, code, registrationToken);
      expect(dead.statusCode).toBe(400);
      expect(apiError(dead).code).toBe('otp_expired');
      expect((await findUser(phone))!.status).toBe('pending_verification');
    });

    it('rejects an expired code', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const code = await latestOtp(ctx, phone);
      ctx.clock.advance(OTP_TTL_MS);
      const response = await verify(phone, code, registrationToken);
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('otp_expired');
    });

    it('rejects a completed registration, or a number that was never registered', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const code = await latestOtp(ctx, phone);
      expect((await verify(phone, code, registrationToken)).statusCode).toBe(200);
      const reused = await verify(phone, code, registrationToken);
      expect(reused.statusCode).toBe(400);
      expect(apiError(reused).code).toBe('registration_expired');

      const unknown = await verify(randomPhone(), '123456', registrationToken);
      expect(unknown.statusCode).toBe(400);
      expect(apiError(unknown).code).toBe('registration_expired');
    });

    it('requires the registration token, and a wrong one does not use up attempts', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const code = await latestOtp(ctx, phone);

      const missing = await post(ctx, '/auth/verify-otp', { phone, code, purpose: 'register' });
      expect(missing.statusCode).toBe(400);
      expect(apiError(missing).code).toBe('validation_error');

      for (let i = 0; i < 6; i += 1) {
        const forged = await verify(phone, code, `forged-${'x'.repeat(30)}-${i}`);
        expect(apiError(forged).code).toBe('registration_expired');
      }
      const [challenge] = await ctx.db.db
        .select({ attempts: otpChallenges.attempts, consumedAt: otpChallenges.consumedAt })
        .from(otpChallenges)
        .where(eq(otpChallenges.phone, phone));
      expect(challenge).toEqual({ attempts: 0, consumedAt: null });

      expect((await verify(phone, code, registrationToken)).statusCode).toBe(200);
    });
  });

  describe('POST /auth/otp/resend', () => {
    it('enforces a 60 s cooldown and retires the previous code', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const firstCode = await latestOtp(ctx, phone);
      const resend = () =>
        post(ctx, '/auth/otp/resend', { phone, purpose: 'register', registrationToken });

      ctx.clock.advance(20_000);
      const tooSoon = await resend();
      expect(tooSoon.statusCode).toBe(429);
      expect(apiError(tooSoon)).toMatchObject({
        code: 'otp_cooldown',
        details: { retryAfterSeconds: 40 },
      });

      ctx.clock.advance(40_000);
      const resent = await resend();
      expect(resent.statusCode).toBe(200);
      const body = OtpSentResponse.parse(resent.json());
      const secondCode = await latestOtp(ctx, phone);
      expect(body.demoOtp).toBe(secondCode);

      if (firstCode !== secondCode) {
        const stale = await verify(phone, firstCode, registrationToken);
        expect(apiError(stale).code).toBe('otp_invalid');
      }
      const ok = await verify(phone, secondCode, registrationToken);
      expect(ok.statusCode).toBe(200);
    });

    it('allows at most 5 codes per number per rolling hour', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      const resend = (extra: Parameters<typeof post>[3] = {}) =>
        post(ctx, '/auth/otp/resend', { phone, purpose: 'register', registrationToken }, extra);
      for (let i = 0; i < 4; i += 1) {
        ctx.clock.advance(61_000);
        const response = await resend();
        expect(response.statusCode).toBe(200);
      }
      ctx.clock.advance(61_000);
      const limited = await resend();
      expect(limited.statusCode).toBe(429);
      const error = apiError(limited);
      expect(error.code).toBe('otp_limit');
      // The oldest of the five codes leaves the window 3600 - 5 * 61 seconds from now.
      expect(error.details).toEqual({ retryAfterSeconds: 3600 - 5 * 61 });

      ctx.clock.advance((3600 - 5 * 61) * 1000);
      const later = await resend({ remoteAddress: '10.20.30.40' });
      expect(later.statusCode).toBe(200);
    });

    it('does not let password-reset requests for a number use up its registration codes', async () => {
      // Anyone can ask for reset codes for any number; nothing is sent without an account.
      const phone = randomPhone();
      for (let i = 0; i < 5; i += 1) {
        ctx.clock.advance(61_000);
        const forgot = await post(
          ctx,
          '/auth/password/forgot',
          { phone },
          { remoteAddress: `192.0.2.${100 + i}` },
        );
        expect(forgot.statusCode).toBe(200);
      }
      ctx.clock.advance(61_000);
      const registered = await post(ctx, '/auth/register', registerPayload(phone));
      expect(registered.statusCode).toBe(201);
      // The reset bucket itself is still capped (per number, across addresses).
      for (let i = 5; i < OTP_HOURLY_PHONE_CEILING; i += 1) {
        const forgot = await post(
          ctx,
          '/auth/password/forgot',
          { phone },
          { remoteAddress: `192.0.2.${100 + i}` },
        );
        expect(forgot.statusCode).toBe(200);
      }
      const over = await post(
        ctx,
        '/auth/password/forgot',
        { phone },
        { remoteAddress: '192.0.2.99' },
      );
      expect(apiError(over).code).toBe('otp_limit');
    });

    it('only resends registration codes to the holder of the registration token', async () => {
      const missing = await post(ctx, '/auth/otp/resend', {
        phone: randomPhone(),
        purpose: 'register',
      });
      expect(missing.statusCode).toBe(400);
      expect(apiError(missing)).toMatchObject({
        code: 'validation_error',
        details: [expect.objectContaining({ path: 'registrationToken' })],
      });

      // Unknown, pending (with someone else's token) and active numbers all get the same answer.
      const pendingPhone = randomPhone();
      await register(pendingPhone);
      const player = await registerAndLogin(ctx);
      ctx.clock.advance(61_000);
      const foreignToken = (await register(randomPhone())).registrationToken;
      for (const phone of [randomPhone(), pendingPhone, player.phone]) {
        const response = await post(ctx, '/auth/otp/resend', {
          phone,
          purpose: 'register',
          registrationToken: foreignToken,
        });
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('registration_expired');
      }
      const sent = await ctx.db.db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.to, pendingPhone));
      expect(sent).toHaveLength(1);
    });

    it('answers password_reset resends for unknown numbers without sending anything', async () => {
      const phone = randomPhone();
      const response = await post(ctx, '/auth/otp/resend', { phone, purpose: 'password_reset' });
      expect(response.statusCode).toBe(200);
      const body = OtpSentResponse.parse(response.json());
      expect(body.otpSentTo).toBe(maskMsisdn(phone));
      expect(body.demoOtp).toBeUndefined();
      const sent = await ctx.db.db.select().from(smsMessages).where(eq(smsMessages.to, phone));
      expect(sent).toHaveLength(0);
    });

    it('does not resend login codes', async () => {
      const response = await post(ctx, '/auth/otp/resend', {
        phone: randomPhone(),
        purpose: 'login',
      });
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('unsupported_purpose');
    });
  });

  describe('POST /auth/login', () => {
    it('opens a session for the right password', async () => {
      const player = await registerAndLogin(ctx);
      const response = await post(ctx, '/auth/login', {
        phone: localForm(player.phone),
        password: player.password,
      });
      expect(response.statusCode).toBe(200);
      const body = SessionResponse.parse(response.json());
      expect(body.user).toMatchObject({ id: player.userId, phone: player.phone, status: 'active' });
      expect(body.sessionToken).not.toBe(player.sessionToken);
      expect(response.cookies.map((c) => c.name).sort()).toEqual(['vamos_csrf', 'vamos_session']);
      expect((await whoami(bearer(body.sessionToken))).user?.id).toBe(player.userId);
      expect((await auditActions(player.userId)).map((row) => row.action)).toContain('user.login');
    });

    it('gives the same 401 for unknown numbers, malformed numbers and wrong passwords', async () => {
      const player = await registerAndLogin(ctx);
      const attempts = [
        { phone: randomPhone(), password: TEST_PASSWORD },
        { phone: 'not-a-phone', password: TEST_PASSWORD },
        { phone: player.phone, password: 'wrong-password' },
      ];
      const errors = [];
      for (const attempt of attempts) {
        const response = await post(ctx, '/auth/login', attempt);
        expect(response.statusCode).toBe(401);
        // Every error carries its own request id; the rest must not tell the cases apart.
        const { requestId, ...error } = apiError(response) as Record<string, unknown>;
        expect(requestId).toBe(response.headers['x-request-id']);
        errors.push(error);
      }
      expect(errors[0]).toEqual({
        code: 'invalid_credentials',
        message: 'Incorrect phone number or password.',
      });
      expect(errors[1]).toEqual(errors[0]);
      expect(errors[2]).toEqual(errors[0]);

      const failures = (await auditActions(player.userId)).filter(
        (row) => row.action === 'user.login_failed',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.metadata).toMatchObject({ reason: 'wrong_password' });
    });

    it('asks pending users to verify their phone (only with the right password)', async () => {
      const phone = randomPhone();
      await post(ctx, '/auth/register', registerPayload(phone));
      const wrong = await post(ctx, '/auth/login', { phone, password: 'nope-nope' });
      expect(wrong.statusCode).toBe(401);
      const right = await post(ctx, '/auth/login', { phone, password: TEST_PASSWORD });
      expect(right.statusCode).toBe(403);
      expect(apiError(right).code).toBe('phone_not_verified');
    });

    it.each(['suspended', 'closed'] as const)(
      'refuses %s accounts and drops their sessions',
      async (status) => {
        const player = await registerAndLogin(ctx);
        await ctx.db.db.update(users).set({ status }).where(eq(users.id, player.userId));
        const response = await post(ctx, '/auth/login', {
          phone: player.phone,
          password: player.password,
        });
        expect(response.statusCode).toBe(403);
        expect(apiError(response).code).toBe('account_disabled');
        expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(401);
      },
    );

    it('blocks self-excluded players, permanently or until the end date', async () => {
      const now = ctx.clock.now;
      const player = await registerAndLogin(ctx);
      const endsAt = new Date(now.getTime() + 180 * DAY_MS);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'self_exclusion',
        startsAt: new Date(now.getTime() - DAY_MS),
        endsAt,
      });
      const response = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      expect(response.statusCode).toBe(403);
      const error = apiError(response);
      expect(error.code).toBe('self_excluded');
      expect(error.message).toContain(endsAt.toISOString());
      const failures = (await auditActions(player.userId)).filter(
        (row) => row.action === 'user.login_failed',
      );
      expect(failures[0]!.metadata).toMatchObject({ reason: 'self_excluded' });

      const permanent = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: permanent.userId,
        kind: 'self_exclusion',
        startsAt: now,
        endsAt: null,
      });
      const blocked = await post(ctx, '/auth/login', {
        phone: permanent.phone,
        password: permanent.password,
      });
      expect(blocked.statusCode).toBe(403);
      expect(apiError(blocked)).toMatchObject({
        code: 'self_excluded',
        message: 'You have permanently self-excluded from Vamos.',
      });
    });

    it('lets players in once a self-exclusion has ended or before it starts', async () => {
      const now = ctx.clock.now;
      const player = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values([
        {
          userId: player.userId,
          kind: 'self_exclusion',
          startsAt: new Date(now.getTime() - 200 * DAY_MS),
          endsAt: new Date(now.getTime() - DAY_MS),
        },
        {
          userId: player.userId,
          kind: 'self_exclusion',
          startsAt: new Date(now.getTime() + DAY_MS),
          endsAt: new Date(now.getTime() + 100 * DAY_MS),
        },
      ]);
      const response = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      expect(response.statusCode).toBe(200);
    });

    it('still lets players on a cool-off log in', async () => {
      const now = ctx.clock.now;
      const player = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'cool_off',
        startsAt: now,
        endsAt: new Date(now.getTime() + 7 * DAY_MS),
      });
      const response = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      expect(response.statusCode).toBe(200);
    });

    it('makes a password that no longer meets the rules be reset first (ASVS 2.1.7)', async () => {
      for (const legacy of ['Ab3$xy7q', 'qwerty123456']) {
        const player = await registerAndLogin(ctx);
        // Set under an older rule (8 characters), or now on the common list.
        await ctx.db.db
          .update(users)
          .set({ passwordHash: await hashPassword(legacy) })
          .where(eq(users.id, player.userId));
        const response = await post(ctx, '/auth/login', { phone: player.phone, password: legacy });
        expect(response.statusCode, legacy).toBe(403);
        expect(apiError(response).code).toBe('password_reset_required');
        expect(response.cookies).toHaveLength(0);
        // A wrong password still gets the generic answer: the rule is only revealed to the holder.
        const wrong = await post(ctx, '/auth/login', { phone: player.phone, password: 'Ab3$xy7r' });
        expect(apiError(wrong).code).toBe('invalid_credentials');
        const audits = await ctx.db.db
          .select({ metadata: auditLog.metadata })
          .from(auditLog)
          .where(
            and(eq(auditLog.action, 'user.login_failed'), eq(auditLog.targetId, player.userId)),
          );
        expect(audits.map((row) => row.metadata)).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'password_policy' })]),
        );
      }
    });
  });

  describe('sessions and CSRF', () => {
    it('requires the CSRF header for cookie-authenticated POSTs', async () => {
      const player = await registerAndLogin(ctx);

      const missing = await post(ctx, '/auth/logout', {}, { headers: { cookie: player.cookie } });
      expect(missing.statusCode).toBe(403);
      expect(apiError(missing).code).toBe('csrf_invalid');

      const wrong = await post(
        ctx,
        '/auth/logout',
        {},
        { headers: { cookie: player.cookie, 'x-csrf-token': 'forged' } },
      );
      expect(wrong.statusCode).toBe(403);
      expect(apiError(wrong).code).toBe('csrf_invalid');

      // Safe methods need no CSRF token.
      expect((await whoami({ cookie: player.cookie })).statusCode).toBe(200);

      const ok = await post(
        ctx,
        '/auth/logout',
        {},
        { headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken } },
      );
      expect(ok.statusCode).toBe(200);
      const cleared = ok.cookies.filter((c) => c.value === '');
      expect(cleared.map((c) => c.name).sort()).toEqual(['vamos_csrf', 'vamos_session']);

      const [stored] = await ctx.db.db
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.userId, player.userId));
      expect(stored!.revokedAt).toBeInstanceOf(Date);

      // The revoked session no longer authenticates.
      const again = await post(
        ctx,
        '/auth/logout',
        {},
        { headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken } },
      );
      expect(again.statusCode).toBe(401);
      expect(apiError(again).code).toBe('unauthorized');
    });

    it('accepts a bearer token without a CSRF header', async () => {
      const player = await registerAndLogin(ctx);
      const response = await post(
        ctx,
        '/auth/logout',
        {},
        { headers: bearer(player.sessionToken) },
      );
      expect(response.statusCode).toBe(200);
      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(401);
    });

    it('rejects missing, unknown and expired sessions', async () => {
      const noAuth = await post(ctx, '/auth/logout', {});
      expect(noAuth.statusCode).toBe(401);
      expect((await whoami(bearer('not-a-real-token'))).statusCode).toBe(401);

      // 12 hours after sign-in at the latest, however active (ASVS 3.3.2).
      const player = await registerAndLogin(ctx);
      const signedInAt = ctx.clock.now.getTime();
      while (ctx.clock.now.getTime() + SESSION_IDLE_MS / 2 < signedInAt + SESSION_ABSOLUTE_MS) {
        ctx.clock.advance(SESSION_IDLE_MS / 2);
        expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(200);
      }
      ctx.clock.advance(signedInAt + SESSION_ABSOLUTE_MS - ctx.clock.now.getTime() - 1000);
      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(200);
      ctx.clock.advance(1000);
      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(401);

      // 30 minutes without a request.
      const idle = await registerAndLogin(ctx);
      ctx.clock.advance(SESSION_IDLE_MS - 1000);
      expect((await whoami(bearer(idle.sessionToken))).statusCode).toBe(200);
      ctx.clock.advance(SESSION_IDLE_MS - 1000);
      expect((await whoami(bearer(idle.sessionToken))).statusCode).toBe(200);
      ctx.clock.advance(SESSION_IDLE_MS);
      expect((await whoami(bearer(idle.sessionToken))).statusCode).toBe(401);
    });

    it('marks cookies Secure in production, in licensed mode and behind HTTPS', async () => {
      const { config } = ctx.deps;
      expect(secureCookies(config)).toBe(false);
      expect(secureCookies({ ...config, nodeEnv: 'production' })).toBe(true);
      expect(secureCookies({ ...config, mode: 'licensed' })).toBe(true);
      expect(
        secureCookies({ ...config, api: { ...config.api, publicUrl: 'https://api.vamos.et' } }),
      ).toBe(true);

      const licensed = buildApp(
        { ...ctx.deps, config: { ...config, mode: 'licensed' } },
        { logger: false, rateLimitNameSpace: `secure-${randomUUID()}:` },
      );
      try {
        const player = await registerAndLogin(ctx);
        const response = await licensed.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { phone: player.phone, password: player.password },
        });
        expect(response.statusCode).toBe(200);
        // __Host- names: Secure, path /, no Domain (ASVS 3.4.4).
        expect(
          response.cookies.map((cookie) => [
            cookie.name,
            cookie.secure,
            cookie.path,
            cookie.domain,
          ]),
        ).toEqual([
          ['__Host-vamos_session', true, '/', undefined],
          ['__Host-vamos_csrf', true, '/', undefined],
        ]);
        const token = response.json<{ sessionToken: string }>().sessionToken;
        const me = (cookie: string) =>
          licensed.inject({ method: 'GET', url: '/me', headers: { cookie } });
        // Only the __Host- cookie authenticates: a plain one could be planted by a sibling host.
        expect((await me(`__Host-vamos_session=${token}`)).statusCode).toBe(200);
        expect((await me(`vamos_session=${token}`)).statusCode).toBe(401);
      } finally {
        await licensed.close();
      }
    });

    it('updates last_seen_at at most once a minute', async () => {
      const player = await registerAndLogin(ctx);
      const lastSeen = async () => {
        const [row] = await ctx.db.db
          .select({ lastSeenAt: sessions.lastSeenAt })
          .from(sessions)
          .where(eq(sessions.userId, player.userId));
        return row!.lastSeenAt.getTime();
      };
      const created = await lastSeen();
      ctx.clock.advance(30_000);
      await whoami(bearer(player.sessionToken));
      expect(await lastSeen()).toBe(created);
      ctx.clock.advance(30_000);
      await whoami(bearer(player.sessionToken));
      expect(await lastSeen()).toBe(ctx.clock.now.getTime());
    });
  });

  describe('password reset', () => {
    it('resets the password with an SMS code and revokes every session', async () => {
      const player = await registerAndLogin(ctx);
      const second = SessionResponse.parse(
        (await post(ctx, '/auth/login', { phone: player.phone, password: player.password })).json(),
      );

      const forgot = await post(ctx, '/auth/password/forgot', { phone: localForm(player.phone) });
      expect(forgot.statusCode).toBe(200);
      const body = OtpSentResponse.parse(forgot.json());
      // A reset code only ever reaches the phone, even in demo mode.
      expect(body.demoOtp).toBeUndefined();
      const code = await latestOtp(ctx, player.phone);
      const [sms] = await ctx.db.db
        .select()
        .from(smsMessages)
        .where(
          and(eq(smsMessages.to, player.phone), eq(smsMessages.template, 'otp_password_reset')),
        );
      expect(sms).toBeDefined();

      const newPassword = 'Haile-Gebrselassie-1973';
      const weak = await post(ctx, '/auth/password/reset', {
        phone: player.phone,
        code,
        newPassword: '123456789012',
      });
      expect(apiError(weak).code).toBe('weak_password');

      const wrongCode = await post(ctx, '/auth/password/reset', {
        phone: player.phone,
        code: code === '999999' ? '888888' : '999999',
        newPassword,
      });
      expect(wrongCode.statusCode).toBe(400);
      expect(apiError(wrongCode)).toMatchObject({
        code: 'otp_invalid',
        details: { attemptsLeft: 4 },
      });

      const reset = await post(ctx, '/auth/password/reset', {
        phone: player.phone,
        code,
        newPassword,
      });
      expect(reset.statusCode).toBe(200);
      expect(OkResponse.parse(reset.json())).toEqual({ ok: true });

      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(401);
      expect((await whoami(bearer(second.sessionToken))).statusCode).toBe(401);
      const old = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      expect(old.statusCode).toBe(401);
      const fresh = await post(ctx, '/auth/login', { phone: player.phone, password: newPassword });
      expect(fresh.statusCode).toBe(200);

      const audit = (await auditActions(player.userId)).find(
        (row) => row.action === 'user.password_reset',
      );
      expect(audit?.metadata).toEqual({ revokedSessions: 2 });

      const reused = await post(ctx, '/auth/password/reset', {
        phone: player.phone,
        code,
        newPassword: 'Another-Password-1',
      });
      expect(apiError(reused).code).toBe('otp_expired');
    });

    it('answers unknown numbers exactly like real ones, without sending an SMS', async () => {
      const player = await registerAndLogin(ctx);
      const unknownPhone = randomPhone();

      const known = await post(ctx, '/auth/password/forgot', { phone: player.phone });
      const unknown = await post(ctx, '/auth/password/forgot', { phone: unknownPhone });
      expect(known.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      const knownBody = OtpSentResponse.parse(known.json());
      const unknownBody = OtpSentResponse.parse(unknown.json());
      expect(unknownBody).toEqual({
        otpSentTo: maskMsisdn(unknownPhone),
        otpExpiresAt: knownBody.otpExpiresAt,
      });
      expect(knownBody).toEqual({
        otpSentTo: maskMsisdn(player.phone),
        otpExpiresAt: knownBody.otpExpiresAt,
      });
      await ctx.app.background.idle();
      const sent = await ctx.db.db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.to, unknownPhone));
      expect(sent).toHaveLength(0);

      // Both requests are audited alike.
      const requests = await ctx.db.db
        .select({ actorId: auditLog.actorId, metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.action, 'user.password_reset_requested'));
      expect(requests).toEqual(
        expect.arrayContaining([
          { actorId: player.userId, metadata: { phone: maskMsisdn(player.phone), smsSent: true } },
          { actorId: null, metadata: { phone: maskMsisdn(unknownPhone), smsSent: false } },
        ]),
      );

      // The cooldown applies to both, so it reveals nothing either.
      const knownAgain = await post(ctx, '/auth/password/forgot', { phone: player.phone });
      const unknownAgain = await post(ctx, '/auth/password/forgot', { phone: unknownPhone });
      expect(apiError(knownAgain).code).toBe('otp_cooldown');
      expect(apiError(unknownAgain).code).toBe('otp_cooldown');

      const guess = await post(ctx, '/auth/password/reset', {
        phone: unknownPhone,
        code: '123456',
        newPassword: 'Whatever-Password-9',
      });
      expect(guess.statusCode).toBe(400);
      expect(apiError(guess).code).toBe('otp_invalid');
    });

    it('answers before the SMS gateway does, so its latency reveals no account', async () => {
      const gateway = new BlockingSms();
      const app = buildApp(
        { ...ctx.deps, sms: gateway },
        { logger: false, rateLimitNameSpace: `slow-sms-${randomUUID()}:` },
      );
      try {
        const player = await registerAndLogin(ctx);
        const known = await app.inject({
          method: 'POST',
          url: '/auth/password/forgot',
          payload: { phone: player.phone },
        });
        // The gateway has not answered yet, but the response is already out.
        expect(known.statusCode).toBe(200);
        expect(gateway.started).toHaveLength(1);
        expect(gateway.delivered).toHaveLength(0);
        const unknown = await app.inject({
          method: 'POST',
          url: '/auth/password/forgot',
          payload: { phone: randomPhone() },
        });
        expect(unknown.statusCode).toBe(200);
        expect(Object.keys(unknown.json<object>())).toEqual(Object.keys(known.json<object>()));

        gateway.release();
        await app.background.idle();
        expect(gateway.delivered).toEqual([
          expect.objectContaining({ to: player.phone, template: 'otp_password_reset' }),
        ]);
      } finally {
        gateway.release();
        await app.close();
      }
    });
  });

  describe('rate limiting', () => {
    it('limits login attempts per IP and phone number with 429 rate_limited', async () => {
      const phone = randomPhone();
      const remoteAddress = '192.0.2.10';
      for (let i = 0; i < 10; i += 1) {
        const response = await post(
          ctx,
          '/auth/login',
          { phone, password: 'wrong-password' },
          { remoteAddress },
        );
        expect(response.statusCode).toBe(401);
      }
      const limited = await post(
        ctx,
        '/auth/login',
        { phone, password: 'wrong-password' },
        { remoteAddress },
      );
      expect(limited.statusCode).toBe(429);
      expect(apiError(limited).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Another number from the same address, or the same number from elsewhere, is unaffected.
      const otherPhone = await post(
        ctx,
        '/auth/login',
        { phone: randomPhone(), password: 'wrong-password' },
        { remoteAddress },
      );
      expect(otherPhone.statusCode).toBe(401);
      const otherIp = await post(
        ctx,
        '/auth/login',
        { phone, password: 'wrong-password' },
        { remoteAddress: '192.0.2.11' },
      );
      expect(otherIp.statusCode).toBe(401);
    });

    it('ignores X-Forwarded-For from clients: it cannot dodge the limit or forge the logged IP', async () => {
      const phone = randomPhone();
      const remoteAddress = '192.0.2.30';
      const attempt = (i: number) =>
        post(
          ctx,
          '/auth/login',
          { phone, password: `wrong-password-${i}` },
          { remoteAddress, headers: { 'x-forwarded-for': `198.51.100.${i}` } },
        );
      for (let i = 0; i < 10; i += 1) {
        expect((await attempt(i)).statusCode).toBe(401);
      }
      const limited = await attempt(10);
      expect(limited.statusCode).toBe(429);
      expect(apiError(limited).code).toBe('rate_limited');

      const failures = await ctx.db.db
        .select({ ip: auditLog.ip })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'user.login_failed'), eq(auditLog.ip, remoteAddress)));
      expect(failures).toHaveLength(10);
    });

    it('reads the client address from X-Forwarded-For only when a trusted proxy sends it', async () => {
      const app = buildApp(ctx.deps, {
        logger: false,
        rateLimitNameSpace: `proxy-${randomUUID()}:`,
        trustProxy: ['10.0.0.0/8'],
      });
      try {
        const phone = randomPhone();
        const login = (remoteAddress: string, forwardedFor: string) =>
          app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { phone, password: 'wrong-password' },
            remoteAddress,
            headers: { 'x-forwarded-for': forwardedFor },
          });
        // Behind the load balancer, each forwarded client has its own budget.
        for (let i = 0; i < 10; i += 1) {
          expect((await login('10.1.2.3', `spoofed, 203.0.113.7`)).statusCode).toBe(401);
        }
        expect((await login('10.9.9.9', '203.0.113.7')).statusCode).toBe(429);
        expect((await login('10.1.2.3', '203.0.113.8')).statusCode).toBe(401);
        // A client outside the trusted range is keyed by its own address.
        expect((await login('192.0.2.40', '203.0.113.9')).statusCode).toBe(401);

        const ips = await ctx.db.db
          .select({ ip: auditLog.ip })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'user.login_failed'), eq(auditLog.ip, '203.0.113.7')));
        expect(ips).toHaveLength(10);
        const direct = await ctx.db.db
          .select({ ip: auditLog.ip })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'user.login_failed'), eq(auditLog.ip, '192.0.2.40')));
        expect(direct).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it('locks a phone number after too many login attempts from any addresses', async () => {
      expect(DEFAULT_AUTH_LIMITS.loginPerPhone).toEqual({ max: 20, timeWindow: 15 * 60_000 });
      const app = buildApp(ctx.deps, {
        logger: false,
        rateLimitNameSpace: `per-phone-${randomUUID()}:`,
        authLimits: { loginPerPhone: { max: 3, timeWindow: 15 * 60_000 } },
      });
      try {
        const player = await registerAndLogin(ctx);
        const login = (password: string, i: number, phone = player.phone) =>
          app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { phone, password },
            remoteAddress: `198.51.100.${i}`,
          });
        for (let i = 0; i < 3; i += 1) {
          expect((await login(`guess-${i}`, i)).statusCode).toBe(401);
        }
        const locked = await login('guess-3', 3);
        expect(locked.statusCode).toBe(429);
        expect(apiError(locked)).toMatchObject({
          code: 'rate_limited',
          details: { retryAfterSeconds: expect.any(Number) },
        });
        expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
        // While locked, even the right password waits; other numbers are unaffected.
        expect((await login(player.password, 4)).statusCode).toBe(429);
        expect((await login('guess', 5, randomPhone())).statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('caps auth requests per client address across phone numbers (IPv6 per /64)', async () => {
      expect(DEFAULT_AUTH_LIMITS.perClient.max).toBeGreaterThanOrEqual(100);
      const app = buildApp(ctx.deps, {
        logger: false,
        rateLimitNameSpace: `per-client-${randomUUID()}:`,
        authLimits: { perClient: { max: 3, timeWindow: 60 * 60_000 } },
      });
      try {
        const forgot = (remoteAddress: string) =>
          app.inject({
            method: 'POST',
            url: '/auth/password/forgot',
            payload: { phone: randomPhone() },
            remoteAddress,
          });
        const login = (remoteAddress: string) =>
          app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { phone: randomPhone(), password: 'whatever-1' },
            remoteAddress,
          });
        expect((await forgot('192.0.2.50')).statusCode).toBe(200);
        expect((await login('192.0.2.50')).statusCode).toBe(401);
        expect((await forgot('192.0.2.50')).statusCode).toBe(200);
        const limited = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: registerPayload(randomPhone()),
          remoteAddress: '192.0.2.50',
        });
        expect(limited.statusCode).toBe(429);
        expect(apiError(limited).code).toBe('rate_limited');
        expect((await forgot('192.0.2.51')).statusCode).toBe(200);

        // One IPv6 subscriber (/64) shares a budget; the next /64 does not.
        for (const address of ['2001:db8:1:2::1', '2001:db8:1:2::abcd', '2001:db8:1:2:ffff::9']) {
          expect((await forgot(address)).statusCode).toBe(200);
        }
        expect((await forgot('2001:db8:1:2::77')).statusCode).toBe(429);
        expect((await forgot('2001:db8:1:3::1')).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('limits forgot-password requests to 5 an hour', async () => {
      const phone = randomPhone();
      const remoteAddress = '192.0.2.20';
      for (let i = 0; i < 5; i += 1) {
        ctx.clock.advance(61_000);
        const response = await post(ctx, '/auth/password/forgot', { phone }, { remoteAddress });
        expect(response.statusCode).toBe(200);
      }
      ctx.clock.advance(61_000);
      const limited = await post(ctx, '/auth/password/forgot', { phone }, { remoteAddress });
      expect(limited.statusCode).toBe(429);
      expect(apiError(limited).code).toBe('rate_limited');
    });
  });

  describe('dev SMS inbox', () => {
    it('lists the mock gateway messages for a number, newest first', async () => {
      const phone = randomPhone();
      const { registrationToken } = await register(phone);
      ctx.clock.advance(61_000);
      await post(ctx, '/auth/otp/resend', { phone, purpose: 'register', registrationToken });

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/dev/sms?phone=${encodeURIComponent(localForm(phone))}`,
      });
      expect(response.statusCode).toBe(200);
      const { items } = response.json<DevSmsResponse>();
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.to === phone && item.template === 'otp_register')).toBe(
        true,
      );
      expect(items[0]!.body).toContain(await latestOtp(ctx, phone));
      expect(Date.parse(items[0]!.createdAt)).toBeGreaterThanOrEqual(
        Date.parse(items[1]!.createdAt),
      );

      // There is no listing of every number.
      const all = await ctx.app.inject({ method: 'GET', url: '/dev/sms' });
      expect(all.statusCode).toBe(400);
      expect(apiError(all).code).toBe('validation_error');

      const invalid = await ctx.app.inject({ method: 'GET', url: '/dev/sms?phone=123' });
      expect(invalid.statusCode).toBe(400);
    });

    it('does not exist, and codes are never echoed, with a real SMS gateway or in licensed mode', async () => {
      const gateway = new RecordingSms();
      const withGateway = buildApp(
        { ...ctx.deps, sms: gateway },
        { logger: false, rateLimitNameSpace: `gateway-${Date.now()}:` },
      );
      const licensed = buildApp(
        { ...ctx.deps, config: { ...ctx.deps.config, mode: 'licensed' } },
        { logger: false, rateLimitNameSpace: `licensed-${Date.now()}:` },
      );
      // A public demo runs with NODE_ENV=production: no inbox there either.
      const publicDemo = buildApp(
        { ...ctx.deps, config: { ...ctx.deps.config, nodeEnv: 'production' } },
        { logger: false, rateLimitNameSpace: `public-demo-${Date.now()}:` },
      );
      try {
        for (const app of [withGateway, licensed, publicDemo]) {
          const inbox = await app.inject({
            method: 'GET',
            url: `/dev/sms?phone=${encodeURIComponent(randomPhone())}`,
          });
          expect(inbox.statusCode).toBe(404);
        }

        const phone = randomPhone();
        const registered = await withGateway.inject({
          method: 'POST',
          url: '/auth/register',
          payload: registerPayload(phone),
        });
        expect(registered.statusCode).toBe(201);
        expect(RegisterResponse.parse(registered.json()).demoOtp).toBeUndefined();
        expect(gateway.sent).toHaveLength(1);
        expect(gateway.sent[0]).toMatchObject({ to: phone, template: 'otp_register' });

        const licensedPhone = randomPhone();
        const licensedRegistration = await licensed.inject({
          method: 'POST',
          url: '/auth/register',
          payload: registerPayload(licensedPhone),
        });
        expect(licensedRegistration.statusCode).toBe(201);
        expect(RegisterResponse.parse(licensedRegistration.json()).demoOtp).toBeUndefined();
      } finally {
        await withGateway.close();
        await licensed.close();
        await publicDemo.close();
      }
    });
  });

  describe('responsible-gambling guard', () => {
    it('reports the most restrictive active exclusion', async () => {
      const now = ctx.clock.now;
      const player = await registerAndLogin(ctx);
      expect(await getActiveExclusion(ctx.db.db, player.userId, now)).toBeNull();
      await expect(assertCanGamble(ctx.db.db, player.userId, now)).resolves.toBeUndefined();

      const coolOffEnd = new Date(now.getTime() + DAY_MS);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'cool_off',
        startsAt: now,
        endsAt: coolOffEnd,
      });
      expect(await getActiveExclusion(ctx.db.db, player.userId, now)).toEqual({
        kind: 'cool_off',
        startsAt: now,
        endsAt: coolOffEnd,
      });
      await expect(assertCanGamble(ctx.db.db, player.userId, now)).rejects.toMatchObject({
        statusCode: 403,
        code: 'cooling_off',
        message: expect.stringContaining(coolOffEnd.toISOString()),
      });
      expect(
        await getActiveExclusion(ctx.db.db, player.userId, now, { kind: 'self_exclusion' }),
      ).toBeNull();

      const selfExclusionEnd = new Date(now.getTime() + 365 * DAY_MS);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'self_exclusion',
        startsAt: new Date(now.getTime() - 1000),
        endsAt: selfExclusionEnd,
      });
      expect((await getActiveExclusion(ctx.db.db, player.userId, now))?.kind).toBe(
        'self_exclusion',
      );
      await expect(assertCanGamble(ctx.db.db, player.userId, now)).rejects.toMatchObject({
        code: 'self_excluded',
        message: expect.stringContaining(selfExclusionEnd.toISOString()),
      });

      // Exclusions end exactly at ends_at.
      expect(await getActiveExclusion(ctx.db.db, player.userId, selfExclusionEnd)).toBeNull();
    });
  });
});
