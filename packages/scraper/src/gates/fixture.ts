import {
  FIXTURE_HORIZON_MS,
  KICKOFF_TOLERANCE_MS,
  MATCH_WINDOW_MS,
  MIN_INDEPENDENT_SOURCES,
  MIN_LEAD_MS,
  SMALL_SHIFT_MS,
} from '../constants';
import type {
  CompetitionPolicy,
  ExistingEvent,
  FixtureObservation,
  ResolvedObservation,
} from '../types';
import { countIndependent, upstreamsOf } from './confirmation';
import {
  canonicalEntries,
  eventProblem,
  iso,
  listOf,
  observationProblem,
  observationSummary,
  type Pairing,
  requireNow,
  samePairing,
  sortedUnique,
} from './internal';
import {
  fixtureFeedRef,
  type GateFinding,
  type GateHold,
  type GateJson,
  type GatePayload,
  type GateReview,
  holdFrom,
} from './review';

/**
 * Fixture rules F2, F3 (its outcome), F4, F6 and F7 (docs/scraper.md 6.1):
 * what one cluster of fixture observations (rule F1, done by `match`) may do
 * to the catalogue.
 *
 * Fail closed by construction:
 * - the only changes are creating an event (always with betting CLOSED, F7) and
 *   moving the kickoff of a scheduled event; a postponement or cancellation is
 *   never a status change, only a `cancellation_proposed` item (F6);
 * - no change is ever derived from a missing observation (F5): with no
 *   observation the decision is 'none';
 * - a kickoff at or before now + MIN_LEAD_MS is never applied;
 * - malformed rows, a cluster mixing pairings and candidates that do not fit
 *   the cluster are `fixture_conflict` holds.
 *
 * Readings chosen where the spec leaves room (each the safer one):
 * - the kickoff used (created or moved to) is the EARLIEST one the sources
 *   give: betting closes no later than any source says the match starts;
 * - F4 needs every observation of the cluster to agree on the new time (a
 *   source still giving another time is a conflict), and never moves an event
 *   that starts within MIN_LEAD_MS (or has started);
 * - F2 also refuses a cluster in which some source says postponed/cancelled;
 * - in shadow mode (policy disabled) conflicts are still raised, nothing is created
 *   and no kickoff is moved: a change that would be applied is proposed as
 *   `kickoff_change` (`policy_disabled`) instead.
 */

export interface FixtureGateInput {
  /** One cluster (rule F1): the current fixture observations of one fixture. */
  readonly observations: readonly ResolvedObservation<FixtureObservation>[];
  /**
   * Rule F3: the scraped events of the same competition, home and away whose
   * start is within MATCH_WINDOW_MS of the cluster. None → a new fixture; one
   * → that event; several → ambiguous (`fixture_conflict`, nothing applied).
   */
  readonly candidates: readonly ExistingEvent[];
  /** Policy of the cluster's competition (another competition's is a programmer error). */
  readonly policy: CompetitionPolicy;
  readonly now: Date;
  /** Rule O1 for BOTH teams (isCalibrated). Anything but true counts as false. */
  readonly calibrated: boolean;
  /** Rule O2 for the prices the new event would get (checkMarkets(...).ok). Anything but true counts as false. */
  readonly pricesSane: boolean;
  /**
   * Rule K2 for the kickoff being created (`assessKickoff(...).confirmed`, no person record).
   * Without it F7 never opens betting: the event is created closed (`kickoff_unconfirmed`).
   * Anything but true counts as false.
   */
  readonly kickoffConfirmed: boolean;
}

interface FixtureCreateBase {
  readonly action: 'create';
  /** The event's feed_ref (fixtureFeedRef of the created kickoff); it never changes. */
  readonly feedRef: string;
  readonly competitionId: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly kickoff: Date;
  /** F7: an event is always created with betting closed. */
  readonly bettingOpen: false;
  /** Sources that saw the fixture (sorted). */
  readonly sources: readonly string[];
}

/**
 * Create the event (F2). `openBetting` says whether betting may be opened right
 * after (F7: auto_open, both teams calibrated, prices sane, kickoff confirmed (K2)); otherwise
 * `review` is the item that asks a trader to open it.
 */
export type FixtureCreate = FixtureCreateBase &
  (
    | { readonly openBetting: true; readonly review: null }
    | {
        readonly openBetting: false;
        readonly review: GateReview<'odds_approval' | 'ratings_uncalibrated'>;
      }
  );

