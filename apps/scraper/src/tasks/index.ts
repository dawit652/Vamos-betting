import type { ScraperContext } from '../context';
import type { ScraperTask } from '../lib/interval';
import { promoteTask } from './promote';
import { pruneTask } from './prune';
import { schedulerTask } from './scheduler';

/** The scraper's tasks, in start order (they stop in reverse). */
export function createTasks(ctx: ScraperContext): ScraperTask[] {
  return [schedulerTask(ctx), promoteTask(ctx), pruneTask(ctx)];
}

export { runDueSources, SCHEDULER_INTERVAL_MS } from './scheduler';
export { runPromotion, PROMOTE_INTERVAL_MS } from './promote';
export { pruneRaw, PRUNE_INTERVAL_MS } from './prune';
