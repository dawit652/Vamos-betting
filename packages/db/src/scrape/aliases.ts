import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { competitions, teams, type LocalizedName } from '../schema/catalog';
import { competitionAliases, teamAliases } from '../schema/scrape';
import {
  actorLabel,
  auditScrape,
  clampLimit,
  ScrapeAliasConflictError,
  type ScrapeActor,
} from './common';

export type AliasKind = 'team' | 'competition';

export interface AliasInput {
  sportId: string;
  /** Already normalised by the caller (normalizeName in @vamos/scraper). */
  aliasNorm: string;
  /** null = valid for every source. */
  sourceId: string | null;
}

export interface TeamAliasInput extends AliasInput {
  teamId: string;
}

export interface CompetitionAliasInput extends AliasInput {
  competitionId: string;
}

export interface AliasRecord {
  kind: AliasKind;
  id: string;
  sportId: string;
  aliasNorm: string;
  sourceId: string | null;
  /** The team or competition the alias points to. */
  targetId: string;
  createdAt: Date;
  createdBy: string | null;
}

/** The exact arrays buildAliasIndex (@vamos/scraper) takes. */
export interface AliasInputs {
  teams: Array<{ id: string; sportId: string; shortName: string; names: string[] }>;
  teamAliases: Array<{ aliasNorm: string; sourceId: string | null; teamId: string }>;
  competitions: Array<{ id: string; slug: string; sportId: string; names: string[] }>;
  competitionAliases: Array<{
    aliasNorm: string;
    sourceId: string | null;
    competitionId: string;
  }>;
}

function assertAliasText(aliasNorm: string): void {
  if (aliasNorm === '' || aliasNorm !== aliasNorm.trim()) {
    throw domainUnprocessable(
      'scrape_bad_alias',
      'an alias must be a non-empty normalised name without surrounding spaces',
    );
  }
}

/** All distinct, non-empty localized names of a catalogue row. */
export function localizedNames(name: LocalizedName): string[] {
  return [
    ...new Set(Object.values(name).filter((v): v is string => typeof v === 'string' && v !== '')),
  ];
}

/**
 * Maps a normalised raw team name to a catalogue team (for one source or all).
 * Idempotent: the same mapping again returns the existing row (`created`
 * false). The same (sport, name, source) pointing at another team is refused
 * with ScrapeAliasConflictError: a trader must remove the old alias first.
 */
export async function addTeamAlias(
  tx: DbTransaction,
  input: TeamAliasInput,
  actor: ScrapeActor,
): Promise<{ alias: AliasRecord; created: boolean }> {
  assertAliasText(input.aliasNorm);
  const [team] = await tx
    .select({ sportId: teams.sportId })
    .from(teams)
    .where(eq(teams.id, input.teamId));
  if (team === undefined) throw domainNotFound('team');
  if (team.sportId !== input.sportId) {
    throw domainUnprocessable('scrape_alias_sport', 'the team belongs to another sport');
  }
  const [row] = await tx
    .insert(teamAliases)
    .values({ ...input, createdBy: actorLabel(actor) })
    .onConflictDoNothing()
    .returning();
  if (row !== undefined) {
    await auditScrape(tx, actor, {
      action: 'scrape.alias.added',
      targetType: 'team_alias',
      targetId: row.id,
      metadata: { aliasNorm: input.aliasNorm, sourceId: input.sourceId, teamId: input.teamId },
    });
    return { alias: teamRecord(row), created: true };
  }
  const [existing] = await tx
    .select()
    .from(teamAliases)
    .where(
      and(
        eq(teamAliases.sportId, input.sportId),
        eq(teamAliases.aliasNorm, input.aliasNorm),
        sql`${teamAliases.sourceId} IS NOT DISTINCT FROM ${input.sourceId}`,
      ),
    );
  if (existing === undefined) throw new Error('team alias vanished during insert');
  if (existing.teamId !== input.teamId) {
    throw new ScrapeAliasConflictError('team', input.aliasNorm, input.sourceId, existing.teamId);
  }
  return { alias: teamRecord(existing), created: false };
}

/** The same for competition labels. */
export async function addCompetitionAlias(
  tx: DbTransaction,
  input: CompetitionAliasInput,
  actor: ScrapeActor,
): Promise<{ alias: AliasRecord; created: boolean }> {
  assertAliasText(input.aliasNorm);
  const [competition] = await tx
    .select({ sportId: competitions.sportId })
    .from(competitions)
    .where(eq(competitions.id, input.competitionId));
  if (competition === undefined) throw domainNotFound('competition');
  if (competition.sportId !== input.sportId) {
    throw domainUnprocessable('scrape_alias_sport', 'the competition belongs to another sport');
  }
  const [row] = await tx
    .insert(competitionAliases)
    .values({ ...input, createdBy: actorLabel(actor) })
    .onConflictDoNothing()
    .returning();
  if (row !== undefined) {
    await auditScrape(tx, actor, {
      action: 'scrape.alias.added',
      targetType: 'competition_alias',
      targetId: row.id,
      metadata: {
        aliasNorm: input.aliasNorm,
        sourceId: input.sourceId,
        competitionId: input.competitionId,
      },
    });
    return { alias: competitionRecord(row), created: true };
  }
  const [existing] = await tx
    .select()
    .from(competitionAliases)
    .where(
      and(
        eq(competitionAliases.sportId, input.sportId),
        eq(competitionAliases.aliasNorm, input.aliasNorm),
        sql`${competitionAliases.sourceId} IS NOT DISTINCT FROM ${input.sourceId}`,
      ),
    );
  if (existing === undefined) throw new Error('competition alias vanished during insert');
  if (existing.competitionId !== input.competitionId) {
    throw new ScrapeAliasConflictError(
      'competition',
      input.aliasNorm,
      input.sourceId,
      existing.competitionId,
    );
  }
  return { alias: competitionRecord(existing), created: false };
}

