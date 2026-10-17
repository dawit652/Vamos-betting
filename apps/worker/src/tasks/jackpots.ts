import {
  closeDueJackpotRounds,
  ensureJackpotRound,
  listJackpotRoundIdsForEvent,
  listJackpotRoundIdsForMarket,
  listJackpotRoundsToSettle,
  loadGameSettings,
  MARKET_RESULTED,
  settleJackpotRound,
  type EnsureJackpotRoundResult,
  type JackpotTemplateCode,
  type SettleJackpotOutcome,
  type SettleJackpotRoundResult,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { withTxRetry } from '../lib/retry';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { SettlementJobData } from './outbox-dispatch';

/**
 * Jackpots (Phase 8): the worker side of the round lifecycle. The money
 * logic lives in @vamos/db (jackpots/*); these tasks only decide when it
 * runs.
 *
 * - `jackpot-rounds` (every 15 s): closes the open rounds whose first game
 *   kicks off (or one of whose games left the schedule) and cancels
 *   scheduled rounds that never opened (closeDueJackpotRounds); then, per
 *   enabled template, keeps one round taking entries (ensureJackpotRound:
 *   the template's number of upcoming scheduled football events with an
 *   open 1X2 market, kicking off more than `leadMs` from now, none of them
 *   a game of another unsettled round of that template; an advisory lock
 *   per template stops two workers opening two rounds). The template and
 *   the winnings tax are read from the settings in force and frozen on the
 *   round, so later edits only reach new rounds.
 * - `jackpot-settlement` (BullMQ consumer): fed by the outbox dispatcher
 *   with event.resulted / event.result_corrected / market.resulted; every
 *   round with a game on that event (or 1X2 market) goes through
 *   settleJackpotRound, which settles it once all its games have a result
 *   (one transaction per round, retried on deadlock / serialization
 *   failure). settleJackpotRound locks the round, so jobs, the sweep and
 *   several workers can run it concurrently: the first one pays and the
 *   others find the round final. A result corrected after settlement only
 *   flags the round (`jackpot.result_mismatch`, logged here); nothing is
 *   paid again.
 * - `jackpot-settlement-sweep` (every 30 s): the safety net for lost or
 *   failed jobs and for rounds whose closing is due
 *   (listJackpotRoundsToSettle).
 */

export const JACKPOT_ROUNDS_INTERVAL_MS = 15_000;
export const JACKPOT_SETTLEMENT_SWEEP_INTERVAL_MS = 30_000;
/** Default: a new round's games kick off at least 30 minutes after it opens. */
export const JACKPOT_ROUND_LEAD_MS = 30 * 60_000;

export interface JackpotRoundsOptions {
  /** Default 15 s. */
  intervalMs?: number;
  /** A new round's games kick off more than this after now (default 30 min). */
  leadMs?: number;
  /** ...and within this long after now (default: no limit). */
  horizonMs?: number;
}

export interface JackpotRoundsSummary {
  /** Open rounds closed by this run. */
  closed: string[];
  /** Scheduled rounds cancelled because they never opened. */
  cancelled: string[];
  /** What ensureJackpotRound did per template ('failed' when it threw; logged). */
  templates: Partial<Record<JackpotTemplateCode, EnsureJackpotRoundResult['outcome'] | 'failed'>>;
  /** Rounds opened by this run. */
  created: string[];
}

/** One run of the round task: close what is due, then keep a round of every enabled template open. */
export async function runJackpotRounds(
  ctx: TaskContext,
  options: Pick<JackpotRoundsOptions, 'leadMs' | 'horizonMs'> = {},
): Promise<JackpotRoundsSummary> {
  const now = ctx.clock();
  const { closed, cancelled } = await withTxRetry(ctx.db, (tx) => closeDueJackpotRounds(tx, now));
  const summary: JackpotRoundsSummary = { closed, cancelled, templates: {}, created: [] };
  if (closed.length > 0 || cancelled.length > 0) {
    ctx.logger.info({ closed, cancelled }, 'jackpot rounds closed');
  }

  const { jackpots } = await loadGameSettings(ctx.db);
  for (const code of Object.keys(jackpots) as JackpotTemplateCode[]) {
    try {
      const result = await withTxRetry(ctx.db, async (tx) => {
        // The template and tax in force when the round opens (frozen on it).
        const settings = await loadGameSettings(tx);
        return ensureJackpotRound(tx, {
          template: settings.jackpots[code],
          tax: settings.tax,
          now,
          leadMs: options.leadMs ?? JACKPOT_ROUND_LEAD_MS,
          ...(options.horizonMs === undefined ? {} : { horizonMs: options.horizonMs }),
        });
      });
      summary.templates[code] = result.outcome;
      if (result.outcome === 'created') {
        summary.created.push(result.round.id);
        ctx.logger.info(
          {
            roundId: result.round.id,
            templateCode: code,
            closesAt: result.round.closesAt.toISOString(),
            games: result.round.gameCount,
          },
          'jackpot round opened',
        );
      } else if (result.outcome === 'not_enough_events') {
        ctx.logger.debug(
          { templateCode: code, available: result.available, needed: result.needed },
          'jackpot round not opened: not enough upcoming events',
        );
      }
    } catch (error) {
      summary.templates[code] = 'failed';
      ctx.logger.error({ err: error, templateCode: code }, 'jackpot round could not be opened');
    }
  }
  return summary;
}

/** The round task as an interval task (every 15 s by default). */
export function jackpotRoundsTask(ctx: TaskContext, options: JackpotRoundsOptions = {}): IntervalTask {
  return intervalTask({
    name: 'jackpot-rounds',
    intervalMs: options.intervalMs ?? JACKPOT_ROUNDS_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runJackpotRounds(ctx, options),
  });
}

export interface JackpotSettleRun {
  rounds: number;
  outcomes: Record<SettleJackpotOutcome, number>;
  /** Rounds that could not be settled (errors logged). */
  failed: string[];
}

function emptyOutcomes(): Record<SettleJackpotOutcome, number> {
  return { settled: 0, voided: 0, open: 0, pending: 0, unchanged: 0, flagged: 0 };
}

/** settleJackpotRound in its own transaction (retried on deadlock / serialization failure). */
function settleOne(ctx: TaskContext, roundId: string): Promise<SettleJackpotRoundResult> {
  return withTxRetry(ctx.db, (tx) => settleJackpotRound(tx, roundId, ctx.clock()), {
    onRetry: (error, attempt) =>
      ctx.logger.warn({ err: error, roundId, attempt }, 'jackpot settlement transaction retried'),
  });
}

/** Runs settleJackpotRound on each round, one transaction per round; a failing round does not stop the others. */
export async function settleJackpotRounds(
  ctx: TaskContext,
  roundIds: readonly string[],
): Promise<JackpotSettleRun> {
  const run: JackpotSettleRun = { rounds: roundIds.length, outcomes: emptyOutcomes(), failed: [] };
  for (const roundId of roundIds) {
    let result: SettleJackpotRoundResult;
    try {
      result = await settleOne(ctx, roundId);
    } catch (error) {
      run.failed.push(roundId);
      ctx.logger.error({ err: error, roundId }, 'jackpot round settlement failed');
      continue;
    }
    run.outcomes[result.outcome] += 1;
    if (result.outcome === 'settled' || result.outcome === 'voided') {
      ctx.logger.info(
        { roundId, outcome: result.outcome, entries: result.entries, winners: result.winners },
        'jackpot round settled',
      );
    } else if (result.outcome === 'flagged') {
      ctx.logger.warn(
        { roundId },
        'jackpot result changed after settlement: round flagged for review, nothing paid again',
      );
    }
  }
  return run;
}

/**
 * Processes one `jackpot-settlement` job: the rounds with a game on the
 * resulted event (or, for market.resulted, on that 1X2 market). Throws (so
 * BullMQ retries) when a round failed; rounds already final are
 * `unchanged` the next time.
 */
export async function processJackpotSettlementJob(
  ctx: TaskContext,
  data: SettlementJobData,
): Promise<JackpotSettleRun> {
  const roundIds =
    data.type === MARKET_RESULTED && data.marketId !== undefined
      ? await listJackpotRoundIdsForMarket(ctx.db, data.marketId)
      : await listJackpotRoundIdsForEvent(ctx.db, data.eventId);
  const run = await settleJackpotRounds(ctx, roundIds);
  if (run.failed.length > 0) {
    throw new Error(
      `jackpot settlement after ${data.type} ${data.marketId ?? data.eventId}: ${run.failed.length} round(s) failed`,
    );
  }
  return run;
}

export interface JackpotSettlementOptions {
  /** Jobs handled in parallel (default 1: rounds share the house jackpot account). */
  concurrency?: number;
}

/** The `jackpot-settlement` queue consumer as a WorkerTask. */
export function jackpotSettlementTask(
  ctx: TaskContext,
  options: JackpotSettlementOptions = {},
): WorkerTask {
  let consumer: QueueWorker<SettlementJobData, JackpotSettleRun> | null = null;
  return {
    name: 'jackpot-settlement',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.jackpotSettlement,
        (job: Job<SettlementJobData>) => processJackpotSettlementJob(ctx, job.data),
        ctx.logger,
        { concurrency: options.concurrency ?? 1 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}

export interface JackpotSettlementSweepOptions {
  /** Default 30 s. */
  intervalMs?: number;
  /** Rounds looked at per run (default 50). */
  limit?: number;
}

/** Runs settleJackpotRound on every round listJackpotRoundsToSettle returns. */
export async function runJackpotSettlementSweep(
  ctx: TaskContext,
  options: Pick<JackpotSettlementSweepOptions, 'limit'> = {},
): Promise<JackpotSettleRun> {
  const roundIds = await listJackpotRoundsToSettle(ctx.db, ctx.clock(), {
    limit: options.limit ?? 50,
  });
  return settleJackpotRounds(ctx, roundIds);
}

/** The sweep as an interval task (every 30 s by default). */
export function jackpotSettlementSweepTask(
  ctx: TaskContext,
  options: JackpotSettlementSweepOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'jackpot-settlement-sweep',
    intervalMs: options.intervalMs ?? JACKPOT_SETTLEMENT_SWEEP_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runJackpotSettlementSweep(ctx, options),
  });
}
