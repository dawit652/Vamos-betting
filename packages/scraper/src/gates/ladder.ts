import { KICKOFF_TOLERANCE_MS, MIN_MATCH_DURATION_MS } from '../constants';
import type { ExistingEvent, ResolvedObservation, ResultObservation, Score } from '../types';
import { fullTimeKey, halfTimeKey, stableSinceMs, upstreamKey } from './confirmation';
import { observationProblem, requireNow, samePairing } from './internal';

/**
 * The result ladder, rungs B to D (docs/plans/hulusport-parity-plan.md section 4.4; tasks 1.6
 * and 1.7), as a SHADOW decision: what the ladder WOULD do for an event that the result gate
 * (rules R1–R11, which are rung A) has not settled. Nothing here applies, voids or closes
 * anything, and nothing calls `resultEvent`: the caller records the decision so that four weeks
 * of shadow can show what each rung would have done before the owner decides D7 and D11.
 *
 * - **Rung B, majority** (from 30 minutes after the earliest end of the match): three or more
 *   independent upstreams have a final regular-time score and exactly one differs. Every
 *   upstream of the majority counts as a second source (trust at least 99.5% on 500 compared
 *   results), the dissenter is not a trusted source, and the majority's observations have stood
 *   for 2 hours. The dissenter is named: it loses trust.
 * - **Rung C, one trusted source** (from 6 hours after): exactly one upstream has a final score,
 *   it is trusted (99.8% on 500 compared results), its score has stood for 6 hours, its goal
 *   events add up to it wherever it has events, and no source says otherwise.
 * - **Rung D, the 48-hour rule** (48 hours after the scheduled kickoff): nothing above holds, so
 *   the match would be void. `strict` says whether the case meets the conservative text of D7
 *   (two upstreams report the match not played, or one does and no upstream has a final score,
 *   and the report has stood for 6 hours); the other cases (no result at all, a split, a lone
 *   unverified score) are reported with `strict: false` for the owner to judge.
 *
 * Fail closed throughout: a report of a postponed, cancelled or abandoned match, an observation
 * whose kickoff is not the event's, or an upstream that contradicts itself blocks rungs B and C;
 * an invalid observation stops the ladder. Only regular-time scores vote; a score of another
 * basis is silence (the cup rules R-3 and R-3b are separate). When the event needs the half-time
 * score, a vote must carry it.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Rung B is looked at this long after the earliest end of the match. */
export const LADDER_MAJORITY_AFTER_MS = 30 * MINUTE_MS;
/** The majority's observations must have been unchanged this long. */
export const LADDER_MAJORITY_STAND_MS = 2 * HOUR_MS;
/** Rung C is looked at this long after the earliest end of the match. */
export const LADDER_SINGLE_AFTER_MS = 6 * HOUR_MS;
/** The lone trusted score must have been unchanged this long. */
export const LADDER_SINGLE_STAND_MS = 6 * HOUR_MS;
/** Rung D: this long after the scheduled kickoff. */
export const LADDER_VOID_AFTER_KICKOFF_MS = 48 * HOUR_MS;
/** Rung D, strict: the not-played report must have been unchanged this long. */
export const LADDER_VOID_REPORT_STAND_MS = 6 * HOUR_MS;

/** Trust is measured, not declared: at least this many compared final scores. */
export const TRUST_MIN_COMPARED = 500;
/** Agreement rate from which an upstream counts as a second source. */
export const TRUST_SECOND_SOURCE_RATE = 0.995;
/** Agreement rate from which an upstream may decide alone (rung C). */
export const TRUST_SINGLE_SOURCE_RATE = 0.998;

/** What the nightly audit measured for one upstream and sport (`sources truth-check`). */
export interface SourceTrustStats {
  /** Final scores compared with settled results. */
  readonly compared: number;
  /** Of those, how many matched. */
  readonly agreed: number;
}

export type TrustLevel = 'untrusted' | 'second_source' | 'trusted';

