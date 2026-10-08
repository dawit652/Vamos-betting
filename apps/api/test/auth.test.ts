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
import { OTP_TTL_MS } from '../src/lib/otp';
import type { DevSmsResponse } from '../src/modules/dev/routes';
import { assertCanGamble, getActiveExclusion } from '../src/modules/rg/guard';
import { SESSION_TTL_MS, type SessionUser } from '../src/plugins/session';
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

      const user = await findUser(phone);
      expect(user).toMatchObject({
        id: body.userId,
        status: 'pending_verification',
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

      expect((await auditActions(body.userId)).map((row) => row.action)).toContain(
        'user.registered',
      );
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

    it.each(['123456', 'PASSWORD', 'qwerty'])('rejects the common password %s', async (pw) => {
      const response = await post(
        ctx,
        '/auth/register',
        registerPayload(randomPhone(), { password: pw }),
      );
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('weak_password');
    });

    it('rejects the phone number as password', async () => {
      const phone = randomPhone();
      for (const password of [localForm(phone), phone, phone.slice(1), phone.slice(4)]) {
        const response = await post(ctx, '/auth/register', registerPayload(phone, { password }));
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('weak_password');
      }
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

    it('lets a pending number register again, replacing its details and code', async () => {
      const phone = randomPhone();
      const first = RegisterResponse.parse(
        (await post(ctx, '/auth/register', registerPayload(phone))).json(),
      );

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
      const second = await post(
        ctx,
        '/auth/register',
        registerPayload(phone, {
          password: newPassword,
          fullName: 'Derartu Tulu',
          dateOfBirth: '1972-03-21',
          locale: 'en',
        }),
      );
      expect(second.statusCode).toBe(201);
      const body = RegisterResponse.parse(second.json());
      expect(body.userId).toBe(first.userId);
      expect(body.demoOtp).toBeDefined();
      expect(await findUser(phone)).toMatchObject({
        fullName: 'Derartu Tulu',
        dateOfBirth: '1972-03-21',
        locale: 'en',
        status: 'pending_verification',
      });

      // The first code was retired by the new challenge.
      if (first.demoOtp !== body.demoOtp) {
        const stale = await post(ctx, '/auth/verify-otp', {
          phone,
          code: first.demoOtp,
          purpose: 'register',
        });
        expect(apiError(stale).code).toBe('otp_invalid');
      }
      const verified = await post(ctx, '/auth/verify-otp', {
        phone,
        code: body.demoOtp,
        purpose: 'register',
      });
      expect(verified.statusCode).toBe(200);
      expect(SessionResponse.parse(verified.json()).user.locale).toBe('en');

      const oldLogin = await post(ctx, '/auth/login', { phone, password: TEST_PASSWORD });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await post(ctx, '/auth/login', { phone, password: newPassword });
      expect(newLogin.statusCode).toBe(200);
    });
  });

  describe('POST /auth/verify-otp', () => {
    it('activates the account and opens a cookie + bearer session', async () => {
      const phone = randomPhone();
      const registered = RegisterResponse.parse(
        (await post(ctx, '/auth/register', registerPayload(phone))).json(),
      );
      const response = await post(ctx, '/auth/verify-otp', {
        phone: localForm(phone),
        code: await latestOtp(ctx, phone),
        purpose: 'register',
      });
      expect(response.statusCode).toBe(200);
      const body = SessionResponse.parse(response.json());
      expect(body.user).toEqual({
        id: registered.userId,
        phone,
        status: 'active',
        locale: 'am',
      });
      expect(new Date(body.expiresAt).getTime()).toBe(ctx.clock.now.getTime() + SESSION_TTL_MS);

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

      // Only hashes of the tokens are stored.
      const [stored] = await ctx.db.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, registered.userId));
      expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored!.tokenHash).not.toBe(body.sessionToken);
      expect(stored!.csrfHash).not.toBe(body.csrfToken);

      const me = await whoami({ cookie: cookieHeader(response) });
      expect(me.user).toEqual({
        id: registered.userId,
        phone,
        status: 'active',
        locale: 'am',
        sessionId: stored!.id,
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
      await post(ctx, '/auth/register', registerPayload(phone));
      const code = await latestOtp(ctx, phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (const attemptsLeft of [4, 3, 2, 1, 0]) {
        const response = await post(ctx, '/auth/verify-otp', {
          phone,
          code: wrong,
          purpose: 'register',
        });
        expect(response.statusCode).toBe(400);
        expect(apiError(response)).toMatchObject({
          code: 'otp_invalid',
          details: { attemptsLeft },
        });
      }
      const dead = await post(ctx, '/auth/verify-otp', { phone, code, purpose: 'register' });
      expect(dead.statusCode).toBe(400);
      expect(apiError(dead).code).toBe('otp_expired');
      expect((await findUser(phone))!.status).toBe('pending_verification');
    });

    it('rejects an expired code', async () => {
      const phone = randomPhone();
      await post(ctx, '/auth/register', registerPayload(phone));
      const code = await latestOtp(ctx, phone);
      ctx.clock.advance(OTP_TTL_MS);
      const response = await post(ctx, '/auth/verify-otp', { phone, code, purpose: 'register' });
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('otp_expired');
    });

    it('rejects a code that was already used, or a number without a challenge', async () => {
      const player = await registerAndLogin(ctx);
      const code = await latestOtp(ctx, player.phone);
      const reused = await post(ctx, '/auth/verify-otp', {
        phone: player.phone,
        code,
        purpose: 'register',
      });
      expect(apiError(reused).code).toBe('otp_expired');

      const unknown = await post(ctx, '/auth/verify-otp', {
        phone: randomPhone(),
        code: '123456',
        purpose: 'register',
      });
      expect(unknown.statusCode).toBe(400);
      expect(apiError(unknown).code).toBe('otp_expired');
    });
  });

  describe('POST /auth/otp/resend', () => {
    it('enforces a 60 s cooldown and retires the previous code', async () => {
      const phone = randomPhone();
      await post(ctx, '/auth/register', registerPayload(phone));
      const firstCode = await latestOtp(ctx, phone);

      ctx.clock.advance(20_000);
      const tooSoon = await post(ctx, '/auth/otp/resend', { phone, purpose: 'register' });
      expect(tooSoon.statusCode).toBe(429);
      expect(apiError(tooSoon)).toMatchObject({
        code: 'otp_cooldown',
        details: { retryAfterSeconds: 40 },
      });

      ctx.clock.advance(40_000);
      const resent = await post(ctx, '/auth/otp/resend', { phone, purpose: 'register' });
      expect(resent.statusCode).toBe(200);
      const body = OtpSentResponse.parse(resent.json());
      const secondCode = await latestOtp(ctx, phone);
      expect(body.demoOtp).toBe(secondCode);

      if (firstCode !== secondCode) {
        const stale = await post(ctx, '/auth/verify-otp', {
          phone,
          code: firstCode,
          purpose: 'register',
        });
        expect(apiError(stale).code).toBe('otp_invalid');
      }
      const ok = await post(ctx, '/auth/verify-otp', {
        phone,
        code: secondCode,
        purpose: 'register',
      });
      expect(ok.statusCode).toBe(200);
    });

    it('allows at most 5 codes per number per rolling hour', async () => {
      const phone = randomPhone();
      await post(ctx, '/auth/register', registerPayload(phone));
      for (let i = 0; i < 4; i += 1) {
        ctx.clock.advance(61_000);
        const response = await post(ctx, '/auth/otp/resend', { phone, purpose: 'register' });
        expect(response.statusCode).toBe(200);
      }
      ctx.clock.advance(61_000);
      const limited = await post(ctx, '/auth/otp/resend', { phone, purpose: 'register' });
      expect(limited.statusCode).toBe(429);
      const error = apiError(limited);
      expect(error.code).toBe('otp_limit');
      // The oldest of the five codes leaves the window 3600 - 5 * 61 seconds from now.
      expect(error.details).toEqual({ retryAfterSeconds: 3600 - 5 * 61 });

      ctx.clock.advance((3600 - 5 * 61) * 1000);
      const later = await post(
        ctx,
        '/auth/otp/resend',
        { phone, purpose: 'register' },
        { remoteAddress: '10.20.30.40' },
      );
      expect(later.statusCode).toBe(200);
    });

    it('only resends registration codes to pending numbers', async () => {
      const unknown = await post(ctx, '/auth/otp/resend', {
        phone: randomPhone(),
        purpose: 'register',
      });
      expect(unknown.statusCode).toBe(404);
      expect(apiError(unknown).code).toBe('not_found');

      const player = await registerAndLogin(ctx);
      ctx.clock.advance(61_000);
      const active = await post(ctx, '/auth/otp/resend', {
        phone: player.phone,
        purpose: 'register',
      });
      expect(active.statusCode).toBe(404);
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
        errors.push(apiError(response));
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

      const player = await registerAndLogin(ctx);
      ctx.clock.advance(SESSION_TTL_MS - 1000);
      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(200);
      ctx.clock.advance(1000);
      expect((await whoami(bearer(player.sessionToken))).statusCode).toBe(401);
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
      const code = await latestOtp(ctx, player.phone);
      expect(body.demoOtp).toBe(code);
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
        newPassword: '12345678',
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
      expect(unknown.statusCode).toBe(200);
      const knownBody = OtpSentResponse.parse(known.json());
      const unknownBody = OtpSentResponse.parse(unknown.json());
      expect(unknownBody.otpSentTo).toBe(maskMsisdn(unknownPhone));
      expect(unknownBody.otpExpiresAt).toBe(knownBody.otpExpiresAt);
      expect(unknownBody.demoOtp).toBeUndefined();
      const sent = await ctx.db.db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.to, unknownPhone));
      expect(sent).toHaveLength(0);

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
      await post(ctx, '/auth/register', registerPayload(phone));
      ctx.clock.advance(61_000);
      await post(ctx, '/auth/otp/resend', { phone, purpose: 'register' });

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

      const all = await ctx.app.inject({ method: 'GET', url: '/dev/sms' });
      expect(all.json<DevSmsResponse>().items.length).toBeLessThanOrEqual(20);

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
      try {
        for (const app of [withGateway, licensed]) {
          const inbox = await app.inject({ method: 'GET', url: '/dev/sms' });
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
