import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';
import { openStream } from './sse';

/**
 * API_ROLE: `all` serves everything, `streams` only /health and the two stream routes, `no-streams`
 * everything else. Routes are told apart by their answer: a route that exists answers 400 or 401
 * to an invalid or unauthenticated request, one that does not exist answers 404.
 */
const STREAM_ROUTES = [
  // A bad filter is refused before any stream opens (a valid one would hold the request open).
  { method: 'GET', url: '/live/stream?events=not-a-guid', served: 400 },
  // No session: the stream route authenticates before it streams.
  { method: 'GET', url: '/me/stream', served: 401 },
] as const;

const OTHER_ROUTES = [
  { method: 'GET', url: '/sports', served: 200 },
  { method: 'GET', url: '/events', served: 200 },
  { method: 'GET', url: '/me', served: 401 },
  { method: 'GET', url: '/wallet', served: 401 },
  { method: 'POST', url: '/auth/login', served: 400 },
  { method: 'POST', url: '/bets', served: 401 },
  { method: 'GET', url: '/admin/session', served: 401 },
] as const;

describe('API_ROLE', () => {
  const contexts: TestContext[] = [];
  async function contextFor(role?: string): Promise<TestContext> {
    const ctx = await createTestContext(role === undefined ? {} : { API_ROLE: role });
    contexts.push(ctx);
    return ctx;
  }
  afterAll(async () => {
    for (const ctx of contexts) await ctx.close();
  });

  async function status(ctx: TestContext, method: 'GET' | 'POST', url: string): Promise<number> {
    const response = await ctx.app.inject({ method, url });
    return response.statusCode;
  }

  it('defaults to all and serves every route', async () => {
    const ctx = await contextFor();
    expect(ctx.deps.config.api.role).toBe('all');
    for (const route of [...STREAM_ROUTES, ...OTHER_ROUTES]) {
      expect(await status(ctx, route.method, route.url), route.url).toBe(route.served);
    }
    expect(await status(ctx, 'GET', '/health')).toBe(200);
  });

  it('streams serves /health and the two stream routes, nothing else', async () => {
    const ctx = await contextFor('streams');
    expect(ctx.deps.config.api.role).toBe('streams');
    expect(await status(ctx, 'GET', '/health')).toBe(200);
    for (const route of STREAM_ROUTES) {
      expect(await status(ctx, route.method, route.url), route.url).toBe(route.served);
    }
    for (const route of OTHER_ROUTES) {
      expect(await status(ctx, route.method, route.url), route.url).toBe(404);
    }
  });

  it('no-streams serves everything except the two stream routes', async () => {
    const ctx = await contextFor('no-streams');
    expect(ctx.deps.config.api.role).toBe('no-streams');
    expect(await status(ctx, 'GET', '/health')).toBe(200);
    for (const route of OTHER_ROUTES) {
      expect(await status(ctx, route.method, route.url), route.url).toBe(route.served);
    }
    for (const route of STREAM_ROUTES) {
      expect(await status(ctx, route.method, route.url), route.url).toBe(404);
    }
  });

  it('the streams role authenticates /me/stream with a session made on another process', async () => {
    // The same database and Redis, a second app with the streams role: the shape of two processes.
    const all = await contextFor();
    const player = await registerAndLogin(all);
    const streamsApp = buildApp(
      {
        ...all.deps,
        config: { ...all.deps.config, api: { ...all.deps.config.api, role: 'streams' } },
      },
      { logger: false, rateLimitNameSpace: `vamos-rl-streams-${randomBytes(4).toString('hex')}:` },
    );
    try {
      await streamsApp.listen({ port: 0, host: '127.0.0.1' });
      const address = streamsApp.server.address();
      const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
      const stream = await openStream(base, '/me/stream', { cookie: player.cookie });
      try {
        expect(stream.status).toBe(200);
        expect(stream.headers.get('content-type')).toContain('text/event-stream');
      } finally {
        stream.close();
      }
      const anonymous = await openStream(base, '/me/stream');
      expect(anonymous.status).toBe(401);
      anonymous.close();
    } finally {
      await streamsApp.close();
    }
  });

  it('refuses an unknown role', async () => {
    await expect(createTestContext({ API_ROLE: 'streaming' })).rejects.toThrow(/API_ROLE/);
  });
});
