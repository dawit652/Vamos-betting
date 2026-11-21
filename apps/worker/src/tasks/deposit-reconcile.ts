import { performance } from 'node:perf_hooks';
import {
  applyDepositEvent,
  expireStaleDepositIntents,
  listPendingDepositIntents,
  scheduleDepositPoll,
  type DepositEventOutcome,
  type PaymentIntent,
  reportServiceFailure,
  reportServiceOk,
} from '@vamos/db';
import {
  eventFromStatusQuery,
  PaymentProviderError,
  type ProviderStatusResult,
} from '@vamos/payments';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { withTxRetry } from '../lib/retry';
import type { TaskContext } from './context';

/**
 * Deposit reconciliation, every minute:
 * 1. expires open intents past their TTL (expireStaleDepositIntents). Expiry
 *    is our own timeout: a verified success that arrives later still credits.
 *    It runs first, so it never waits behind slow providers.
 * 2. asks the provider about deposits it may still settle (provider.
 *    queryDeposit), in case its webhook was lost: pending ones older than
 *    `queryAfterMs`, and expired ones that reached the provider, for
 *    DEPOSIT_LATE_PAYMENT_WINDOW_MS after their expiry. A final answer is
 *    applied like a webhook (eventFromStatusQuery + applyDepositEvent, which
 *    credits at most once and records the event once). Anything else pushes
 *    the intent's next poll back (scheduleDepositPoll, longer the older it
 *    is), so every intent gets its turn. A few queries run at once, and no
 *    new one starts after `deadlineMs`, so a run stays short (and so does
 *    waiting for it at shutdown).
 * The mock provider has no status endpoint (its queryDeposit always answers
 * pending), so in demo mode only the expiry does anything.
 */

export const DEPOSIT_RECONCILE_INTERVAL_MS = 60_000;

const MIN_POLL_DELAY_MS = 60_000;
const MAX_POLL_DELAY_MS = 60 * 60_000;

/** Time until the next status query of an intent this old: a quarter of its age, 1 min to 1 h. */
export function depositPollDelayMs(ageMs: number): number {
  return Math.min(Math.max(Math.floor(ageMs / 4), MIN_POLL_DELAY_MS), MAX_POLL_DELAY_MS);
}

export interface DepositReconcileOptions {
  /** Default 60 s. */
  intervalMs?: number;
  /** Only deposits created at least this long ago are queried (default 2 min). */
  queryAfterMs?: number;
  /** Deposits queried per run at most (default 50). */
  queryLimit?: number;
  /** Intents expired per run (default 500). */
  expireLimit?: number;
  /** Status queries in flight at once (default 4). */
  concurrency?: number;
  /** No new status query starts this long after the queries began (default 40 s). */
  deadlineMs?: number;
}

export interface DepositReconcileSummary {
  /** Deposits asked about. */
  queried: number;
  /** Still pending at the provider. */
  stillPending: number;
  /** Query failed (provider error, or its provider is no longer enabled). */
  queryFailed: number;
  /** What applying the final answers did. */
  applied: Partial<Record<DepositEventOutcome, number>>;
  expired: number;
}

/** Pushes the intent's next status query back; a failure here only costs an early poll. */
async function backOff(ctx: TaskContext, intent: PaymentIntent): Promise<void> {
  const now = ctx.clock();
  const at = new Date(
    now.getTime() + depositPollDelayMs(now.getTime() - intent.createdAt.getTime()),
  );
  try {
    await scheduleDepositPoll(ctx.db, { intentId: intent.id, at });
  } catch (error) {
    ctx.logger.warn({ err: error, intentId: intent.id }, 'deposit poll not rescheduled');
  }
}

async function reconcileOne(
  ctx: TaskContext,
  intent: PaymentIntent,
  summary: DepositReconcileSummary,
): Promise<void> {
  const provider = ctx.payments.get(intent.provider);
  if (provider === undefined || intent.providerRef === null) {
    summary.queryFailed += 1;
    await backOff(ctx, intent);
    return;
  }
  summary.queried += 1;
  let result: ProviderStatusResult;
  // Each call reports the provider's health (service-health task; docs/plans/
  // counter-codes-and-deposit-recovery.md, G7).
  const service = `payments:${intent.provider}`;
  try {
    result = await provider.queryDeposit(intent.providerRef);
    await reportServiceOk(ctx.db, service, ctx.clock());
  } catch (error) {
    summary.queryFailed += 1;
    if (!(error instanceof PaymentProviderError)) throw error;
    if (error.retryable) {
      await reportServiceFailure(ctx.db, service, ctx.clock(), error.message);
    }
    ctx.logger.warn(
      { err: error, intentId: intent.id, provider: intent.provider },
      'deposit status query failed',
    );
    await backOff(ctx, intent);
    return;
  }
  if (result.status === 'pending') {
    summary.stillPending += 1;
    await backOff(ctx, intent);
    return;
  }
  if (result.providerRef !== intent.providerRef) {
    summary.queryFailed += 1;
    ctx.logger.error(
      { intentId: intent.id, asked: intent.providerRef, answered: result.providerRef },
      'deposit status query answered for another reference; ignored',
    );
    await backOff(ctx, intent);
    return;
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
    if (applied.outcome === 'ignored' || applied.outcome === 'duplicate') {
      await backOff(ctx, intent);
    }
  } catch (error) {
    summary.queryFailed += 1;
    ctx.logger.error({ err: error, intentId: intent.id }, 'reconciled deposit not applied');
    await backOff(ctx, intent);
  }
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

  // Wall time, not the business clock: this only bounds how long a run takes.
  const deadline = performance.now() + (options.deadlineMs ?? 40_000);
  const startedAt = ctx.clock();
  // The SMS rail has nobody to ask: its deposits wait for their SMS (or the player's check).
  const manual = ctx.payments.names.filter((name) => ctx.payments.get(name)?.capabilities.manual);
  const due = await listPendingDepositIntents(ctx.db, {
    now: startedAt,
    excludeProviders: manual,
    createdBefore: new Date(startedAt.getTime() - (options.queryAfterMs ?? 2 * 60_000)),
    limit: options.queryLimit ?? 50,
  });
  let next = 0;
  const poller = async (): Promise<void> => {
    while (next < due.length && performance.now() < deadline) {
      const intent = due[next];
      next += 1;
      if (intent !== undefined) await reconcileOne(ctx, intent, summary);
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 4, due.length));
  await Promise.all(Array.from({ length: lanes }, poller));
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