/** Move the kickoff of a scheduled event (F4). The event keeps its feedRef. */
export interface FixtureUpdateKickoff {
  readonly action: 'update-kickoff';
  readonly eventId: string;
  readonly feedRef: string;
  readonly from: Date;
  readonly to: Date;
  /** F4a: independent upstreams agree; F4b: one source, small later shift, no bets, betting closed (K4). */
  readonly rule: 'F4a' | 'F4b';
  readonly upstreams: readonly string[];
}

export type FixtureNoneReason =
  | 'no_observations'
  | 'outside_window'
  | 'not_scheduled'
  | 'policy_disabled'
  | 'unchanged'
  | 'event_closed';

export interface FixtureNone {
  readonly action: 'none';
  readonly reason: FixtureNoneReason;
}

export type FixtureDecision = FixtureCreate | FixtureUpdateKickoff | GateHold | FixtureNone;

type FixtureObs = ResolvedObservation<FixtureObservation>;

/**
 * Several clusters (rule F1) for ONE fixture: sources that disagree by more than
 * the cluster window (the kickoff moved for some, not for others). Each cluster
 * decided on its own would move the kickoff back and forth on every pass, or
 * create the fixture twice, so none is decided: one hold asks a person.
 *
 * - `event`: the clusters all matched this scheduled event (F3) → a
 *   `kickoff_change` (`sources_disagree`), critical when a cluster says the
 *   match starts earlier than the event does (betting would stay open too long);
 * - `pairing`: the clusters matched no event but are the same pairing within
 *   MATCH_WINDOW_MS of each other → a `fixture_conflict` (`sources_disagree`);
 *   nothing is created.
 *
 * Pure; the order of the clusters does not matter.
 */
export function holdSeveralClusters(
  input:
    | { readonly event: ExistingEvent; readonly clusters: readonly (readonly FixtureObs[])[] }
    | { readonly pairing: Pairing; readonly clusters: readonly (readonly FixtureObs[])[] },
): GateHold {
  const summaries = input.clusters
    .map((items) => {
      const kickoffs = listOf(items).map((o) => o.obs.kickoff.getTime());
      return {
        earliest: Math.min(...kickoffs),
        latest: Math.max(...kickoffs),
        sources: sortedUnique(listOf(items).map((o) => o.obs.sourceId)),
        statuses: sortedUnique(listOf(items).map((o) => o.obs.status)),
      };
    })
    .sort((a, b) => a.earliest - b.earliest || a.latest - b.latest);
  const clusters: GateJson = summaries.map((c) => ({
    earliest: iso(c.earliest),
    latest: iso(c.latest),
    sources: c.sources,
    statuses: c.statuses,
  }));
  if ('event' in input) {
    const { event } = input;
    const startMs = event.startTime.getTime();
    const earlier = summaries.some((c) => c.earliest < startMs);
    return holdFrom(
      event.feedRef,
      [
        {
          kind: 'kickoff_change',
          rule: 'F4',
          reason: 'sources_disagree',
          ...(earlier ? { severity: 'critical' as const } : {}),
        },
      ],
      () => ({
        eventId: event.eventId,
        feedRef: event.feedRef,
        eventStart: iso(startMs),
        hasBets: event.hasBets,
        clusters,
        ...kickoffContract(
          event,
          summaries.map((c) => c.earliest),
          input.clusters.flatMap((items) => listOf(items)),
        ),
      }),
    );
  }
  const first = Math.min(...summaries.map((c) => c.earliest));
  const subjectKey = fixtureFeedRef(input.pairing, new Date(first));
  return holdFrom(
    subjectKey,
    [{ kind: 'fixture_conflict', rule: 'F1', reason: 'sources_disagree' }],
    () => ({ feedRef: subjectKey, clusters }),
  );
}

