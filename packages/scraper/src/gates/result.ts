import type { ScrapeReviewKind } from '@vamos/core';
import {
  KICKOFF_TOLERANCE_MS,
  MIN_INDEPENDENT_SOURCES,
  MIN_MATCH_DURATION_MS,
  UNVERIFIED_AFTER_MS,
} from '../constants';
import type {
  CompetitionPolicy,
  ExistingEvent,
  ResolvedObservation,
  ResultObservation,
  Score,
} from '../types';
import {
  contradicts,
  countIndependent,
  effectiveConfirmMs,
  fullTimeKey,
  halfTimeKey,
  stableSinceMs,
  upstreamsOf,
} from './confirmation';
import {
  canonicalEntries,
  eventProblem,
  iso,
  listOf,
  observationProblem,
  observationSummary,
  requireNow,
  samePairing,
  sortedUnique,
} from './internal';
import {
  type GateFinding,
  type GateHold,
  type GateJson,
  type GatePayload,
  holdFrom,
} from './review';

/**
 * Result rules R1–R11 (docs/scraper.md 6.2): whether the result observations
 * of one fixture may settle its event.
 *
 * Fail closed by construction:
 * - the only status a decision can carry is 'finished' (ResultApply.status);
 *   there is no cancel, void or abandon action, so R7 can only ever become a
 *   `cancellation_proposed` item, and a correction (R8) only `result_correction`;
 * - an invalid event row or observation is a `result_conflict` hold, never an
 *   exception and never ignored;
 * - observations about another pairing are ignored (they are not this fixture,
 *   so they can neither vote nor dissent), everything else of the pairing counts;
 * - missing data (no observation, a source that has not caught up) is silence:
 *   it can delay a result, never produce one.
 *
 * Readings chosen where the spec leaves room (each the safer one):
 * - dissent (R3) is judged over EVERY finished observation whatever its basis;
 *   a half-time difference is dissent only when the event needs half time;
 * - R4 waits until EVERY observation of the fixture (not only the agreeing
 *   ones) has been unchanged for the delay;
 * - a non-regular-time score (R10) also turns automatic application into a
 *   `result_ready` confirmation for a person;
 * - an observation whose kickoff differs from the event's start by more than
 *   KICKOFF_TOLERANCE_MS blocks the result (pending reschedule, wrong match);
 * - R8 also flags a void status observed after a finished result.
 */

/** R9: the event's exposure, copied into review items that ask for a result decision. */
export interface ResultExposure {
  readonly openBets: number;
  /** Total stake of the open bets, santim. */
  readonly totalStake: bigint;
}

export interface ResultGateInput {
  /** The scraped event the fixture matched (rule F3). */
  readonly event: ExistingEvent;
  /** The current result observations of the fixture, from all enabled sources. */
  readonly observations: readonly ResolvedObservation<ResultObservation>[];
  /** Policy of the event's competition (a policy of another competition is a programmer error). */
  readonly policy: CompetitionPolicy;
  readonly now: Date;
  /** Configured R4 wait (DEFAULT_RESULT_CONFIRM_MS unless configured); raised to MIN_RESULT_CONFIRM_MS. */
  readonly confirmMs: number;
  /** null when unknown; the items then carry `exposure: null`. */
  readonly exposure: ResultExposure | null;
}

/** Settle the event as finished with this score (resultEvent). */
export interface ResultApply {
  readonly action: 'apply';
  readonly eventId: string;
  readonly feedRef: string;
  /** The only status the gates can apply. */
  readonly status: 'finished';
  readonly score: Score;
  /** The independent upstreams that agreed (normalised, sorted). */
  readonly upstreams: readonly string[];
  /** The sources whose observations voted (sorted). */
  readonly sources: readonly string[];
  /** The R4 wait that was satisfied. */
  readonly confirmMs: number;
}

export type ResultWaitReason =
  /** R1: kickoff + MIN_MATCH_DURATION_MS not reached. */
  | 'match_not_over'
  /** R4: an observation changed within the confirmation delay. */
  | 'not_stable'
  /** R6: one upstream so far; a person is asked once UNVERIFIED_AFTER_MS has passed. */
  | 'single_source'
  /** The event needs the half-time score and no source gave one with a final score. */
  | 'half_time_missing';

