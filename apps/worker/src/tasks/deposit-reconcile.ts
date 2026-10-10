import {
  applyDepositEvent,
  expireStaleDepositIntents,
  listPendingDepositIntents,
  type DepositEventOutcome,
} from '@vamos/db';
import { eventFromStatusQuery, PaymentProviderError } from '@vamos/payments';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { withTxRetry } from '../lib/retry';
import type { TaskContext } from './context';

/**
 * Deposit reconciliation, every minute:
 * 1. asks the provider about pending deposits older than `queryAfterMs`
 *    (provider.queryDeposit), in case its webhook was lost; a final answer is
 *    applied like a webhook (eventFromStatusQuery + applyDepositEvent, which
 *    credits at most once and records the event once);
 * 2. expires open intents past their TTL (expireStaleDepositIntents). Expiry
 *    is our own timeout: a verified success that arrives later still credits.
 * The mock provider has no status endpoint (its queryDeposit always answers
 * pending), so in demo mode only the expiry does anything.
 */

export const DEPOSIT_RECONCILE_INTERVAL_MS = 60_000;

export interface DepositReconcileOptions {
  /** Default 60 s. */
  intervalMs?: number;
  /** Only deposits created at least this long ago are queried (default 2 min). */
  queryAfterMs?: number;
  /** Deposits queried per run (default 50). */
  queryLimit?: number;
  /** Intents expired per run (default 500). */
  expireLimit?: number;
}

export interface DepositReconcileSummary {
  /** Pending deposits asked about. */
  queried: number;
  /** Still pending at the provider. */
  stillPending: number;
  /** Query failed (provider error, or its provider is no longer enabled). */
  queryFailed: number;
  /** What applying the final answers did. */
  applied: Partial<Record<DepositEventOutcome, number>>;
  expired: number;
}

export async function runDepositReconciliation(
  ctx: TaskContext,
  options: Omit<DepositReconcileOptions, 'intervalMs'> = {},
): Promise<DepositReconcileSummary> {
  const summary: DepositReconcileSummary = {
    queried: 0,
    stillPending: 0,
    queryFailed: 0,
    applied: {},
    expired: 0,
  };
  const startedAt = ctx.clock();
  const pending = await listPendingDepositIntents(ctx.db, {
    createdBefore: new Date(startedAt.getTime() - (options.queryAfterMs ?? 2 * 60_000)),
    limit: options.queryLimit ?? 50,
  });

  for (const intent of pending) {
    const provider = ctx.payments.get(intent.provider);
    if (provider === undefined || intent.providerRef === null) {
      summary.queryFailed += 1;
      continue;
    }
    summary.queried += 1;
    let result;
    try {
      result = await provider.queryDeposit(intent.providerRef);
    } catch (error) {
      summary.queryFailed += 1;
      if (!(error instanceof PaymentProviderError)) throw error;
      ctx.logger.warn(
        { err: error, intentId: intent.id, provider: intent.provider },
        'deposit status query failed',
      );
      continue;
    }
    if (result.status === 'pending') {
      summary.stillPending += 1;
      continue;
    }
    if (result.providerRef !== intent.providerRef) {
      summary.queryFailed += 1;
      ctx.logger.error(
        { intentId: intent.id, asked: intent.providerRef, answered: result.providerRef },
        'deposit status query answered for another reference; ignored',
      );
      continue;
    }
    const event = eventFromStatusQuery('deposit', result);
    try {
      const applied = await withTxRetry(ctx.db, (tx) =>
        applyDepositEvent(tx, { provider: intent.provider, event, now: ctx.clock() }),
      );
      summary.applied[applied.outcome] = (summary.applied[applied.outcome] ?? 0) + 1;
      ctx.logger.info(
        { intentId: intent.id, provider: intent.provider, outcome: applied.outcome },
        'deposit reconciled from a status query',
      );
    } catch (error) {
      summary.queryFailed += 1;
      ctx.logger.error({ err: error, intentId: intent.id }, 'reconciled deposit not applied');
    }
  }

  const expired = await withTxRetry(ctx.db, (tx) =>
    expireStaleDepositIntents(tx, {
      now: ctx.clock(),
      ...(options.expireLimit === undefined ? {} : { limit: options.expireLimit }),
    }),
  );
  summary.expired = expired.length;
  if (expired.length > 0) {
    ctx.logger.info({ expired: expired.length }, 'expired stale deposit intents');
  }
  return summary;
}

/** The reconciliation as an interval task (every minute by default). */
export function depositReconcileTask(
  ctx: TaskContext,
  options: DepositReconcileOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'deposit-reconcile',
    intervalMs: options.intervalMs ?? DEPOSIT_RECONCILE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runDepositReconciliation(ctx, options),
  });
}
