import { DAY_MS, MATCH_WINDOW_MS } from '../constants';
import type { FixtureDecision } from './fixture';
import { parseFixtureFeedRef } from './review';

/**
 * Rule F6c (docs/scraper.md 6.1): a `fixture_conflict` raised only because the sources disagreed
 * closes by itself once they agree again for CONFLICT_AGREED_PASSES consecutive promotion passes.
 * Pure building blocks; the runner (apps/scraper promote-fixtures) reads the open items, records
 * which subjects the pass raised and which it found agreeing, and applies `nextConflictStep`.
 *
 * - Only source disagreement closes this way: F6 `status_disagreement`, F2 `kickoff_disagreement`
 *   and F1/F4c `sources_disagree` (several clusters of one unknown fixture). Every other reason
 *   needs a person and is never closed here: F3 `feed_ref_exists` (an event already holds the
 *   ref), F3 `ambiguous_match` / `candidate_mismatch` (the catalogue), F1 `mixed_cluster` and
 *   F2 `invalid_observation` (mapping or parsing). An item holding any such reason stays open.
 * - The streak is the item's own payload field `agreedPasses`: raising the conflict again
 *   refreshes the item and replaces its payload (openReviewItem), so the streak restarts at 0.
 * - A pass agrees for a subject only when the gate decided a cluster of that fixture and the
 *   decision shows the sources agreeing (`sourcesAgree`). A pass that does not decide the
 *   fixture (no observation, deferred, failed, outside the window) breaks the streak: nothing is
 *   derived from missing data (F5).
 * - Closing the item is all it does: no event, price or betting state changes.
 */

/** Consecutive agreeing passes that close the item. */
export const CONFLICT_AGREED_PASSES = 2;

/** The resolution the scraper writes on an item it closes under F6c. */
export const CONFLICT_AGREED_RESOLUTION = `auto: sources agree again (${CONFLICT_AGREED_PASSES} passes)`;

/** The reasons of a `fixture_conflict` that are source disagreement and nothing else. */
export const AGREEABLE_CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'status_disagreement',
  'kickoff_disagreement',
  'sources_disagree',
]);

/**
 * The open item may close under F6c: its payload's `reasons` are a non-empty list of
 * AGREEABLE_CONFLICT_REASONS only. Anything else (no reasons, an unknown or person-only reason
 * such as `feed_ref_exists`) is false.
 */
export function conflictClosesOnAgreement(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const reasons = (payload as { reasons?: unknown }).reasons;
  return (
    Array.isArray(reasons) &&
    reasons.length > 0 &&
    reasons.every((r) => typeof r === 'string' && AGREEABLE_CONFLICT_REASONS.has(r))
  );
}

/** The streak stored on the item (a non-negative integer; anything else counts as 0). */
export function agreedPassesOf(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const n = (payload as { agreedPasses?: unknown }).agreedPasses;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * The gate found the sources of a cluster in agreement: it would create the fixture (F2, F7),
 * move a kickoff every source gives (F4a, F4b), the event's kickoff is what every source says
 * (`unchanged`), or the sources agree and only the switched-off policy stops the creation
 * (`policy_disabled`, reached in F2 after the status and kickoff checks). A hold of any kind,
 * and `none` for any other reason (outside the window, not scheduled, event closed, nothing
 * observed), is not agreement.
 */
export function sourcesAgree(decision: FixtureDecision): boolean {
  switch (decision.action) {
    case 'create':
    case 'update-kickoff':
      return true;
    case 'none':
      return decision.reason === 'unchanged' || decision.reason === 'policy_disabled';
    default:
      return false;
  }
}

/** One agreeing cluster of a pass: its pairing, kickoff range and the feed refs it was decided under. */
export interface FixtureAgreement {
  readonly competitionId: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly firstKickoff: Date;
  readonly lastKickoff: Date;
  /** The created or matched event's feed_ref (or the key the fixture would be created under). */
  readonly feedRefs: readonly string[];
}

/**
 * The agreeing cluster answers the conflict with this subject: the subject is one of its feed
 * refs, or a fixture key (`fx|...|day`) of the same directional pairing whose day lies within
 * MATCH_WINDOW_MS of the cluster's kickoffs. That is the codebase's "same fixture" (F3, and the
 * several-clusters grouping of F4c): a conflict raised under the earliest kickoff's day still
 * closes when the sources settle on a kickoff of another day.
 */
export function agreementCovers(agreement: FixtureAgreement, subjectKey: string): boolean {
  if (agreement.feedRefs.includes(subjectKey)) return true;
  const parsed = parseFixtureFeedRef(subjectKey);
  if (parsed === null) return false;
  const { pairing } = parsed;
  if (
    pairing.competitionId !== agreement.competitionId ||
    pairing.homeTeamId !== agreement.homeTeamId ||
    pairing.awayTeamId !== agreement.awayTeamId
  ) {
    return false;
  }
  const first = agreement.firstKickoff.getTime();
  const last = agreement.lastKickoff.getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  const dayStart = parsed.day.getTime();
  const dayEnd = dayStart + DAY_MS - 1;
  const gap = Math.max(0, dayStart - last, first - dayEnd);
  return gap <= MATCH_WINDOW_MS;
}

/**
 * What a pass does to one open `fixture_conflict` that was not raised again in the pass:
 * - `keep`: nothing to write (not an F6c item, or no agreement and no streak to reset);
 * - `count`: store `agreedPasses` (agreeing, below CONFLICT_AGREED_PASSES);
 * - `reset`: store 0 (the pass did not agree, so the passes are no longer consecutive);
 * - `close`: the agreeing pass that reaches CONFLICT_AGREED_PASSES.
 */
export type ConflictStep =
  | { readonly action: 'keep' }
  | { readonly action: 'count' | 'close'; readonly agreedPasses: number }
  | { readonly action: 'reset'; readonly agreedPasses: 0 };

export function nextConflictStep(payload: unknown, agreed: boolean): ConflictStep {
  if (!conflictClosesOnAgreement(payload)) return { action: 'keep' };
  const previous = agreedPassesOf(payload);
  if (!agreed) return previous > 0 ? { action: 'reset', agreedPasses: 0 } : { action: 'keep' };
  const agreedPasses = Math.min(previous + 1, CONFLICT_AGREED_PASSES);
  return { action: agreedPasses >= CONFLICT_AGREED_PASSES ? 'close' : 'count', agreedPasses };
}
