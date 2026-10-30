import {
  SCRAPE_FIXTURE_STATUSES,
  SCRAPE_RESULT_STATUSES,
  SCRAPE_SCORE_BASES,
  SCRAPE_SPORTS,
} from '@vamos/core';
import type { ExistingEvent, ResolvedObservation, Score, ScrapedEventStatus } from '../types';
import type { GateJson } from './review';

/**
 * Validation and formatting helpers shared by the gates. Not exported from the
 * package: every check here exists so that a malformed row fails CLOSED (a
 * hold) instead of being silently ignored or throwing.
 */

/** The pairing a fixture is about (F1: home and away are never swapped). */
export interface Pairing {
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
}

/** Milliseconds of a valid Date, or null for anything else (NaN dates included). */
export function instant(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** `now` comes from the runner's clock: an invalid one is a programmer error. */
export function requireNow(now: unknown): number {
  const ms = instant(now);
  if (ms === null) throw new RangeError('now must be a valid Date');
  return ms;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 99;
}

/** Same constraints as ScoreSchema (types.ts), re-checked because rows come back from the database. */
export function isValidScore(score: unknown): score is Score {
  if (typeof score !== 'object' || score === null) return false;
  const { home, away, htHome, htAway } = score as Record<string, unknown>;
  if (!isPoints(home) || !isPoints(away)) return false;
  if (htHome === null && htAway === null) return true;
  return isPoints(htHome) && isPoints(htAway) && htHome <= home && htAway <= away;
}

export function samePairing(names: unknown, pairing: Pairing): boolean {
  if (typeof names !== 'object' || names === null) return false;
  const n = names as Record<string, unknown>;
  return (
    n.competitionId === pairing.competitionId &&
    n.homeTeamId === pairing.homeTeamId &&
    n.awayTeamId === pairing.awayTeamId
  );
}

const EVENT_STATUSES: ReadonlySet<string> = new Set<ScrapedEventStatus>([
  'scheduled',
  'live',
  'finished',
  'cancelled',
  'postponed',
  'abandoned',
]);

/** Why an event row cannot be trusted, or null when it is well formed. */
export function eventProblem(event: ExistingEvent): string | null {
  if (typeof event !== 'object' || event === null) return 'event_missing';
  if (!isNonEmptyString(event.eventId)) return 'bad_event_id';
  if (!isNonEmptyString(event.feedRef)) return 'bad_feed_ref';
  if (
    !isNonEmptyString(event.competitionId) ||
    !isNonEmptyString(event.homeTeamId) ||
    !isNonEmptyString(event.awayTeamId)
  ) {
    return 'bad_pairing';
  }
  if (instant(event.startTime) === null) return 'bad_start_time';
  if (!EVENT_STATUSES.has(event.status)) return 'bad_status';
  if (typeof event.hasBets !== 'boolean') return 'bad_has_bets';
  if (typeof event.needsHalfTimeScore !== 'boolean') return 'bad_needs_half_time';
  if (event.resultedAt !== null && instant(event.resultedAt) === null) return 'bad_resulted_at';
  if (event.score !== null && !isValidScore(event.score)) return 'bad_score';
  return null;
}

const FIXTURE_STATUSES: ReadonlySet<string> = new Set(SCRAPE_FIXTURE_STATUSES);
const RESULT_STATUSES: ReadonlySet<string> = new Set(SCRAPE_RESULT_STATUSES);
const SCORE_BASES: ReadonlySet<string> = new Set(SCRAPE_SCORE_BASES);
const SPORTS: ReadonlySet<string> = new Set(SCRAPE_SPORTS);

/**
 * Why a resolved observation cannot be trusted, or null. The zod schemas ran at
 * the adapter, but the gates read rows back from storage, so the invariants the
 * rules depend on (valid clocks, status/score consistency) are checked again.
 */
export function observationProblem(
  o: ResolvedObservation,
  kind: 'fixture' | 'result',
): string | null {
  if (typeof o !== 'object' || o === null) return 'observation_missing';
  if (!isNonEmptyString(o.upstream)) return 'bad_upstream';
  const obs = o.obs as unknown as Record<string, unknown> | null;
  if (typeof obs !== 'object' || obs === null) return 'observation_missing';
  if (obs.kind !== kind) return 'wrong_kind';
  if (!isNonEmptyString(obs.sourceId)) return 'bad_source_id';
  if (typeof obs.sport !== 'string' || !SPORTS.has(obs.sport)) return 'bad_sport';
  for (const clock of [obs.kickoff, obs.observedAt, o.firstSeenAt, o.changedAt, o.lastSeenAt]) {
    if (instant(clock) === null) return 'bad_clock';
  }
  if (kind === 'fixture') {
    return typeof obs.status === 'string' && FIXTURE_STATUSES.has(obs.status) ? null : 'bad_status';
  }
  if (typeof obs.status !== 'string' || !RESULT_STATUSES.has(obs.status)) return 'bad_status';
  if (typeof obs.scoreBasis !== 'string' || !SCORE_BASES.has(obs.scoreBasis)) return 'bad_basis';
  if (obs.status === 'finished') return isValidScore(obs.score) ? null : 'bad_score';
  return obs.score === null ? null : 'score_without_finish';
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** ISO text of a Date, or null when it is not a valid one (for payloads built from bad rows). */
export function isoOrNull(value: unknown): string | null {
  const ms = instant(value);
  return ms === null ? null : iso(ms);
}

export function scoreText(score: unknown): string | null {
  if (!isValidScore(score)) return null;
  const ft = `${score.home}-${score.away}`;
  return score.htHome === null ? ft : `${ft} (ht ${score.htHome}-${score.htAway})`;
}

/**
 * A score as JSON the back office reads (`FeedScoreView`): full time and half time, null half time when
 * there is none; null for anything that is not a valid score.
 */
export function scoreView(score: unknown): { [key: string]: GateJson } | null {
  if (!isValidScore(score)) return null;
  return {
    home: score.home,
    away: score.away,
    htHome: score.htHome ?? null,
    htAway: score.htAway ?? null,
  };
}

/** Sorted, de-duplicated strings: payloads must not depend on input order or duplicates. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Sorted, de-duplicated JSON entries (by their canonical text). */
export function canonicalEntries<T extends GateJson>(entries: readonly T[]): T[] {
  const byText = new Map<string, T>();
  for (const entry of entries) byText.set(JSON.stringify(entry), entry);
  return [...byText.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry);
}

/** Machine-readable summary of one observation for a review payload. Never throws. */
export function observationSummary(o: ResolvedObservation): { [key: string]: GateJson } {
  const obs = (o?.obs ?? {}) as unknown as Record<string, unknown>;
  return {
    sourceId: typeof obs.sourceId === 'string' ? obs.sourceId : null,
    upstream: typeof o?.upstream === 'string' ? o.upstream : null,
    status: typeof obs.status === 'string' ? obs.status : null,
    score: scoreView(obs.score),
    scoreBasis: typeof obs.scoreBasis === 'string' ? obs.scoreBasis : null,
    kickoff: isoOrNull(obs.kickoff),
    changedAt: isoOrNull(o?.changedAt),
  };
}

/** The array itself, or an empty one when a caller passed something else (never throws, keeps the element type). */
export function listOf<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}
