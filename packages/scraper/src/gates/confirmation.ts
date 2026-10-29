import { MIN_RESULT_CONFIRM_MS } from '../constants';
import type { Score } from '../types';

/**
 * Pure consensus helpers behind R2–R4 and F4: counting independent voices,
 * comparing scores and measuring stability. They know nothing about events or
 * policies; result.ts and fixture.ts combine them into decisions.
 */

/**
 * How upstreams are compared: trimmed and lower-cased, so 'Opta' and 'opta '
 * are the same producer and can never count as two votes.
 */
export function upstreamKey(upstream: string): string {
  return upstream.trim().toLowerCase();
}

/** A vote: which source said it and who produces that source's data. */
export interface ConsensusVoice {
  sourceId: string;
  upstream: string;
}

/**
 * Number of INDEPENDENT voices (R2, F4a). Two voices are one when they share a
 * source or an upstream, transitively (union-find): sources of one upstream
 * count once, a source counts once even if rows disagree about its upstream,
 * and a duplicated observation adds nothing.
 */
export function countIndependent(voices: readonly ConsensusVoice[]): number {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) {
      root = up;
    }
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const voice of voices) union(`s:${voice.sourceId}`, `u:${upstreamKey(voice.upstream)}`);
  return new Set(voices.map((voice) => find(`s:${voice.sourceId}`))).size;
}

/** The distinct normalised upstreams of some voices, sorted (for payloads). */
export function upstreamsOf(voices: readonly ConsensusVoice[]): string[] {
  return [...new Set(voices.map((voice) => upstreamKey(voice.upstream)))].sort();
}

/**
 * The R4 wait actually used: the configured value, raised to
 * MIN_RESULT_CONFIRM_MS when lower (never below). A negative or non-finite
 * value is a programmer error.
 */
export function effectiveConfirmMs(configuredMs: number): number {
  if (typeof configuredMs !== 'number' || !Number.isFinite(configuredMs) || configuredMs < 0) {
    throw new RangeError(`confirmation delay must be a finite number >= 0, got ${configuredMs}`);
  }
  return Math.max(configuredMs, MIN_RESULT_CONFIRM_MS);
}

/**
 * Since when an observation has held its current value. `changedAt` before
 * `firstSeenAt` is impossible, so the later of the two is used: a row can
 * never look older (more stable) than it is.
 */
export function stableSinceMs(o: { changedAt: Date; firstSeenAt: Date }): number {
  return Math.max(o.changedAt.getTime(), o.firstSeenAt.getTime());
}

/** R4: unchanged for at least `confirmMs` at `nowMs` (exactly confirmMs counts as stable). */
export function isStableFor(
  o: { changedAt: Date; firstSeenAt: Date },
  nowMs: number,
  confirmMs: number,
): boolean {
  return stableSinceMs(o) + confirmMs <= nowMs;
}

/** Full-time score as text ('2-1'). */
export function fullTimeKey(score: Score): string {
  return `${score.home}-${score.away}`;
}

/** Half-time score as text, or null when the source did not give one. */
export function halfTimeKey(score: Score): string | null {
  return score.htHome === null || score.htAway === null ? null : `${score.htHome}-${score.htAway}`;
}

/**
 * Whether an observed score contradicts a reference score for an event: a
 * different full time, or (only when the event needs it) a different
 * half time. A missing half time is silence, not a contradiction.
 */
export function scoreContradicts(
  reference: Score,
  observed: Score,
  needsHalfTime: boolean,
): boolean {
  if (fullTimeKey(reference) !== fullTimeKey(observed)) return true;
  if (!needsHalfTime) return false;
  const seen = halfTimeKey(observed);
  return seen !== null && seen !== halfTimeKey(reference);
}
