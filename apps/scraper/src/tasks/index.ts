import type { ScraperContext } from '../context';
import type { ScraperTask } from '../lib/interval';
import { promoteTask } from './promote';
import { pruneTask } from './prune';
import { schedulerTask } from './scheduler';
import { therundownTask } from './therundown';

/**
 * The scraper's tasks, in start order (they stop in reverse). The TheRundown poller exists only
 * when THERUNDOWN_ENABLED is on (docs/therundown-plan).
 */
export function createTasks(ctx: ScraperContext): ScraperTask[] {
  const tasks = [schedulerTask(ctx), promoteTask(ctx), pruneTask(ctx)];
  if (ctx.config.therundown.enabled) tasks.push(therundownTask(ctx));
  return tasks;
}

export { runDueSources, SCHEDULER_INTERVAL_MS } from './scheduler';
export { runPromotion, PROMOTE_INTERVAL_MS } from './promote';
export { pruneRaw, PRUNE_INTERVAL_MS } from './prune';
export { runTherundown, THERUNDOWN_INTERVAL_MS } from './therundown';
