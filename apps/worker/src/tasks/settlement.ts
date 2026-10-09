import {
  listBetIdsForEvent,
  settlePlacedBet,
  type SettleBetResult,
  type SettleOutcome,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { withTxRetry } from '../lib/retry';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { SettlementJobData } from './outbox-dispatch';

/**
 * Settlement consumer: a BullMQ worker on the `settlement` queue, fed by the
 * outbox dispatcher with event.resulted / event.result_corrected. Each bet
 * with a leg on the event is settled by settlePlacedBet (@vamos/db) in its
 * own short transaction, retried on deadlock / serialization failure, so
 * events settled in parallel that share an accumulator do not hold the house
 * accounts for long. settlePlacedBet reads the results resultEvent stored,
 * so it is idempotent: a replayed job, or two jobs for the same event
 * (result then correction) in any order, end in the same state.
 *
 * A bet that keeps failing does not stop the others; the job then fails and
 * BullMQ retries it (the bets already settled are `unchanged` the next time).
 */

export interface SettlementOptions {
  /** Jobs (events) settled in parallel (default 2). */
  concurrency?: number;
}

export interface SettleEventRun {
  eventId: string;
  bets: number;
  outcomes: Record<SettleOutcome, number>;
  /** Bets that could not be settled (errors logged). */
  failed: string[];
}

/** Settles every bet with a leg on the event, one transaction per bet. */
export async function settleEvent(ctx: TaskContext, eventId: string): Promise<SettleEventRun> {
  const ids = await listBetIdsForEvent(ctx.db, eventId);
  const run: SettleEventRun = {
    eventId,
    bets: ids.length,
    outcomes: {
      settled: 0,
      resettled: 0,
      reopened: 0,
      unchanged: 0,
      skipped: 0,
      correction_blocked: 0,
    },
    failed: [],
  };
  for (const betId of ids) {
    let result: SettleBetResult;
    try {
      result = await withTxRetry(ctx.db, (tx) => settlePlacedBet(tx, betId, ctx.clock()), {
        onRetry: (error, attempt) =>
          ctx.logger.warn({ err: error, betId, attempt }, 'settlement transaction retried'),
      });
    } catch (error) {
      run.failed.push(betId);
      ctx.logger.error({ err: error, betId, eventId }, 'bet settlement failed');
      continue;
    }
    run.outcomes[result.outcome] += 1;
    if (result.outcome === 'correction_blocked') {
      ctx.logger.warn(
        { betId, eventId, version: result.version },
        'settlement correction blocked (player balance too low); back office must step in',
      );
    }
  }
  return run;
}

/** Processes one settlement job; throws (so BullMQ retries) when a bet failed. */
export async function processSettlementJob(
  ctx: TaskContext,
  data: SettlementJobData,
): Promise<SettleEventRun> {
  const run = await settleEvent(ctx, data.eventId);
  const changed =
    run.outcomes.settled +
    run.outcomes.resettled +
    run.outcomes.reopened +
    run.outcomes.correction_blocked;
  if (changed > 0 || run.failed.length > 0) {
    ctx.logger.info({ ...run, type: data.type, outboxId: data.outboxId }, 'event settled');
  }
  if (run.failed.length > 0) {
    throw new Error(`settlement of event ${data.eventId}: ${run.failed.length} bet(s) failed`);
  }
  return run;
}

/** The settlement queue consumer as a WorkerTask (start creates the Worker, stop closes it). */
export function settlementTask(ctx: TaskContext, options: SettlementOptions = {}): WorkerTask {
  let consumer: QueueWorker<SettlementJobData, SettleEventRun> | null = null;
  return {
    name: 'settlement',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.settlement,
        (job: Job<SettlementJobData>) => processSettlementJob(ctx, job.data),
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
