import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOUR_MS } from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { gatherWeeklyInputs } from '../eval/weekly-data';
import { buildWeeklyReport, lastCompleteWeek } from '../eval/weekly-report';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';

/** How often the task looks at the clock; it writes only when the week's report is missing. */
export const WEEKLY_REPORT_INTERVAL_MS = HOUR_MS;
/** Results of the last day of the week are audited 48 hours after the week ends; the report waits. */
export const WEEKLY_REPORT_WAIT_MS = 48 * HOUR_MS;
const WEEKLY_REPORT_LOCK_TTL_MS = 10 * 60_000;

export interface WeeklyReportSummary {
  /** False when the week's report exists, it is too early, or another instance holds the lock. */
  ran: boolean;
  week: string;
}

/** Where a week's report is kept: `<archiveDir>/reports/weekly-<YYYY-Www>.md` and `.json`. */
export function weeklyReportPaths(
  archiveDir: string,
  weekId: string,
): { dir: string; md: string; json: string } {
  const dir = join(archiveDir, 'reports');
  return {
    dir,
    md: join(dir, `weekly-${weekId}.md`),
    json: join(dir, `weekly-${weekId}.json`),
  };
}

const exists = (path: string): Promise<boolean> =>
  readFile(path).then(
    () => true,
    () => false,
  );

/** Writes through a temporary name, so a half-written file never counts as the report. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await writeFile(`${path}.tmp`, text, 'utf8');
  await rename(`${path}.tmp`, path);
}

/**
 * The weekly report (plan task 1.3): the report of the last complete ISO week, written as Markdown
 * and JSON under the archive directory with no command typed, once its week is 48 hours over (so the
 * 48-hour measures can be read) and skipped when the files already exist. Measurement only.
 */
export async function runWeeklyReport(ctx: ScraperContext): Promise<WeeklyReportSummary> {
  const now = ctx.clock();
  const week = lastCompleteWeek(now);
  const skipped = { ran: false, week: week.id };
  if (now.getTime() < week.to.getTime() + WEEKLY_REPORT_WAIT_MS) return skipped;
  const paths = weeklyReportPaths(ctx.config.scraper.archiveDir, week.id);
  // The JSON is written last: its presence means the report is complete.
  if (await exists(paths.json)) return skipped;
  const lock = await tryLock(ctx.redis, 'scraper:weekly-report', WEEKLY_REPORT_LOCK_TTL_MS);
  if (lock === null) return skipped;
  try {
    if (await exists(paths.json)) return skipped;
    const report = buildWeeklyReport(await gatherWeeklyInputs(ctx.db, week, now));
    await mkdir(paths.dir, { recursive: true });
    await writeAtomic(paths.md, report.markdown);
    await writeAtomic(paths.json, `${JSON.stringify(report.json, null, 2)}\n`);
    ctx.logger.info(
      { week: week.id, file: paths.md, ...report.json.summary },
      'weekly report written',
    );
    return { ran: true, week: week.id };
  } finally {
    await lock.release().catch(() => false);
  }
}

export function weeklyReportTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-weekly-report',
    intervalMs: WEEKLY_REPORT_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runWeeklyReport(ctx),
    runOnStart: false,
  });
}
