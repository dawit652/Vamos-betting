import { pruneUssdSessions, USSD_PRUNE_BATCH_SIZE, USSD_SESSION_RETENTION_MS } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** How often expired USSD sessions are pruned (default hourly). */
export const USSD_PRUNE_INTERVAL_MS = 3_600_000;

export interface UssdPruneOptions {
  intervalMs?: number;
  /** Default USSD_SESSION_RETENTION_MS (7 days after expiry). */
  retentionMs?: number;
  /** Rows deleted per batch (default USSD_PRUNE_BATCH_SIZE). */
  batchSize?: number;
  /** Batches per run at most (default 10), so one run stays short. */
  maxBatches?: number;
}

/**
 * Deletes expired USSD sessions without a bet once they are past the
 * retention window, in bounded batches (pruneUssdSessions). Sessions with a
 * bet and the inbound SMS texts (evidence) are kept. Returns rows deleted.
 */
export async function runUssdPrune(
  ctx: TaskContext,
  options: UssdPruneOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? USSD_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? 10;
  const now = ctx.clock();
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await pruneUssdSessions(ctx.db, {
      now,
      retentionMs: options.retentionMs ?? USSD_SESSION_RETENTION_MS,
      batchSize,
    });
    total += deleted;
    if (deleted < batchSize) break;
  }
  if (total > 0) ctx.logger.info({ deleted: total }, 'pruned expired USSD sessions');
  return total;
}

export function ussdPruneTask(ctx: TaskContext, options: UssdPruneOptions = {}): IntervalTask {
  return intervalTask({
    name: 'ussd-session-prune',
    intervalMs: options.intervalMs ?? USSD_PRUNE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runUssdPrune(ctx, options),
  });
}
