import type { OpenBatchResult, OpenCheckResult, ReviewItemView } from '@vamos/contracts';
import { isRepriceItem } from '@vamos/contracts';
import { chunkBatch } from './feed-bulk';

/**
 * Pure helpers for the bulk "Open selected" of the review queue (plan A-4). The server decides
 * (tolerance, O1, O2, kickoff); the page only shows its read-only check and sends ids.
 */

/** Open odds_approval items that ask to open betting (a re-price is not one). */
export function isOpenCandidate(item: ReviewItemView): boolean {
  return item.kind === 'odds_approval' && item.status === 'open' && !isRepriceItem(item);
}

/** The ids to ask the server about, in chunks of the API's batch size. */
export function checkChunks(items: readonly ReviewItemView[]): string[][] {
  return chunkBatch(items.filter(isOpenCandidate).map((item) => item.id));
}

/** Items a checkbox may be ticked for: those the server found within tolerance. */
export function selectableIds(
  items: readonly ReviewItemView[],
  checks: ReadonlyMap<string, OpenCheckResult>,
): string[] {
  return items
    .filter((item) => isOpenCandidate(item) && checks.get(item.id)?.withinTolerance === true)
    .map((item) => item.id);
}

/** Keeps only ids that are still selectable (the list or the checks changed). */
export function pruneSelection(
  selected: ReadonlySet<string>,
  selectable: readonly string[],
): Set<string> {
  const allowed = new Set(selectable);
  return new Set([...selected].filter((id) => allowed.has(id)));
}

const REASONS: Record<string, string> = {
  no_consensus: 'no fresh bookmaker consensus',
  no_prices: 'no complete 1X2 prices',
  out_of_tolerance: 'a 1X2 price is out of tolerance',
  not_open_item: 'not an open betting request',
};

/** "within 3%", or why not; "checking" while the answer is not in yet. */
export function toleranceText(check: OpenCheckResult | undefined, toleranceBps: number): string {
  if (check === undefined) return 'checking';
  if (check.withinTolerance) return `within ${toleranceBps / 100}%`;
  return check.reason === null ? 'refused' : (REASONS[check.reason] ?? check.reason);
}

/** The widest deviation of an item's compared prices, as "+1.2%" (shorter) or "-0.8%"; null when none. */
export function worstDeviation(check: OpenCheckResult | undefined): string | null {
  if (check === undefined || check.selections.length === 0) return null;
  let worst = check.selections[0]!.deviation;
  for (const s of check.selections)
    if (Math.abs(s.deviation) > Math.abs(worst)) worst = s.deviation;
  const pct = (worst * 100).toFixed(1);
  return `${worst > 0 ? '+' : ''}${pct}%`;
}

/** "3 opened, 1 failed: reasons" with the first failure reasons. */
export function openSummary(results: readonly OpenBatchResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const opened = results.length - failed.length;
  const reasons = [...new Set(failed.map((r) => r.error?.message ?? 'failed'))].slice(0, 3);
  return failed.length === 0
    ? `${opened} opened.`
    : `${opened} opened, ${failed.length} failed: ${reasons.join('; ')}`;
}