/** The trust level of measured stats: nothing counts below TRUST_MIN_COMPARED comparisons. */
export function trustLevel(stats: SourceTrustStats | undefined): TrustLevel {
  if (stats === undefined) return 'untrusted';
  const { compared, agreed } = stats;
  if (
    !Number.isSafeInteger(compared) ||
    !Number.isSafeInteger(agreed) ||
    compared < TRUST_MIN_COMPARED ||
    agreed < 0 ||
    agreed > compared
  ) {
    return 'untrusted';
  }
  const rate = agreed / compared;
  if (rate >= TRUST_SINGLE_SOURCE_RATE) return 'trusted';
  return rate >= TRUST_SECOND_SOURCE_RATE ? 'second_source' : 'untrusted';
}

export interface LadderInput {
  readonly event: ExistingEvent;
  /** The current result observations of the event's fixture, from all enabled sources. */
  readonly observations: readonly ResolvedObservation<ResultObservation>[];
  /** Measured trust per upstream (by `upstreamKey`) for the event's sport; missing is untrusted. */
  readonly trust: ReadonlyMap<string, SourceTrustStats>;
  /** Per source id: whether its goal events add up to its score (goalsAddUp); absent: no events. */
  readonly goalsAddUp?: ReadonlyMap<string, boolean>;
  readonly now: Date;
}

export type LadderVoidReason =
  /** Upstreams report the match postponed, cancelled or abandoned. */
  | 'not_played'
  /** One upstream reports it not played and another has a final score. */
  | 'status_conflict'
  /** No upstream has a final score or a report. */
  | 'no_result'
  /** Upstreams disagree on the score and no majority holds. */
  | 'split'
  /** One upstream has a score but cannot decide alone. */
  | 'unverified';

export type LadderWaitReason =
  | 'match_not_over'
  | 'majority_not_due'
  | 'majority_standing'
  | 'single_not_due'
  | 'single_standing'
  | 'void_not_due'
  | 'void_report_standing';

export type LadderDecision =
  | {
      readonly action: 'apply';
      readonly rung: 'B' | 'C';
      readonly score: Score;
      /** The upstreams whose score applies (sorted). */
      readonly upstreams: readonly string[];
      /** The upstream that differed (rung B), which loses trust; empty for rung C. */
      readonly dissent: readonly string[];
    }
  | {
      readonly action: 'void';
      readonly rung: 'D';
      readonly reason: LadderVoidReason;
      /** Meets the conservative text of D7 (see the module comment). */
      readonly strict: boolean;
      /** The upstreams that reported the match not played (sorted). */
      readonly notPlayed: readonly string[];
    }
  | { readonly action: 'wait'; readonly until: Date; readonly reason: LadderWaitReason }
  | {
      readonly action: 'none';
      /** `agreement`: two or more upstreams agree with no dissent; rung A (the gate) decides. */
      readonly reason: 'already_resulted' | 'not_eligible' | 'invalid_observation' | 'agreement';
    };

const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);
const SETTLED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  'finished',
  'cancelled',
  'abandoned',
  'postponed',
]);

type ResultObs = ResolvedObservation<ResultObservation>;

/** What one upstream says, all its sources taken together. */
type Verdict =
  | { kind: 'score'; score: Score; key: string; stableSinceMs: number; sources: string[] }
  | { kind: 'not_played'; stableSinceMs: number }
  /** A kickoff that is not the event's, or sources of one upstream that disagree. */
  | { kind: 'blocker' }
  /** Only scores of another basis, or a vote without the half time the event needs. */
  | { kind: 'silent' };

