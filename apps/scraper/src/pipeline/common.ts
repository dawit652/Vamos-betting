import { SCRAPER_ACTOR, type ScrapeFixtureStatus, type ScrapeResultStatus } from '@vamos/core';
import {
  openReviewItem,
  writeAudit,
  type DbExecutor,
  type DbTransaction,
  type ScrapeObservationRow,
} from '@vamos/db';
import type {
  FixtureObservation,
  GateReview,
  ResolvedObservation,
  ResultObservation,
} from '@vamos/scraper';

/** Competition id -> slug, for ResolvedNames. */
export type SlugMap = ReadonlyMap<string, string>;

/**
 * A stored observation as the rules see it. null when it is not fully
 * resolved (nothing then votes on it) or its competition is unknown.
 */
export function toResolved(
  row: ScrapeObservationRow,
  slugs: SlugMap,
): ResolvedObservation<FixtureObservation | ResultObservation> | null {
  if (row.competitionId === null || row.homeTeamId === null || row.awayTeamId === null) {
    return null;
  }
  const competitionSlug = slugs.get(row.competitionId);
  if (competitionSlug === undefined || row.sport !== 'football') return null;
  const names = {
    competitionId: row.competitionId,
    competitionSlug,
    homeTeamId: row.homeTeamId,
    awayTeamId: row.awayTeamId,
  };
  const base = {
    sourceId: row.sourceId,
    externalRef: row.sourceKey,
    sport: 'football' as const,
    competition: row.competitionRaw,
    home: row.homeRaw,
    away: row.awayRaw,
    kickoff: row.kickoff,
    observedAt: row.lastSeenAt,
  };
  const clocks = {
    upstream: row.upstream,
    names,
    firstSeenAt: row.firstSeenAt,
    changedAt: row.changedAt,
    lastSeenAt: row.lastSeenAt,
  };
  if (row.kind === 'fixture') {
    return {
      ...clocks,
      obs: {
        kind: 'fixture',
        ...base,
        status: row.status as ScrapeFixtureStatus,
        round: row.round,
      },
    };
  }
  if (row.scoreBasis === null) return null;
  return {
    ...clocks,
    obs: {
      kind: 'result',
      ...base,
      status: row.status as ScrapeResultStatus,
      score: row.score,
      scoreBasis: row.scoreBasis,
    },
  };
}

/** Opens (or refreshes) the review items a gate decision asks for. Idempotent per (kind, subject). */
export async function openGateReviews(
  tx: DbTransaction,
  reviews: readonly GateReview[],
  now: Date,
): Promise<number> {
  let created = 0;
  for (const review of reviews) {
    const result = await openReviewItem(tx, {
      kind: review.kind,
      subjectKey: review.subjectKey,
      severity: review.severity,
      title: review.title,
      payload: review.payload,
      now,
    });
    if (result.created) created += 1;
  }
  return created;
}

/** An audit record of an automated change (actor SCRAPER_ACTOR). */
export async function auditScraper(
  exec: DbExecutor,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await writeAudit(exec, { actorType: 'system', actorId: SCRAPER_ACTOR, ...entry });
}

/** Stable text compare for sorting. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
