import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import {
  baseLoggerOptions,
  NOOP_TELEMETRY,
  redactUrl,
  REQUEST_ID_HEADER,
  requestIdFrom,
  type AppConfig,
  type SpanHandle,
  type Telemetry,
  type TrustProxySetting,
} from '@vamos/config';
import { STAFF_CSRF_HEADER, type HealthResponse } from '@vamos/contracts';
import { DomainError } from '@vamos/db';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { AppDeps } from './deps';
import { BackgroundTasks } from './lib/background';
import { AppError } from './lib/errors';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from './lib/idempotency';
import { DEFAULT_AUTH_LIMITS, type AuthLimits } from './lib/rate-limits';
import { registerModules } from './modules/index';
import { installMetrics } from './plugins/metrics';
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
  interface FastifyRequest {
    /** The request's tracing span (a no-op unless OpenTelemetry is on). */
    span?: SpanHandle;
  }
}

/** Where (and how verbosely) the API logs; `false` turns logging off (tests). */
export type ApiLoggerOption = false | { level?: string; stream?: { write(line: string): unknown } };

export interface BuildAppOptions {
  /**
   * Default: pino at LOG_LEVEL on stdout. The redaction and the request
   * serializers (apiLoggerOptions) always apply.
   */
  logger?: ApiLoggerOption;
  /** Tracing (startTelemetry of @vamos/config); default the no-op. */
  telemetry?: Telemetry;
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
  if (isShopPath(url)) {
    // The shop app (docs/plans/agent-shops.md phase 1b): its own origin, /shop/* only.
    return config.web.shopUrl === null ? [] : [new URL(config.web.shopUrl).origin];
  }
  return [new URL(isAdminPath(url) ? config.web.adminUrl : config.web.publicUrl).origin];
}

/** Whether `url` is in the shop app's API (/shop/*). */
export function isShopPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path === '/shop' || path.startsWith('/shop/');
}

interface LoggedRequest {
  id: string;
  method: string;
  url: string;
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  routeOptions?: { url?: string | undefined };
}

/**
 * The API's pino options: structured JSON with the service name, secrets
 * redacted wherever they are logged (headers, bodies, nested objects; see
 * logRedactPaths), and request lines that carry only the method, the URL
 * (secret query values redacted), the route, the client address and the user
 * agent: never headers, cookies or bodies. Every line of a request carries
 * its `requestId`.
 */
export function apiLoggerOptions(
  config: Pick<AppConfig, 'logLevel'>,
  option: Exclude<ApiLoggerOption, false> = {},
): FastifyServerOptions['logger'] {
  return {
    ...baseLoggerOptions({ level: option.level ?? config.logLevel, service: 'vamos-api' }),
    ...(option.stream === undefined ? {} : { stream: option.stream }),
    serializers: {
      // Fastify logs the request as `req`; anything else logged under that key passes through
      // (and the redaction still applies to it).
      req: (request: LoggedRequest | Record<string, unknown>) =>
        typeof request.method === 'string' && typeof request.url === 'string'
          ? {
              method: request.method,
              url: redactUrl(request.url),
              route: (request as LoggedRequest).routeOptions?.url,
              remoteAddress: (request as LoggedRequest).ip,
              userAgent: (request as LoggedRequest).headers?.['user-agent'],
            }
          : request,
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    },
  } as FastifyServerOptions['logger'];
}

/**
 * Security headers on every response: no rendering (CSP default-src and
 * frame-ancestors 'none', X-Frame-Options DENY), no MIME sniffing, no
 * Referer, and HSTS (one year, subdomains) in production and licensed mode,
 * where the API is only reachable over HTTPS. Exported for tests.
 */
export function securityHeaderOptions(config: Pick<AppConfig, 'nodeEnv' | 'mode'>) {
  const hsts = config.nodeEnv === 'production' || config.mode === 'licensed';
  return {
    // A JSON API serves no documents: forbid everything if a response is ever rendered.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    // The web app (another port or subdomain) is same-site with the API.
    crossOriginResourcePolicy: { policy: 'same-site' as const },
    frameguard: { action: 'deny' as const },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' as const },
    strictTransportSecurity: hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  };
}

/** Content types answered as a download if opened as a page (see applyResponseDefaults). */
const ATTACHMENT_NAMES: ReadonlyArray<readonly [prefix: string, filename: string]> = [
  ['application/json', 'api.json'],
  ['text/plain', 'api.txt'],
];

/**
 * Defaults for every response, unless the route set its own:
 * - `Cache-Control: no-store`: answers carry balances, personal data and
 *   session tokens, which no browser or proxy may keep (ASVS 8.1.1, 8.2.1).
 *   Public catalogue routes opt into short public caching.
 * - `Content-Disposition: attachment` for JSON and plain-text bodies, so a
 *   response opened directly in a browser is downloaded, never rendered
 *   (ASVS 14.4.2). fetch() and EventSource ignore it. Exported for tests.
 */
