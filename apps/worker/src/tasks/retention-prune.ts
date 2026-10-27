import { pruneExpiredSecurityRecords, RETENTION_BATCH_SIZE, type RetentionResult } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** How often ended sessions and old one-time codes are pruned (default hourly). */
export const RETENTION_PRUNE_INTERVAL_MS = 3_600_000;

export interface RetentionPruneOptions {
  intervalMs?: number;
  /** Default SESSION_RETENTION_MS of @vamos/db (90 days after a session ended). */
  sessionRetentionMs?: number;
  /** Default OTP_RETENTION_MS of @vamos/db (30 days after a code was issued). */
  otpRetentionMs?: number;
  /** Rows deleted per table and batch (default RETENTION_BATCH_SIZE). */
  batchSize?: number;
  /** Batches per run at most (default 10), so one run stays short. */
  maxBatches?: number;
}

/**
 * Deletes ended player and staff sessions and old one-time SMS codes once
 * they are past their retention (pruneExpiredSecurityRecords, ASVS 8.3.8),
 * in bounded batches. Returns the rows deleted per table.
 */
export async function runRetentionPrune(
  ctx: TaskContext,
  options: RetentionPruneOptions = {},
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? 10;
  const now = ctx.clock();
  const total: RetentionResult = { sessions: 0, staffSessions: 0, otpChallenges: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await pruneExpiredSecurityRecords(ctx.db, {
      now,
      batchSize,
      ...(options.sessionRetentionMs === undefined
        ? {}
        : { sessionRetentionMs: options.sessionRetentionMs }),
      ...(options.otpRetentionMs === undefined ? {} : { otpRetentionMs: options.otpRetentionMs }),
    });
    total.sessions += deleted.sessions;
    total.staffSessions += deleted.staffSessions;
    total.otpChallenges += deleted.otpChallenges;
    if (Math.max(deleted.sessions, deleted.staffSessions, deleted.otpChallenges) < batchSize) break;
  }
  if (total.sessions + total.staffSessions + total.otpChallenges > 0) {
    ctx.logger.info({ deleted: total }, 'pruned records past their retention');
  }
  return total;
}

export function retentionPruneTask(
  ctx: TaskContext,
  options: RetentionPruneOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'retention-prune',
    intervalMs: options.intervalMs ?? RETENTION_PRUNE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runRetentionPrune(ctx, options),
  });
}