/** Removes an alias (audited). Observations keep the ids they already resolved to until re-resolved. */
export async function removeAlias(
  tx: DbTransaction,
  kind: AliasKind,
  id: string,
  actor: ScrapeActor,
): Promise<AliasRecord> {
  const removed =
    kind === 'team'
      ? await tx.delete(teamAliases).where(eq(teamAliases.id, id)).returning()
      : await tx.delete(competitionAliases).where(eq(competitionAliases.id, id)).returning();
  const row = removed[0];
  if (row === undefined) throw domainNotFound('alias');
  const record = 'teamId' in row ? teamRecord(row) : competitionRecord(row);
  await auditScrape(tx, actor, {
    action: 'scrape.alias.removed',
    targetType: kind === 'team' ? 'team_alias' : 'competition_alias',
    targetId: id,
    metadata: { aliasNorm: record.aliasNorm, sourceId: record.sourceId, targetId: record.targetId },
  });
  return record;
}

const teamRecord = (row: typeof teamAliases.$inferSelect): AliasRecord => ({
  kind: 'team',
  id: row.id,
  sportId: row.sportId,
  aliasNorm: row.aliasNorm,
  sourceId: row.sourceId,
  targetId: row.teamId,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
});

const competitionRecord = (row: typeof competitionAliases.$inferSelect): AliasRecord => ({
  kind: 'competition',
  id: row.id,
  sportId: row.sportId,
  aliasNorm: row.aliasNorm,
  sourceId: row.sourceId,
  targetId: row.competitionId,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
});

/** Everything buildAliasIndex needs for one sport: the catalogue's names and every alias. */
export async function loadAliasInputs(exec: DbExecutor, sportId: string): Promise<AliasInputs> {
  const [teamRows, teamAliasRows, competitionRows, competitionAliasRows] = await Promise.all([
    exec
      .select({
        id: teams.id,
        sportId: teams.sportId,
        shortName: teams.shortName,
        name: teams.name,
      })
      .from(teams)
      .where(eq(teams.sportId, sportId))
      .orderBy(asc(teams.id)),
    exec
      .select({
        aliasNorm: teamAliases.aliasNorm,
        sourceId: teamAliases.sourceId,
        teamId: teamAliases.teamId,
      })
      .from(teamAliases)
      .where(eq(teamAliases.sportId, sportId))
      .orderBy(asc(teamAliases.aliasNorm), asc(teamAliases.id)),
    exec
      .select({
        id: competitions.id,
        slug: competitions.slug,
        sportId: competitions.sportId,
        name: competitions.name,
      })
      .from(competitions)
      .where(eq(competitions.sportId, sportId))
      .orderBy(asc(competitions.id)),
    exec
      .select({
        aliasNorm: competitionAliases.aliasNorm,
        sourceId: competitionAliases.sourceId,
        competitionId: competitionAliases.competitionId,
      })
      .from(competitionAliases)
      .where(eq(competitionAliases.sportId, sportId))
      .orderBy(asc(competitionAliases.aliasNorm), asc(competitionAliases.id)),
  ]);
  return {
    teams: teamRows.map(({ name, ...team }) => ({ ...team, names: localizedNames(name) })),
    teamAliases: teamAliasRows,
    competitions: competitionRows.map(({ name, ...c }) => ({ ...c, names: localizedNames(name) })),
    competitionAliases: competitionAliasRows,
  };
}

export interface AliasListRow extends AliasRecord {
  /** English name (teams) or slug-and-name (competitions) of the target, for display. */
  targetLabel: string;
}

/** Aliases for the back office, newest first. */
export async function listAliases(
  exec: DbExecutor,
  options: { kind?: AliasKind; sportId?: string; sourceId?: string; limit?: number } = {},
): Promise<AliasListRow[]> {
  const limit = clampLimit(options.limit, 200, 2000);
  const out: AliasListRow[] = [];
  if (options.kind !== 'competition') {
    const filters: SQL[] = [];
    if (options.sportId !== undefined) filters.push(eq(teamAliases.sportId, options.sportId));
    if (options.sourceId !== undefined) filters.push(eq(teamAliases.sourceId, options.sourceId));
    const rows = await exec
      .select({ alias: teamAliases, name: teams.name, shortName: teams.shortName })
      .from(teamAliases)
      .innerJoin(teams, eq(teams.id, teamAliases.teamId))
      .where(and(...filters))
      .orderBy(sql`${teamAliases.createdAt} DESC`, sql`${teamAliases.id} DESC`)
      .limit(limit);
    for (const row of rows) {
      out.push({ ...teamRecord(row.alias), targetLabel: row.name.en || row.shortName });
    }
  }
  if (options.kind !== 'team') {
    const filters: SQL[] = [];
    if (options.sportId !== undefined) {
      filters.push(eq(competitionAliases.sportId, options.sportId));
    }
    if (options.sourceId !== undefined) {
      filters.push(eq(competitionAliases.sourceId, options.sourceId));
    }
    const rows = await exec
      .select({ alias: competitionAliases, name: competitions.name, slug: competitions.slug })
      .from(competitionAliases)
      .innerJoin(competitions, eq(competitions.id, competitionAliases.competitionId))
      .where(and(...filters))
      .orderBy(sql`${competitionAliases.createdAt} DESC`, sql`${competitionAliases.id} DESC`)
      .limit(limit);
    for (const row of rows) {
      out.push({ ...competitionRecord(row.alias), targetLabel: row.name.en || row.slug });
    }
  }
  return out
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, limit);
}
