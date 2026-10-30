import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { events, teams } from '../schema/catalog';
import { scrapeRatingApplied } from '../schema/scrape';
import { auditScrape, type ScrapeActor } from './common';

export interface TeamRatings {
  /** teams.ratings as stored (null = never rated). */
  ratings: Record<string, number> | null;
  /** ratings.matches: the results the ratings were learned from (0 when absent). */
  matches: number;
  /** ratings.manual = 1: a trader set them and vouches for them (rule O1). */
  manual: boolean;
}

/**
 * Records that the result of `fixtureKey` updated the ratings. True only the
 * first time (INSERT … ON CONFLICT DO NOTHING), so a result applied twice, or
 * by two workers at once, moves the ratings once (O4). Call it in the same
 * transaction as the result and the ratings update: they commit or roll back
 * together.
 */
export async function markRatingApplied(tx: DbTransaction, fixtureKey: string): Promise<boolean> {
  const rows = await tx
    .insert(scrapeRatingApplied)
    .values({ fixtureKey })
    .onConflictDoNothing()
    .returning({ fixtureKey: scrapeRatingApplied.fixtureKey });
  return rows.length > 0;
}

function toRatings(ratings: Record<string, number> | null): TeamRatings {
  return {
    ratings,
    matches: ratings !== null && Number.isFinite(ratings.matches) ? Number(ratings.matches) : 0,
    manual: ratings?.manual === 1,
  };
}

/**
 * The ratings of some teams (teams without ratings map to {null, 0, false};
 * unknown ids are absent). `forUpdate` locks the rows for a read-modify-write.
 */
export async function getTeamRatings(
  exec: DbExecutor,
  teamIds: readonly string[],
  options: { forUpdate?: boolean } = {},
): Promise<Map<string, TeamRatings>> {
  if (teamIds.length === 0) return new Map();
  const ids = [...new Set(teamIds)].sort();
  const query = exec
    .select({ id: teams.id, ratings: teams.ratings })
    .from(teams)
    .where(inArray(teams.id, ids))
    .orderBy(teams.id);
  const rows = await (options.forUpdate ? query.for('update') : query);
  return new Map(rows.map((row) => [row.id, toRatings(row.ratings)]));
}

/** Replaces a team's ratings (audited with before and after). Values must be finite numbers. */
export async function setTeamRatings(
  tx: DbTransaction,
  teamId: string,
  ratings: Record<string, number>,
  actor: ScrapeActor,
): Promise<TeamRatings> {
  for (const [key, value] of Object.entries(ratings)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw domainUnprocessable('scrape_bad_ratings', `rating "${key}" is not a finite number`);
    }
  }
  const [current] = await tx
    .select({ ratings: teams.ratings })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for('update');
  if (current === undefined) throw domainNotFound('team');
  await tx.update(teams).set({ ratings }).where(eq(teams.id, teamId));
  await auditScrape(tx, actor, {
    action: 'scrape.ratings.updated',
    targetType: 'team',
    targetId: teamId,
    metadata: { before: current.ratings, after: ratings },
  });
  return toRatings(ratings);
}

/** What a competition's finished results say about its home advantage: whole numbers. */
export interface CompetitionGoalEvidence {
  /** Finished matches with a full-time score. */
  matches: number;
  homeGoals: number;
  awayGoals: number;
}

/**
 * The home and away goals of every finished, scored event of the competition
 * that the scraper created (F-07). Derived from the stored results, so it
 * needs no counter of its own: a result applied in the same transaction is
 * included, a corrected score is picked up, and nothing can drift.
 */
export async function competitionGoalEvidence(
  exec: DbExecutor,
  competitionId: string,
): Promise<CompetitionGoalEvidence> {
  const [row] = await exec
    .select({
      matches: sql<number>`count(*)::int`,
      homeGoals: sql<number>`coalesce(sum(${events.scoreHome}), 0)::int`,
      awayGoals: sql<number>`coalesce(sum(${events.scoreAway}), 0)::int`,
    })
    .from(events)
    .where(
      and(
        eq(events.competitionId, competitionId),
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.status, 'finished'),
        isNotNull(events.scoreHome),
        isNotNull(events.scoreAway),
      ),
    );
  return {
    matches: row?.matches ?? 0,
    homeGoals: row?.homeGoals ?? 0,
    awayGoals: row?.awayGoals ?? 0,
  };
}