/** Decides what rungs B to D would do for one event. Pure; throws only for a bad `now`. */
export function decideLadder(input: LadderInput): LadderDecision {
  const nowMs = requireNow(input.now);
  const { event } = input;
  const resulted =
    event.resultedAt !== null || event.score !== null || SETTLED_EVENT_STATUSES.has(event.status);
  if (resulted) return { action: 'none', reason: 'already_resulted' };
  if (event.status !== 'scheduled') return { action: 'none', reason: 'not_eligible' };

  const mine = input.observations.filter((o) => samePairing(o?.names, event));
  if (mine.some((o) => observationProblem(o, 'result') !== null)) {
    return { action: 'none', reason: 'invalid_observation' };
  }

  const startMs = event.startTime.getTime();
  const earliestEndMs = startMs + MIN_MATCH_DURATION_MS;
  if (nowMs < earliestEndMs) {
    return { action: 'wait', until: new Date(earliestEndMs), reason: 'match_not_over' };
  }

  const verdicts = verdictsByUpstream(mine, event);
  const scored = [...verdicts.entries()].flatMap(([upstream, v]) =>
    v.kind === 'score' ? [{ upstream, ...v }] : [],
  );
  const notPlayed = [...verdicts.entries()].flatMap(([upstream, v]) =>
    v.kind === 'not_played' ? [{ upstream, stableSinceMs: v.stableSinceMs }] : [],
  );
  const blocked = [...verdicts.values()].some((v) => v.kind === 'blocker');
  const level = (upstream: string) => trustLevel(input.trust.get(upstream));

  // Group the scores; two or more upstreams agreeing with no dissent is rung A's case.
  const groups = new Map<string, typeof scored>();
  for (const s of scored) groups.set(s.key, [...(groups.get(s.key) ?? []), s]);
  if (!blocked && notPlayed.length === 0 && groups.size === 1 && scored.length >= 2) {
    return { action: 'none', reason: 'agreement' };
  }

  const pending: Array<{ until: number; reason: LadderWaitReason }> = [];
  const clean = !blocked && notPlayed.length === 0;

  // Rung B: a majority with exactly one dissenter.
  if (clean && scored.length >= 3 && groups.size === 2) {
    const [a, b] = [...groups.values()] as [typeof scored, typeof scored];
    const [majority, minority] = a.length > b.length ? [a, b] : [b, a];
    const dissenter = minority[0];
    if (
      minority.length === 1 &&
      dissenter !== undefined &&
      majority.every((s) => level(s.upstream) !== 'untrusted') &&
      level(dissenter.upstream) !== 'trusted'
    ) {
      const dueMs = earliestEndMs + LADDER_MAJORITY_AFTER_MS;
      const stoodMs = Math.max(...majority.map((s) => s.stableSinceMs)) + LADDER_MAJORITY_STAND_MS;
      const readyMs = Math.max(dueMs, stoodMs);
      if (nowMs >= readyMs) {
        return {
          action: 'apply',
          rung: 'B',
          score: (majority[0] as (typeof scored)[number]).score,
          upstreams: majority.map((s) => s.upstream).sort(),
          dissent: [dissenter.upstream],
        };
      }
      // The reason names the constraint that ends last.
      pending.push({
        until: readyMs,
        reason: stoodMs > dueMs ? 'majority_standing' : 'majority_not_due',
      });
    }
  }

  // Rung C: one trusted upstream alone.
  const only = scored[0];
  if (clean && scored.length === 1 && only !== undefined && level(only.upstream) === 'trusted') {
    const eventsAddUp = only.sources.every((id) => input.goalsAddUp?.get(id) !== false);
    if (eventsAddUp) {
      const dueMs = earliestEndMs + LADDER_SINGLE_AFTER_MS;
      const stoodMs = only.stableSinceMs + LADDER_SINGLE_STAND_MS;
      const readyMs = Math.max(dueMs, stoodMs);
      if (nowMs >= readyMs) {
        return {
          action: 'apply',
          rung: 'C',
          score: only.score,
          upstreams: [only.upstream],
          dissent: [],
        };
      }
      pending.push({
        until: readyMs,
        reason: stoodMs > dueMs ? 'single_standing' : 'single_not_due',
      });
    }
  }

  // Rung D: the 48-hour rule.
  const voidDueMs = startMs + LADDER_VOID_AFTER_KICKOFF_MS;
  if (nowMs < voidDueMs) {
    pending.push({ until: voidDueMs, reason: 'void_not_due' });
    const next = pending.reduce((a, b) => (b.until < a.until ? b : a));
    return { action: 'wait', until: new Date(next.until), reason: next.reason };
  }
  // A rung B or C still standing comes first: the 48 hours do not cut a result short.
  const standing = pending.filter(
    (p) => p.reason === 'majority_standing' || p.reason === 'single_standing',
  );
  if (standing.length > 0) {
    const next = standing.reduce((a, b) => (b.until < a.until ? b : a));
    return { action: 'wait', until: new Date(next.until), reason: next.reason };
  }

  const notPlayedUpstreams = notPlayed.map((n) => n.upstream).sort();
  const reportStoodMs =
    notPlayed.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...notPlayed.map((n) => n.stableSinceMs)) + LADDER_VOID_REPORT_STAND_MS;
  const strictShape = notPlayed.length >= 2 || (notPlayed.length === 1 && scored.length === 0);
  if (strictShape && !blocked && nowMs < reportStoodMs) {
    return { action: 'wait', until: new Date(reportStoodMs), reason: 'void_report_standing' };
  }
  let reason: LadderVoidReason;
  if (notPlayed.length > 0) reason = scored.length > 0 ? 'status_conflict' : 'not_played';
  else if (scored.length === 0) reason = 'no_result';
  else if (groups.size > 1) reason = 'split';
  else reason = 'unverified';
  return {
    action: 'void',
    rung: 'D',
    reason,
    strict: strictShape && !blocked && scored.length === 0 && nowMs >= reportStoodMs,
    notPlayed: notPlayedUpstreams,
  };
}

