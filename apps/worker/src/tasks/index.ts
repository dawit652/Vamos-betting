import type { AppConfig } from '@vamos/config';
import type { WorkerTask } from '../worker';
import {
  betAcceptanceSweepTask,
  betAcceptanceTask,
  type BetAcceptanceOptions,
  type BetAcceptanceSweepOptions,
} from './bet-acceptance';
import {
  amlEvaluateTask,
  amlSweepTask,
  reconciliationRequestTask,
  reconciliationTask,
  type AmlEvaluateOptions,
  type AmlSweepOptions,
  type ReconciliationTaskOptions,
} from './compliance';
import type { TaskContext } from './context';
import { depositReconcileTask, type DepositReconcileOptions } from './deposit-reconcile';
import { feedIngestTask, type FeedIngestOptions } from './feed-ingest';
import {
  jackpotRoundsTask,
  jackpotSettlementSweepTask,
  jackpotSettlementTask,
  type JackpotRoundsOptions,
  type JackpotSettlementOptions,
  type JackpotSettlementSweepOptions,
} from './jackpots';
import { liveSimTask, type LiveSimOptions } from './live-sim';
import { outboxDispatchTask, type OutboxDispatchOptions } from './outbox-dispatch';
import {
  payoutSweepTask,
  payoutTask,
  type PayoutSweepOptions,
  type PayoutTaskOptions,
} from './payouts';
import { prematchDriftTask, type PrematchDriftOptions } from './prematch-drift';
import { retentionPruneTask, type RetentionPruneOptions } from './retention-prune';
import { smsNotifyTask, type SmsNotifyOptions } from './sms-notify';
import { smsRailTasks, type SmsRailTaskOptions } from './smsrail';
import { userNotifyTask, type UserNotifyOptions } from './user-notify';
import { ussdPruneTask, type UssdPruneOptions } from './ussd-prune';
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
  jackpotRounds?: JackpotRoundsOptions;
  jackpotSettlement?: JackpotSettlementOptions;
  jackpotSettlementSweep?: JackpotSettlementSweepOptions;
  betAcceptance?: BetAcceptanceOptions;
  betAcceptanceSweep?: BetAcceptanceSweepOptions;
  payouts?: PayoutTaskOptions;
  payoutSweep?: PayoutSweepOptions;
  depositReconcile?: DepositReconcileOptions;
  smsNotify?: SmsNotifyOptions;
  userNotify?: UserNotifyOptions;
  reconciliation?: ReconciliationTaskOptions;
  amlEvaluate?: AmlEvaluateOptions;
  amlSweep?: AmlSweepOptions;
  outboxDispatch?: OutboxDispatchOptions;
  ussdPrune?: UssdPruneOptions;
  retentionPrune?: RetentionPruneOptions;
  smsRail?: SmsRailTaskOptions;
}

/**
 * The worker's tasks for a configuration. The simulated feed (ingest, live
 * simulator, prematch drift) runs only with FEED_PROVIDER=mock, which
 * loadConfig() already refuses outside demo mode; the mode is checked here
 * again so simulated odds can never reach a licensed (real-money) database.
 *
 * Settlement (and its sweep), the jackpot rounds, their settlement (and its
 * sweep), live bet acceptance, the payout worker (and
 * its sweep), deposit reconciliation, SMS notifications, player push
 * messages, the compliance tasks (reconciliation, AML evaluation and sweep;
 * see ./compliance.ts), the
 * retention pruning (USSD sessions; ended sessions and old one-time codes) and the
 * outbox dispatcher run in every mode and with every feed; the payment providers in
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
    jackpotRoundsTask(ctx, options.jackpotRounds),
    jackpotSettlementTask(ctx, options.jackpotSettlement),
    jackpotSettlementSweepTask(ctx, options.jackpotSettlementSweep),
    betAcceptanceTask(ctx, options.betAcceptance),
    betAcceptanceSweepTask(ctx, options.betAcceptanceSweep),
    payoutTask(ctx, options.payouts),
    payoutSweepTask(ctx, options.payoutSweep),
    depositReconcileTask(ctx, options.depositReconcile),
    smsNotifyTask(ctx, options.smsNotify),
    userNotifyTask(ctx, options.userNotify),
    reconciliationTask(ctx, options.reconciliation),
    reconciliationRequestTask(ctx),
    amlEvaluateTask(ctx, options.amlEvaluate),
    amlSweepTask(ctx, options.amlSweep),
    ussdPruneTask(ctx, options.ussdPrune),
    retentionPruneTask(ctx, options.retentionPrune),
    // The SMS rail's receipt audit, balance reconciliation and watch (only with `sms`).
    ...smsRailTasks(ctx, options.smsRail),
    outboxDispatchTask(ctx, options.outboxDispatch),
  );
  return tasks;
}
