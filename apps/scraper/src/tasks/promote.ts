import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { openConfirmedEvents } from '../pipeline/auto-open';
import { captureClosePrices } from '../pipeline/close-prices';
import { closeBettingOnEarlierKickoff } from '../pipeline/kickoff-safety';
import { promoteFixtures } from '../pipeline/promote-fixtures';
import {
  applyStaffConfirmations,
  flagOverdueResults,
  promoteResults,
} from '../pipeline/promote-results';
import { repriceScheduledEvents } from '../pipeline/reprice';
import { rateHandResults } from '../pipeline/result-ratings';
import { sweepReviewQueue } from '../pipeline/review-sweep';
import { sweepStaleReviewItems } from '../pipeline/review-sweep-stale';
import { flagStaleSources } from '../pipeline/stale-sources';
import { reresolveChangedAliases, reresolveUnresolved } from '../pipeline/run-source';

export const PROMOTE_INTERVAL_MS = 60_000;
const PROMOTE_LOCK_TTL_MS = 5 * 60_000;

/**
 * One promotion pass: re-resolve names, close betting on earlier kickoffs (K1), promote fixtures, apply what staff
 * confirmed, promote results, raise the matches no source has a result for, move the ratings for results a person entered (S-5),
 * then re-price the events whose teams' ratings moved, and open betting where auto_open allows it once the
 * kickoff is confirmed (F7b), and last close the review items that became pointless (Q1, Q2). Each step is independent: one failing does not stop the others.
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
      // Before anything else decides on fixtures: betting open while a source says the match starts earlier is closed (K1).
      ['kickoff safety', () => closeBettingOnEarlierKickoff(ctx)],
      ['fixtures', () => promoteFixtures(ctx)],
      // Before the result gate: a confirmed item must not be shadowed by a fresh one.
      ['staff confirmations', () => applyStaffConfirmations(ctx)],
      ['results', () => promoteResults(ctx)],
      // After results: what no source will ever settle is raised for a person (F-04).
      ['overdue results', () => flagOverdueResults(ctx)],
      // A source that answers but shows nothing new while matches end (S5).
      ['stale sources', () => flagStaleSources(ctx)],
      // After results, before re-pricing: a result a person entered moves the ratings too (O4, S-5).
      ['hand result ratings', () => rateHandResults(ctx)],
      // After results: they move the ratings the prices depend on (rule O3).
      ['reprice', () => repriceScheduledEvents(ctx)],
      // Last: with the kickoff confirmed and the prices current, open what auto_open allows (F7b).
      ['auto open', () => openConfirmedEvents(ctx)],
      // What we and the market priced at betting close, for the scorecard (M1, measurement only).
      ['close prices', () => captureClosePrices(ctx)],
      // After auto open (it may open betting): close the items nobody needs any more (Q1).
      ['review sweep', () => sweepReviewQueue(ctx)],
      // Same place: items about sources that no longer run and names nobody has seen for a week (Q2).
      ['stale review sweep', () => sweepStaleReviewItems(ctx)],
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
