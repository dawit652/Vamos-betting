import type { ScraperContext } from '../context';
import type { ScraperTask } from '../lib/interval';
import { marketFamilyTask } from './market-families';
import { boardResultsTask } from './board-results';
import { hulusportTask } from './hulusport';
import { narobetTask } from './narobet';
import { promoteTask } from './promote';
import { pruneTask } from './prune';
import { schedulerTask } from './scheduler';
import { teamLogosTask } from './team-logos';
import { trustTask } from './trust';
import { weeklyReportTask } from './weekly-report';

/**
 * The scraper's tasks, in start order (they stop in reverse). The Hulusport board only when
 * configured (SCRAPER_HULUSPORT_URL), and its API-Football results only with a key as well; the
 * Narobet board (mr-z) only when SCRAPER_NAROBET_URL is set.
 */
export function createTasks(ctx: ScraperContext): ScraperTask[] {
  const hulusport = hulusportTask(ctx);
  const narobet = narobetTask(ctx);
  const results = hulusport === null ? null : boardResultsTask(ctx);
  const logos = teamLogosTask(ctx);
  return [
    schedulerTask(ctx),
    promoteTask(ctx),
    pruneTask(ctx),
    trustTask(ctx),
    marketFamilyTask(ctx),
    weeklyReportTask(ctx),
    ...(hulusport === null ? [] : [hulusport]),
    ...(narobet === null ? [] : [narobet]),
    ...(results === null ? [] : [results]),
    ...(logos === null ? [] : [logos]),
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
export { readHulusportBoard, HULUSPORT_BOARD_PATH } from './hulusport';
export { readNarobetBoard } from './narobet';
export { runBoardResults, BOARD_RESULTS_INTERVAL_MS } from './board-results';
export { runTeamLogos, TEAM_LOGOS_INTERVAL_MS } from './team-logos';
