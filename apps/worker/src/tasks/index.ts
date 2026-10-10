import type { AppConfig } from '@vamos/config';
import type { WorkerTask } from '../worker';
import {
  betAcceptanceSweepTask,
  betAcceptanceTask,
  type BetAcceptanceOptions,
  type BetAcceptanceSweepOptions,
} from './bet-acceptance';
import type { TaskContext } from './context';
import { depositReconcileTask, type DepositReconcileOptions } from './deposit-reconcile';
import { feedIngestTask, type FeedIngestOptions } from './feed-ingest';
import { liveSimTask, type LiveSimOptions } from './live-sim';
import { outboxDispatchTask, type OutboxDispatchOptions } from './outbox-dispatch';
import {
  payoutSweepTask,
  payoutTask,
  type PayoutSweepOptions,
  type PayoutTaskOptions,
} from './payouts';
import { prematchDriftTask, type PrematchDriftOptions } from './prematch-drift';
import { smsNotifyTask, type SmsNotifyOptions } from './sms-notify';
import {
  settlementSweepTask,
  settlementTask,
  type SettlementOptions,
  type SettlementSweepOptions,
} from './settlement';

export type { TaskContext } from './context';

export interface TaskOptions {
  feedIngest?: FeedIngestOptions;
  liveSim?: Partial<LiveSimOptions>;
  prematchDrift?: PrematchDriftOptions;
  settlement?: SettlementOptions;
  settlementSweep?: SettlementSweepOptions;
  betAcceptance?: BetAcceptanceOptions;
  betAcceptanceSweep?: BetAcceptanceSweepOptions;
  payouts?: PayoutTaskOptions;
  payoutSweep?: PayoutSweepOptions;
  depositReconcile?: DepositReconcileOptions;
  smsNotify?: SmsNotifyOptions;
  outboxDispatch?: OutboxDispatchOptions;
}

/**
 * The worker's tasks for a configuration. The simulated feed (ingest, live
 * simulator, prematch drift) runs only with FEED_PROVIDER=mock, which
 * loadConfig() already refuses outside demo mode; the mode is checked here
 * again so simulated odds can never reach a licensed (real-money) database.
 *
 * Settlement (and its sweep), live bet acceptance, the payout worker (and
 * its sweep), deposit reconciliation, SMS notifications and the outbox
 * dispatcher run in every mode and with every feed; the payment providers in
 * ctx.payments are whatever PAYMENT_PROVIDERS enables (only the mock one in
 * demo mode). The consumers come before the dispatcher, so they are started
 * first and stopped last.
 */
export function createTasks(
  config: AppConfig,
  ctx: TaskContext,
  options: TaskOptions = {},
): WorkerTask[] {
  const tasks: WorkerTask[] = [];
  if (config.feed.provider === 'mock' && config.mode === 'demo') {
    tasks.push(
      feedIngestTask(ctx, options.feedIngest),
      liveSimTask(ctx, {
        ...options.liveSim,
        simSpeed: options.liveSim?.simSpeed ?? config.feed.simSpeed,
      }),
      prematchDriftTask(ctx, options.prematchDrift),
    );
  }
  tasks.push(
    settlementTask(ctx, options.settlement),
    settlementSweepTask(ctx, options.settlementSweep),
    betAcceptanceTask(ctx, options.betAcceptance),
    betAcceptanceSweepTask(ctx, options.betAcceptanceSweep),
    payoutTask(ctx, options.payouts),
    payoutSweepTask(ctx, options.payoutSweep),
    depositReconcileTask(ctx, options.depositReconcile),
    smsNotifyTask(ctx, options.smsNotify),
    outboxDispatchTask(ctx, options.outboxDispatch),
  );
  return tasks;
}