/** What each upstream says (keyed by `upstreamKey`), fail closed. */
function verdictsByUpstream(
  observations: readonly ResultObs[],
  event: ExistingEvent,
): Map<string, Verdict> {
  const startMs = event.startTime.getTime();
  const byUpstream = new Map<string, ResultObs[]>();
  for (const o of observations) {
    const key = upstreamKey(o.upstream);
    byUpstream.set(key, [...(byUpstream.get(key) ?? []), o]);
  }
  const verdicts = new Map<string, Verdict>();
  for (const [upstream, list] of byUpstream) {
    if (list.some((o) => Math.abs(o.obs.kickoff.getTime() - startMs) > KICKOFF_TOLERANCE_MS)) {
      verdicts.set(upstream, { kind: 'blocker' });
      continue;
    }
    const voids = list.filter((o) => VOID_STATUSES.has(o.obs.status));
    const regular = list.filter(
      (o) =>
        o.obs.status === 'finished' && o.obs.scoreBasis === 'regular_time' && o.obs.score !== null,
    );
    if (voids.length > 0 && regular.length > 0) {
      verdicts.set(upstream, { kind: 'blocker' });
      continue;
    }
    if (voids.length > 0) {
      verdicts.set(upstream, {
        kind: 'not_played',
        stableSinceMs: Math.max(...voids.map(stableSinceMs)),
      });
      continue;
    }
    if (regular.length === 0) {
      verdicts.set(upstream, { kind: 'silent' });
      continue;
    }
    const keys = new Set(
      regular.map((o) => voteKey(o.obs.score as Score, event.needsHalfTimeScore)),
    );
    if (keys.size !== 1) {
      verdicts.set(upstream, { kind: 'blocker' });
      continue;
    }
    const score = regular[0]?.obs.score as Score;
    const key = [...keys][0] as string;
    if (event.needsHalfTimeScore && halfTimeKey(score) === null) {
      verdicts.set(upstream, { kind: 'silent' });
      continue;
    }
    verdicts.set(upstream, {
      kind: 'score',
      score,
      key,
      stableSinceMs: Math.max(...regular.map(stableSinceMs)),
      sources: [...new Set(regular.map((o) => o.obs.sourceId))].sort(),
    });
  }
  return verdicts;
}

/** The score a vote is for: the full time, and the half time when the event needs it. */
function voteKey(score: Score, needsHalfTime: boolean): string {
  const full = fullTimeKey(score);
  return needsHalfTime ? `${full}|${halfTimeKey(score) ?? '?'}` : full;
}
