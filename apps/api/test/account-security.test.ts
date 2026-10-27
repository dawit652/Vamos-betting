import {
  ApiErrorSchema,
  PlayerSessionsResponse,
  SessionResponse,
  SessionStateResponse,
  StaffSessionResponse,
} from '@vamos/contracts';
import { auditLog, sessions, smsMessages } from '@vamos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { sha256Hex } from '../src/lib/crypto';
import { SESSION_IDLE_MS } from '../src/plugins/session';
import { DATA_EXPORT_FORMAT } from '../src/modules/me/export';
import { DATA_EXPORTS_PER_HOUR, REAUTH_LIMIT } from '../src/modules/me/routes';
import { demoCode, seedStaff, staffEmail } from './admin-helpers';
import {
  cookieHeader,
  createTestContext,
  latestOtp,
  post,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';
import { DEMO_STAFF_PASSWORD } from '@vamos/db/demo-staff';

/** Account security of the INSA readiness pass (ASVS 2.1.5, 2.1.6, 2.2.3, 3.3.3, 3.3.4, 3.4.4). */

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const apiError = (response: LightMyRequestResponse) => ApiErrorSchema.parse(response.json()).error;
const NEW_PASSWORD = 'Tirunesh-Dibaba-2008';

describe('account security', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function login(player: LoggedInUser, password = player.password) {
    const response = await post(ctx, '/auth/login', { phone: player.phone, password });
    return {
      response,
      body: response.statusCode === 200 ? SessionResponse.parse(response.json()) : null,
    };
  }

  async function smsTo(phone: string) {
    await ctx.app.background.idle();
    return ctx.db.db
      .select({ body: smsMessages.body, template: smsMessages.template })
      .from(smsMessages)
      .where(eq(smsMessages.to, phone))
      .orderBy(desc(smsMessages.createdAt));
  }

  describe('GET /auth/session', () => {
    it('hands out the CSRF token of a cookie session, and null without one (always 200)', async () => {
      const anonymous = await ctx.app.inject({ method: 'GET', url: '/auth/session' });
      expect(anonymous.statusCode).toBe(200);
      expect(SessionStateResponse.parse(anonymous.json())).toEqual({ session: null });

      const player = await registerAndLogin(ctx);
      // Only the httpOnly session cookie: a web app on another host cannot read the CSRF cookie.
      const sessionCookie = player.cookie.split('; ').find((c) => c.startsWith('vamos_session='))!;
      const state = await ctx.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: sessionCookie },
      });
      const body = SessionStateResponse.parse(state.json());
      expect(body.session?.csrfToken).toBe(player.csrfToken);
      expect(body.session?.user).toMatchObject({ id: player.userId, phone: player.phone });
      expect(state.headers['cache-control']).toBe('no-store');
      // ...and that token passes the CSRF check.
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: '/me',
        headers: { cookie: sessionCookie, 'x-csrf-token': body.session!.csrfToken },
        payload: { locale: 'en' },
      });
      expect(patch.statusCode).toBe(200);

      // An idle-expired session is no session.
      ctx.clock.advance(SESSION_IDLE_MS);
      const expired = await ctx.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: sessionCookie },
      });
      expect(SessionStateResponse.parse(expired.json())).toEqual({ session: null });
    });
  });

  describe('POST /me/password', () => {
    it('needs the current password, ends the other sessions and sends a notice', async () => {
      const player = await registerAndLogin(ctx);
      const other = (await login(player)).body!;

      const wrong = await ctx.app.inject({
        method: 'POST',
        url: '/me/password',
        headers: bearer(player.sessionToken),
        payload: { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD },
      });
      expect(wrong.statusCode).toBe(403);
      expect(apiError(wrong).code).toBe('reauth_failed');

      for (const [newPassword, code] of [
        ['qwerty123456', 'weak_password'],
        ['short-one', 'validation_error'],
        [player.password, 'password_unchanged'],
      ] as const) {
        const refused = await ctx.app.inject({
          method: 'POST',
          url: '/me/password',
          headers: bearer(player.sessionToken),
          payload: { currentPassword: player.password, newPassword },
        });
        expect(apiError(refused).code, newPassword).toBe(code);
      }

      // Cookie sessions need the CSRF header like any change.
      const forged = await ctx.app.inject({
        method: 'POST',
        url: '/me/password',
        headers: { cookie: player.cookie },
        payload: { currentPassword: player.password, newPassword: NEW_PASSWORD },
      });
      expect(apiError(forged).code).toBe('csrf_invalid');

      const changed = await ctx.app.inject({
        method: 'POST',
        url: '/me/password',
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
        payload: { currentPassword: player.password, newPassword: NEW_PASSWORD },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ ok: true });

      // This session stays; the other one ended.
      const me = (token: string) =>
        ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) });
      expect((await me(player.sessionToken)).statusCode).toBe(200);
      expect((await me(other.sessionToken)).statusCode).toBe(401);
      // The old password no longer works, the new one does.
      expect((await login(player)).response.statusCode).toBe(401);
      expect((await login(player, NEW_PASSWORD)).response.statusCode).toBe(200);

      const [notice] = await smsTo(player.phone);
      expect(notice?.template).toBe('password_changed');
      expect(notice?.body).toContain('Your password was changed');

      const audits = await ctx.db.db
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.targetId, player.userId));
      expect(audits).toEqual(
        expect.arrayContaining([
          { action: 'user.reauth_failed', metadata: { purpose: 'password_change' } },
          { action: 'user.password_changed', metadata: { revokedSessions: 1 } },
        ]),
      );
    });

    it('limits password checks per player', async () => {
      const player = await registerAndLogin(ctx);
      const attempt = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/me/sessions/revoke',
          headers: bearer(player.sessionToken),
          payload: { password: 'wrong-password' },
        });
      for (let i = 0; i < REAUTH_LIMIT.max; i += 1) {
        expect((await attempt()).statusCode).toBe(403);
      }
      // One budget for both routes.
      const limited = await ctx.app.inject({
        method: 'POST',
        url: '/me/password',
        headers: bearer(player.sessionToken),
        payload: { currentPassword: player.password, newPassword: NEW_PASSWORD },
      });
      expect(limited.statusCode).toBe(429);
    });
  });

  describe('a password reset', () => {
    it('sends the "password changed" notice too', async () => {
      const player = await registerAndLogin(ctx);
      ctx.clock.advance(61_000);
      await post(ctx, '/auth/password/forgot', { phone: player.phone });
      const code = await latestOtp(ctx, player.phone);
      const reset = await post(ctx, '/auth/password/reset', {
        phone: player.phone,
        code,
        newPassword: NEW_PASSWORD,
      });
      expect(reset.statusCode).toBe(200);
      const [notice] = await smsTo(player.phone);
      expect(notice?.template).toBe('password_changed');
    });
  });

  describe('sessions', () => {
    it('lists the live sessions and ends one or all others after the password is re-entered', async () => {
      const player = await registerAndLogin(ctx);
      const second = (await login(player)).body!;
      const third = (await login(player)).body!;
      // Ended ones are not listed.
      const gone = (await login(player)).body!;
      await post(ctx, '/auth/logout', {}, { headers: bearer(gone.sessionToken) });

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/me/sessions',
        headers: bearer(player.sessionToken),
      });
      const { items } = PlayerSessionsResponse.parse(list.json());
      expect(items).toHaveLength(3);
      expect(items.filter((item) => item.current)).toHaveLength(1);
      const [mine] = await ctx.db.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256Hex(player.sessionToken)));
      expect(items.find((item) => item.current)?.id).toBe(mine!.id);

      const revoke = (payload: Record<string, unknown>) =>
        ctx.app.inject({
          method: 'POST',
          url: '/me/sessions/revoke',
          headers: bearer(player.sessionToken),
          payload,
        });
      // The password first.
      expect(apiError(await revoke({ password: 'wrong-password' })).code).toBe('reauth_failed');
      // Not the current session (log out ends it), nor someone else's.
      expect(apiError(await revoke({ password: player.password, sessionId: mine!.id })).code).toBe(
        'current_session',
      );
      const stranger = await registerAndLogin(ctx);
      const [strangerSession] = await ctx.db.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, stranger.userId));
      const foreign = await revoke({ password: player.password, sessionId: strangerSession!.id });
      expect(foreign.statusCode).toBe(404);

      const secondId = items.find((item) => !item.current && item.id !== mine!.id)!.id;
      const one = await revoke({ password: player.password, sessionId: secondId });
      expect(one.json()).toEqual({ revoked: 1 });
      const all = await revoke({ password: player.password });
      expect(all.json()).toEqual({ revoked: 1 });

      const me = (token: string) =>
        ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) });
      expect((await me(player.sessionToken)).statusCode).toBe(200);
      expect((await me(second.sessionToken)).statusCode).toBe(401);
      expect((await me(third.sessionToken)).statusCode).toBe(401);
      expect((await me(stranger.sessionToken)).statusCode).toBe(200);

      const [audit] = await ctx.db.db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'user.sessions_revoked'), eq(auditLog.targetId, player.userId)),
        )
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(audit?.metadata).toEqual({ revoked: 1, scope: 'others' });
    });
  });

  describe('GET /me/data-export (ASVS 8.3.2)', () => {
    it('gives the player a download of their data, audited and rate limited', async () => {
      const player = await registerAndLogin(ctx);
      const topUp = await ctx.app.inject({
        method: 'POST',
        url: '/wallet/demo-topup',
        headers: { ...bearer(player.sessionToken), 'idempotency-key': `export-${player.userId}` },
        payload: { amount: '50000' },
      });
      expect(topUp.statusCode).toBe(200);
      const exported = await ctx.app.inject({
        method: 'GET',
        url: '/me/data-export',
        headers: bearer(player.sessionToken),
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-disposition']).toBe(
        'attachment; filename="vamos-my-data.json"',
      );
      expect(exported.headers['cache-control']).toBe('no-store');
      const body = exported.json<{
        format: string;
        profile: { id: string; phone: string };
        sessions: Array<{ createdAt: string }>;
        walletTransactions: { items: Array<{ type: string; amount: string }>; truncated: boolean };
        bets: { open: { items: unknown[] }; settled: { items: unknown[] } };
      }>();
      expect(body.format).toBe(DATA_EXPORT_FORMAT);
      expect(body.profile).toMatchObject({ id: player.userId, phone: player.phone });
      expect(body.sessions.length).toBeGreaterThanOrEqual(1);
      expect(body.walletTransactions).toMatchObject({
        items: [{ type: 'demo_topup', amount: '50000' }],
        truncated: false,
      });
      expect(body.bets.open.items).toEqual([]);
      // Never a secret: no password hash, session token or ID-number hash.
      expect(exported.body).not.toContain('$argon2');
      expect(exported.body).not.toContain(player.sessionToken);

      const [audit] = await ctx.db.db
        .select({ actorId: auditLog.actorId })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'user.data_exported'), eq(auditLog.targetId, player.userId)),
        );
      expect(audit?.actorId).toBe(player.userId);

      for (let i = 1; i < DATA_EXPORTS_PER_HOUR; i += 1) {
        const again = await ctx.app.inject({
          method: 'GET',
          url: '/me/data-export',
          headers: bearer(player.sessionToken),
        });
        expect(again.statusCode).toBe(200);
      }
      const limited = await ctx.app.inject({
        method: 'GET',
        url: '/me/data-export',
        headers: bearer(player.sessionToken),
      });
      expect(limited.statusCode).toBe(429);
      expect((await ctx.app.inject({ method: 'GET', url: '/me/data-export' })).statusCode).toBe(
        401,
      );
    });
  });

  describe('staff cookie', () => {
    it('is __Host-vamos_staff with path / when cookies are Secure', async () => {
      await seedStaff(ctx);
      const secure = buildApp(
        { ...ctx.deps, config: { ...ctx.deps.config, nodeEnv: 'production' } },
        { logger: false, rateLimitNameSpace: `staff-secure-${Date.now()}:` },
      );
      try {
        ctx.clock.advance(30_000);
        const response = await secure.inject({
          method: 'POST',
          url: '/admin/auth/login',
          payload: {
            email: staffEmail('admin'),
            password: DEMO_STAFF_PASSWORD,
            code: demoCode(ctx),
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        StaffSessionResponse.parse(response.json());
        const [cookie] = response.cookies;
        expect(cookie).toMatchObject({
          name: '__Host-vamos_staff',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
        });
        expect(cookie?.domain).toBeUndefined();
        const session = await secure.inject({
          method: 'GET',
          url: '/admin/session',
          headers: { cookie: cookieHeader(response) },
        });
        expect(session.statusCode).toBe(200);
        // The un-prefixed name is ignored when cookies are Secure.
        const plain = await secure.inject({
          method: 'GET',
          url: '/admin/session',
          headers: { cookie: `vamos_staff=${cookie!.value}` },
        });
        expect(plain.statusCode).toBe(401);
      } finally {
        await secure.close();
      }
    });
  });
});
