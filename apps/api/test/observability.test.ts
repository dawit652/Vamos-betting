import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SpanAttributes, Telemetry } from '@vamos/config';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, securityHeaderOptions } from '../src/app';
import { createApiShutdown } from '../src/lib/shutdown';
import { createTestContext, type TestContext } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Secret values that must never appear in a log line. */
const SECRETS = {
  bearer: 'Bearer sk_live_bearer_9f8e7d6c5b4a',
  cookie: 'vamos_session=cookie-secret-1a2b3c4d; vamos_csrf=csrf-cookie-5e6f7a8b',
  csrf: 'csrf-header-secret-0a9b8c7d',
  staffCsrf: 'staff-csrf-secret-6e5d4c3b',
  password: 'Pa55word-never-logged!',
  newPassword: 'N3w-Pa55word-never-logged!',
  pin: '73914',
  code: '482915',
  totpCode: '615243',
  resetToken: 'reset-token-in-query-77aa88bb',
};

function captureLogs(): { lines: string[]; stream: { write(line: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

describe('request ids, error bodies and security headers', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('keeps a well-formed incoming X-Request-ID and echoes it', async () => {
    const id = 'lb-7f3a9c2e-0001';
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': id },
    });
    expect(response.headers['x-request-id']).toBe(id);
  });

  it('replaces a malformed or missing request id with a UUID', async () => {
    for (const bad of ['bad id\nINFO forged line', 'x', 'a'.repeat(200)]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': bad },
      });
      expect(response.headers['x-request-id']).toMatch(UUID);
    }
    const none = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(none.headers['x-request-id']).toMatch(UUID);
  });

  it('puts the request id in every error body', async () => {
    const id = 'support-ref-12345678';
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': id },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found', requestId: id } });

    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { phone: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);
    const body = invalid.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.requestId).toBe(invalid.headers['x-request-id']);

    // Success bodies are left alone.
    const ok = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(ok.json()).not.toHaveProperty('requestId');
    expect(ok.json()).not.toHaveProperty('error');
  });

  it('sends the security headers; HSTS only in production and licensed mode', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['strict-transport-security']).toBeUndefined();

    expect(
      securityHeaderOptions({ nodeEnv: 'production', mode: 'demo' }).strictTransportSecurity,
    ).toEqual({ maxAge: 31_536_000, includeSubDomains: true });
    expect(
      securityHeaderOptions({ nodeEnv: 'development', mode: 'licensed' }).strictTransportSecurity,
    ).not.toBe(false);

    const production = buildApp(
      { ...ctx.deps, config: { ...ctx.deps.config, nodeEnv: 'production' } },
      { logger: false, rateLimitNameSpace: `rl-prod-${Date.now()}:` },
    );
    try {
      const secure = await production.inject({ method: 'GET', url: '/health' });
      expect(secure.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
    } finally {
      await production.close();
    }
  });

  it('takes the trusted proxies from config (TRUST_PROXY)', async () => {
    const echoIp = async (trustProxy: false | string[]) => {
      const app = buildApp(
        {
          ...ctx.deps,
          config: { ...ctx.deps.config, api: { ...ctx.deps.config.api, trustProxy } },
        },
        { logger: false, rateLimitNameSpace: `rl-tp-${Date.now()}:` },
      );
      app.get('/test/ip', async (request) => ({ ip: request.ip }));
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/test/ip',
          remoteAddress: '10.1.2.3',
          headers: { 'x-forwarded-for': '196.188.1.1' },
        });
        return response.json<{ ip: string }>().ip;
      } finally {
        await app.close();
      }
    };
    expect(await echoIp(false)).toBe('10.1.2.3');
    expect(await echoIp(['10.0.0.0/8'])).toBe('196.188.1.1');
    expect(await echoIp(['192.168.0.0/16'])).toBe('10.1.2.3');
  });
});

