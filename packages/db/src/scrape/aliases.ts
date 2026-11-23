import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { categories, competitions, teams, type LocalizedName } from '../schema/catalog';
import { competitionAliases, scrapeSources, teamAliases } from '../schema/scrape';
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
  competitions: Array<{
    id: string;
    slug: string;
    sportId: string;
    names: string[];
    /** L1: the category, when it is one country's (has a country code); else null. */
    countryCategoryId: string | null;
  }>;
  competitionAliases: Array<{
    aliasNorm: string;
    sourceId: string | null;
    competitionId: string;
  }>;
  /** L1: the competitions the targets of source-scoped team aliases have events in. */
  teamCompetitions: Array<{ teamId: string; competitionId: string }>;
  /** L2: each source's upstream. */
  sourceUpstreams: Array<{ sourceId: string; upstream: string }>;
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

export interface NewTeamInput {
  sportId: string;
  name: LocalizedName;
  shortName: string;
  countryCode: string | null;
  /** The raw name of the review item, normalised by the caller (it becomes the alias). */
  aliasNorm: string;
  sourceId: string | null;
  /** The scraper's normalizeName: names and aliases are compared through it. */
  normalize: (name: string) => string;
}

/**
 * Creates a catalogue team from an unknown-team review item and maps the raw name to
 * it, audited. The team has no ratings: O1 keeps its matches closed until they are
 * learned or reviewed. `shortName` is the per-sport unique key (the team's slug): a clash
 * gets a numeric suffix. Refused with 409 `team_exists` when a team of the sport already
 * has the new name or the raw name as its name, short name or alias (map the item instead).
 */
export async function addTeamWithAlias(
  tx: DbTransaction,
  input: NewTeamInput,
  actor: ScrapeActor,
): Promise<{ teamId: string; shortName: string; aliasId: string }> {
  assertAliasText(input.aliasNorm);
  const wanted = new Set(
    [input.aliasNorm, ...localizedNames(input.name)]
      .map((n) => input.normalize(n))
      .filter((n) => n !== ''),
  );
  const existing = await tx
    .select({ id: teams.id, shortName: teams.shortName, name: teams.name })
    .from(teams)
    .where(eq(teams.sportId, input.sportId));
  for (const team of existing) {
    const known = [team.shortName, ...localizedNames(team.name)].map((n) => input.normalize(n));
    if (known.some((n) => wanted.has(n))) throw teamExists(team.id);
  }
  const aliases = await tx
    .select({ teamId: teamAliases.teamId, aliasNorm: teamAliases.aliasNorm })
    .from(teamAliases)
    .where(eq(teamAliases.sportId, input.sportId));
  for (const alias of aliases) {
    if (wanted.has(alias.aliasNorm)) throw teamExists(alias.teamId);
  }

  const taken = new Set(existing.map((t) => t.shortName));
  let shortName = input.shortName;
  for (let n = 2; taken.has(shortName); n += 1) {
    const suffix = ` ${n}`;
    shortName = input.shortName.slice(0, 40 - suffix.length) + suffix;
  }
  const [team] = await tx
    .insert(teams)
    .values({
      sportId: input.sportId,
      name: input.name,
      shortName,
      countryCode: input.countryCode,
      ratings: null,
    })
    .returning({ id: teams.id });
  if (team === undefined) throw new Error('team insert returned no row');
  await auditScrape(tx, actor, {
    action: 'scrape.team.added',
    targetType: 'team',
    targetId: team.id,
    metadata: { sportId: input.sportId, name: input.name, shortName, aliasNorm: input.aliasNorm },
  });
  const { alias } = await addTeamAlias(
    tx,
    {
      sportId: input.sportId,
      aliasNorm: input.aliasNorm,
      sourceId: input.sourceId,
      teamId: team.id,
    },
    actor,
  );
  return { teamId: team.id, shortName, aliasId: alias.id };
}

const teamExists = (existingTeamId: string) =>
  domainConflict(
    'team_exists',
    'A team with this name already exists: map the name to it instead',
    {
      existingTeamId,
    },
  );

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

