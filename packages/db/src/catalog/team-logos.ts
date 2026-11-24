import { and, eq, gte, inArray, isNull, lt, lte, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../client';
import { events, teamLogos, teams } from '../schema';

/**
 * Team logos (owner, 17 Nov 2026: a logo for every team). The scraper's team-logos task finds the
 * football matches of the coming days whose teams have no logo yet, matches them to API-Football's
 * fixtures (which carry each team's id), downloads each logo once, stores it small, and marks the
 * teams it looked at so it does not ask again for a while. The site serves the stored PNG itself.
 */

export interface LogoTeam {
  id: string;
  name: string;
  /** No logo yet, and not looked for since the recheck period. */
  needsLogo: boolean;
}

export interface LogoCandidate {
  eventId: string;
  kickoff: Date;
  home: LogoTeam;
  away: LogoTeam;
}

const homeTeam = alias(teams, 'logo_home');
const awayTeam = alias(teams, 'logo_away');

/** Football matches starting within `horizonMs` with at least one team still to look for. */
export async function eventsNeedingTeamLogos(
  db: Database,
  input: { now: Date; horizonMs: number; recheckMs: number; limit: number },
): Promise<LogoCandidate[]> {
  const since = new Date(input.now.getTime() - input.recheckMs);
  const needs = (logoAt: AnyColumn, checkedAt: AnyColumn) =>
    and(isNull(logoAt), or(isNull(checkedAt), lt(checkedAt, since)));
  const rows = await db
    .select({
      eventId: events.id,
      kickoff: events.startTime,
      homeId: homeTeam.id,
      homeName: homeTeam.name,
      homeNeeds: sql<boolean>`${needs(homeTeam.logoAt, homeTeam.logoCheckedAt)}`,
      awayId: awayTeam.id,
      awayName: awayTeam.name,
      awayNeeds: sql<boolean>`${needs(awayTeam.logoAt, awayTeam.logoCheckedAt)}`,
    })
    .from(events)
    .innerJoin(homeTeam, eq(homeTeam.id, events.homeTeamId))
    .innerJoin(awayTeam, eq(awayTeam.id, events.awayTeamId))
    .where(
      and(
        eq(events.sportId, 'football'),
        eq(events.status, 'scheduled'),
        gte(events.startTime, input.now),
        lte(events.startTime, new Date(input.now.getTime() + input.horizonMs)),
        or(
          needs(homeTeam.logoAt, homeTeam.logoCheckedAt),
          needs(awayTeam.logoAt, awayTeam.logoCheckedAt),
        ),
      ),
    )
    .orderBy(events.startTime)
    .limit(input.limit);
  return rows.map((row) => ({
    eventId: row.eventId,
    kickoff: row.kickoff,
    home: { id: row.homeId, name: row.homeName.en, needsLogo: row.homeNeeds === true },
    away: { id: row.awayId, name: row.awayName.en, needsLogo: row.awayNeeds === true },
  }));
}

/** Stores a team's logo (replacing an older one) and marks the team as having one. */
export async function storeTeamLogo(
  db: Database,
  input: { teamId: string; apiFootballTeamId: number; png: Buffer; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(teamLogos)
      .values({
        teamId: input.teamId,
        apiFootballTeamId: input.apiFootballTeamId,
        png: input.png,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: teamLogos.teamId,
        set: { apiFootballTeamId: input.apiFootballTeamId, png: input.png, updatedAt: input.now },
      });
    await tx
      .update(teams)
      .set({ logoAt: input.now, logoCheckedAt: input.now })
      .where(eq(teams.id, input.teamId));
  });
}

/** Marks teams as looked for (no logo found), so the task skips them until the recheck period. */
export async function markTeamLogosChecked(
  db: Database,
  input: { teamIds: readonly string[]; now: Date },
): Promise<void> {
  if (input.teamIds.length === 0) return;
  await db
    .update(teams)
    .set({ logoCheckedAt: input.now })
    .where(inArray(teams.id, [...input.teamIds]));
}
