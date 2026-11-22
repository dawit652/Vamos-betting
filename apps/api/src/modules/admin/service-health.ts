import { ServiceHealthResponse } from '@vamos/contracts';
import { SERVICE_STALE_AFTER_MS, serviceHealth, serviceName } from '@vamos/core';
import { listServiceStatus } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { wire } from './common';

/**
 * The back office's Service health page (docs/plans/counter-codes-and-deposit-recovery.md, G7):
 * every service that reports its calls, judged by the same rules as the worker's watch that sends
 * the owner's "down" alerts. Down services first.
 */
export default async function adminServiceHealthRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.get('/admin/service-health', { config: { staff: 'dashboard.view' } }, async () => {
    const now = deps.clock();
    const rows = await listServiceStatus(deps.db);
    const services = rows.map((row) => {
      const staleAfterMs = SERVICE_STALE_AFTER_MS[row.service];
      const health = serviceHealth(row, now, staleAfterMs === undefined ? {} : { staleAfterMs });
      return {
        service: row.service,
        name: serviceName(row.service),
        status: health.status,
        since: health.status === 'down' ? health.since : null,
        lastOkAt: row.lastOkAt,
        lastFailureAt: row.lastFailureAt,
        lastError: row.lastError,
      };
    });
    const order = { down: 0, unknown: 1, up: 2 } as const;
    services.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    return wire(ServiceHealthResponse, { checkedAt: now, services });
  });
}
