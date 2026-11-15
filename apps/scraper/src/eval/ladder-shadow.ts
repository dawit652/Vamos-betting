import type { LadderShadowEntry } from '@vamos/db';

/** What happened to the event a shadow decision was about. */
export type ShadowOutcome = 'match' | 'mismatch' | 'played' | 'void' | 'event_voided' | 'pending';

const VOID_EVENT_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);

/**
 * An 'apply' decision against the event's applied score: match (full time, and half time when both
 * have one), mismatch, event_voided (the event was cancelled, abandoned or postponed instead) or
 * pending (not resulted yet). A 'void' decision: played (the event got a final result), void (it was
 * cancelled, abandoned or postponed) or pending.
 */
export function shadowOutcome(entry: LadderShadowEntry): ShadowOutcome {
  const { event } = entry;
  if (entry.action === 'void') {
    if (event.status === 'finished') return 'played';
    return VOID_EVENT_STATUSES.has(event.status) ? 'void' : 'pending';
  }
  if (VOID_EVENT_STATUSES.has(event.status)) return 'event_voided';
  if (event.status !== 'finished' || event.score === null || entry.score === null) return 'pending';
  const full = event.score.home === entry.score.home && event.score.away === entry.score.away;
  const half =
    event.score.htHome === null ||
    event.score.htAway === null ||
    entry.score.htHome === null ||
    entry.score.htAway === null ||
    (event.score.htHome === entry.score.htHome && event.score.htAway === entry.score.htAway);
  return full && half ? 'match' : 'mismatch';
}

const AGREED_OUTCOMES: ReadonlySet<ShadowOutcome> = new Set(['match', 'void']);
const DISAGREED_OUTCOMES: ReadonlySet<ShadowOutcome> = new Set([
  'mismatch',
  'played',
  'event_voided',
]);

/** The summary label of a decision: the rung, the action and the reason ('strict' for a D7 void). */
export const shadowLabel = (e: LadderShadowEntry): string =>
  e.action === 'apply'
    ? `${e.rung} apply`
    : `${e.rung} void ${e.reason ?? '-'}${e.strict === true ? ' (strict)' : ''}`;

export interface ShadowSummaryRow {
  label: string;
  decisions: number;
  agreed: number;
  disagreed: number;
  pending: number;
}

/** Decisions, agreed, disagreed and pending per label (rung, action and reason), by label. */
export function summariseShadow(
  decisions: readonly { label: string; outcome: ShadowOutcome }[],
): ShadowSummaryRow[] {
  const groups = new Map<string, Omit<ShadowSummaryRow, 'label'>>();
  for (const d of decisions) {
    const g = groups.get(d.label) ?? { decisions: 0, agreed: 0, disagreed: 0, pending: 0 };
    g.decisions += 1;
    if (AGREED_OUTCOMES.has(d.outcome)) g.agreed += 1;
    else if (DISAGREED_OUTCOMES.has(d.outcome)) g.disagreed += 1;
    else g.pending += 1;
    groups.set(d.label, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, g]) => ({ label, ...g }));
}
