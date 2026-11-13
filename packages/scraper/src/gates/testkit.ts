import type { ScrapeScoreBasis } from '@vamos/core';
import { MIN_MATCH_DURATION_MS } from '../constants';
import type {
  CompetitionPolicy,
  ExistingEvent,
  FixtureObservation,
  ResolvedNames,
  ResolvedObservation,
  ResultObservation,
  Score,
} from '../types';

/**
 * Builders for the gates' tests (not exported from the package). Every clock
 * is a fixed instant; nothing reads the real time.
 */

export const KICKOFF = Date.parse('2026-11-01T15:00:00.000Z');
/** Earliest possible end of the match at KICKOFF (R1). */
export const END = KICKOFF + MIN_MATCH_DURATION_MS;
export const NAMES: ResolvedNames = {
  competitionId: 'comp-1',
  competitionSlug: 'league-1',
  homeTeamId: 'team-h',
  awayTeamId: 'team-a',
};
export const FEED_REF = 'fx|comp-1|team-h|team-a|2026-11-01';

/** A score; `ht` is the half-time score when the source gave one. */
export function score(home: number, away: number, ht?: readonly [number, number]): Score {
  return { home, away, htHome: ht?.[0] ?? null, htAway: ht?.[1] ?? null };
}

export function makeEvent(over: Partial<ExistingEvent> = {}): ExistingEvent {
  return {
    eventId: 'ev-1',
    feedRef: FEED_REF,
    competitionId: NAMES.competitionId,
    homeTeamId: NAMES.homeTeamId,
    awayTeamId: NAMES.awayTeamId,
    startTime: new Date(KICKOFF),
    status: 'scheduled',
    bettingOpen: true,
    hasBets: false,
    needsHalfTimeScore: false,
    resultedAt: null,
    score: null,
    ...over,
  };
}

export function makePolicy(over: Partial<CompetitionPolicy> = {}): CompetitionPolicy {
  return {
    competitionId: NAMES.competitionId,
    enabled: true,
    autoOpen: false,
    autoResults: true,
    extraTime: false,
    factoryMarkets: false,
    ...over,
  };
}

export interface ResultSpec {
  source: string;
  /** Default `up-<source>` (every source independent). */
  upstream?: string;
  status?: ResultObservation['status'];
  /** Default 2-1 when finished, null otherwise. */
  score?: Score | null;
  basis?: ScrapeScoreBasis;
  kickoff?: number;
  /** Default END. */
  changedAt?: number;
  firstSeenAt?: number;
  names?: Partial<ResolvedNames>;
}

export function resultObs(spec: ResultSpec): ResolvedObservation<ResultObservation> {
  const status = spec.status ?? 'finished';
  const changedAt = spec.changedAt ?? END;
  return {
    upstream: spec.upstream ?? `up-${spec.source}`,
    names: { ...NAMES, ...spec.names },
    obs: {
      kind: 'result',
      sourceId: spec.source,
      externalRef: null,
      sport: 'football',
      competition: 'League One',
      home: 'Home FC',
      away: 'Away FC',
      kickoff: new Date(spec.kickoff ?? KICKOFF),
      observedAt: new Date(changedAt),
      status,
      score: spec.score !== undefined ? spec.score : status === 'finished' ? score(2, 1) : null,
      scoreBasis: spec.basis ?? 'regular_time',
    },
    firstSeenAt: new Date(spec.firstSeenAt ?? changedAt),
    changedAt: new Date(changedAt),
    lastSeenAt: new Date(changedAt),
  };
}

export interface FixtureSpec {
  source: string;
  upstream?: string;
  status?: FixtureObservation['status'];
  kickoff?: number;
  names?: Partial<ResolvedNames>;
  seenAt?: number;
}

export function fixtureObs(spec: FixtureSpec): ResolvedObservation<FixtureObservation> {
  const seenAt = spec.seenAt ?? KICKOFF - 3 * 24 * 3_600_000;
  return {
    upstream: spec.upstream ?? `up-${spec.source}`,
    names: { ...NAMES, ...spec.names },
    obs: {
      kind: 'fixture',
      sourceId: spec.source,
      externalRef: null,
      sport: 'football',
      competition: 'League One',
      home: 'Home FC',
      away: 'Away FC',
      kickoff: new Date(spec.kickoff ?? KICKOFF),
      observedAt: new Date(seenAt),
      status: spec.status ?? 'scheduled',
      round: null,
    },
    firstSeenAt: new Date(seenAt),
    changedAt: new Date(seenAt),
    lastSeenAt: new Date(seenAt),
  };
}
