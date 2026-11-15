import type { ScraperContext } from '../context';
import type { ScraperTask } from '../lib/interval';
import { marketFamilyTask } from './market-families';
import { promoteTask } from './promote';
import { pruneTask } from './prune';
import { schedulerTask } from './scheduler';
import { trustTask } from './trust';
import { weeklyReportTask } from './weekly-report';

/** The scraper's tasks, in start order (they stop in reverse). */
export function createTasks(ctx: ScraperContext): ScraperTask[] {
  return [
    schedulerTask(ctx),
    promoteTask(ctx),
    pruneTask(ctx),
    trustTask(ctx),
    marketFamilyTask(ctx),
    weeklyReportTask(ctx),
  ];
}

export { runDueSources, SCHEDULER_INTERVAL_MS } from './scheduler';
export { runPromotion, PROMOTE_INTERVAL_MS } from './promote';
export { pruneRaw, PRUNE_INTERVAL_MS } from './prune';
export { runTrustCheck, TRUST_INTERVAL_MS, TRUST_MIN_AGE_MS } from './trust';
export {
  MARKET_FAMILY_INTERVAL_MS,
  MARKET_FAMILY_WAIT_MS,
  runMarketFamilyJob,
} from './market-families';
export {
  runWeeklyReport,
  weeklyReportPaths,
  WEEKLY_REPORT_INTERVAL_MS,
  WEEKLY_REPORT_WAIT_MS,
} from './weekly-report';
