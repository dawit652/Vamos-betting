import { HealthResponseSchema } from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3001' },
    });
    expect(admin.headers['access-control-allow-origin']).toBe('http://localhost:3001');

    const other = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
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

  it('returns the API error shape for unknown routes', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
