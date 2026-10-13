import {
  applyPayoutAttempt,
  claimDuePayouts,
  loadGameSettings,
  markPayoutProcessing,
  recordPayoutAttemptError,
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
 * 1. claim (one transaction, one payout at a time): lock the payout (FOR
 *    UPDATE SKIP LOCKED) if it is approved or processing, not flagged and
 *    due, and markPayoutProcessing with `checkAt = now +
 *    payoutRetryDelayMs(attempts + 1)` and the provider's payoutReference
 *    (stored before anything is sent). checkAt is the lease: no other worker
 *    looks at the payout before then, and if this one dies mid-attempt the
 *    sweep picks it up again at checkAt.
 * 2. attemptPayout (outside any transaction): sends the payout under its id
 *    (the provider's idempotency reference) or, when an earlier attempt may
 *    have reached the provider, asks about it first. It decides what an
 *    error means for the money (paid / failed / pending / retry / unknown).
 * 3. applyPayoutAttempt (one transaction), with the attempt number claimed in
 *    step 1 so a result that outlived its lease is ignored: paid → the hold
 *    moves to the provider's clearing account; failed → the hold goes back to
 *    the player (withdrawal_reversal); pending / retry / unknown → looked at
 *    again at `now + payoutRetryDelayMs(attempts)` (1, 2, 4… minutes, at most
 *    6 h) with the hold kept; a contradiction, too many attempts in a row
 *    without an answer (settings.payments.payoutMaxAttempts) or pending for
 *    too long → flagged for staff and skipped from then on. When step 2
 *    throws or step 3 cannot be recorded, recordPayoutAttemptError counts it
 *    the same way, so such a payout is flagged too.
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
  /** Payouts attempted per run, claimed one at a time (default 20). */
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
      .select({ id: payouts.id, attempts: payouts.attempts, provider: payouts.provider })
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
    return markPayoutProcessing(tx, {
      payoutId,
      now,
      checkAt: leaseUntil(now, row.attempts),
      providerRef: payoutReference(ctx, row),
    });
  });
}

/** The reference the payout's provider will know it by, when fixed before sending. */
function payoutReference(ctx: TaskContext, payout: Pick<Payout, 'id' | 'provider'>) {
  return ctx.payments.get(payout.provider)?.payoutReference?.(payout.id) ?? null;
}

/**
 * Claims up to `limit` due payouts (claimDuePayouts + markPayoutProcessing,
 * one transaction). Each lease starts now, so only claim what is attempted
 * at once: the sweep claims one payout at a time.
 */
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
          providerRef: payoutReference(ctx, payout),
        }),
      );
    }
    return claimed;
  });
}

/**
 * Counts an attempt that threw or could not be recorded (recordPayoutAttemptError),
 * so a payout that keeps failing this way is flagged once its attempts run out.
 */
async function noteAttemptError(
  ctx: TaskContext,
  payout: Payout,
  error: unknown,
  what: string,
): Promise<PayoutRun> {
  const message = `${what}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  try {
    const settings = await loadGameSettings(ctx.db);
    const { applied, payout: updated } = await withTxRetry(ctx.db, (tx) =>
      recordPayoutAttemptError(tx, {
        payoutId: payout.id,
        attempt: payout.attempts,
        error: message,
        now: ctx.clock(),
        maxAttempts: settings.payments.payoutMaxAttempts,
      }),
    );
    if (applied === 'flagged') {
      ctx.logger.error(
        { payoutId: payout.id, flagReason: updated.flagReason, error: message },
        'payout flagged: it waits for staff',
      );
      return { payoutId: payout.id, outcome: 'flagged' };
    }
  } catch (recordError) {
    ctx.logger.error(
      { err: recordError, payoutId: payout.id },
      'payout attempt error could not be recorded',
    );
  }
  return { payoutId: payout.id, outcome: 'error' };
}

/**
 * Steps 2 and 3 for a claimed payout (its `attempts` already counts this
 * attempt). An unexpected error (a bug in an adapter, the database away)
 * is logged and counted (noteAttemptError); the payout stays `processing`
 * until its lease ends, when the sweep looks at it again (asking the
 * provider first, so a lost answer never becomes a second payment).
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
      'payout attempt threw; looked at again when its lease ends',
    );
    return noteAttemptError(ctx, payout, error, 'payout attempt threw');
  }

  try {
    const settings = await loadGameSettings(ctx.db);
    const now = ctx.clock();
    const { applied, payout: updated } = await withTxRetry(ctx.db, (tx) =>
      applyPayoutAttempt(tx, {
        payoutId: payout.id,
        attempt: payout.attempts,
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
      ctx.logger.warn(log, 'payout attempt got no clear answer; looking again later');
    } else if (applied === 'stale') {
      ctx.logger.warn(log, 'payout attempt outlived its lease; its result is ignored');
    } else {
      ctx.logger.info(log, 'payout attempt recorded');
    }
    return { payoutId: payout.id, outcome: applied, attempt: result.outcome };
  } catch (error) {
    ctx.logger.error(
      { err: error, payoutId: payout.id, attempt: result.outcome },
      'payout result could not be recorded; the payout is looked at again when its lease ends',
    );
    const run = await noteAttemptError(
      ctx,
      payout,
      error,
      `result ${result.outcome} could not be recorded`,
    );
    return { ...run, attempt: result.outcome };
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

/**
 * Attempts due payouts (at most `limit`), claiming each one only when its
 * turn comes: a lease starts at its claim, so a slow provider call never
 * eats into the lease of a payout still waiting in this sweep.
 */
export async function runPayoutSweep(
  ctx: TaskContext,
  options: Pick<PayoutSweepOptions, 'limit'> = {},
): Promise<PayoutSweepSummary> {
  const limit = options.limit ?? 20;
  const summary: PayoutSweepSummary = { claimed: 0, outcomes: {} };
  while (summary.claimed < limit) {
    const [payout] = await claimDue(ctx, 1);
    if (payout === undefined) break;
    summary.claimed += 1;
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
