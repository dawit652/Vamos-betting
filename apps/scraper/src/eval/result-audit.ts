/**
 * Pure helpers of `review results-audit` (S-6 of docs/feed-quality-plan.md): compare an applied
 * result with what each source says now, and measure how long the result took to be applied.
 * No I/O.
 */

/** A score as stored on the event and on result observations. */
export interface AuditScore {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}

/** The final whistle is assumed this long after kickoff (90 min, half-time break and stoppage). */
export const ASSUMED_MATCH_MINUTES = 105;
/** The plan's targets (docs/feed-quality-plan.md): applied within this long after the whistle. */
export const TARGET_MEDIAN_MINUTES = 20;
export const TARGET_P90_MINUTES = 30;

const MINUTE_MS = 60_000;

/** Minutes from the assumed final whistle (kickoff + 105 min) to the moment the result was applied. */
export function latencyMinutes(kickoff: Date, appliedAt: Date): number {
  return (appliedAt.getTime() - kickoff.getTime()) / MINUTE_MS - ASSUMED_MATCH_MINUTES;
}

/** Nearest-rank percentile (p in (0, 1]); null for no values. Does not modify its input. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 1)) throw new RangeError('p must be in (0, 1]');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

/** The median, the mean of the two middle values for an even count; null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** One source's current result observation of the match. */
export interface SourceResult {
  sourceId: string;
  upstream: string;
  status: string;
  scoreBasis: string | null;
  score: AuditScore | null;
  changedAt: Date;
}

/**
 * match: agrees; ft / ht / ft_ht: the full-time score, the half-time score or both differ;
 * not_finished: the source shows no final score; other_basis: its score is not a regular-time score,
 * so it is not comparable (extra time).
 */
export type Verdict = 'match' | 'ft' | 'ht' | 'ft_ht' | 'not_finished' | 'other_basis';

export interface SourceComparison {
  sourceId: string;
  upstream: string;
  verdict: Verdict;
  score: AuditScore | null;
  changedAt: Date;
}

/** True for a verdict that is a disagreement (not agreement, and not "cannot compare"). */
export const isMismatch = (verdict: Verdict): boolean =>
  verdict === 'ft' || verdict === 'ht' || verdict === 'ft_ht';

/** The applied score against one source. A half-time score is compared only when both sides have one. */
export function compareSource(applied: AuditScore, source: SourceResult): SourceComparison {
  const base = {
    sourceId: source.sourceId,
    upstream: source.upstream,
    score: source.score,
    changedAt: source.changedAt,
  };
  if (source.status !== 'finished' || source.score === null) {
    return { ...base, verdict: 'not_finished' };
  }
  if (source.scoreBasis !== 'regular_time') return { ...base, verdict: 'other_basis' };
  const ft = source.score.home !== applied.home || source.score.away !== applied.away;
  const ht =
    source.score.htHome !== null &&
    source.score.htAway !== null &&
    applied.htHome !== null &&
    applied.htAway !== null &&
    (source.score.htHome !== applied.htHome || source.score.htAway !== applied.htAway);
  return { ...base, verdict: ft && ht ? 'ft_ht' : ft ? 'ft' : ht ? 'ht' : 'match' };
}

/** Each source's most recently changed observation (a source may hold several rows for one match). */
export function latestPerSource(results: readonly SourceResult[]): SourceResult[] {
  const best = new Map<string, SourceResult>();
  for (const r of results) {
    const prior = best.get(r.sourceId);
    if (prior === undefined || r.changedAt.getTime() > prior.changedAt.getTime()) {
      best.set(r.sourceId, r);
    }
  }
  return [...best.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
}

export interface AuditedEvent {
  competition: string;
  latencyMinutes: number;
  comparisons: readonly SourceComparison[];
}

export interface AuditSummary {
  competition: string;
  /** Applied results audited. */
  count: number;
  /** Results where at least one source disagrees. */
  mismatches: number;
  medianLatencyMinutes: number | null;
  p90LatencyMinutes: number | null;
  /** Median at most the target and p90 at most the target; null without results. */
  meetsTargets: boolean | null;
}

function summarise(competition: string, items: readonly AuditedEvent[]): AuditSummary {
  const latencies = items.map((i) => i.latencyMinutes);
  const med = median(latencies);
  const p90 = percentile(latencies, 0.9);
  return {
    competition,
    count: items.length,
    mismatches: items.filter((i) => i.comparisons.some((c) => isMismatch(c.verdict))).length,
    medianLatencyMinutes: med,
    p90LatencyMinutes: p90,
    meetsTargets:
      med === null || p90 === null
        ? null
        : med <= TARGET_MEDIAN_MINUTES && p90 <= TARGET_P90_MINUTES,
  };
}

/** The overall summary and one per competition (by name). */
export function summariseAudit(items: readonly AuditedEvent[]): {
  overall: AuditSummary;
  byCompetition: AuditSummary[];
} {
  const groups = new Map<string, AuditedEvent[]>();
  for (const item of items) {
    const list = groups.get(item.competition) ?? [];
    list.push(item);
    groups.set(item.competition, list);
  }
  return {
    overall: summarise('all', items),
    byCompetition: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, list]) => summarise(name, list)),
  };
}
