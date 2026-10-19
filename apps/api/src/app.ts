import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AppConfig, TrustProxySetting } from '@vamos/config';
import { STAFF_CSRF_HEADER, type HealthResponse } from '@vamos/contracts';
import { DomainError } from '@vamos/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppDeps } from './deps';
import { BackgroundTasks } from './lib/background';
import { AppError } from './lib/errors';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from './lib/idempotency';
import { DEFAULT_AUTH_LIMITS, type AuthLimits } from './lib/rate-limits';
import { registerModules } from './modules/index';
import { CSRF_HEADER, sessionPlugin } from './plugins/session';

export type { AppDeps } from './deps';

export const API_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** Brute-force limits of the auth endpoints (defaults, or BuildAppOptions.authLimits). */
    authLimits: AuthLimits;
    /** Work that runs after a response (see BackgroundTasks); awaited on close. */
    background: BackgroundTasks;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Redis key namespace for rate-limit counters (tests use one per app instance). */
  rateLimitNameSpace?: string;
  /**
   * Whose X-Forwarded-For may set `request.ip` (see `parseTrustProxy` of
   * @vamos/config). Default: TRUST_PROXY (`config.api.trustProxy`), itself
   * false by default: `request.ip` is the TCP peer, which clients cannot forge.
   */
  trustProxy?: TrustProxySetting;
  /** Overrides of DEFAULT_AUTH_LIMITS. */
  authLimits?: Partial<AuthLimits>;
}

/**
 * Whether a request URL is a back office route (`/admin` or `/admin/...`).
 * Exported for tests.
 */
export function isAdminPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * Browser origins allowed to call the API with credentials. The back office
 * origin may call `/admin/*` only, and the player web origin everything else:
 * a script on the much larger player site (XSS, third-party script) must not
 * read the staff CSRF token from `/admin/session` and drive the staff API.
 */
export function corsOriginsFor(config: AppConfig, url: string): string[] {
  return [new URL(isAdminPath(url) ? config.web.adminUrl : config.web.publicUrl).origin];
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    // Never `true`: trusting every hop would let clients pick their own IP.
    trustProxy: options.trustProxy ?? config.api.trustProxy,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  app.decorate('deps', deps);
  app.decorate('authLimits', { ...DEFAULT_AUTH_LIMITS, ...options.authLimits });
  app.decorate('background', new BackgroundTasks(app.log));
  app.addHook('onClose', async () => {
    await app.background.idle();
  });

  void app.register(fastifyCookie);
  void app.register(fastifyHelmet, {
    // A JSON API serves no documents: forbid everything if a response is ever rendered.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    // The web app (another port or subdomain) is same-site with the API.
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  const corsOptions = {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      CSRF_HEADER,
      STAFF_CSRF_HEADER,
      'x-request-id',
      IDEMPOTENCY_KEY_HEADER,
    ],
    exposedHeaders: ['x-request-id', 'retry-after', IDEMPOTENT_REPLAYED_HEADER],
    maxAge: 600,
  };
  void app.register(fastifyCors, {
    delegator: (request, callback) => {
      callback(null, { ...corsOptions, origin: corsOriginsFor(config, request.url ?? '/') });
    },
  });
  void app.register(fastifyRateLimit, {
    // Limits are opt-in per route via `config.rateLimit`.
    global: false,
    redis: deps.redis,
    nameSpace: options.rateLimitNameSpace ?? 'vamos-rl:',
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`, {
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
  });
  // After @fastify/cookie, so cookies are parsed when the session hook runs.
  void app.register(sessionPlugin);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-vamos-mode', config.mode);
  });

  app.setErrorHandler((error, request, reply) => {
    // AppError and the DomainError thrown by shared @vamos/db services.
    if (error instanceof DomainError) {
      return reply.status(error.status).send(error.toBody());
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: (error as { code?: string }).code ?? 'bad_request',
          message: (error as Error).message,
        },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'vamos-api',
    mode: config.mode,
    version: API_VERSION,
    time: deps.clock().toISOString(),
  }));

  void app.register(async (instance) => {
    await registerModules(instance, deps);
  });

  return app;
}