/** Decides F2–F7 for one cluster. Pure; throws only for programmer errors (bad `now`, wrong policy). */
export function decideFixture(input: FixtureGateInput): FixtureDecision {
  const nowMs = requireNow(input.now);
  const observations = listOf(input.observations);
  if (observations.length === 0) return { action: 'none', reason: 'no_observations' };

  const pairings = pairingsOf(observations);
  const pairing = pairings[0];
  const validKickoffs = observations.flatMap((o) => {
    const ms = o?.obs?.kickoff instanceof Date ? o.obs.kickoff.getTime() : Number.NaN;
    return Number.isFinite(ms) ? [ms] : [];
  });
  const firstKickoff = validKickoffs.length > 0 ? Math.min(...validKickoffs) : Number.NaN;
  const clusterKey = (p: Pairing | undefined): string =>
    p === undefined ? 'fx|unknown' : fixtureFeedRef(p, new Date(firstKickoff));
  const conflict = (subjectKey: string, findings: GateFinding[], extra: GatePayload = {}) =>
    holdFrom(subjectKey, findings, () => ({
      observations: canonicalEntries(observations.map(observationSummary)),
      ...extra,
    }));

  if (pairing === undefined || pairings.length > 1) {
    return conflict(clusterKey(pairing), [
      {
        kind: 'fixture_conflict',
        rule: 'F1',
        reason: 'mixed_cluster',
        detail: pairings.map(pairingText),
      },
    ]);
  }
  if (input.policy?.competitionId !== pairing.competitionId) {
    throw new RangeError(
      `policy of competition ${String(input.policy?.competitionId)} given for a fixture of ${pairing.competitionId}`,
    );
  }
  const invalid = observations.flatMap((o) => {
    const problem = observationProblem(o, 'fixture');
    return problem === null ? [] : [{ problem, observation: observationSummary(o) }];
  });
  if (invalid.length > 0) {
    return conflict(clusterKey(pairing), [
      {
        kind: 'fixture_conflict',
        rule: 'F2',
        reason: 'invalid_observation',
        detail: canonicalEntries(invalid),
      },
    ]);
  }

  // F3 outcome. Candidates are re-checked: one that does not fit is a conflict, never ignored
  // (ignoring it could create a second event for the same match).
  const candidates = distinctCandidates(input.candidates);
  const misfits = candidates.events.filter(
    (e) =>
      eventProblem(e) !== null ||
      !samePairing(e, pairing) ||
      Math.abs(e.startTime.getTime() - firstKickoff) > MATCH_WINDOW_MS,
  );
  if (candidates.inconsistent || misfits.length > 0) {
    return conflict(clusterKey(pairing), [
      {
        kind: 'fixture_conflict',
        rule: 'F3',
        reason: 'candidate_mismatch',
        detail: sortedUnique(misfits.map((e) => String(e?.eventId))),
      },
    ]);
  }
  if (candidates.events.length > 1) {
    return conflict(clusterKey(pairing), [
      {
        kind: 'fixture_conflict',
        rule: 'F3',
        reason: 'ambiguous_match',
        detail: sortedUnique(candidates.events.map((e) => e.eventId)),
      },
    ]);
  }
  const existing = candidates.events[0];
  if (existing !== undefined) {
    return decideExisting(existing, observations, nowMs, conflict, input.policy);
  }
  return decideNew(input, pairing, observations, nowMs, conflict);
}

type Conflict = (subjectKey: string, findings: GateFinding[], extra?: GatePayload) => GateHold;

