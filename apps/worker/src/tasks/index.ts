import type { AppConfig } from '@vamos/config';
import type { WorkerTask } from '../worker';
import {
  betAcceptanceSweepTask,
  betAcceptanceTask,
  type BetAcceptanceOptions,
  type BetAcceptanceSweepOptions,
} from './bet-acceptance';
import type { TaskContext } from './context';
import { feedIngestTask, type FeedIngestOptions } from './feed-ingest';
import { liveSimTask, type LiveSimOptions } from './live-sim';
import { outboxDispatchTask, type OutboxDispatchOptions } from './outbox-dispatch';
import { prematchDriftTask, type PrematchDriftOptions } from './prematch-drift';
import { settlementTask, type SettlementOptions } from './settlement';

export type { TaskContext } from './context';

export interface TaskOptions {
  feedIngest?: FeedIngestOptions;
  liveSim?: Partial<LiveSimOptions>;
  prematchDrift?: PrematchDriftOptions;
  settlement?: SettlementOptions;
  betAcceptance?: BetAcceptanceOptions;
  betAcceptanceSweep?: BetAcceptanceSweepOptions;
  outboxDispatch?: OutboxDispatchOptions;
}

/**
 * The worker's tasks for a configuration. The simulated feed (ingest, live
 * simulator, prematch drift) runs only with FEED_PROVIDER=mock, which
 * loadConfig() already refuses outside demo mode; the mode is checked here
 * again so simulated odds can never reach a licensed (real-money) database.
 *
 * Settlement, live bet acceptance and the outbox dispatcher run in every
 * mode and with every feed. The consumers come before the dispatcher, so
 * they are started first and stopped last.
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
    betAcceptanceTask(ctx, options.betAcceptance),
    betAcceptanceSweepTask(ctx, options.betAcceptanceSweep),
    outboxDispatchTask(ctx, options.outboxDispatch),
  );
  return tasks;
}
