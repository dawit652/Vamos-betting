import { minutesSince, serviceHealth } from '@vamos/core';
import { listServiceStatus, setServiceAlerted, sourceRunReports } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { raiseOwnerAlert } from '../lib/owner-alert';
import type { TaskContext } from './context';

/** The services' health is looked at every minute. */
export const SERVICE_HEALTH_INTERVAL_MS = 60_000;

/** How each service is named in the owner's alerts (a feed source is named after the source). */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'payments:chapa': 'Chapa payments',
  'payments:telebirr': 'telebirr payments',
  mrx: 'mr-x (Hulusport board)',
  mrz: 'mr-z (Narobet board)',
  'api-football': 'API-Football results',
};

/**
 * Services read on a schedule: not succeeding for this long is an outage too (the reader stopped,
 * e.g. the scraper is down). mr-x and mr-z are read every few minutes.
 */
const STALE_AFTER_MS: Readonly<Record<string, number>> = {
  mrx: 30 * 60_000,
  mrz: 30 * 60_000,
};

export interface ServiceHealthSummary {
  down: string[];
  recovered: string[];
}

/**
 * The service health watch (docs/plans/counter-codes-and-deposit-recovery.md, G7; owner, 21 Nov
 * 2026): every service that reports its calls (service_status) and every enabled feed source (its
 * last runs). A service down for SERVICE_DOWN_AFTER_MS raises `service_down`, which reaches the
 * owner's Telegram every 15 minutes while it lasts (OWNER_ALERT_POLICY); when it works again,
 * `service_recovered` once. Each new outage is one `error` line with an `alarm` field.
 */
export async function runServiceHealth(ctx: TaskContext): Promise<ServiceHealthSummary> {
  const now = ctx.clock();
  const summary: ServiceHealthSummary = { down: [], recovered: [] };
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
  for (const r of reports) {
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
