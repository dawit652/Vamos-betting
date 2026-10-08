import { randomInt } from 'node:crypto';
import { MAX_ODDS_MILLI, MIN_ODDS_MILLI } from '@vamos/core';
import {
  FEED_ODDS_SOURCE,
  listScheduledEventIds,
  lockEvent,
  MANUAL_ODDS_SOURCE,
  marketsWithSelections,
  oddsProvenance,
  setSelectionOdds,
  type OddsChange,
} from '@vamos/db';
import { createRng, MOCK_PROVIDER_NAME, type Rng } from '@vamos/feed';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { publishAfterCommit } from '../lib/publish';
import type { TaskContext } from './context';

/**
 * Demo prematch odds drift (FEED_PROVIDER=mock): every 30 seconds a few
 * random scheduled events get one or two of their open markets nudged by
 * ±1–3% per selection, so odds changes (bet slip "odds changed" prompts, SSE
 * deltas) can be seen and tested without waiting for kick-off.
 *
 * Bounded: a price stays within ±10% of the feed's last price for that
 * selection, within 1.001–1000, and every nudged book keeps an overround of
 * at least 1 (no arbitrage for the customer). Markets carrying a trader's
 * manual price are left alone.
 */

export interface PrematchDriftOptions {
  /** Default 30 s. */
  intervalMs?: number;
  /** Events nudged per run (default 3). */
  eventsPerRun?: number;
  /** Markets nudged per event (default 2). */
  marketsPerEvent?: number;
  /** Relative step per selection, drawn uniformly from [minStep, maxStep] (default 1–3%). */
  minStep?: number;
  maxStep?: number;
  /** Largest distance from the feed's last price (default 0.1 = 10%). */
  maxDeviation?: number;
  /** Events of this feed provider are drifted (default 'mock'). */
  feedProvider?: string;
  /** Random source (tests pass a seeded one); default a fresh random seed per run. */
  rng?: Rng;
}

export const PREMATCH_DRIFT_INTERVAL_MS = 30_000;
/** odds_history.source of drifted prices. */
export const DRIFT_ODDS_SOURCE = 'drift';

export interface PrematchDriftSummary {
  /** Events whose odds changed. */
  events: string[];
  /** Selections repriced. */
  changed: number;
  published: number;
}

interface DriftBounds {
  minStep: number;
  maxStep: number;
  maxDeviation: number;
}

/**
 * New prices for one market's selections: each moves by ±[minStep, maxStep]
 * (rounded to a hundredth), clamped to ±maxDeviation around its base (feed)
 * price. If the book would fall below an overround of 1, every price is
 * scaled down until it does not; null when even that fails.
 */
export function driftMarketOdds(
  selections: ReadonlyArray<{ oddsMilli: number; baseOddsMilli: number }>,
  rng: Rng,
  bounds: DriftBounds,
): number[] | null {
  const proposed = selections.map(({ oddsMilli, baseOddsMilli }) => {
    const step = bounds.minStep + rng.next() * (bounds.maxStep - bounds.minStep);
    const factor = rng.next() < 0.5 ? 1 - step : 1 + step;
    const low = Math.max(MIN_ODDS_MILLI, Math.ceil(baseOddsMilli * (1 - bounds.maxDeviation)));
    const high = Math.min(MAX_ODDS_MILLI, Math.floor(baseOddsMilli * (1 + bounds.maxDeviation)));
    const moved = Math.round((oddsMilli * factor) / 10) * 10;
    return Math.min(high, Math.max(low, moved));
  });
  const overround = bookOverround(proposed);
  if (overround >= 1) return proposed;
  const scaled = proposed.map((odds) =>
    Math.max(MIN_ODDS_MILLI, Math.floor((odds * overround) / 10) * 10),
  );
  return bookOverround(scaled) >= 1 ? scaled : null;
}

/** Σ 1/odds of a book (float: a price check, never money). */
export function bookOverround(oddsMilli: readonly number[]): number {
  return oddsMilli.reduce((sum, odds) => sum + 1000 / odds, 0);
}

/** One drift run. */
export async function runPrematchDrift(
  ctx: TaskContext,
  options: PrematchDriftOptions = {},
): Promise<PrematchDriftSummary> {
  const rng = options.rng ?? createRng(randomInt(0, 2 ** 32));
  const bounds: DriftBounds = {
    minStep: options.minStep ?? 0.01,
    maxStep: options.maxStep ?? 0.03,
    maxDeviation: options.maxDeviation ?? 0.1,
  };
  if (!(bounds.minStep > 0 && bounds.minStep <= bounds.maxStep && bounds.maxStep < 1)) {
    throw new RangeError('prematch drift needs 0 < minStep <= maxStep < 1');
  }
  const ids = await listScheduledEventIds(ctx.db, {
    feedProvider: options.feedProvider ?? MOCK_PROVIDER_NAME,
    after: ctx.clock(),
    limit: 500,
  });
  const chosen = rng.shuffle(ids).slice(0, options.eventsPerRun ?? 3);
  const summary: PrematchDriftSummary = { events: [], changed: 0, published: 0 };

  for (const eventId of chosen) {
    try {
      const result = await ctx.db.transaction(async (tx) => {
        const event = await lockEvent(tx, eventId);
        if (event.status !== 'scheduled' || !event.bettingOpen) return null;
        const open = (await marketsWithSelections(tx, eventId)).filter(
          (market) =>
            market.status === 'open' &&
            market.selections.length >= 2 &&
            market.selections.every((selection) => selection.status === 'open'),
        );
        const picked = rng.shuffle(open).slice(0, options.marketsPerEvent ?? 2);
        const provenance = await oddsProvenance(
          tx,
          picked.flatMap((market) => market.selections.map((selection) => selection.id)),
        );
        const changes: OddsChange[] = [];
        for (const market of picked) {
          const manual = market.selections.some(
            (selection) => provenance.get(selection.id)?.latestSource === MANUAL_ODDS_SOURCE,
          );
          if (manual) continue;
          const next = driftMarketOdds(
            market.selections.map((selection) => ({
              oddsMilli: selection.oddsMilli,
              baseOddsMilli:
                provenance.get(selection.id)?.bySource.get(FEED_ODDS_SOURCE) ?? selection.oddsMilli,
            })),
            rng,
            bounds,
          );
          if (next === null) continue;
          market.selections.forEach((selection, index) => {
            const odds = next[index];
            if (odds !== undefined && odds !== selection.oddsMilli) {
              changes.push({
                selectionId: selection.id,
                oddsMilli: odds,
                source: DRIFT_ODDS_SOURCE,
              });
            }
          });
        }
        return setSelectionOdds(tx, changes);
      });
      if (result === null || result.changed.length === 0) continue;
      summary.events.push(eventId);
      summary.changed += result.changed.length;
      summary.published += await publishAfterCommit(
        ctx.redis,
        result.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      ctx.logger.error({ err: error, eventId }, 'prematch drift failed');
    }
  }
  ctx.logger.debug({ ...summary, events: summary.events.length }, 'prematch drift run');
  return summary;
}

export function prematchDriftTask(
  ctx: TaskContext,
  options: PrematchDriftOptions = {},
): IntervalTask {
  return intervalTask({
    name: 'prematch-drift',
    intervalMs: options.intervalMs ?? PREMATCH_DRIFT_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runPrematchDrift(ctx, options),
  });
}