describe('structured logs', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  const logs = captureLogs();

  beforeAll(async () => {
    ctx = await createTestContext();
    app = buildApp(ctx.deps, {
      logger: { level: 'info', stream: logs.stream },
      rateLimitNameSpace: `rl-logs-${Date.now()}:`,
    });
    // A careless handler that logs everything it was sent: the redaction must still hold.
    app.post('/test/log-everything', async (request) => {
      request.log.info(
        { headers: request.headers, body: request.body, query: request.query },
        'everything',
      );
      request.log.warn({ req: { headers: request.headers, body: request.body } }, 'nested');
      return { ok: true };
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  it('logs JSON lines carrying the request id, and no secrets', async () => {
    const requestId = 'trace-abc-12345678';
    const headers = {
      'x-request-id': requestId,
      authorization: SECRETS.bearer,
      cookie: SECRETS.cookie,
      'x-csrf-token': SECRETS.csrf,
      'x-staff-csrf-token': SECRETS.staffCsrf,
      'user-agent': 'vamos-test/1.0',
    };
    const payload = {
      phone: '+251911000000',
      password: SECRETS.password,
      newPassword: SECRETS.newPassword,
      pin: SECRETS.pin,
      code: SECRETS.code,
      totpCode: SECRETS.totpCode,
      nested: { password: SECRETS.password, pin: SECRETS.pin },
    };
    const careless = await app.inject({
      method: 'POST',
      url: `/test/log-everything?token=${SECRETS.resetToken}&code=${SECRETS.code}`,
      headers,
      payload,
    });
    expect(careless.statusCode, logs.lines.join('')).toBe(200);
    // A real route too (staff login with a password and TOTP code), failing on purpose.
    await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      headers,
      payload: { email: 'nobody@demo.vamos.test', password: SECRETS.password, code: SECRETS.code },
    });
    await app.inject({ method: 'POST', url: '/auth/login', headers, payload });

    const text = logs.lines.join('');
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(text, name).not.toContain(secret);
    }
    // The cookie values, even split from their names.
    expect(text).not.toContain('cookie-secret-1a2b3c4d');
    expect(text).not.toContain('csrf-cookie-5e6f7a8b');
    expect(text).toContain('[redacted]');

    const lines = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const mine = lines.filter((line) => line.requestId === requestId);
    // incoming request, the handler's two lines, request completed (per request).
    expect(mine.length).toBeGreaterThanOrEqual(4);
    for (const line of mine) {
      expect(line.service).toBe('vamos-api');
      expect(typeof line.level).toBe('number');
    }
    const incoming = mine.find((line) => line.msg === 'incoming request') as
      { req: Record<string, unknown> } | undefined;
    expect(incoming?.req).toMatchObject({
      method: 'POST',
      userAgent: 'vamos-test/1.0',
      url: '/test/log-everything?token=[redacted]&code=[redacted]',
    });
    expect(incoming?.req).not.toHaveProperty('headers');
    // The phone number in the body is not a secret, but bodies are never logged by default.
    const completed = mine.filter((line) => line.msg === 'request completed');
    expect(completed.length).toBe(3);
  });
});

describe('tracing hooks', () => {
  it('opens one server span per request, named by route, with the status', async () => {
    const ctx = await createTestContext();
    const spans: Array<{
      name: string;
      attributes: SpanAttributes;
      ended: boolean;
      error: boolean;
    }> = [];
    const telemetry: Telemetry = {
      enabled: true,
      startSpan(name, options = {}) {
        const span = { name, attributes: { ...options.attributes }, ended: false, error: false };
        spans.push(span);
        return {
          traceId: '0'.repeat(32),
          setAttributes: (attributes) => Object.assign(span.attributes, attributes),
          recordError: () => {
            span.error = true;
          },
          end: () => {
            span.ended = true;
          },
        };
      },
      shutdown: () => Promise.resolve(),
    };
    const app = buildApp(ctx.deps, {
      logger: false,
      telemetry,
      rateLimitNameSpace: `rl-trace-${Date.now()}:`,
    });
    try {
      await app.inject({ method: 'GET', url: '/events/00000000-0000-4000-8000-000000000000' });
      await app.inject({ method: 'GET', url: '/health' });
      expect(spans.map((span) => span.name)).toEqual(['GET /events/:id', 'GET /health']);
      expect(spans.every((span) => span.ended)).toBe(true);
      expect(spans[1]?.attributes['http.response.status_code']).toBe(200);
      expect(spans[0]?.attributes['http.response.status_code']).toBe(404);
      expect(spans[1]?.attributes['vamos.request_id']).toMatch(UUID);
    } finally {
      await app.close();
      await ctx.close();
    }
  });
});

describe('graceful shutdown', () => {
  it('stops accepting, finishes the requests in flight, then closes the pools and exits 0', async () => {
    const ctx = await createTestContext();
    const app = buildApp(ctx.deps, { logger: false, rateLimitNameSpace: `rl-sd-${Date.now()}:` });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    app.get('/test/slow', async () => {
      entered();
      await held;
      return { done: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const order: string[] = [];
    const exits: number[] = [];
    try {
      const slow = new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path: '/test/slow', agent: false }, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => (body += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        })
          .on('error', reject)
          .end();
      });
      await inFlight;

      const shutdown = createApiShutdown({
        app,
        closeDeps: async () => void order.push('deps'),
        telemetry: {
          enabled: false,
          startSpan: () => {
            throw new Error('unused');
          },
          shutdown: async () => void order.push('telemetry'),
        },
        exit: (code) => void exits.push(code),
      });
      const done = shutdown('SIGTERM');
      // A second signal while shutting down does nothing more.
      void shutdown('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The listener is closed: a new connection is refused.
      const refused = await new Promise<string>((resolve) => {
        httpRequest({ host: '127.0.0.1', port, path: '/health', agent: false }, () =>
          resolve('connected'),
        )
          .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
          .end();
      });
      expect(refused).toBe('ECONNREFUSED');
      // Nothing is closed while the request is in flight.
      expect(order).toEqual([]);
      expect(exits).toEqual([]);

      release();
      await expect(slow).resolves.toEqual({ status: 200, body: '{"done":true}' });
      await done;
      expect(order).toEqual(['deps', 'telemetry']);
      expect(exits).toEqual([0]);
    } finally {
      release();
      await app.close();
      await ctx.close();
    }
  });
});