/** Nothing to do yet; decide again at `until` (or on the next scheduled pass). */
export interface ResultWait {
  readonly action: 'wait';
  readonly until: Date;
  readonly reason: ResultWaitReason;
}

export interface ResultNone {
  readonly action: 'none';
  readonly reason: 'no_observations' | 'already_resulted' | 'not_eligible';
}

export type ResultDecision = ResultApply | GateHold | ResultWait | ResultNone;

const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);
const SETTLED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  'finished',
  'cancelled',
  'abandoned',
  'postponed',
]);
/** Items that ask a person for a result decision carry the exposure (R9). */
const EXPOSURE_KINDS: ReadonlySet<ScrapeReviewKind> = new Set([
  'result_ready',
  'result_unverified',
  'result_conflict',
  'result_correction',
  'cancellation_proposed',
]);

type ResultObs = ResolvedObservation<ResultObservation>;

/** Decides R1–R11 for one event. Pure; throws only for programmer errors (bad `now`, `confirmMs`, policy). */
export function decideResult(input: ResultGateInput): ResultDecision {
  const nowMs = requireNow(input.now);
  const confirmMs = effectiveConfirmMs(input.confirmMs);
  const { event, policy } = input;
  const subjectKey = eventSubjectKey(event);
  const exposure = exposureJson(input.exposure);
  const hold = (
    findings: GateFinding[],
    observations: readonly ResultObs[],
    extra: GatePayload = {},
  ) =>
    holdFrom(subjectKey, findings, (kind) => ({
      eventId: typeof event?.eventId === 'string' ? event.eventId : null,
      feedRef: typeof event?.feedRef === 'string' ? event.feedRef : null,
      ...(EXPOSURE_KINDS.has(kind) ? { exposure } : {}),
      observations: canonicalEntries(observations.map(observationSummary)),
      ...extra,
    }));

  const badEvent = eventProblem(event);
  if (badEvent !== null) {
    return hold(
      [{ kind: 'result_conflict', rule: 'R1', reason: 'invalid_event', detail: badEvent }],
      [],
    );
  }
  if (policy?.competitionId !== event.competitionId) {
    throw new RangeError(
      `policy of competition ${String(policy?.competitionId)} given for an event of ${event.competitionId}`,
    );
  }

  const mine = listOf(input.observations).filter((o) => samePairing(o?.names, event));
  const resulted =
    event.resultedAt !== null || event.score !== null || SETTLED_EVENT_STATUSES.has(event.status);
  if (mine.length === 0)
    return { action: 'none', reason: resulted ? 'already_resulted' : 'no_observations' };

  const invalid = mine.flatMap((o) => {
    const problem = observationProblem(o, 'result');
    return problem === null ? [] : [{ problem, observation: observationSummary(o) }];
  });
  if (invalid.length > 0) {
    return hold(
      [
        {
          kind: 'result_conflict',
          rule: 'R2',
          reason: 'invalid_observation',
          detail: canonicalEntries(invalid),
        },
      ],
      mine,
    );
  }

  if (resulted) return decideCorrection(event, mine, hold);
  // R1: scraped events never go live; anything but 'scheduled' is not ours to result.
  if (event.status !== 'scheduled') return { action: 'none', reason: 'not_eligible' };

  const startMs = event.startTime.getTime();
  const needsHalfTime = event.needsHalfTimeScore;
  const findings: GateFinding[] = [];
  const voids = mine.filter((o) => VOID_STATUSES.has(o.obs.status));
  const finished = mine.filter((o) => o.obs.status === 'finished');
  const nonRegular = finished.filter((o) => o.obs.scoreBasis !== 'regular_time');
  const mismatched = mine.filter(
    (o) => Math.abs(o.obs.kickoff.getTime() - startMs) > KICKOFF_TOLERANCE_MS,
  );
  const basisFinding = (): void => {
    if (nonRegular.length === 0) return;
    findings.push({
      kind: 'score_basis_unknown',
      rule: 'R10',
      reason: 'score_basis_not_regular_time',
      detail: sortedUnique(nonRegular.map((o) => `${o.obs.sourceId}:${o.obs.scoreBasis}`)),
    });
  };
  const kickoffFinding = (): void => {
    if (mismatched.length === 0) return;
    findings.push({
      kind: 'result_conflict',
      rule: 'R1',
      reason: 'kickoff_mismatch',
      detail: {
        eventStart: iso(startMs),
        sources: sortedUnique(mismatched.map((o) => o.obs.sourceId)),
      },
    });
  };

  // R7 (and R3): a void status is never applied; it is raised at once, even
  // before the match could have ended, because it is time-critical for traders.
  if (voids.length > 0) {
    findings.push({
      kind: 'cancellation_proposed',
      rule: 'R7',
      reason: 'void_status_reported',
      detail: sortedUnique(voids.map((o) => `${o.obs.sourceId}:${o.obs.status}`)),
    });
    if (finished.length > 0) {
      findings.push({ kind: 'result_conflict', rule: 'R3', reason: 'status_disagreement' });
    }
    kickoffFinding();
    basisFinding();
    return hold(findings, mine);
  }

  // R1: no result before the earliest possible end of the match.
  const earliestEndMs = startMs + MIN_MATCH_DURATION_MS;
  if (nowMs < earliestEndMs) {
    return { action: 'wait', until: new Date(earliestEndMs), reason: 'match_not_over' };
  }

  // R3: every finished observation (any basis) must show the same score.
  kickoffFinding();
  const fullTimes = sortedUnique(finished.map((o) => fullTimeKey(o.obs.score as Score)));
  if (fullTimes.length > 1) {
    findings.push({
      kind: 'result_conflict',
      rule: 'R3',
      reason: 'score_disagreement',
      detail: fullTimes,
    });
  }
  if (needsHalfTime) {
    const halfTimes = sortedUnique(
      finished.flatMap((o) => {
        const ht = halfTimeKey(o.obs.score as Score);
        return ht === null ? [] : [ht];
      }),
    );
    if (halfTimes.length > 1) {
      findings.push({
        kind: 'result_conflict',
        rule: 'R3',
        reason: 'half_time_disagreement',
        detail: halfTimes,
      });
    }
  }
  basisFinding();
  if (findings.some((f) => f.kind === 'result_conflict')) return hold(findings, mine);

  // R2: votes come only from finished, regular-time scores (with half time when needed).
  const regular = finished.filter((o) => o.obs.scoreBasis === 'regular_time');
  const voters = regular.filter(
    (o) => !needsHalfTime || halfTimeKey(o.obs.score as Score) !== null,
  );
  const voices = voters.map((o) => ({ sourceId: o.obs.sourceId, upstream: o.upstream }));
  const independent = countIndependent(voices);
  const agreed = agreedScore(voters);

  if (independent >= MIN_INDEPENDENT_SOURCES && agreed !== null) {
    // R4: every observation of the fixture unchanged for the delay.
    const latestChangeMs = Math.max(...mine.map(stableSinceMs));
    if (latestChangeMs + confirmMs > nowMs) {
      if (findings.length > 0) return hold(findings, mine);
      return { action: 'wait', until: new Date(latestChangeMs + confirmMs), reason: 'not_stable' };
    }
    const upstreams = upstreamsOf(voices);
    const sources = sortedUnique(voters.map((o) => o.obs.sourceId));
    // R5: automatic only with auto_results and no basis doubt (R10).
    if (policy.autoResults === true && findings.length === 0) {
      return {
        action: 'apply',
        eventId: event.eventId,
        feedRef: event.feedRef,
        status: 'finished',
        score: agreed,
        upstreams,
        sources,
        confirmMs,
      };
    }
    findings.push({ kind: 'result_ready', rule: 'R5', reason: 'confirmed_by_sources' });
    return hold(findings, mine, { score: scoreJson(agreed), upstreams, sources, confirmMs });
  }

  if (regular.length > 0) {
    // R6: one upstream (or no usable half time) after the waiting time goes to a person.
    const unverifiedAtMs = earliestEndMs + UNVERIFIED_AFTER_MS;
    const reason: ResultWaitReason = voters.length > 0 ? 'single_source' : 'half_time_missing';
    if (nowMs >= unverifiedAtMs) {
      findings.push({ kind: 'result_unverified', rule: 'R6', reason });
      const candidate = agreedScore(voters) ?? agreedScore(regular);
      return hold(findings, mine, {
        score: candidate === null ? null : scoreJson(candidate),
        upstreams: upstreamsOf(
          regular.map((o) => ({ sourceId: o.obs.sourceId, upstream: o.upstream })),
        ),
      });
    }
    if (findings.length > 0) return hold(findings, mine);
    return { action: 'wait', until: new Date(unverifiedAtMs), reason };
  }

  // Only scores of another basis remain: they never vote (R10), a person looks.
  if (findings.length === 0) {
    findings.push({ kind: 'score_basis_unknown', rule: 'R10', reason: 'no_regular_time_score' });
  }
  return hold(findings, mine);
}

