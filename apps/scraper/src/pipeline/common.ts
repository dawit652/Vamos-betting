import {
  anyMarketKey,
  SCRAPER_ACTOR,
  type ScrapeFixtureStatus,
  type ScrapeResultStatus,
} from '@vamos/core';
import {
  openReviewItem,
  writeAudit,
  type DbExecutor,
  type DbTransaction,
  type ScrapeObservationRow,
} from '@vamos/db';
import { competitions as competitionsTable, teams as teamsTable } from '@vamos/db/schema';
import { inArray } from 'drizzle-orm';
import {
  CLUSTER_WINDOW_MS,
  type FixtureObservation,
  type GateJson,
  type GateMarket,
  type GateReview,
  type ResolvedObservation,
  type ResultObservation,
} from '@vamos/scraper';

/**
 * The upsertFixture option of rule P7 (price expiry, plan task 1.10): prices written or
 * confirmed at `now` stay valid for SCRAPER_PRICE_EXPIRY_MINUTES; 0 (the default) leaves
 * `price_valid_until` untouched, so nothing expires.
 */
export function priceExpiryOption(
  scraper: { priceExpiryMinutes: number },
  now: Date,
): { priceValidUntil?: Date } {
  const minutes = scraper.priceExpiryMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return {};
  return { priceValidUntil: new Date(now.getTime() + minutes * 60_000) };
}

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

/** The proposal as the review page shows it: per market, each selection with its stored price. */
export function display(previous: readonly GateMarket[], next: readonly GateMarket[]): GateJson {
  const old = new Map<string, number>();
  for (const m of previous) {
    for (const s of m.selections) old.set(`${anyMarketKey(m.type, m.line)}|${s.code}`, s.oddsMilli);
  }
  return next.map((m) => {
    const key = anyMarketKey(m.type, m.line);
    return {
      market: key,
      selections: m.selections.map((s) => {
        const before = old.get(`${key}|${s.code}`);
        return {
          name: s.code,
          oddsMilli: s.oddsMilli,
          ...(before === undefined ? {} : { previousOddsMilli: before }),
        };
      }),
    };
  });
}

export async function teamNames(
  tx: DbTransaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: teamsTable.id, name: teamsTable.name, shortName: teamsTable.shortName })
    .from(teamsTable)
    .where(inArray(teamsTable.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name.en || row.shortName]));
}

export async function competitionNames(
  tx: DbTransaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: competitionsTable.id,
      name: competitionsTable.name,
      slug: competitionsTable.slug,
    })
    .from(competitionsTable)
    .where(inArray(competitionsTable.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name.en || row.slug]));
}

/** Most current observations one promotion pass reads (`listCurrentObservations` is ordered by kickoff). */
export const OBSERVATION_ROW_LIMIT = 20_000;

/** Test hook for the promotion steps. */
export interface PromoteOptions {
  /** Row limit of the observation read; default OBSERVATION_ROW_LIMIT. */
  rowLimit?: number;
}

/**
 * Fails closed when an observation read hit its limit (review, not-covered list).
 * The rows come ordered by kickoff, so a read that returned exactly `limit` rows
 * may have cut through the last kickoff group, hiding sources that disagree.
 * Returns the kickoff from which nothing may be decided on this pass, or null
 * when the read was complete: the last kickoff returned, moved back by the
 * clustering window, because a hidden row at that kickoff chains into the
 * cluster of a fixture up to that window earlier. Those fixtures are decided on
 * a later pass, once the window has moved on and the read fits.
 */
export function undecidedFrom(
  rows: ReadonlyArray<{ kickoff: Date }>,
  limit: number,
  logger: { error: (obj: object, msg: string) => void },
  what: string,
): Date | null {
  const last = rows.at(-1);
  if (last === undefined || rows.length < limit) return null;
  const from = new Date(last.kickoff.getTime() - CLUSTER_WINDOW_MS);
  logger.error(
    { limit, what, lastKickoff: last.kickoff.toISOString(), undecidedFrom: from.toISOString() },
    'observation read reached its row limit: fixtures from this kickoff on are not decided in this pass',
  );
  return from;
}
