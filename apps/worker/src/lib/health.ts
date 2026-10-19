import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { queueWorkerStatuses, withTimeout, type QueueWorkerStatus } from './queues';

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

/** Time limit of each readiness check. */
export const READINESS_CHECK_TIMEOUT_MS = 2000;

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
  const checks: HealthReport['checks'] = {};
  for (const [name, result] of results) checks[name] = result;
  const ok = results.every(([, result]) => result.ok);
  return { status: ok ? 'ok' : 'unavailable', checks };
}

/**
 * The worker's health server (WORKER_HEALTH_PORT, default 4100):
 * - `GET /health`: 200 while the process is up (liveness);
 * - `GET /ready`: 200 when every readiness check passes (database, Redis,
 *   the queue consumers connected), 503 with the failing checks otherwise,
 *   and 503 `draining` once shutdown has begun.
 * Anything else is 404. Answers are JSON and never cached. Errors carry the
 * dependency's message, not credentials (connection URLs are not logged).
 */
export async function startHealthServer(input: {
  host: string;
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
      send(200, { status: 'ok', service: 'vamos-worker' });
      return;
    }
    if (path === '/ready') {
      if (draining) {
        send(503, { status: 'draining', checks: {} } satisfies HealthReport);
        return;
      }
      void readiness(input.checks, input.timeoutMs).then(
        (report) => {
          if (report.status !== 'ok') {
            input.logger.warn({ checks: report.checks }, 'worker not ready');
          }
          send(report.status === 'ok' ? 200 : 503, report);
        },
        (error: unknown) => {
          input.logger.error({ err: error }, 'readiness check crashed');
          send(503, { status: 'unavailable', checks: {} });
        },
      );
      return;
    }
    send(404, { status: 'not_found' });
  });
  // Probes must not keep connections (and so the shutdown) open.
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => {
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

/**
 * The worker's readiness checks: the database answers, Redis answers, and
 * every queue consumer is running on a ready connection.
 */
export function workerReadinessChecks(input: {
  db: { execute: (query: SQL) => Promise<unknown> };
  redis: { ping: () => Promise<unknown> };
  queues?: () => QueueWorkerStatus[];
}): ReadinessCheck[] {
  const statuses = input.queues ?? queueWorkerStatuses;
  return [
    { name: 'database', check: async () => void (await input.db.execute(sql`SELECT 1`)) },
    { name: 'redis', check: async () => void (await input.redis.ping()) },
    {
      name: 'queues',
      check: () => {
        const down = statuses().filter((status) => !status.running || !status.connected);
        if (down.length > 0) {
          return Promise.reject(
            new Error(`not connected: ${down.map((status) => status.queue).join(', ')}`),
          );
        }
        return Promise.resolve();
      },
    },
  ];
}
