import type { ScraperContext } from '../context';
import type { ScraperTask } from '../lib/interval';
import { boardResultsTask } from './board-results';
import { hulusportTask } from './hulusport';
import { promoteTask } from './promote';
import { pruneTask } from './prune';
import { schedulerTask } from './scheduler';

/**
 * The scraper's tasks, in start order (they stop in reverse). The Hulusport board only when
 * configured (SCRAPER_HULUSPORT_URL), and its API-Football results only with a key as well.
 */
export function createTasks(ctx: ScraperContext): ScraperTask[] {
  const hulusport = hulusportTask(ctx);
  const results = hulusport === null ? null : boardResultsTask(ctx);
  return [
    schedulerTask(ctx),
    promoteTask(ctx),
    pruneTask(ctx),
    ...(hulusport === null ? [] : [hulusport]),
    ...(results === null ? [] : [results]),
  ];
}

export { runDueSources, SCHEDULER_INTERVAL_MS } from './scheduler';
export { runPromotion, PROMOTE_INTERVAL_MS } from './promote';
export { pruneRaw, PRUNE_INTERVAL_MS } from './prune';
export { readHulusportBoard, HULUSPORT_BOARD_PATH } from './hulusport';
export { runBoardResults, BOARD_RESULTS_INTERVAL_MS } from './board-results';
