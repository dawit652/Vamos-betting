import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTasks } from '../src/tasks/index';
import {
  runWeeklyReport,
  WEEKLY_REPORT_WAIT_MS,
  weeklyReportPaths,
} from '../src/tasks/weekly-report';
import { createHarness, HOUR, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/** The weekly report task (plan task 1.3): written once a week with no command typed. */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const reportFiles = (): string[] => {
  const dir = join(h.ctx.config.scraper.archiveDir, 'reports');
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

describe('the weekly report task', () => {
  it(
    'writes the last complete week once, then skips until the next week is over',
    async () => {
      h = await createHarness();
      const archiveDir = h.ctx.config.scraper.archiveDir;

      // 2026-10-29 is in week 44: week 43 ended on 26 October.
      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: true, week: '2026-W43' });
      expect(reportFiles()).toEqual(['weekly-2026-W43.json', 'weekly-2026-W43.md']);
      const paths = weeklyReportPaths(archiveDir, '2026-W43');
      expect(paths.md).toBe(join(archiveDir, 'reports', 'weekly-2026-W43.md'));
      expect(readFileSync(paths.md, 'utf8')).toContain('# Weekly report 2026-W43');
      const json = JSON.parse(readFileSync(paths.json, 'utf8')) as {
        week: { id: string };
        measures: unknown[];
      };
      expect(json.week.id).toBe('2026-W43');
      expect(json.measures.length).toBeGreaterThan(10);
      const written = statSync(paths.json).mtimeMs;

      // Later the same week, and a day on: nothing is written again.
      h.advance(25 * HOUR);
      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: false, week: '2026-W43' });
      expect(statSync(paths.json).mtimeMs).toBe(written);
      expect(reportFiles()).toHaveLength(2);

      // Week 44 ended on 2 November; its report waits another 48 hours.
      h.at(new Date('2026-11-03T12:00:00Z'));
      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: false, week: '2026-W44' });
      expect(reportFiles()).toHaveLength(2);
      h.at(new Date(Date.UTC(2026, 10, 2) + WEEKLY_REPORT_WAIT_MS));
      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: true, week: '2026-W44' });
      expect(reportFiles()).toEqual([
        'weekly-2026-W43.json',
        'weekly-2026-W43.md',
        'weekly-2026-W44.json',
        'weekly-2026-W44.md',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'skips quietly while another instance holds the lock, and is one of the scraper tasks',
    async () => {
      h = await createHarness();
      await h.ctx.redis.set('scraper:weekly-report', 'other', 'PX', 60_000);
      expect(await runWeeklyReport(h.ctx)).toEqual({ ran: false, week: '2026-W43' });
      expect(reportFiles()).toEqual([]);
      expect(createTasks(h.ctx).map((t) => t.name)).toContain('scraper-weekly-report');
    },
    TEST_TIMEOUT,
  );
});
