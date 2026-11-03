import type { AppConfig } from '@vamos/config';
import { createElsReporter } from '@vamos/db';
import { OddsApiClient } from '@vamos/feed';
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
  dailySummaryTask,
  elsReportTask,
  elsSweepTask,
  reconciliationRequestTask,
  reconciliationTask,
  type AmlEvaluateOptions,
  type AmlSweepOptions,
  type DailySummaryOptions,
  type ElsReportOptions,
  type ElsSweepOptions,
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
import { oddsApiTasks, type OddsApiTaskOptions } from './oddsapi/index';
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
  /** FEED_PROVIDER=theoddsapi (tests pass a fake client). */
  oddsApi?: OddsApiTaskOptions;
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
  elsReport?: ElsReportOptions;
  elsSweep?: ElsSweepOptions;
  dailySummaries?: DailySummaryOptions;
  reconciliation?: ReconciliationTaskOptions;
  amlEvaluate?: AmlEvaluateOptions;
  amlSweep?: AmlSweepOptions;
  outboxDispatch?: OutboxDispatchOptions;
  ussdPrune?: UssdPruneOptions;
  retentionPrune?: RetentionPruneOptions;
}

/**
 * The worker's tasks for a configuration. The simulated feed (ingest, live
 * simulator, prematch drift) runs only with FEED_PROVIDER=mock, which
 * loadConfig() already refuses outside demo mode; the mode is checked here
 * again so simulated odds can never reach a licensed (real-money) database.
 * FEED_PROVIDER=theoddsapi runs the real feed instead (./oddsapi), in either
 * mode.
 *
 * Settlement (and its sweep), the jackpot rounds, their settlement (and its
 * sweep), live bet acceptance, the payout worker (and
 * its sweep), deposit reconciliation, SMS notifications, player push
 * messages, the compliance tasks (ELS stream and its sweep, daily summaries,
 * reconciliation, AML evaluation and sweep; see ./compliance.ts), the
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
  // ELS_REPORTING_MODE / ELS_REPORT_DIR, unless the caller brought its own reporter.
  const compliance: TaskContext = { ...ctx, els: ctx.els ?? createElsReporter(config.els) };
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
  if (config.feed.provider === 'theoddsapi') {
    const odds = config.feed.oddsApi;
    const client =
      options.oddsApi?.client ??
      new OddsApiClient({ apiKey: odds.apiKey ?? '', baseUrl: odds.baseUrl });
    tasks.push(...oddsApiTasks(ctx, { client, config: odds, mode: config.mode }, options.oddsApi));
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
    elsReportTask(compliance, options.elsReport),
    elsSweepTask(compliance, options.elsSweep),
    dailySummaryTask(compliance, options.dailySummaries),
    reconciliationTask(compliance, options.reconciliation),
    reconciliationRequestTask(compliance),
    amlEvaluateTask(compliance, options.amlEvaluate),
    amlSweepTask(compliance, options.amlSweep),
    ussdPruneTask(ctx, options.ussdPrune),
    retentionPruneTask(ctx, options.retentionPrune),
    outboxDispatchTask(ctx, options.outboxDispatch),
  );
  return tasks;
}
