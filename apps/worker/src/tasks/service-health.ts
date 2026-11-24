import {
  minutesSince,
  SERVICE_NAMES,
  SERVICE_STALE_AFTER_MS as STALE_AFTER_MS,
  serviceHealth,
} from '@vamos/core';
import {
  listServiceStatus,
  resetServiceHealth,
  servicesSwitchedOff,
  setServiceAlerted,
  sourceRunReports,
} from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { raiseOwnerAlert } from '../lib/owner-alert';
import type { TaskContext } from './context';

export { SERVICE_NAMES };

/** The services' health is looked at every minute. */
export const SERVICE_HEALTH_INTERVAL_MS = 60_000;

export interface ServiceHealthSummary {
  down: string[];
  recovered: string[];
  /** Switched off in the back office or not used here: not watched (servicesSwitchedOff). */
  off: string[];
}

/**
 * The service health watch (docs/plans/counter-codes-and-deposit-recovery.md, G7; owner, 21 Nov
 * 2026): every service that reports its calls (service_status) and every enabled feed source (its
 * last runs). A service down for SERVICE_DOWN_AFTER_MS raises `service_down`, which reaches the
 * owner's Telegram every 15 minutes while it lasts (OWNER_ALERT_POLICY); when it works again,
 * `service_recovered` once. Each new outage is one `error` line with an `alarm` field.
 *
 * A service switched off (owner, 23 Nov 2026: mr-x with `hulusport_pricing` off, mr-z with both
 * Narobet switches off, a feed source switched off, a payment provider not in PAYMENT_PROVIDERS)
 * is skipped: no alert at all, its health forgotten, so the 15-minute "down" alert stops at once.
 */
export async function runServiceHealth(ctx: TaskContext): Promise<ServiceHealthSummary> {
  const now = ctx.clock();
  const summary: ServiceHealthSummary = { down: [], recovered: [], off: [] };
  const rows = await listServiceStatus(ctx.db);
  const known = new Map(rows.map((row) => [row.service, row]));
  const reports = rows.map((row) => ({
    service: row.service,
    name: SERVICE_NAMES[row.service] ?? row.service,
    lastOkAt: row.lastOkAt,
    failingSince: row.failingSince,
    lastError: row.lastError,
    alertedDownSince: row.alertedDownSince,
  }));
  for (const source of await sourceRunReports(ctx.db)) {
    const index = reports.findIndex((r) => r.service === source.service);
    const report = {
      service: source.service,
      name: `Feed source ${source.sourceName}`,
      lastOkAt: source.lastOkAt,
      failingSince: source.failingSince,
      lastError: source.lastError,
      alertedDownSince: known.get(source.service)?.alertedDownSince ?? null,
    };
    if (index === -1) reports.push(report);
    else reports[index] = report;
  }
  const off = await servicesSwitchedOff(
    ctx.db,
    reports.map((r) => r.service),
    { paymentProviders: ctx.payments.names },
  );
  for (const r of reports) {
    if (off.has(r.service)) {
      summary.off.push(r.service);
      if (await resetServiceHealth(ctx.db, r.service, now)) {
        ctx.logger.info({ service: r.service }, 'service switched off: not watched, no alerts');
      }
      continue;
    }
    const staleAfterMs = STALE_AFTER_MS[r.service];
    const health = serviceHealth(r, now, staleAfterMs === undefined ? {} : { staleAfterMs });
    if (health.status === 'down') {
      summary.down.push(r.service);
      if (r.alertedDownSince?.getTime() !== health.since.getTime()) {
        await setServiceAlerted(ctx.db, r.service, health.since, now);
        ctx.logger.error(
          {
            alarm: 'service_down',
            service: r.service,
            since: health.since.toISOString(),
            detail: r.lastError,
          },
          'service down',
        );
      }
      await raiseOwnerAlert(ctx, {
        alarm: 'service_down',
        service: r.name,
        minutesDown: minutesSince(health.since, now),
        detail: r.lastError === null ? null : r.lastError.slice(0, 60),
      });
    } else if (health.status === 'up' && r.alertedDownSince !== null) {
      summary.recovered.push(r.service);
      await raiseOwnerAlert(ctx, {
        alarm: 'service_recovered',
        service: r.name,
        minutesDown: minutesSince(r.alertedDownSince, now),
        downSinceMs: r.alertedDownSince.getTime(),
      });
      await setServiceAlerted(ctx.db, r.service, null, now);
      ctx.logger.info({ service: r.service }, 'service works again');
    }
  }
  return summary;
}

export function serviceHealthTask(ctx: TaskContext, intervalMs?: number): IntervalTask {
  return intervalTask({
    name: 'service-health',
    intervalMs: intervalMs ?? SERVICE_HEALTH_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runServiceHealth(ctx),
  });
}
