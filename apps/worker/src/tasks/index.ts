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
import { cashCollectTask } from './cash-collect';
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
import { moneyNotCreditedTask } from './money-not-credited';
import { reportCloseTask } from './report-close';
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
import { DomainError, fileDepositClaim, smsRailHealth, userIdByPhone } from '@vamos/db';
import { createCatalogReader } from '../telegram/catalog';
import { createResetCodeRequester } from '../telegram/reset';
import { telegramBotTask, type TelegramBotTaskOptions } from '../telegram/task';
import { userNotifyTask, type UserNotifyOptions } from './user-notify';
import { ussdPruneTask, type UssdPruneOptions } from './ussd-prune';
import { agentStatementsTask } from './agent-statements';
import { retailAlertsTask } from './retail-alerts';
import { serviceHealthTask } from './service-health';
import { retailExpiryTask } from './retail-expiry';
import {
  settlementSweepTask,
  settlementTask,
  type SettlementOptions,
  type SettlementSweepOptions,
} from './settlement';

export type { TaskContext } from './context';

export interface TaskOptions {
  feedIngest?: FeedIngestOptions;
  telegramBot?: TelegramBotTaskOptions;
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
    // Approved cash withdrawals nobody collected go back to the player (CASH_WITHDRAWAL_COLLECT_DAYS).
    cashCollectTask(ctx, { maxAgeMs: config.payments.cashCollectMs }),
    depositReconcileTask(ctx, options.depositReconcile),
    smsNotifyTask(ctx, options.smsNotify),
    userNotifyTask(ctx, options.userNotify),
    reconciliationTask(ctx, options.reconciliation),
    reconciliationRequestTask(ctx),
    // Owner reports: closes each business day after midnight and re-checks the last ones.
    reportCloseTask(ctx),
    moneyNotCreditedTask(ctx),
    amlEvaluateTask(ctx, options.amlEvaluate),
    amlSweepTask(ctx, options.amlSweep),
    ussdPruneTask(ctx, options.ussdPrune),
    retailExpiryTask(ctx),
    // Agents' weekly statements (Monday to Sunday, Addis Ababa time), made once the week closed.
    agentStatementsTask(ctx),
    // Alerts about the agent shops (big wins, repeated picks, cancels, late tickets, balances...).
    retailAlertsTask(ctx),
    // A service down (payments, feeds, mr-x, mr-z): Telegram every 15 minutes, then "works again".
    serviceHealthTask(ctx),
    retentionPruneTask(ctx, options.retentionPrune),
    // The SMS rail's receipt audit, balance reconciliation and watch (only with `sms`).
    ...smsRailTasks(ctx, options.smsRail),
    outboxDispatchTask(ctx, options.outboxDispatch),
  );
  // The Telegram bot (TELEGRAM_BOT_TOKEN): players' read-only menu, /id and the owner's /status.
  if (ctx.telegram !== undefined && config.telegram.botToken !== undefined) {
    tasks.push(
      telegramBotTask(
        {
          client: ctx.telegram,
          catalog: createCatalogReader({ baseUrl: config.api.internalUrl }),
          redis: ctx.redis,
          logger: ctx.logger,
          clock: ctx.clock,
          webUrl: config.web.publicUrl,
          ownerChatIds: new Set(config.telegram.ownerChatIds),
          playerMenu: config.telegram.playerMenu,
          demo: config.mode === 'demo',
          status: async () => smsRailHealth(ctx.db),
          // "Deposit problem" (G5.4, O3): the claim waits in Back office → Money not credited.
          depositClaim: {
            playerByPhone: (phone) => userIdByPhone(ctx.db, phone),
            file: async (input) => {
              try {
                await ctx.db.transaction((tx) =>
                  fileDepositClaim(tx, {
                    ...input,
                    paidAt: ctx.clock(),
                    note: 'Telegram',
                    source: 'telegram',
                    now: ctx.clock(),
                  }),
                );
                return 'filed';
              } catch (error) {
                if (!(error instanceof DomainError)) throw error;
                if (error.code === 'claim_exists') return 'exists';
                if (error.code === 'too_many_open_claims') return 'too_many';
                return 'invalid';
              }
            },
          },
          // Forgot PIN over Telegram (X12): the API issues the code, the bot sends it.
          resetCode: createResetCodeRequester({
            baseUrl: config.api.internalUrl,
            secret: config.sessionSecret,
            clock: ctx.clock,
          }),
        },
        options.telegramBot,
      ),
    );
  }
  return tasks;
}
