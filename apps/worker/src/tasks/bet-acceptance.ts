import { acceptPendingBet, listDuePendingBets, type AcceptPendingResult } from '@vamos/db';
import { DelayedError, type Job } from 'bullmq';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { withTxRetry } from '../lib/retry';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { BetAcceptanceJobData } from './outbox-dispatch';

/**
 * Live bet acceptance. A bet with a live leg is placed `pending_acceptance`
 * with accept_after = placed + live_bet_delay_ms; the outbox dispatcher turns
 * its bet.placed into a `bet-acceptance` job delayed until then. The job runs
 * acceptPendingBet (@vamos/db), which accepts the bet when its live legs are
 * still bettable at acceptable odds, or rejects and refunds it.
 *
 * acceptPendingBet locks the bet and leaves a bet that is no longer pending
 * alone, so the job, a replay of it and the sweep below can race safely.
 * The sweep (every 2 s) is the safety net for a lost or late job: it decides
 * every bet whose delay ended more than `graceMs` ago.
 */

export const BET_ACCEPTANCE_SWEEP_INTERVAL_MS = 2000;
/** Shortest re-delay of a job that ran before its bet was due (clock skew). */
const MIN_REDELAY_MS = 100;

export interface BetAcceptanceOptions {
  /** Jobs run in parallel (default 4). */
  concurrency?: number;
}

export interface BetAcceptanceSweepOptions {
  /** Default 2 s. */
  intervalMs?: number;
  /** Only bets due at least this long ago, so the delayed job goes first (default 1 s). */
  graceMs?: number;
  /** Bets decided per run (default 100). */
  limit?: number;
}

/** Decides one pending bet at ctx.clock() in its own transaction (retried on deadlock). */
export async function decidePendingBet(
  ctx: TaskContext,
  betId: string,
): Promise<AcceptPendingResult> {
  const result = await withTxRetry(ctx.db, (tx) => acceptPendingBet(tx, betId, ctx.clock()), {
    onRetry: (error, attempt) =>
      ctx.logger.warn({ err: error, betId, attempt }, 'bet acceptance transaction retried'),
  });
  if (result.outcome === 'accepted' || result.outcome === 'rejected') {
    ctx.logger.info(
      { betId, shortId: result.bet.shortId, outcome: result.outcome, reason: result.reason },
      `live bet ${result.outcome}`,
    );
  }
  return result;
}

/**
 * Processes one `bet-acceptance` job. When it runs before the bet is due by
 * ctx.clock() (the job's delay is real time), it is delayed again.
 */
export async function processBetAcceptanceJob(
  ctx: TaskContext,
  job: Pick<Job<BetAcceptanceJobData>, 'data' | 'moveToDelayed'>,
  token?: string,
): Promise<AcceptPendingResult['outcome']> {
  const result = await decidePendingBet(ctx, job.data.betId);
  if (result.outcome === 'not_due') {
    const due = result.bet.acceptAfter?.getTime() ?? Date.parse(job.data.acceptAfter);
    const wait = Math.max(MIN_REDELAY_MS, due - ctx.clock().getTime());
    await job.moveToDelayed(Date.now() + wait, token);
    throw new DelayedError();
  }
  return result.outcome;
}

/** The `bet-acceptance` queue consumer as a WorkerTask. */
export function betAcceptanceTask(
  ctx: TaskContext,
  options: BetAcceptanceOptions = {},
): WorkerTask {
  let consumer: QueueWorker<BetAcceptanceJobData, string> | null = null;
  return {
    name: 'bet-acceptance',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.betAcceptance,
        (job: Job<BetAcceptanceJobData>, token?: string) =>
          processBetAcceptanceJob(ctx, job, token),
        ctx.logger,
        { concurrency: options.concurrency ?? 4 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

export interface AcceptanceSweepSummary {
  due: number;
  accepted: number;
  rejected: number;
  /** Already decided (by the job) or not due after all. */
  unchanged: number;
  failed: number;
}

/** Decides every pending bet due at least `graceMs` ago (at most `limit`). */
export async function runAcceptanceSweep(
  ctx: TaskContext,
  options: Pick<BetAcceptanceSweepOptions, 'graceMs' | 'limit'> = {},
): Promise<AcceptanceSweepSummary> {
  const cutoff = new Date(ctx.clock().getTime() - (options.graceMs ?? 1000));
  const ids = await listDuePendingBets(ctx.db, cutoff, options.limit ?? 100);
  const summary: AcceptanceSweepSummary = {
    due: ids.length,
    accepted: 0,
    rejected: 0,
    unchanged: 0,
    failed: 0,
  };
  for (const betId of ids) {
    try {
      const { outcome } = await decidePendingBet(ctx, betId);
      if (outcome === 'accepted') summary.accepted += 1;
      else if (outcome === 'rejected') summary.rejected += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, betId }, 'live bet acceptance failed');
    }
  }
  if (summary.accepted + summary.rejected > 0) {
    ctx.logger.info({ ...summary }, 'acceptance sweep decided overdue live bets');
  }
  return summary;
}

/** The sweep as an interval task (every 2 s by default). */
export function betAcceptanceSweepTask(
  ctx: TaskContext,
  options: BetAcceptanceSweepOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'bet-acceptance-sweep',
    intervalMs: options.intervalMs ?? BET_ACCEPTANCE_SWEEP_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runAcceptanceSweep(ctx, options),
  });
}
