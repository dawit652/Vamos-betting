import {
  listBetIdsForEvent,
  listBetIdsForMarket,
  listBetsToSettle,
  MARKET_RESULTED,
  settlePlacedBet,
  type SettleBetResult,
  type SettleOutcome,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { withTxRetry } from '../lib/retry';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { SettlementJobData } from './outbox-dispatch';

/**
 * Settlement consumer: a BullMQ worker on the `settlement` queue, fed by the
 * outbox dispatcher with event.resulted / event.result_corrected, and with
 * market.resulted for a market resulted early in play (resultMarket: its
 * outcome was already certain). Each bet with a leg on the event (or, for
 * market.resulted, on that market only) is settled by settlePlacedBet
 * (@vamos/db) in its
 * own short transaction, retried on deadlock / serialization failure, so
 * events settled in parallel that share an accumulator do not hold the house
 * accounts for long. settlePlacedBet reads the results resultEvent stored,
 * so it is idempotent: a replayed job, or two jobs for the same event
 * (result then correction) in any order, end in the same state.
 *
 * A bet that keeps failing does not stop the others; the job then fails and
 * BullMQ retries it (the bets already settled are `unchanged` the next time).
 *
 * The settlement sweep (every 30 s) is the safety net: it settles bets left
 * behind by a job that failed for good (e.g. Postgres away for longer than
 * the job's retries) or was never queued, bets accepted while a prematch leg
 * was being resulted, and retries corrections that were blocked because the
 * player's balance was too low (listBetsToSettle in @vamos/db).
 */

export const SETTLEMENT_SWEEP_INTERVAL_MS = 30_000;

export interface SettlementOptions {
  /** Jobs (events) settled in parallel (default 2). */
  concurrency?: number;
}

export interface SettlementSweepOptions {
  /** Default 30 s. */
  intervalMs?: number;
  /** Only events resulted at least this long ago, so their job goes first (default 60 s). */
  graceMs?: number;
  /** How far back resulted events are looked at (default 7 days, as long as failed jobs are kept). */
  lookbackMs?: number;
  /** Bets settled per run (default 200). */
  limit?: number;
}

export interface SettleEventRun {
  eventId: string;
  /** Set when only the bets on this market were looked at (market.resulted). */
  marketId?: string;
  bets: number;
  outcomes: Record<SettleOutcome, number>;
  /** Bets that could not be settled (errors logged). */
  failed: string[];
}

function emptyOutcomes(): Record<SettleOutcome, number> {
  return {
    settled: 0,
    resettled: 0,
    reopened: 0,
    unchanged: 0,
    skipped: 0,
    correction_blocked: 0,
  };
}

/** settlePlacedBet in its own transaction (retried on deadlock / serialization failure). */
function settleOne(ctx: TaskContext, betId: string): Promise<SettleBetResult> {
  return withTxRetry(ctx.db, (tx) => settlePlacedBet(tx, betId, ctx.clock()), {
    onRetry: (error, attempt) =>
      ctx.logger.warn({ err: error, betId, attempt }, 'settlement transaction retried'),
  });
}

/** Settles every bet with a leg on the event, one transaction per bet. */
export async function settleEvent(ctx: TaskContext, eventId: string): Promise<SettleEventRun> {
  const ids = await listBetIdsForEvent(ctx.db, eventId);
  return settleBets(ctx, { eventId, bets: ids.length, outcomes: emptyOutcomes(), failed: [] }, ids);
}

/**
 * Settles every bet with a leg on a market resulted early (market.resulted),
 * one transaction per bet. A bet whose other legs are still open stays open
 * (settlePlacedBet records the leg and waits for canSettle).
 */
export async function settleMarket(
  ctx: TaskContext,
  eventId: string,
  marketId: string,
): Promise<SettleEventRun> {
  const ids = await listBetIdsForMarket(ctx.db, marketId);
  return settleBets(
    ctx,
    { eventId, marketId, bets: ids.length, outcomes: emptyOutcomes(), failed: [] },
    ids,
  );
}

async function settleBets(
  ctx: TaskContext,
  run: SettleEventRun,
  ids: readonly string[],
): Promise<SettleEventRun> {
  const { eventId } = run;
  for (const betId of ids) {
    let result: SettleBetResult;
    try {
      result = await settleOne(ctx, betId);
    } catch (error) {
      run.failed.push(betId);
      ctx.logger.error({ err: error, betId, eventId }, 'bet settlement failed');
      continue;
    }
    run.outcomes[result.outcome] += 1;
    if (result.outcome === 'correction_blocked') {
      ctx.logger.warn(
        { betId, eventId, version: result.version },
        'settlement correction blocked (player balance too low); the sweep retries it',
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
  const run =
    data.type === MARKET_RESULTED && data.marketId !== undefined
      ? await settleMarket(ctx, data.eventId, data.marketId)
      : await settleEvent(ctx, data.eventId);
  const changed =
    run.outcomes.settled +
    run.outcomes.resettled +
    run.outcomes.reopened +
    run.outcomes.correction_blocked;
  if (changed > 0 || run.failed.length > 0) {
    ctx.logger.info(
      { ...run, type: data.type, outboxId: data.outboxId },
      run.marketId === undefined ? 'event settled' : 'market resulted early settled',
    );
  }
  if (run.failed.length > 0) {
    const what = run.marketId === undefined ? `event ${data.eventId}` : `market ${run.marketId}`;
    throw new Error(`settlement of ${what}: ${run.failed.length} bet(s) failed`);
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

export interface SettlementSweepSummary {
  /** Bets the sweep found to settle. */
  due: number;
  outcomes: Record<SettleOutcome, number>;
  failed: number;
}

/** Runs settlePlacedBet on every bet listBetsToSettle returns (at most `limit`). */
export async function runSettlementSweep(
  ctx: TaskContext,
  options: Pick<SettlementSweepOptions, 'graceMs' | 'lookbackMs' | 'limit'> = {},
): Promise<SettlementSweepSummary> {
  const ids = await listBetsToSettle(ctx.db, ctx.clock(), {
    graceMs: options.graceMs ?? 60_000,
    lookbackMs: options.lookbackMs ?? 7 * 24 * 3600_000,
    limit: options.limit ?? 200,
  });
  const summary: SettlementSweepSummary = { due: ids.length, outcomes: emptyOutcomes(), failed: 0 };
  for (const betId of ids) {
    try {
      const result = await settleOne(ctx, betId);
      summary.outcomes[result.outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, betId }, 'settlement sweep: bet settlement failed');
    }
  }
  const { settled, resettled, reopened, correction_blocked: blocked } = summary.outcomes;
  if (settled + resettled + reopened > 0 || summary.failed > 0) {
    ctx.logger.warn({ ...summary }, 'settlement sweep settled bets its jobs had missed');
  } else if (blocked > 0) {
    ctx.logger.info({ blocked }, 'settlement sweep: corrections still blocked (balance too low)');
  }
  return summary;
}

/** The sweep as an interval task (every 30 s by default). */
export function settlementSweepTask(
  ctx: TaskContext,
  options: SettlementSweepOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'settlement-sweep',
    intervalMs: options.intervalMs ?? SETTLEMENT_SWEEP_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runSettlementSweep(ctx, options),
  });
}