/** R8 / R11 for an event that already has a result: flag differences, never apply. */
function decideCorrection(
  event: ExistingEvent,
  mine: readonly ResultObs[],
  hold: (
    findings: GateFinding[],
    observations: readonly ResultObs[],
    extra?: GatePayload,
  ) => GateHold,
): ResultDecision {
  const applied = event.score;
  const differing = mine.filter((o) => {
    if (o.obs.status === 'finished') {
      return (
        applied === null || contradicts(applied, o.obs.score as Score, event.needsHalfTimeScore)
      );
    }
    // A void status after a finished result would reverse payouts too.
    return applied !== null || event.status === 'finished';
  });
  if (differing.length === 0) return { action: 'none', reason: 'already_resulted' };
  return hold(
    [{ kind: 'result_correction', rule: 'R8', reason: 'differs_from_applied_result' }],
    mine,
    {
      appliedStatus: event.status,
      appliedScore: applied === null ? null : scoreJson(applied),
      resultedAt: event.resultedAt === null ? null : iso(event.resultedAt.getTime()),
      differing: canonicalEntries(differing.map(observationSummary)),
    },
  );
}

/**
 * The score to apply: the voters' full time (identical once dissent is ruled
 * out) and their half time when they all give the same one (always the case
 * when the event needs it), else no half time.
 */
