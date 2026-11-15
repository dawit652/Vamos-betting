import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';

/** One readiness check: resolves when the dependency answers, throws otherwise. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface HealthServer {
  /** The bound port (useful with port 0 in tests). */
  port: number;
  /** From now on /ready answers 503 `draining` (called first on shutdown). */
  markDraining(): void;
  close(): Promise<void>;
}

export interface HealthReport {
  status: 'ok' | 'unavailable' | 'draining';
  checks: Record<string, { ok: boolean; error?: string }>;
}

export const READINESS_CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs every check in parallel, each with a time limit. */
export async function readiness(
  checks: ReadinessCheck[],
  timeoutMs = READINESS_CHECK_TIMEOUT_MS,
): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check }) => {
      try {
        await withTimeout(check(), timeoutMs, name);
        return [name, { ok: true }] as const;
      } catch (error) {
        return [
          name,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
        ] as const;
      }
    }),
  );
  const byName: HealthReport['checks'] = {};
  for (const [name, result] of results) byName[name] = result;
  return { status: results.every(([, r]) => r.ok) ? 'ok' : 'unavailable', checks: byName };
}

/**
 * The scraper's health server (SCRAPER_PORT): `GET /health` is liveness,
 * `GET /ready` is 200 when the database and Redis answer (503 otherwise, and
 * 503 `draining` once shutdown has begun). Anything else is 404.
 */
export async function startHealthServer(input: {
  host?: string;
  port: number;
  checks: ReadinessCheck[];
  logger: Logger;
  timeoutMs?: number;
}): Promise<HealthServer> {
  let draining = false;
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    const path = (request.url ?? '/').split('?', 1)[0];
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, { status: 'method_not_allowed' });
      return;
    }
    if (path === '/health') {
      send(200, { status: 'ok', service: 'vamos-scraper' });
      return;
    }
    if (path === '/ready') {
      if (draining) {
        send(503, { status: 'draining', checks: {} } satisfies HealthReport);
        return;
      }
      void readiness(input.checks, input.timeoutMs).then(
        (report) => send(report.status === 'ok' ? 200 : 503, report),
        (error: unknown) => {
          input.logger.error({ err: error }, 'readiness check crashed');
          send(503, { status: 'unavailable', checks: {} });
        },
      );
      return;
    }
    send(404, { status: 'not_found' });
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    markDraining: () => {
      draining = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

/** Readiness checks: the database and Redis answer. */
export function scraperReadinessChecks(input: {
  db: { execute: (query: SQL) => Promise<unknown> };
  redis: { ping: () => Promise<unknown> };
}): ReadinessCheck[] {
  return [
    { name: 'database', check: async () => void (await input.db.execute(sql`SELECT 1`)) },
    { name: 'redis', check: async () => void (await input.redis.ping()) },
  ];
}
