import {
  applyPayoutAttempt,
  claimDuePayouts,
  loadGameSettings,
  markPayoutProcessing,
  schema,
  type AppliedPayoutAttempt,
  type Payout,
} from '@vamos/db';
import { attemptPayout, payoutRetryDelayMs, type PayoutAttemptResult } from '@vamos/payments';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { withTxRetry } from '../lib/retry';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { PayoutJobData } from './outbox-dispatch';

/**
 * The payout worker. Money safety comes from @vamos/db and @vamos/payments;
 * this file only drives them:
 *
 * 1. claim (one transaction): lock the payout (FOR UPDATE SKIP LOCKED) if it
 *    is approved or processing, not flagged and due, and markPayoutProcessing
 *    with `checkAt = now + payoutRetryDelayMs(attempts + 1)`. checkAt is the
 *    lease: no other worker looks at the payout before then, and if this one
 *    dies mid-attempt the sweep picks it up again at checkAt.
 * 2. attemptPayout (outside any transaction): sends the payout under its id
 *    (the provider's idempotency reference) or, once a provider reference is
 *    known, only asks for its status. It decides what an error means for the
 *    money (paid / failed / pending / retry / unknown).
 * 3. applyPayoutAttempt (one transaction): paid → the hold moves to the
 *    provider's clearing account; failed → the hold goes back to the player
 *    (withdrawal_reversal); pending / retry → looked at again at
 *    `now + payoutRetryDelayMs(attempts)` (1, 2, 4… minutes, at most 6 h);
 *    unknown, a contradiction or running out of attempts
 *    (settings.payments.payoutMaxAttempts) → flagged for staff and skipped
 *    from then on.
 *
 * Two entry points share this: the `payouts` queue (fed by the outbox
 * dispatcher with payment.withdrawal_approved, so an approved payout is sent
 * at once) and the payout sweep, which takes every due payout: retries after
 * backoff, status polls of pending (`processing`) payouts, and approved
 * payouts whose job was lost.
 */

export const PAYOUT_SWEEP_INTERVAL_MS = 15_000;

export interface PayoutTaskOptions {
  /** Payout jobs handled in parallel (default 2). */
  concurrency?: number;
}

export interface PayoutSweepOptions {
  /** Default 15 s. */
  intervalMs?: number;
  /** Payouts claimed per run (default 20). */
  limit?: number;
}

/** What one payout run did ('skipped': not due, flagged, closed, or held by another worker). */
export type PayoutRunOutcome = AppliedPayoutAttempt | 'skipped' | 'error';

export interface PayoutRun {
  payoutId: string;
  outcome: PayoutRunOutcome;
  /** The provider's answer, when one was asked for. */
  attempt?: PayoutAttemptResult['outcome'];
}

const DUE_STATUSES = ['approved', 'processing'] as const;

/** The lease time of a payout about to make its attempt number `attempts + 1`. */
function leaseUntil(now: Date, attempts: number): Date {
  return new Date(now.getTime() + payoutRetryDelayMs(attempts + 1));
}

/**
 * Claims one payout if it is due (see 1. above); null when it is not
 * approved / processing, flagged, not due yet, or another worker holds it.
 */
export async function claimPayout(ctx: TaskContext, payoutId: string): Promise<Payout | null> {
  const now = ctx.clock();
  return withTxRetry(ctx.db, async (tx) => {
    const { payouts } = schema;
    const [row] = await tx
      .select({ id: payouts.id, attempts: payouts.attempts })
      .from(payouts)
      .where(
        and(
          eq(payouts.id, payoutId),
          inArray(payouts.status, [...DUE_STATUSES]),
          isNull(payouts.flaggedAt),
          or(isNull(payouts.nextAttemptAt), lte(payouts.nextAttemptAt, now)),
        ),
      )
      .for('update', { skipLocked: true });
    if (row === undefined) return null;
    return markPayoutProcessing(tx, { payoutId, now, checkAt: leaseUntil(now, row.attempts) });
  });
}

/** Claims up to `limit` due payouts (claimDuePayouts + markPayoutProcessing, one transaction). */
export async function claimDue(ctx: TaskContext, limit: number): Promise<Payout[]> {
  const now = ctx.clock();
  return withTxRetry(ctx.db, async (tx) => {
    const due = await claimDuePayouts(tx, { now, limit });
    const claimed: Payout[] = [];
    for (const payout of due) {
      claimed.push(
        await markPayoutProcessing(tx, {
          payoutId: payout.id,
          now,
          checkAt: leaseUntil(now, payout.attempts),
        }),
      );
    }
    return claimed;
  });
}