/** F2 + F6 + F7 for a cluster that matched no event. */
function decideNew(
  input: FixtureGateInput,
  pairing: Pairing,
  observations: readonly FixtureObs[],
  nowMs: number,
  conflict: Conflict,
): FixtureDecision {
  const kickoffs = observations.map((o) => o.obs.kickoff.getTime());
  const earliest = Math.min(...kickoffs);
  const latest = Math.max(...kickoffs);
  const inWindow = (ms: number): boolean =>
    ms > nowMs + MIN_LEAD_MS && ms <= nowMs + FIXTURE_HORIZON_MS;
  const subjectKey = fixtureFeedRef(pairing, new Date(earliest));

  // "Or nothing, when the fixture is simply outside the window."
  if (!kickoffs.some(inWindow)) return { action: 'none', reason: 'outside_window' };
  const scheduled = observations.filter((o) => o.obs.status === 'scheduled');
  if (scheduled.length === 0) return { action: 'none', reason: 'not_scheduled' };
  if (scheduled.length < observations.length) {
    return conflict(subjectKey, [
      {
        kind: 'fixture_conflict',
        rule: 'F6',
        reason: 'status_disagreement',
        detail: sortedUnique(observations.map((o) => `${o.obs.sourceId}:${o.obs.status}`)),
      },
    ]);
  }
  if (latest - earliest > KICKOFF_TOLERANCE_MS) {
    return conflict(subjectKey, [
      {
        kind: 'fixture_conflict',
        rule: 'F2',
        reason: 'kickoff_disagreement',
        detail: { earliest: iso(earliest), latest: iso(latest) },
      },
    ]);
  }
  // The created kickoff is the earliest one; it must itself be inside the window.
  if (!inWindow(earliest)) return { action: 'none', reason: 'outside_window' };
  if (input.policy.enabled !== true) return { action: 'none', reason: 'policy_disabled' };

  const base: FixtureCreateBase = {
    action: 'create',
    feedRef: subjectKey,
    competitionId: pairing.competitionId,
    homeTeamId: pairing.homeTeamId,
    awayTeamId: pairing.awayTeamId,
    kickoff: new Date(earliest),
    bettingOpen: false,
    sources: sortedUnique(observations.map((o) => o.obs.sourceId)),
  };
  const calibrated = input.calibrated === true;
  const pricesSane = input.pricesSane === true;
  const kickoffConfirmed = input.kickoffConfirmed === true;
  if (input.policy.autoOpen === true && calibrated && pricesSane && kickoffConfirmed) {
    return { ...base, openBetting: true, review: null };
  }
  const kind = calibrated ? 'odds_approval' : 'ratings_uncalibrated';
  const reason = !calibrated
    ? 'ratings_uncalibrated'
    : !pricesSane
      ? 'prices_not_sane'
      : input.policy.autoOpen !== true
        ? 'auto_open_off'
        : 'kickoff_unconfirmed';
  const { review } = holdFrom(subjectKey, [{ kind, rule: 'F7', reason }], () => ({
    feedRef: subjectKey,
    kickoff: iso(earliest),
    calibrated,
    pricesSane,
    kickoffConfirmed,
    autoOpen: input.policy.autoOpen === true,
  }));
  return {
    ...base,
    openBetting: false,
    review: { ...review, kind },
  };
}

/** F4 + F6 for a cluster that matched exactly one event. */
function decideExisting(
  event: ExistingEvent,
  observations: readonly FixtureObs[],
  nowMs: number,
  conflict: Conflict,
  policy: CompetitionPolicy,
): FixtureDecision {
  const subjectKey = event.feedRef;
  const startMs = event.startTime.getTime();
  const sources = sortedUnique(observations.map((o) => o.obs.sourceId));
  const scheduled = observations.filter((o) => o.obs.status === 'scheduled');
  const eventPayload: GatePayload = {
    eventId: event.eventId,
    feedRef: event.feedRef,
    eventStart: iso(startMs),
  };

  if (event.resultedAt !== null || event.score !== null)
    return { action: 'none', reason: 'event_closed' };
  if (event.status === 'postponed' || event.status === 'cancelled') {
    // Sources list a new date for a match the catalogue holds as postponed: a person re-schedules it.
    const future = scheduled.filter((o) => o.obs.kickoff.getTime() > nowMs);
    if (future.length === 0) return { action: 'none', reason: 'event_closed' };
    return conflict(
      subjectKey,
      [{ kind: 'kickoff_change', rule: 'F4', reason: 'event_not_scheduled', detail: sources }],
      {
        ...eventPayload,
        ...kickoffContract(
          event,
          future.map((o) => o.obs.kickoff.getTime()),
          future,
        ),
      },
    );
  }
  if (event.status !== 'scheduled') return { action: 'none', reason: 'event_closed' };

  // F6: postponed / cancelled are never applied, they would void bets.
  const voids = observations.filter((o) => o.obs.status !== 'scheduled');
  if (voids.length > 0) {
    return conflict(
      subjectKey,
      [
        {
          kind: 'cancellation_proposed',
          rule: 'F6',
          reason: 'void_status_reported',
          detail: sortedUnique(voids.map((o) => `${o.obs.sourceId}:${o.obs.status}`)),
        },
      ],
      eventPayload,
    );
  }

  const kickoffs = observations.map((o) => o.obs.kickoff.getTime());
  const earliest = Math.min(...kickoffs);
  const latest = Math.max(...kickoffs);
  const sameAsEvent = (ms: number): boolean => Math.abs(ms - startMs) <= KICKOFF_TOLERANCE_MS;
  if (kickoffs.every(sameAsEvent)) return { action: 'none', reason: 'unchanged' };

  const proposal = (reason: string, severity: 'warning' | 'critical'): GateHold =>
    conflict(subjectKey, [{ kind: 'kickoff_change', rule: 'F4', reason, severity }], {
      ...eventPayload,
      ...kickoffContract(event, kickoffs, observations),
      latestKickoff: iso(latest),
      upstreams: upstreamsOf(observations.map(voiceOf)),
    });
  // A move to an earlier time left undone keeps betting open too long: critical.
  const severity = earliest < startMs ? 'critical' : 'warning';
  if (latest - earliest > KICKOFF_TOLERANCE_MS) return proposal('sources_disagree', severity);
  if (sameAsEvent(earliest)) return { action: 'none', reason: 'unchanged' };
  if (startMs <= nowMs + MIN_LEAD_MS) return proposal('event_about_to_start', severity);
  // "A new time before now + MIN_LEAD_MS is never applied" (at it neither: same bound as F2).
  if (earliest <= nowMs + MIN_LEAD_MS) return proposal('new_time_too_close', severity);

  // S4: a switched-off competition is never moved by the scraper, a person decides.
  if (policy.enabled !== true) return proposal('policy_disabled', severity);

  const independent = countIndependent(observations.map(voiceOf));
  const later = earliest > startMs;
  const update = (rule: 'F4a' | 'F4b'): FixtureUpdateKickoff => ({
    action: 'update-kickoff',
    eventId: event.eventId,
    feedRef: event.feedRef,
    from: new Date(startMs),
    to: new Date(earliest),
    rule,
    upstreams: upstreamsOf(observations.map(voiceOf)),
  });
  if (independent >= MIN_INDEPENDENT_SOURCES) return update('F4a');
  if (
    independent === 1 &&
    later &&
    earliest - startMs <= SMALL_SHIFT_MS &&
    event.hasBets === false
  ) {
    // K4: a later time from one source is moved to only while betting is closed. If the source is
    // wrong, a moved start would keep betting open past the real kickoff.
    if (event.bettingOpen !== false) return proposal('betting_open', severity);
    return update('F4b');
  }
  return proposal('needs_independent_sources', severity);
}