export function applyResponseDefaults(reply: FastifyReply): void {
  if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  if (reply.hasHeader('content-disposition')) return;
  const type = String(reply.getHeader('content-type') ?? '').toLowerCase();
  const match = ATTACHMENT_NAMES.find(([prefix]) => type.startsWith(prefix));
  if (match !== undefined)
    reply.header('content-disposition', `attachment; filename="${match[1]}"`);
}

/** Refusals logged as warnings: authentication, authorization, CSRF and rate limits. */
const WARN_STATUSES = new Set([401, 403, 429]);
/** Refusals logged as info: bad input (validation, parsing, size, media type), unknown ids. */
const INFO_STATUSES = new Set([400, 401, 404, 413, 415]);

/**
 * One structured line per refused request (ASVS 7.1.3, 7.2.2): who (player
 * or staff id, address, route) was refused what (status and error code).
 * Failed access decisions and rate limits are warnings; input that failed
 * validation or parsing, an unknown id and a request without credentials are
 * info. Business refusals (409, 422: odds changed, limits) are not security
 * events and are left to the request log. Never logs bodies or tokens.
 */
function logRefusal(request: FastifyRequest, status: number, code: string): void {
  const plainUnauthenticated = status === 401 && code === 'unauthorized';
  const warn = WARN_STATUSES.has(status) && !plainUnauthenticated;
  if (!warn && !INFO_STATUSES.has(status)) return;
  const staff = request.staffAuth?.status === 'ok' ? request.staffAuth.staff.id : undefined;
  const security = {
    status,
    code,
    route: request.routeOptions.url,
    ...(request.user === null ? {} : { userId: request.user.id }),
    ...(staff === undefined ? {} : { staffId: staff }),
  };
  if (warn) request.log.warn({ security }, 'request refused');
  else request.log.info({ security }, 'request refused');
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const { config } = deps;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  const app = Fastify({
    logger: options.logger === false ? false : apiLoggerOptions(config, options.logger),
    // Never `true`: trusting every hop would let clients pick their own IP.
    trustProxy: options.trustProxy ?? config.api.trustProxy,
    bodyLimit: 64 * 1024,
    // A well-formed incoming X-Request-ID is kept (it ties our lines to the proxy's); anything
    // else (missing, too long, odd characters that could forge log lines) gets a new UUID.
    requestIdHeader: false,
    genReqId: (request) => requestIdFrom(request.headers[REQUEST_ID_HEADER]),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });

  app.decorate('deps', deps);
  app.decorate('authLimits', { ...DEFAULT_AUTH_LIMITS, ...options.authLimits });
  app.decorate('background', new BackgroundTasks(app.log));
  app.addHook('onClose', async () => {
    await app.background.idle();
  });

  // Before any route: the response hook then covers every route, and the stream plugins find
  // `app.metrics`. GET /metrics itself exists only with METRICS_TOKEN.
  installMetrics(app, deps);

  void app.register(fastifyCookie);
  void app.register(fastifyHelmet, securityHeaderOptions(config));
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

  if (telemetry.enabled) {
    app.addHook('onRequest', async (request) => {
      const traceparent = request.headers.traceparent;
      request.span = telemetry.startSpan(
        `${request.method} ${request.routeOptions.url ?? 'unmatched'}`,
        {
          kind: 'server',
          traceparent: typeof traceparent === 'string' ? traceparent : undefined,
          attributes: {
            'http.request.method': request.method,
            'http.route': request.routeOptions.url,
            'vamos.request_id': request.id,
          },
        },
      );
    });
    app.addHook('onResponse', async (request, reply) => {
      request.span?.setAttributes({ 'http.response.status_code': reply.statusCode });
      if (reply.statusCode >= 500) request.span?.recordError(`HTTP ${reply.statusCode}`);
      request.span?.end();
    });
  }

  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header('x-vamos-mode', config.mode);
    applyResponseDefaults(reply);
  });

  // Every error body carries the request id, so a player or staff member can quote it to
  // support and we find the matching log lines.
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode < 400 || payload === null || typeof payload !== 'object') return payload;
    const error = (payload as { error?: unknown }).error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return payload;
    return { ...payload, error: { ...error, requestId: request.id } };
  });

  app.setErrorHandler((error, request, reply) => {
    // AppError and the DomainError thrown by shared @vamos/db services.
    if (error instanceof DomainError) {
      logRefusal(request, error.status, error.code);
      return reply.status(error.status).send(error.toBody());
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const code = (error as { code?: string }).code ?? 'bad_request';
      logRefusal(request, statusCode, code);
      return reply.status(statusCode).send({
        error: { code, message: (error as Error).message },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    request.span?.recordError(error);
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