/**
 * Steps 2 and 3 for a claimed payout (its `attempts` already counts this
 * attempt). An unexpected error (a bug in an adapter, the database away)
 * is logged and leaves the payout `processing` until its lease ends, when
 * the sweep tries again: a resubmission that the provider refuses is then
 * `unknown` and flagged, never a second payment.
 */
export async function executePayout(ctx: TaskContext, payout: Payout): Promise<PayoutRun> {
  let result: PayoutAttemptResult;
  try {
    result = await attemptPayout(ctx.payments.get(payout.provider), {
      payoutId: payout.id,
      amount: payout.amount,
      phone: payout.phone,
      recipientName: payout.recipientName,
      providerRef: payout.providerRef,
      attempts: payout.attempts,
    });
  } catch (error) {
    ctx.logger.error(
      { err: error, payoutId: payout.id, provider: payout.provider },
      'payout attempt threw; retried when its lease ends',
    );
    return { payoutId: payout.id, outcome: 'error' };
  }

  try {
    const settings = await loadGameSettings(ctx.db);
    const now = ctx.clock();
    const { applied, payout: updated } = await withTxRetry(ctx.db, (tx) =>
      applyPayoutAttempt(tx, {
        payoutId: payout.id,
        result,
        now,
        retryAt: new Date(now.getTime() + payoutRetryDelayMs(payout.attempts)),
        maxAttempts: settings.payments.payoutMaxAttempts,
      }),
    );
    const log = {
      payoutId: payout.id,
      provider: payout.provider,
      attempts: payout.attempts,
      attempt: result.outcome,
      applied,
      ...('error' in result ? { error: result.error } : {}),
    };
    if (applied === 'flagged') {
      ctx.logger.error(
        { ...log, flagReason: updated.flagReason },
        'payout flagged: it waits for staff',
      );
    } else if (applied === 'retry_scheduled') {
      ctx.logger.warn(log, 'payout attempt got no answer; retrying later');
    } else {
      ctx.logger.info(log, 'payout attempt recorded');
    }
    return { payoutId: payout.id, outcome: applied, attempt: result.outcome };
  } catch (error) {
    ctx.logger.error(
      { err: error, payoutId: payout.id, attempt: result.outcome },
      'payout result could not be recorded; the payout is looked at again when its lease ends',
    );
    return { payoutId: payout.id, outcome: 'error', attempt: result.outcome };
  }
}

/** One `payouts` job: claim the payout if it is due, then attempt it. */
export async function processPayoutJob(
  ctx: TaskContext,
  data: Pick<PayoutJobData, 'payoutId'>,
): Promise<PayoutRun> {
  const payout = await claimPayout(ctx, data.payoutId);
  if (payout === null) return { payoutId: data.payoutId, outcome: 'skipped' };
  return executePayout(ctx, payout);
}

/** The `payouts` queue consumer as a WorkerTask. */
export function payoutTask(ctx: TaskContext, options: PayoutTaskOptions = {}): WorkerTask {
  let consumer: QueueWorker<PayoutJobData, PayoutRun> | null = null;
  return {
    name: 'payouts',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.payouts,
        (job: Job<PayoutJobData>) => processPayoutJob(ctx, job.data),
        ctx.logger,
        { concurrency: options.concurrency ?? 2 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

export interface PayoutSweepSummary {
  claimed: number;
  outcomes: Partial<Record<PayoutRunOutcome, number>>;
}

/** Claims every due payout (at most `limit`) and attempts each in turn. */
export async function runPayoutSweep(
  ctx: TaskContext,
  options: Pick<PayoutSweepOptions, 'limit'> = {},
): Promise<PayoutSweepSummary> {
  const claimed = await claimDue(ctx, options.limit ?? 20);
  const summary: PayoutSweepSummary = { claimed: claimed.length, outcomes: {} };
  for (const payout of claimed) {
    const run = await executePayout(ctx, payout);
    summary.outcomes[run.outcome] = (summary.outcomes[run.outcome] ?? 0) + 1;
  }
  return summary;
}

/** The payout sweep as an interval task (every 15 s by default). */
export function payoutSweepTask(ctx: TaskContext, options: PayoutSweepOptions = {}): IntervalTask {
  return intervalTask({
    name: 'payout-sweep',
    intervalMs: options.intervalMs ?? PAYOUT_SWEEP_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runPayoutSweep(ctx, options),
  });
}
