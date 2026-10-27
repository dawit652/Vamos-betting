import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CreateStaffResponse,
  permissionsOf,
  RevokeOwnStaffSessionsResponse,
  StaffOwnSessionsResponse,
  StaffSessionResponse,
  StaffUserView,
  STAFF_CSRF_HEADER,
  STAFF_SESSION_COOKIE,
  TotpEnrolmentView,
} from '@vamos/contracts';
import { base32Decode, totpCode } from '@vamos/db/totp';
import { DEMO_STAFF_PASSWORD } from '@vamos/db/demo-staff';
import { adminSessions, auditLog } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  asStaff,
  demoCode,
  seedStaff,
  staffEmail,
  staffLogin,
  staffLoginRequest,
} from './admin-helpers';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

const apiError = (response: LightMyRequestResponse) => ApiErrorSchema.parse(response.json()).error;

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.targetId, targetId))
    .orderBy(auditLog.id);
  return rows.map((row) => row.action);
}

describe('staff sign-in', () => {
  it('signs in with email, password and TOTP code and sets a strict staff cookie', async () => {
    ctx.clock.advance(30_000);
    const response = await staffLoginRequest(ctx, {
      email: '  Trader@Demo.Vamos.Test ',
      password: DEMO_STAFF_PASSWORD,
      code: demoCode(ctx),
    });
    expect(response.statusCode).toBe(200);
    const body = StaffSessionResponse.parse(response.json());
    expect(body.staff).toMatchObject({ email: staffEmail('trader'), role: 'trader' });
    expect(body.staff.permissions).toEqual(permissionsOf('trader'));
    expect(new Date(body.expiresAt).getTime() - ctx.clock.now.getTime()).toBe(12 * 3_600_000);
    expect(new Date(body.idleExpiresAt).getTime() - ctx.clock.now.getTime()).toBe(30 * 60_000);
    // No token in the body: the cookie is the only credential.
    expect(JSON.stringify(body)).not.toContain('sessionToken');
    const cookie = response.cookies.find((c) => c.name === STAFF_SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin' });
    // The player cookies are never set by a staff sign-in.
    expect(response.cookies.map((c) => c.name)).toEqual([STAFF_SESSION_COOKIE]);

    const session = await ctx.app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${cookie!.value}` },
    });
    expect(session.statusCode).toBe(200);
    expect(StaffSessionResponse.parse(session.json()).csrfToken).toBe(body.csrfToken);
    expect(await auditActions(body.staff.id)).toContain('staff.login');
  });

  it('answers every failure with the same 401 invalid_credentials', async () => {
    ctx.clock.advance(30_000);
    const attempts = [
      { email: 'nobody@demo.vamos.test', password: DEMO_STAFF_PASSWORD, code: demoCode(ctx) },
      { email: staffEmail('kyc'), password: 'wrong-password-1', code: demoCode(ctx) },
      { email: staffEmail('kyc'), password: DEMO_STAFF_PASSWORD, code: demoCode(ctx, 120_000) },
    ];
    const messages = new Set<string>();
    for (const attempt of attempts) {
      const response = await staffLoginRequest(ctx, attempt);
      expect(response.statusCode).toBe(401);
      const error = apiError(response);
      expect(error.code).toBe('invalid_credentials');
      messages.add(error.message);
      expect(response.cookies).toEqual([]);
    }
    expect(messages.size).toBe(1);
    // A malformed body is a 400, not a sign-in attempt.
    const malformed = await staffLoginRequest(ctx, { email: staffEmail('kyc'), password: 'x' });
    expect(malformed.statusCode).toBe(400);
  });

  it('refuses a replayed code within its window', async () => {
    ctx.clock.advance(30_000);
    const payload = {
      email: staffEmail('compliance'),
      password: DEMO_STAFF_PASSWORD,
      code: demoCode(ctx),
    };
    expect((await staffLoginRequest(ctx, payload)).statusCode).toBe(200);
    const replay = await staffLoginRequest(ctx, payload);
    expect(replay.statusCode).toBe(401);
    expect(apiError(replay).code).toBe('invalid_credentials');
    ctx.clock.advance(30_000);
    expect((await staffLoginRequest(ctx, { ...payload, code: demoCode(ctx) })).statusCode).toBe(
      200,
    );
  });

  it('locks the failing address out for 15 minutes after 5 failures, not the account', async () => {
    ctx.clock.advance(30_000);
    const email = staffEmail('support');
    for (let i = 0; i < 5; i += 1) {
      const response = await staffLoginRequest(ctx, {
        email,
        password: `wrong-password-${i}`,
        code: demoCode(ctx),
      });
      expect(response.statusCode).toBe(401);
    }
    // Even the right password and code are refused while locked.
    const locked = await staffLoginRequest(ctx, {
      email,
      password: DEMO_STAFF_PASSWORD,
      code: demoCode(ctx),
    });
    expect(locked.statusCode).toBe(401);
    expect(apiError(locked).code).toBe('invalid_credentials');
    // The same message whatever the reason: it does not tell a lock apart.
    expect(apiError(locked).message).toBe(
      apiError(await staffLoginRequest(ctx, { email, password: 'nope-nope-nope', code: '000000' }))
        .message,
    );
    // The staff member still signs in from another address.
    ctx.clock.advance(30_000);
    const elsewhere = await ctx.app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      remoteAddress: '10.20.30.40',
      payload: { email, password: DEMO_STAFF_PASSWORD, code: demoCode(ctx) },
    });
    expect(elsewhere.statusCode).toBe(200);

    ctx.clock.advance(14 * 60_000);
    expect(
      (await staffLoginRequest(ctx, { email, password: DEMO_STAFF_PASSWORD, code: demoCode(ctx) }))
        .statusCode,
    ).toBe(401);
    ctx.clock.advance(60_000 + 30_000);
    const unlocked = await staffLoginRequest(ctx, {
      email,
      password: DEMO_STAFF_PASSWORD,
      code: demoCode(ctx),
    });
    expect(unlocked.statusCode).toBe(200);
    const staffId = StaffSessionResponse.parse(unlocked.json()).staff.id;
    const actions = await auditActions(staffId);
    expect(actions.filter((a) => a === 'staff.login_failed').length).toBeGreaterThanOrEqual(5);
    expect(actions).toContain('staff.locked');
  });

  it('rate limits sign-in per email and address', async () => {
    const limited = buildApp(ctx.deps, {
      logger: false,
      rateLimitNameSpace: `vamos-rl-staff-${Date.now()}:`,
      authLimits: { staffLoginPerEmail: { max: 2, timeWindow: 60_000 } },
    });
    await limited.ready();
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/admin/auth/login',
          payload: { email: 'limited@demo.vamos.test', password: 'whatever-123', code: '000000' },
        });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const third = await attempt();
      expect(third.statusCode).toBe(429);
      expect(apiError(third).code).toBe('rate_limited');
      expect(third.headers['retry-after']).toBeDefined();
      // Another address is not held up by what this one used.
      const elsewhere = await limited.inject({
        method: 'POST',
        url: '/admin/auth/login',
        remoteAddress: '10.20.30.41',
        payload: { email: 'limited@demo.vamos.test', password: 'whatever-123', code: '000000' },
      });
      expect(elsewhere.statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });
});

describe('staff sessions', () => {
  it('needs the CSRF token on unsafe methods and signs out', async () => {
    const staff = await staffLogin(ctx, 'kyc');
    const noToken = await ctx.app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      headers: { cookie: staff.cookie },
    });
    expect(noToken.statusCode).toBe(403);
    expect(apiError(noToken).code).toBe('csrf_invalid');
    const wrongToken = await asStaff(ctx, staff, 'POST', '/admin/auth/logout', undefined, {
      [STAFF_CSRF_HEADER]: 'not-the-token',
    });
    expect(wrongToken.statusCode).toBe(403);
    expect(apiError(wrongToken).code).toBe('csrf_invalid');
    // A KYC mutation without the token is refused before anything else.
    const kycNoToken = await ctx.app.inject({
      method: 'POST',
      url: `/admin/kyc/${staff.id}/review`,
      headers: { cookie: staff.cookie },
      payload: { decision: 'approve' },
    });
    expect(kycNoToken.statusCode).toBe(403);
    expect(apiError(kycNoToken).code).toBe('csrf_invalid');
    // Safe methods need no token.
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/admin/session',
          headers: { cookie: staff.cookie },
        })
      ).statusCode,
    ).toBe(200);

    const logout = await asStaff(ctx, staff, 'POST', '/admin/auth/logout');
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    const cleared = logout.cookies.find((c) => c.name === STAFF_SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(401);
    expect(await auditActions(staff.id)).toContain('staff.logout');
  });

  it('ends after 30 minutes idle', async () => {
    const staff = await staffLogin(ctx, 'finance');
    ctx.clock.advance(29 * 60_000);
    expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(200);
    ctx.clock.advance(29 * 60_000);
    expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(200);
    ctx.clock.advance(30 * 60_000 + 1);
    const expired = await asStaff(ctx, staff, 'GET', '/admin/session');
    expect(expired.statusCode).toBe(401);
    expect(apiError(expired).code).toBe('unauthorized');
  });

  it('ends 12 hours after sign-in whatever the activity', async () => {
    const staff = await staffLogin(ctx, 'admin');
    for (let elapsed = 0; elapsed < 12 * 60; elapsed += 25) {
      expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(200);
      ctx.clock.advance(25 * 60_000);
    }
    expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(401);
  });

  it('never accepts a player session on /admin, nor a staff session on player routes', async () => {
    const player = await registerAndLogin(ctx);
    const staff = await staffLogin(ctx, 'admin');
    // Player credentials on the staff API: cookie (with its CSRF token) and bearer.
    for (const headers of [
      { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
      { authorization: `Bearer ${player.sessionToken}` },
      // The player token in the staff cookie.
      { cookie: `${STAFF_SESSION_COOKIE}=${player.sessionToken}` },
    ]) {
      const session = await ctx.app.inject({ method: 'GET', url: '/admin/session', headers });
      expect(session.statusCode).toBe(401);
      const mutation = await ctx.app.inject({
        method: 'POST',
        url: '/admin/auth/logout',
        headers,
      });
      expect(mutation.statusCode).toBe(401);
    }
    // Staff credentials on player routes: the staff cookie, the staff token as
    // the player cookie, or as a bearer token.
    for (const headers of [
      { cookie: staff.cookie },
      { cookie: `vamos_session=${staff.token}` },
      { authorization: `Bearer ${staff.token}` },
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url: '/me', headers })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'GET', url: '/wallet', headers })).statusCode).toBe(
        401,
      );
    }
    // No bearer tokens for staff either.
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/admin/session',
          headers: { authorization: `Bearer ${staff.token}` },
        })
      ).statusCode,
    ).toBe(401);
    // Both sessions still work where they belong.
    expect((await asStaff(ctx, staff, 'GET', '/admin/session')).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: player.cookie } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('staff accounts (staff.manage)', () => {
  it('creates, signs in, disables and re-enables a staff member, audited', async () => {
    const admin = await staffLogin(ctx, 'admin');
    const created = await asStaff(ctx, admin, 'POST', '/admin/staff', {
      email: 'new.trader@vamos.test',
      displayName: 'New Trader',
      role: 'trader',
    });
    expect(created.statusCode).toBe(201);
    const body = CreateStaffResponse.parse(created.json());
    expect(body.user).toMatchObject({ email: 'new.trader@vamos.test', role: 'trader' });
    expect(body.generatedPassword).not.toBeNull();
    expect(body.totp.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(created.body).not.toContain('passwordHash');
    expect(created.body).not.toContain('totpSecretEnc');

    const duplicate = await asStaff(ctx, admin, 'POST', '/admin/staff', {
      email: 'new.trader@vamos.test',
      displayName: 'Again',
      role: 'trader',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(apiError(duplicate).code).toBe('staff_email_taken');

    const secret = base32Decode(body.totp.secret);
    const login = (offset = 0) =>
      staffLoginRequest(ctx, {
        email: 'new.trader@vamos.test',
        password: body.generatedPassword,
        code: totpCode(secret, ctx.clock.now.getTime() + offset),
      });
    ctx.clock.advance(30_000);
    expect((await login()).statusCode).toBe(200);

    const list = await asStaff(ctx, admin, 'GET', '/admin/staff');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items.length).toBe(7);

    const disabled = await asStaff(ctx, admin, 'POST', `/admin/staff/${body.user.id}/disable`);
    expect(disabled.statusCode).toBe(200);
    expect(StaffUserView.parse(disabled.json()).disabledAt).not.toBeNull();
    ctx.clock.advance(30_000);
    expect((await login()).statusCode).toBe(401);

    const enabled = await asStaff(ctx, admin, 'POST', `/admin/staff/${body.user.id}/enable`);
    expect(StaffUserView.parse(enabled.json()).disabledAt).toBeNull();
    const renamed = await asStaff(ctx, admin, 'PATCH', `/admin/staff/${body.user.id}`, {
      role: 'support',
    });
    expect(StaffUserView.parse(renamed.json()).role).toBe('support');
    ctx.clock.advance(30_000);
    expect((await login()).statusCode).toBe(200);

    const rows = await ctx.db.db
      .select({ action: auditLog.action, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, body.user.id), eq(auditLog.actorType, 'admin')));
    const actions = rows.filter((row) => row.actorId === admin.id).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['staff.created', 'staff.disabled', 'staff.enabled']),
    );

    expect((await asStaff(ctx, admin, 'GET', '/admin/staff/not-a-uuid')).statusCode).toBe(404);
  });
});

describe('staff self-service (/admin/me)', () => {
  it('forces a password change on an account an admin created, then lets it work', async () => {
    const admin = await staffLogin(ctx, 'admin');
    const created = CreateStaffResponse.parse(
      (
        await asStaff(ctx, admin, 'POST', '/admin/staff', {
          email: 'forced.finance@vamos.test',
          displayName: 'Forced Finance',
          role: 'finance',
        })
      ).json(),
    );
    const secret = base32Decode(created.totp.secret);
    const code = () => totpCode(secret, ctx.clock.now.getTime());
    ctx.clock.advance(30_000);
    const signedIn = await staffLoginRequest(ctx, {
      email: 'forced.finance@vamos.test',
      password: created.generatedPassword,
      code: code(),
    });
    expect(signedIn.statusCode).toBe(200);
    const body = StaffSessionResponse.parse(signedIn.json());
    expect(body.staff.passwordChangeRequired).toBe(true);
    const cookie = signedIn.cookies.find((c) => c.name === STAFF_SESSION_COOKIE)!;
    const finance = {
      role: 'finance' as const,
      id: body.staff.id,
      token: cookie.value,
      cookie: `${STAFF_SESSION_COOKIE}=${cookie.value}`,
      csrfToken: body.csrfToken,
    };
    // Nothing but the session routes until the password is changed.
    const blocked = await asStaff(ctx, finance, 'GET', '/admin/withdrawals');
    expect(blocked.statusCode).toBe(403);
    expect(apiError(blocked).code).toBe('password_change_required');
    expect((await asStaff(ctx, finance, 'GET', '/admin/session')).statusCode).toBe(200);

    // CSRF still applies; a wrong current password is refused.
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/admin/me/password',
      headers: { cookie: finance.cookie },
      payload: {
        currentPassword: created.generatedPassword,
        code: code(),
        newPassword: 'x'.repeat(12),
      },
    });
    expect(apiError(noCsrf).code).toBe('csrf_invalid');
    ctx.clock.advance(30_000);
    const wrong = await asStaff(ctx, finance, 'POST', '/admin/me/password', {
      currentPassword: 'not my password',
      code: code(),
      newPassword: 'my own long passphrase',
    });
    expect(wrong.statusCode).toBe(403);
    expect(apiError(wrong).code).toBe('reauth_failed');
    ctx.clock.advance(30_000);
    const changed = await asStaff(ctx, finance, 'POST', '/admin/me/password', {
      currentPassword: created.generatedPassword,
      code: code(),
      newPassword: 'my own long passphrase',
    });
    expect(changed.statusCode).toBe(200);
    const session = StaffSessionResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/session')).json(),
    );
    expect(session.staff.passwordChangeRequired).toBe(false);
    expect((await asStaff(ctx, finance, 'GET', '/admin/withdrawals')).statusCode).toBe(200);
    expect(await auditActions(finance.id)).toEqual(
      expect.arrayContaining(['staff.login_failed', 'staff.password_changed']),
    );
    ctx.clock.advance(30_000);
    expect(
      (
        await staffLoginRequest(ctx, {
          email: 'forced.finance@vamos.test',
          password: created.generatedPassword,
          code: code(),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('re-enrols the own authenticator, confirmed by a code from the new secret', async () => {
    const support = await staffLogin(ctx, 'support');
    const other = await staffLogin(ctx, 'support');
    ctx.clock.advance(30_000);
    const started = await asStaff(ctx, support, 'POST', '/admin/me/totp', {
      password: DEMO_STAFF_PASSWORD,
      code: demoCode(ctx),
    });
    expect(started.statusCode).toBe(200);
    const enrolment = TotpEnrolmentView.parse(started.json());
    const fresh = base32Decode(enrolment.secret);
    const badCode = totpCode(fresh, ctx.clock.now.getTime()) === '000000' ? '111111' : '000000';
    const bad = await asStaff(ctx, support, 'POST', '/admin/me/totp/confirm', { code: badCode });
    expect(apiError(bad).code).toBe('invalid_code');
    ctx.clock.advance(30_000);
    const confirmed = await asStaff(ctx, support, 'POST', '/admin/me/totp/confirm', {
      code: totpCode(fresh, ctx.clock.now.getTime()),
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await asStaff(ctx, support, 'GET', '/admin/session')).statusCode).toBe(200);
    expect((await asStaff(ctx, other, 'GET', '/admin/session')).statusCode).toBe(401);
    // The published demo secret no longer signs in; the new one does.
    ctx.clock.advance(30_000);
    const email = staffEmail('support');
    expect(
      (await staffLoginRequest(ctx, { email, password: DEMO_STAFF_PASSWORD, code: demoCode(ctx) }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await staffLoginRequest(ctx, {
          email,
          password: DEMO_STAFF_PASSWORD,
          code: totpCode(fresh, ctx.clock.now.getTime()),
        })
      ).statusCode,
    ).toBe(200);
    expect(await auditActions(support.id)).toEqual(
      expect.arrayContaining(['staff.totp_enrolment_started', 'staff.totp_changed']),
    );
  });
});

describe('own staff sessions (ASVS 3.3.4)', () => {
  it('lists the live sessions and ends one or all others after the password and a code', async () => {
    const current = await staffLogin(ctx, 'compliance');
    const second = await staffLogin(ctx, 'compliance');
    const third = await staffLogin(ctx, 'compliance');
    const sessionIds = async () => {
      const listed = await asStaff(ctx, current, 'GET', '/admin/me/sessions');
      expect(listed.statusCode).toBe(200);
      const items = StaffOwnSessionsResponse.parse(listed.json()).items;
      expect(items.filter((item) => item.current)).toHaveLength(1);
      expect(JSON.stringify(items)).not.toContain(current.token);
      return items;
    };
    const before = await sessionIds();
    expect(before).toHaveLength(3);
    const currentId = before.find((item) => item.current)!.id;
    const [secondRow] = await ctx.db.db
      .select({ id: adminSessions.id })
      .from(adminSessions)
      .where(eq(adminSessions.tokenHash, createHash('sha256').update(second.token).digest('hex')));
    const secondId = secondRow!.id;

    const revoke = (payload: Record<string, unknown>) => {
      ctx.clock.advance(30_000);
      return asStaff(ctx, current, 'POST', '/admin/me/sessions/revoke', {
        password: DEMO_STAFF_PASSWORD,
        code: demoCode(ctx),
        ...payload,
      });
    };
    expect(apiError(await revoke({ sessionId: currentId })).code).toBe('current_session');
    expect(apiError(await revoke({ password: 'not my password' })).code).toBe('reauth_failed');
    expect((await revoke({ sessionId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(
      404,
    );

    const one = await revoke({ sessionId: secondId });
    expect(one.statusCode).toBe(200);
    expect(RevokeOwnStaffSessionsResponse.parse(one.json())).toEqual({ revoked: 1 });
    expect((await sessionIds()).map((item) => item.id)).not.toContain(secondId);

    const rest = await revoke({});
    expect(RevokeOwnStaffSessionsResponse.parse(rest.json())).toEqual({ revoked: 1 });
    expect((await sessionIds()).map((item) => item.id)).toEqual([currentId]);
    for (const ended of [second, third]) {
      expect((await asStaff(ctx, ended, 'GET', '/admin/session')).statusCode).toBe(401);
    }
    expect((await asStaff(ctx, current, 'GET', '/admin/session')).statusCode).toBe(200);
    expect(await auditActions(current.id)).toEqual(
      expect.arrayContaining(['staff.sessions_revoked']),
    );
  });
});
