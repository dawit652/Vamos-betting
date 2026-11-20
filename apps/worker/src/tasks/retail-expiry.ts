import { expireRetailTickets, withTxRetry } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** How often unpaid winning shop tickets past their expiry are expired (hourly). */
export const RETAIL_EXPIRY_INTERVAL_MS = 3_600_000;
const BATCH = 200;

/**
 * Expires won and void shop tickets not paid within their agent's expiry days after their last
 * match (docs/plans/agent-shops.md phase 4): what they owed goes from retail payable to revenue.
 * Bounded batches; returns how many expired.
 */
export async function runRetailExpiry(ctx: TaskContext, maxBatches = 10): Promise<number> {
  const now = ctx.clock();
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const expired = await withTxRetry(ctx.db, (tx) =>
      expireRetailTickets(tx, { now, limit: BATCH }),
    );
    total += expired;
    if (expired < BATCH) break;
  }
  if (total > 0) ctx.logger.info({ expired: total }, 'shop tickets expired unpaid');
  return total;
}

export function retailExpiryTask(ctx: TaskContext): IntervalTask {
  return intervalTask({
    name: 'retail-ticket-expiry',
    intervalMs: RETAIL_EXPIRY_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runRetailExpiry(ctx),
  });
}
