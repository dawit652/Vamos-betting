import { scanRetailAlerts } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** The agent shops' alerts are looked for every 5 minutes. */
export const RETAIL_ALERTS_INTERVAL_MS = 5 * 60_000;

/**
 * Alerts about the agent shops (docs/plans/agent-shops.md, "Phase 5 design", step 4): raises each
 * new alert once (scanRetailAlerts) and writes it as one `error` line with an `alarm` field, the
 * repository's alarm convention; staff acknowledge them in the back office.
 */
export async function runRetailAlerts(ctx: TaskContext): Promise<number> {
  const raised = await ctx.db.transaction((tx) => scanRetailAlerts(tx, ctx.clock()));
  for (const alert of raised) {
    ctx.logger.error(
      {
        alarm: `retail_${alert.kind}`,
        alertId: alert.id,
        agentId: alert.agentId,
        shopId: alert.shopId,
        details: alert.details,
      },
      'agent shop alert',
    );
  }
  return raised.length;
}

export function retailAlertsTask(ctx: TaskContext, intervalMs?: number): IntervalTask {
  return intervalTask({
    name: 'retail-alerts',
    intervalMs: intervalMs ?? RETAIL_ALERTS_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runRetailAlerts(ctx),
  });
}
