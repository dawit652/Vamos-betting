import { auditLog } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ACCOUNT_RATE_LIMIT_PER_MINUTE } from '../src/lib/rate-limits';
import { asStaff, seedStaff, staffLogin } from './admin-helpers';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';

/** Regression tests of the INSA readiness pass (ASVS 4.0.3 L2; docs/security/). */

type LogLine = Record<string, unknown> & {
  level: number;
  msg: string;
  security?: Record<string, unknown>;
  staffAccess?: Record<string, unknown>;
};

const WARN = 40;
const INFO = 30;

describe('response defaults (ASVS 8.2.1, 14.4.2)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('marks every answer no-store and JSON as an attachment, unless the route says otherwise', async () => {
    const player = await registerAndLogin(ctx);
    for (const url of ['/me', '/wallet', '/health']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${player.sessionToken}` },
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers['content-disposition'], url).toBe('attachment; filename="api.json"');
    }
    // Errors too (they carry the request id and sometimes account state).
    const refused = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.headers['content-disposition']).toBe('attachment; filename="api.json"');

    // The public catalogue keeps its short public caching.
    const sports = await ctx.app.inject({ method: 'GET', url: '/sports' });
    expect(sports.headers['cache-control']).toBe('public, max-age=5');
  });
});

describe('security event logs (ASVS 7.1.3, 7.2.2, 8.3.5)', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  const lines: string[] = [];
  const logs = (): LogLine[] => lines.map((line) => JSON.parse(line) as LogLine);

  beforeAll(async () => {
    ctx = await createTestContext();
    await seedStaff(ctx);
    app = buildApp(ctx.deps, {
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
      rateLimitNameSpace: `rl-sec-${Date.now()}:`,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  it('logs refused requests with the code, the route and who asked, as warnings for access failures', async () => {
    const player = await registerAndLogin(ctx);
    // A cookie session without the CSRF header: refused before the handler.
    const forged = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { cookie: player.cookie },
      payload: { locale: 'en' },
    });
    expect(forged.statusCode).toBe(403);
    // Input that fails validation.
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { authorization: `Bearer ${player.sessionToken}` },
      payload: { locale: 'xx' },
    });
    expect(invalid.statusCode).toBe(400);
    // No credentials at all.
    expect((await app.inject({ method: 'GET', url: '/wallet' })).statusCode).toBe(401);

    const refusals = logs().filter((line) => line.msg === 'request refused');
    const csrf = refusals.find((line) => line.security?.code === 'csrf_invalid');
    expect(csrf?.level).toBe(WARN);
    expect(csrf?.security).toMatchObject({ status: 403, route: '/me' });
    const validation = refusals.find((line) => line.security?.code === 'validation_error');
    expect(validation?.level).toBe(INFO);
    expect(validation?.security).toMatchObject({ status: 400, userId: player.userId });
    const anonymous = refusals.find(
      (line) => line.security?.code === 'unauthorized' && line.security.route === '/wallet',
    );
    expect(anonymous?.level).toBe(INFO);
    // Never a token or a body.
    const text = lines.join('');
    expect(text).not.toContain(player.sessionToken);
    expect(text).not.toContain(player.csrfToken);
  });

  it('logs a staff 403 as a warning naming the staff member', async () => {
    const support = await staffLogin({ ...ctx, app }, 'support');
    const response = await asStaff({ ...ctx, app }, support, 'GET', '/admin/trading/events');
    expect(response.statusCode).toBe(403);
    const refusal = logs().find(
      (line) => line.msg === 'request refused' && line.security?.staffId === support.id,
    );
    expect(refusal?.level).toBe(WARN);
    expect(refusal?.security).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('leaves an access line for every staff request and audits player detail views', async () => {
    const player = await registerAndLogin(ctx);
    const admin = await staffLogin({ ...ctx, app }, 'admin');
    const search = await asStaff(
      { ...ctx, app },
      admin,
      'GET',
      `/admin/users?q=${encodeURIComponent(player.phone)}`,
    );
    expect(search.statusCode).toBe(200);
    const detail = await asStaff({ ...ctx, app }, admin, 'GET', `/admin/users/${player.userId}`);
    expect(detail.statusCode).toBe(200);

    const access = logs()
      .filter((line) => line.msg === 'staff access' && line.staffAccess?.staffId === admin.id)
      .map((line) => line.staffAccess);
    expect(access).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', url: `/admin/users/${player.userId}` }),
        expect.objectContaining({ url: '/admin/users?q=[redacted]', statusCode: 200 }),
      ]),
    );
    // The searched phone number never reaches the logs.
    expect(lines.join('')).not.toContain(player.phone.slice(4));

    const audits = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'player.viewed'), eq(auditLog.targetId, player.userId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'admin', actorId: admin.id, targetType: 'user' });
  });
});

describe('account write routes are rate limited (ASVS 11.1.4)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('limits PATCH /me per player', async () => {
    const player = await registerAndLogin(ctx);
    const patch = () =>
      ctx.app.inject({
        method: 'PATCH',
        url: '/me',
        headers: { authorization: `Bearer ${player.sessionToken}` },
        payload: { locale: 'en' },
      });
    for (let i = 0; i < ACCOUNT_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect((await patch()).statusCode).toBe(200);
    }
    const limited = await patch();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another player has a budget of their own.
    const other = await registerAndLogin(ctx);
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/me/limits',
      headers: { authorization: `Bearer ${other.sessionToken}` },
      payload: {},
    });
    expect(response.statusCode).not.toBe(429);
  });
});
