import { HealthResponseSchema } from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from '../src/lib/idempotency';
import { createTestContext, type TestContext } from './helpers';

describe('GET /health', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('reports ok and the operating mode', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(response.json());
    expect(body.mode).toBe('demo');
    expect(response.headers['x-vamos-mode']).toBe('demo');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('sends security headers and CORS only for the configured origins', async () => {
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['content-security-policy']).toContain("default-src 'none'");

    // The back office origin is allowed on /admin only (below), not on player routes.
    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3001' },
    });
    expect(admin.headers['access-control-allow-origin']).toBeUndefined();

    const other = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only the back office origin on /admin routes, never the player origin', async () => {
    // A script on the player origin must not read the staff CSRF token or send it.
    for (const url of ['/admin/session', '/admin/session?x=1', '/admin']) {
      const player = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { origin: 'http://localhost:3000' },
      });
      expect(player.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/admin/staff',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-staff-csrf-token',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const adminPreflight = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/admin/staff',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-staff-csrf-token',
      },
    });
    expect(adminPreflight.statusCode).toBe(204);
    expect(adminPreflight.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(adminPreflight.headers['access-control-allow-credentials']).toBe('true');
    expect(adminPreflight.headers['access-control-allow-headers']).toContain('x-staff-csrf-token');

    const adminGet = await ctx.app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { origin: 'http://localhost:3001' },
    });
    expect(adminGet.headers['access-control-allow-origin']).toBe('http://localhost:3001');

    // A player route that only looks like /admin is a player route.
    const lookalike = await ctx.app.inject({
      method: 'GET',
      url: '/administrator',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(lookalike.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('answers CORS preflight for state-changing requests with the CSRF header', async () => {
    const response = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/auth/logout',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('x-csrf-token');
  });

  it('lets browsers send Idempotency-Key and read Idempotent-Replayed', async () => {
    const response = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/wallet/demo-topup',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token,idempotency-key',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const allowed = String(response.headers['access-control-allow-headers'])
      .split(',')
      .map((header) => header.trim());
    expect(allowed).toEqual(
      expect.arrayContaining(['content-type', 'x-csrf-token', IDEMPOTENCY_KEY_HEADER]),
    );

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    const exposed = String(get.headers['access-control-expose-headers'])
      .split(',')
      .map((header) => header.trim());
    expect(exposed).toEqual(
      expect.arrayContaining(['x-request-id', 'retry-after', IDEMPOTENT_REPLAYED_HEADER]),
    );
  });

  it('returns the API error shape for unknown routes', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