/**
 * Removes an alias (audited). Observations keep the ids they already resolved to
 * until they are re-resolved: the scraper's promotion pass does so when the alias
 * tables changed (`reresolveChangedAliases`), and a new fetch writes the new resolution.
 */
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
  const [
    teamRows,
    teamAliasRows,
    competitionRows,
    competitionAliasRows,
    teamCompetitionRows,
    sourceRows,
  ] = await Promise.all([
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
        categoryId: competitions.categoryId,
        countryCode: categories.countryCode,
      })
      .from(competitions)
      .leftJoin(categories, eq(categories.id, competitions.categoryId))
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
    // L1: only the teams some source-scoped alias points to (a few hundred), each once per competition.
    exec.execute<{ teamId: string; competitionId: string }>(sql`
      SELECT DISTINCT x.team_id AS "teamId", x.competition_id AS "competitionId"
      FROM (
        SELECT home_team_id AS team_id, competition_id FROM events
        UNION ALL
        SELECT away_team_id AS team_id, competition_id FROM events
      ) x
      WHERE x.team_id IN (
        SELECT team_id FROM team_aliases WHERE sport_id = ${sportId} AND source_id IS NOT NULL
      )
      ORDER BY 1, 2`),
    exec
      .select({ sourceId: scrapeSources.id, upstream: scrapeSources.upstream })
      .from(scrapeSources)
      .orderBy(asc(scrapeSources.id)),
  ]);
  return {
    teams: teamRows.map(({ name, ...team }) => ({ ...team, names: localizedNames(name) })),
    teamAliases: teamAliasRows,
    competitions: competitionRows.map(({ name, categoryId, countryCode, ...c }) => ({
      ...c,
      names: localizedNames(name),
      countryCategoryId: countryCode === null || countryCode === '' ? null : categoryId,
    })),
    competitionAliases: competitionAliasRows,
    teamCompetitions: teamCompetitionRows.rows,
    sourceUpstreams: sourceRows,
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

/** L4 (docs/plans/name-learning.md): one alias as the file of mappings holds it. */
export interface AliasExportRow {
  kind: AliasKind;
  sport: string;
  aliasNorm: string;
  /** A team's short name (unique in its sport) or a competition's slug. */
  target: string;
  sourceId: string | null;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * L4: every alias, its target named as the file of mappings names it (a team by its short name,
 * unique in its sport by `teams_sport_short_name_uq`; a competition by its slug), in a fixed order.
 */
export async function exportAliases(exec: DbExecutor): Promise<AliasExportRow[]> {
  const [teamRows, competitionRows] = await Promise.all([
    exec
      .select({
        sport: teamAliases.sportId,
        aliasNorm: teamAliases.aliasNorm,
        sourceId: teamAliases.sourceId,
        shortName: teams.shortName,
      })
      .from(teamAliases)
      .innerJoin(teams, eq(teams.id, teamAliases.teamId)),
    exec
      .select({
        sport: competitionAliases.sportId,
        aliasNorm: competitionAliases.aliasNorm,
        sourceId: competitionAliases.sourceId,
        slug: competitions.slug,
      })
      .from(competitionAliases)
      .innerJoin(competitions, eq(competitions.id, competitionAliases.competitionId)),
  ]);
  const rows: AliasExportRow[] = [];
  for (const row of teamRows) {
    rows.push({
      kind: 'team',
      sport: row.sport,
      aliasNorm: row.aliasNorm,
      target: row.shortName,
      sourceId: row.sourceId,
    });
  }
  for (const row of competitionRows) {
    rows.push({
      kind: 'competition',
      sport: row.sport,
      aliasNorm: row.aliasNorm,
      target: row.slug,
      sourceId: row.sourceId,
    });
  }
  rows.sort(
    (a, b) =>
      byText(a.kind, b.kind) ||
      byText(a.sport, b.sport) ||
      byText(a.aliasNorm, b.aliasNorm) ||
      byText(a.sourceId ?? '', b.sourceId ?? ''),
  );
  return rows;
}

/** L4: whether someone removed an alias of this spelling and scope (audit `scrape.alias.removed`). */
export async function aliasWasRemoved(
  exec: DbExecutor,
  kind: AliasKind,
  aliasNorm: string,
  sourceId: string | null,
): Promise<boolean> {
  const result = await exec.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM audit_log
    WHERE action = 'scrape.alias.removed'
      AND target_type = ${kind === 'team' ? 'team_alias' : 'competition_alias'}
      AND metadata->>'aliasNorm' = ${aliasNorm}
      AND coalesce(metadata->>'sourceId', '') = ${sourceId ?? ''}`);
  return (result.rows[0]?.n ?? 0) > 0;
}
