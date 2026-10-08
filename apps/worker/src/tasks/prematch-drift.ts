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
import { createRng, DEFAULT_MARGIN_BPS, MOCK_PROVIDER_NAME, type Rng } from '@vamos/feed';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { publishAfterCommit } from '../lib/publish';
import type { TaskContext } from './context';

/**
 * Demo prematch odds drift (FEED_PROVIDER=mock): every 30 seconds a few
 * random scheduled events get one or two of their open markets nudged by
 * ±1–3% per selection, so odds changes (bet slip "odds changed" prompts, SSE
 * deltas) can be seen and tested without waiting for kick-off.
 *
 * Bounded, so the drift never hands the customer an edge:
 * - a price rises at most 3% above the feed's last price for that selection
 *   (half the feed's 6% prematch margin) and never above a feed price of 1.01
 *   or less, whose margin may already be squeezed (see priceProbability in
 *   @vamos/feed). The feed prices every selection at or below 1 / (p × (1 +
 *   margin)), so a drifted price still pays less than the fair 1 / p: no
 *   selection has a positive expectation, and no combination of selections,
 *   within one market or across the event's markets (1X2 against double
 *   chance or draw no bet), is a sure win;
 * - it falls at most 10% below the feed's price, and stays within 1.001–1000;
 * - every nudged book keeps an overround of at least its fair sum: 1, or 2
 *   for double chance (each outcome is covered by two of its selections).
 * Markets carrying a trader's manual price, or with no feed price, are left alone.
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
  /** Largest move below the feed's last price (default 0.1 = 10%). */
  maxDeviation?: number;
  /**
   * Largest move above the feed's last price (default 0.03: half the feed's
   * prematch margin, so drifted prices keep a margin).
   */
  maxRise?: number;
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

/** The feed's price floor (oddsFromProbability): prices at or below it may carry no margin. */
const FLOOR_PRICE_MILLI = 1010;
/** Default largest rise above the feed price: half the feed's prematch margin. */
export const DEFAULT_MAX_RISE = DEFAULT_MARGIN_BPS / 2 / 10_000;

export interface DriftBounds {
  minStep: number;
  maxStep: number;
  /** Largest relative move below the base price. */
  maxDeviation: number;
  /** Largest relative move above the base price (none for a base of 1.01 or less). */
  maxRise: number;
}

/** The smallest fair overround of a market type: 2 for double chance, else 1. */
export function fairOverround(type: string): number {
  return type === 'dc' ? 2 : 1;
}

/**
 * The highest price a selection may drift to from its feed price `base`: at
 * most maxRise above it, and no rise at all from 1.01 or less.
 */
export function maxDriftedOdds(base: number, maxRise: number): number {
  if (base <= FLOOR_PRICE_MILLI) return base;
  return Math.min(MAX_ODDS_MILLI, Math.floor(base * (1 + maxRise)));
}

/**
 * New prices for one market's selections: each moves by ±[minStep, maxStep]
 * (rounded to a hundredth), clamped to [base × (1 − maxDeviation),
 * maxDriftedOdds(base)] around its base (feed) price. If the book would fall
 * below `minOverround` (see fairOverround), every price is scaled down until
 * it does not; null when even that fails.
 */
export function driftMarketOdds(
  selections: ReadonlyArray<{ oddsMilli: number; baseOddsMilli: number }>,
  rng: Rng,
  bounds: DriftBounds,
  minOverround = 1,
): number[] | null {
  const proposed = selections.map(({ oddsMilli, baseOddsMilli }) => {
    const step = bounds.minStep + rng.next() * (bounds.maxStep - bounds.minStep);
    const factor = rng.next() < 0.5 ? 1 - step : 1 + step;
    const low = Math.max(MIN_ODDS_MILLI, Math.ceil(baseOddsMilli * (1 - bounds.maxDeviation)));
    const high = Math.max(low, maxDriftedOdds(baseOddsMilli, bounds.maxRise));
    const moved = Math.round((oddsMilli * factor) / 10) * 10;
    return Math.min(high, Math.max(low, moved));
  });
  const overround = bookOverround(proposed);
  if (overround >= minOverround) return proposed;
  const scaled = proposed.map((odds) =>
    Math.max(MIN_ODDS_MILLI, Math.floor((odds * overround) / minOverround / 10) * 10),
  );
  return bookOverround(scaled) >= minOverround ? scaled : null;
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
    maxRise: options.maxRise ?? DEFAULT_MAX_RISE,
  };
  if (!(bounds.minStep > 0 && bounds.minStep <= bounds.maxStep && bounds.maxStep < 1)) {
    throw new RangeError('prematch drift needs 0 < minStep <= maxStep < 1');
  }
  if (!(bounds.maxDeviation >= 0 && bounds.maxDeviation < 1)) {
    throw new RangeError('prematch drift needs 0 <= maxDeviation < 1');
  }
  if (!(bounds.maxRise >= 0 && bounds.maxRise < DEFAULT_MARGIN_BPS / 10_000)) {
    throw new RangeError('prematch drift needs 0 <= maxRise < the feed margin');
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
          const book: Array<{ oddsMilli: number; baseOddsMilli: number }> = [];
          for (const selection of market.selections) {
            const feed = provenance.get(selection.id)?.bySource.get(FEED_ODDS_SOURCE);
            if (feed === undefined) break;
            book.push({ oddsMilli: selection.oddsMilli, baseOddsMilli: feed });
          }
          if (book.length !== market.selections.length) continue;
          const next = driftMarketOdds(book, rng, bounds, fairOverround(market.type));
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
        return setSelectionOdds(tx, changes, { now: ctx.clock() });
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
