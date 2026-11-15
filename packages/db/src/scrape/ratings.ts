import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { events, teams } from '../schema/catalog';
import { scrapeRatingApplied } from '../schema/scrape';
import { localizedNames } from './aliases';
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

/** A football team of the catalogue with every name it answers to. */
export interface FootballTeamNames {
  id: string;
  shortName: string;
  names: string[];
}

/** Football teams of the catalogue with every name they answer to (short name, localized names). */
export async function footballTeamNames(exec: DbExecutor): Promise<FootballTeamNames[]> {
  const rows = await exec
    .select({ id: teams.id, shortName: teams.shortName, name: teams.name })
    .from(teams)
    .where(eq(teams.sportId, 'football'));
  return rows.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    names: [r.shortName, ...localizedNames(r.name)],
  }));
}

/** What a ratings read needs from the caller: the scraper's name normaliser. */
export interface RatingsListOptions {
  /** Already-normalised text the team's names must contain ('' = all). */
  nameKey: string;
  normalize: (name: string) => string;
}

export interface RatedTeamRow {
  teamId: string;
  team: string;
  ratings: Record<string, number>;
  manual: boolean;
}

/** Football teams that have ratings (learned or set by hand), by short name. */
export async function listRatedTeams(
  exec: DbExecutor,
  options: RatingsListOptions,
): Promise<RatedTeamRow[]> {
  const candidates = (await footballTeamNames(exec)).filter(
    (t) =>
      options.nameKey === '' || t.names.some((n) => options.normalize(n).includes(options.nameKey)),
  );
  const current = await getTeamRatings(
    exec,
    candidates.map((t) => t.id),
  );
  return candidates
    .flatMap((t) => {
      const r = current.get(t.id);
      return r?.ratings === null || r?.ratings === undefined
        ? []
        : [{ teamId: t.id, team: t.shortName, ratings: r.ratings, manual: r.manual }];
    })
    .sort((a, b) => a.team.localeCompare(b.team));
}

export interface UnratedTeamRow {
  teamId: string;
  team: string;
  /** Learned matches (0 without ratings). */
  matches: number;
  hasRatings: boolean;
  /** The stored ratings, null when the team has none. */
  ratings: Record<string, number> | null;
  /** Scheduled scraped matches still to come. */
  upcoming: number;
  nextKickoff: Date;
}

/**
 * Teams that keep a match from opening on the model (rule O1): every football team of a scheduled
 * scraped match still to come whose ratings `calibrated` rejects, most upcoming matches first.
 * The caller supplies the calibration rule (isCalibrated of @vamos/scraper, which this package
 * does not depend on).
 */
export async function listUnratedTeams(
  exec: DbExecutor,
  options: RatingsListOptions & {
    now: Date;
    calibrated: (ratings: Record<string, number> | null) => boolean;
  },
): Promise<UnratedTeamRow[]> {
  const upcoming = await exec
    .select({
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
      startTime: events.startTime,
    })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.status, 'scheduled'),
        isNull(events.resultedAt),
        gt(events.startTime, options.now),
      ),
    );
  const playing = new Map<string, { count: number; next: Date }>();
  for (const event of upcoming) {
    for (const id of [event.homeTeamId, event.awayTeamId]) {
      if (id === null) continue;
      const seen = playing.get(id);
      if (seen === undefined) playing.set(id, { count: 1, next: event.startTime });
      else {
        seen.count += 1;
        if (event.startTime.getTime() < seen.next.getTime()) seen.next = event.startTime;
      }
    }
  }
  const candidates = (await footballTeamNames(exec)).filter(
    (t) =>
      playing.has(t.id) &&
      (options.nameKey === '' ||
        t.names.some((n) => options.normalize(n).includes(options.nameKey))),
  );
  const current = await getTeamRatings(
    exec,
    candidates.map((t) => t.id),
  );
  return candidates
    .filter((t) => !options.calibrated(current.get(t.id)?.ratings ?? null))
    .map((t) => {
      const got = current.get(t.id);
      const plays = playing.get(t.id)!;
      return {
        teamId: t.id,
        team: t.shortName,
        matches: got?.matches ?? 0,
        hasRatings: (got?.ratings ?? null) !== null,
        ratings: got?.ratings ?? null,
        upcoming: plays.count,
        nextKickoff: plays.next,
      };
    })
    .sort(
      (a, b) =>
        b.upcoming - a.upcoming ||
        a.nextKickoff.getTime() - b.nextKickoff.getTime() ||
        a.team.localeCompare(b.team),
    );
}