function voiceOf(o: FixtureObs): { sourceId: string; upstream: string } {
  return { sourceId: o.obs.sourceId, upstream: o.upstream };
}

/**
 * The fields of the `kickoff_change` contract (packages/contracts/src/feed.ts) that every kickoff
 * item of the gate carries, so `apply_kickoff` and the review page can read it: the event, its
 * current kickoff, the proposed one (the earliest given, the same reading as the decision), who
 * said so (`SourceVote`: source, upstream, when its observation took its value; sorted) and bets.
 */
function kickoffContract(
  event: ExistingEvent,
  proposedMs: readonly number[],
  observations: readonly FixtureObs[],
): GatePayload {
  const sources = observations
    .map((o) => ({
      sourceId: o.obs.sourceId,
      upstream: o.upstream,
      changedAt: iso(o.changedAt.getTime()),
    }))
    .sort(
      (a, b) =>
        (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) ||
        (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : 0) ||
        (a.upstream < b.upstream ? -1 : a.upstream > b.upstream ? 1 : 0),
    );
  return {
    eventId: event.eventId,
    currentKickoff: iso(event.startTime.getTime()),
    proposedKickoff: iso(Math.min(...proposedMs)),
    sources,
    hasBets: event.hasBets,
  };
}

/** Distinct pairings of a cluster, sorted (one expected). */
function pairingsOf(observations: readonly FixtureObs[]): Pairing[] {
  const byText = new Map<string, Pairing>();
  for (const o of observations) {
    const names = o?.names as Partial<Pairing> | undefined;
    const pairing: Pairing = {
      competitionId: String(names?.competitionId),
      homeTeamId: String(names?.homeTeamId),
      awayTeamId: String(names?.awayTeamId),
    };
    byText.set(pairingText(pairing), pairing);
  }
  return [...byText.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
}

function pairingText(p: Pairing): string {
  return `${p.competitionId}|${p.homeTeamId}|${p.awayTeamId}`;
}

/** Candidates de-duplicated by eventId; two different rows with one id are inconsistent. */
function distinctCandidates(candidates: readonly ExistingEvent[]): {
  events: ExistingEvent[];
  inconsistent: boolean;
} {
  const byId = new Map<string, { event: ExistingEvent; text: string }>();
  let inconsistent = false;
  for (const event of listOf(candidates)) {
    const id = String(event?.eventId);
    const text = JSON.stringify(event, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const seen = byId.get(id);
    if (seen === undefined) byId.set(id, { event, text });
    else if (seen.text !== text) inconsistent = true;
  }
  const events = [...byId.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry.event);
  return { events, inconsistent };
}
