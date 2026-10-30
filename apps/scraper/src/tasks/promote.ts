import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { promoteFixtures } from '../pipeline/promote-fixtures';
import {
  applyStaffConfirmations,
  flagOverdueResults,
  promoteResults,
} from '../pipeline/promote-results';
import { repriceScheduledEvents } from '../pipeline/reprice';
import { flagStaleSources } from '../pipeline/stale-sources';
import { reresolveChangedAliases, reresolveUnresolved } from '../pipeline/run-source';

export const PROMOTE_INTERVAL_MS = 60_000;
const PROMOTE_LOCK_TTL_MS = 5 * 60_000;

/**
 * One promotion pass: re-resolve names, promote fixtures, apply what staff
 * confirmed, promote results, raise the matches no source has a result for,
 * then re-price the events whose teams' ratings moved. Each step is independent: one failing does not stop the others.
 * Under a Redis lock so two instances do not both promote.
 */
export async function runPromotion(ctx: ScraperContext): Promise<boolean> {
  const lock = await tryLock(ctx.redis, 'scraper:promote', PROMOTE_LOCK_TTL_MS);
  if (lock === null) return false;
  try {
    const steps: Array<[string, () => Promise<unknown>]> = [
      // First: an alias that was removed or changed un-maps/re-maps what is stored (finding 8).
      ['re-resolve changed aliases', () => reresolveChangedAliases(ctx)],
      ['reresolve', () => reresolveUnresolved(ctx)],
      ['fixtures', () => promoteFixtures(ctx)],
      // Before the result gate: a confirmed item must not be shadowed by a fresh one.
      ['staff confirmations', () => applyStaffConfirmations(ctx)],
      ['results', () => promoteResults(ctx)],
      // After results: what no source will ever settle is raised for a person (F-04).
      ['overdue results', () => flagOverdueResults(ctx)],
      // A source that answers but shows nothing new while matches end (S5).
      ['stale sources', () => flagStaleSources(ctx)],
      // After results: they move the ratings the prices depend on (rule O3).
      ['reprice', () => repriceScheduledEvents(ctx)],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        ctx.logger.error({ err: error, step: name }, 'promotion step failed');
      }
    }
    return true;
  } finally {
    await lock.release().catch(() => false);
  }
}

export function promoteTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-promote',
    intervalMs: PROMOTE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runPromotion(ctx),
  });
}