function agreedScore(voters: readonly ResultObs[]): Score | null {
  const first = voters[0]?.obs.score;
  if (first === undefined || first === null) return null;
  const fullTimes = new Set(voters.map((o) => fullTimeKey(o.obs.score as Score)));
  if (fullTimes.size !== 1) return null;
  const halfTimes = new Set(voters.map((o) => halfTimeKey(o.obs.score as Score)));
  const sameHalfTime = halfTimes.size === 1 && first.htHome !== null;
  return {
    home: first.home,
    away: first.away,
    htHome: sameHalfTime ? first.htHome : null,
    htAway: sameHalfTime ? first.htAway : null,
  };
}

function eventSubjectKey(event: ExistingEvent): string {
  if (typeof event?.feedRef === 'string' && event.feedRef.trim().length > 0) return event.feedRef;
  return `event|${String(event?.eventId)}`;
}

function scoreJson(score: Score): GateJson {
  return { home: score.home, away: score.away, htHome: score.htHome, htAway: score.htAway };
}

/** Exposure as JSON: bet count and total stake as a decimal string of santim (R9). */
function exposureJson(exposure: ResultExposure | null): GateJson {
  if (exposure === null || typeof exposure !== 'object') return null;
  const { openBets, totalStake } = exposure;
  if (!Number.isSafeInteger(openBets) || openBets < 0) return null;
  if (typeof totalStake !== 'bigint' || totalStake < 0n) return null;
  return { openBets, totalStake: totalStake.toString() };
}
