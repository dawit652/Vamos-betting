import { SHAPE_BASELINE_RUNS, SHAPE_MIN_BASELINE_RUNS, SHAPE_MIN_RATIO } from '../constants';
import type { ParseIssue, ParseStats } from '../types';
import { listOf } from './internal';
import { buildReviews, type GateReview } from './review';

/**
 * Rule S1 (docs/scraper.md 6.3): did a page parse the way it used to?
 *
 * The yield (`recordsAccepted`) is compared with the median of the source's
 * last SHAPE_BASELINE_RUNS successful runs for the same URL. Fail closed: a
 * fatal issue, malformed stats or a malformed baseline count as `broken`
 * (nothing is stored and `source_broken` opens), never as healthy.
 */

export type ShapeBrokenReason =
  'fatal_issue' | 'invalid_stats' | 'invalid_baseline' | 'zero_records' | 'low_yield';

export type ShapeCheck =
  | { readonly status: 'ok'; readonly accepted: number; readonly baseline: number }
  /** Fewer than SHAPE_MIN_BASELINE_RUNS successful runs: no baseline yet. */
  | { readonly status: 'learning'; readonly accepted: number; readonly runs: number }
  | {
      readonly status: 'broken';
      readonly reason: ShapeBrokenReason;
      readonly accepted: number | null;
      readonly baseline: number | null;
    };

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Median; the mean of the two middle values for an even count. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * S1 for one parsed page.
 *
 * @param recentAccepted `recordsAccepted` of the source's most recent
 *   SUCCESSFUL runs for the same URL, newest first; only the first
 *   SHAPE_BASELINE_RUNS entries are used.
 *
 * Broken when: any fatal issue (even while learning); accepted is zero while
 * the baseline is positive; accepted < SHAPE_MIN_RATIO × baseline (exactly the
 * ratio is healthy).
 */
export function checkShape(
  stats: ParseStats,
  issues: readonly ParseIssue[],
  recentAccepted: readonly number[],
): ShapeCheck {
  const accepted = stats?.recordsAccepted;
  const seen = stats?.recordsSeen;
  const acceptedOrNull = isCount(accepted) ? accepted : null;
  if (listOf(issues).some((issue) => issue?.fatal === true)) {
    return { status: 'broken', reason: 'fatal_issue', accepted: acceptedOrNull, baseline: null };
  }
  if (!isCount(accepted) || !isCount(seen) || accepted > seen) {
    return { status: 'broken', reason: 'invalid_stats', accepted: acceptedOrNull, baseline: null };
  }
  const window = listOf(recentAccepted).slice(0, SHAPE_BASELINE_RUNS);
  if (!window.every(isCount)) {
    return { status: 'broken', reason: 'invalid_baseline', accepted, baseline: null };
  }
  if (window.length < SHAPE_MIN_BASELINE_RUNS) {
    return { status: 'learning', accepted, runs: window.length };
  }
  const baseline = median(window);
  if (baseline > 0 && accepted === 0) {
    return { status: 'broken', reason: 'zero_records', accepted, baseline };
  }
  if (accepted < SHAPE_MIN_RATIO * baseline) {
    return { status: 'broken', reason: 'low_yield', accepted, baseline };
  }
  return { status: 'ok', accepted, baseline };
}

/** The `source_broken` item for a broken check (one open item per source). */
export function sourceBrokenReview(
  sourceId: string,
  url: string,
  check: Extract<ShapeCheck, { status: 'broken' }>,
  runId: string,
): GateReview<'source_broken'> {
  const [review] = buildReviews(
    `source|${sourceId}`,
    [{ kind: 'source_broken', rule: 'S1', reason: check.reason }],
    // runId, reason and recordsAccepted are what the back office reads (contract source_broken).
    () => ({
      sourceId,
      runId,
      url,
      reason: check.reason,
      recordsAccepted: check.accepted,
      accepted: check.accepted,
      baseline: check.baseline,
    }),
  );
  if (review === undefined) throw new Error('internal: source_broken review missing');
  return { ...review, kind: 'source_broken' };
}
