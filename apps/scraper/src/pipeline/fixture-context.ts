import { SCRAPED_FEED_PROVIDER, SCRAPER_ACTOR } from '@vamos/core';
import {
  addTeamAlias,
  ScrapeAliasConflictError,
  writeAudit,
  type DbTransaction,
  type ScrapeReviewItem,
} from '@vamos/db';
import { auditLog, events, scrapeObservations } from '@vamos/db/schema';
import {
  combineFixtureContexts,
  fixtureContextSuggestions,
  normalizeName,
  teamCatalogueNames,
  FIXTURE_CONTEXT_WINDOW_MS,
  MIN_INDEPENDENT_SOURCES,
  AUTO_ALIAS_MIN_FIXTURES,
  type AliasIndex,
  type CatalogueFixture,
  type FixtureContextResult,
  type FixtureSide,
} from '@vamos/scraper';
import { and, eq, gte, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { fullTimeUpstreamsByCompetition } from '../lib/source-competition';

/**
 * Rule N4 (docs/scraper.md 6.4, U-4 of docs/feed-quality-plan.md): fixture-context suggestions
 * for unknown team names, and their optional automatic use as a SOURCE-SCOPED alias.
 *
 * Guardrail 4 of the plan: automatic name mapping is source-scoped and audited, never global, and
 * needs two independent signals (the name, and the fixture context). It writes an alias and
 * nothing else: events, bets and prices change only through the usual re-resolution and gates.
 */

/** Where an unknown team name was seen: its side, the kickoff, the resolved competition and opponent. */
export interface UnknownFixtureContext {
  side: FixtureSide;
  kickoff: Date;
  competitionId: string;
  opponentId: string;
}

/** At most this many sightings of one name are looked up per item (the first, in kickoff order). */
export const MAX_FIXTURE_SIGHTINGS = 5;

/** When N4 may apply a strong suggestion (SCRAPER_AUTO_ALIAS and the R2 coverage). */
export interface AutoAliasPolicy {
  enabled: boolean;
  /** Distinct enabled full-time upstreams of the competition (rule R2 needs MIN_INDEPENDENT_SOURCES). */
  fullTimeUpstreams(competitionId: string): Promise<number>;
}

/** Suggestions only (the default, and every path but a source's own fetch). */
export const SUGGEST_ONLY: AutoAliasPolicy = {
  enabled: false,
  fullTimeUpstreams: () => Promise.resolve(0),
};

/** The policy for one fetch: SCRAPER_AUTO_ALIAS, with the coverage read once when first needed. */
export function autoAliasPolicy(ctx: ScraperContext): AutoAliasPolicy {
  if (!ctx.config.scraper.autoAlias) return SUGGEST_ONLY;
  let coverage: Promise<Map<string, number>> | null = null;
  return {
    enabled: true,
    fullTimeUpstreams: async (competitionId) => {
      coverage ??= fullTimeUpstreamsByCompetition(ctx.db);
      return (await coverage).get(competitionId) ?? 0;
    },
  };
}

/**
 * The catalogue fixtures around one sighting: scraped events, and other sources' fully resolved
 * observations, of the competition within ±24 h whose home or away team is the opponent.
 */
async function catalogueFixtures(
  tx: DbTransaction,
  index: AliasIndex,
  sport: string,
  sourceId: string,
  at: UnknownFixtureContext,
): Promise<CatalogueFixture[]> {
  const from = new Date(at.kickoff.getTime() - FIXTURE_CONTEXT_WINDOW_MS);
  const to = new Date(at.kickoff.getTime() + FIXTURE_CONTEXT_WINDOW_MS);
  const scraped = await tx
    .select({ kickoff: events.startTime, home: events.homeTeamId, away: events.awayTeamId })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.competitionId, at.competitionId),
        or(eq(events.homeTeamId, at.opponentId), eq(events.awayTeamId, at.opponentId)),
        gte(events.startTime, from),
        lte(events.startTime, to),
      ),
    )
    .limit(50);
  const observed = await tx
    .select({
      kickoff: scrapeObservations.kickoff,
      home: scrapeObservations.homeTeamId,
      away: scrapeObservations.awayTeamId,
    })
    .from(scrapeObservations)
    .where(
      and(
        ne(scrapeObservations.sourceId, sourceId),
        eq(scrapeObservations.competitionId, at.competitionId),
        isNotNull(scrapeObservations.homeTeamId),
        isNotNull(scrapeObservations.awayTeamId),
        or(
          eq(scrapeObservations.homeTeamId, at.opponentId),
          eq(scrapeObservations.awayTeamId, at.opponentId),
        ),
        gte(scrapeObservations.kickoff, from),
        lte(scrapeObservations.kickoff, to),
      ),
    )
    .limit(200);
  const out: CatalogueFixture[] = [];
  for (const row of [...scraped, ...observed]) {
    if (row.home === null || row.away === null) continue;
    out.push({
      competitionId: at.competitionId,
      kickoff: row.kickoff,
      homeTeamId: row.home,
      awayTeamId: row.away,
      homeNames: teamCatalogueNames(index, sport, row.home),
      awayNames: teamCatalogueNames(index, sport, row.away),
    });
  }
  return out;
}

export interface FixtureContextLookup {
  /** The sightings looked up (at most MAX_FIXTURE_SIGHTINGS). */
  sightings: UnknownFixtureContext[];
  result: FixtureContextResult;
  /** L3: how many sightings name the strong candidate (0 without one). */
  agreeing: number;
}

/** Rule N4 for one unknown team name: the combined suggestion over its sightings. */
export async function lookupFixtureContext(
  tx: DbTransaction,
  index: AliasIndex,
  name: { sport: string; sourceId: string; raw: string },
  contexts: readonly UnknownFixtureContext[],
): Promise<FixtureContextLookup> {
  const sightings = contexts.slice(0, MAX_FIXTURE_SIGHTINGS);
  const results: FixtureContextResult[] = [];
  for (const at of sightings) {
    const fixtures = await catalogueFixtures(tx, index, name.sport, name.sourceId, at);
    results.push(fixtureContextSuggestions({ raw: name.raw, ...at }, fixtures));
  }
  const result = combineFixtureContexts(results);
  const strongId = result.strong?.teamId;
  const agreeing =
    strongId === undefined
      ? 0
      : results.filter((r) => r.candidates.some((c) => c.teamId === strongId)).length;
  return { sightings, result, agreeing };
}

/** A person removed an alias of this spelling (for this source or all): N4 never re-adds it. */
async function aliasRemovedBefore(
  tx: DbTransaction,
  aliasNorm: string,
  sourceId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'scrape.alias.removed'),
        eq(auditLog.targetType, 'team_alias'),
        sql`${auditLog.metadata}->>'aliasNorm' = ${aliasNorm}`,
        sql`coalesce(${auditLog.metadata}->>'sourceId', ${sourceId}) = ${sourceId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface AutoAliasDecision {
  teamId: string;
  fullTimeUpstreams: number;
}

/**
 * Whether N4 applies the strong suggestion of an unknown (not ambiguous) team name: the setting
 * is on, the suggestion is strong, every sighting's competition has at least two independent
 * full-time upstreams (R2), no person dismissed the name before and no person removed an alias of
 * it. Null: suggest only.
 */
export async function decideAutoAlias(
  tx: DbTransaction,
  policy: AutoAliasPolicy,
  name: { sourceId: string; raw: string; unknown: boolean; dismissedBefore: boolean },
  lookup: FixtureContextLookup,
): Promise<AutoAliasDecision | null> {
  const strong = lookup.result.strong;
  if (!policy.enabled || strong === null || !name.unknown || name.dismissedBefore) return null;
  // L3: two of the name's fixtures must agree on the team before it is mapped without a person.
  if (lookup.agreeing < AUTO_ALIAS_MIN_FIXTURES) return null;
  let upstreams = Infinity;
  for (const competitionId of new Set(lookup.sightings.map((s) => s.competitionId))) {
    upstreams = Math.min(upstreams, await policy.fullTimeUpstreams(competitionId));
  }
  if (!(upstreams >= MIN_INDEPENDENT_SOURCES) || !Number.isFinite(upstreams)) return null;
  if (await aliasRemovedBefore(tx, normalizeName(name.raw), name.sourceId)) return null;
  return { teamId: strong.teamId, fullTimeUpstreams: upstreams };
}

/**
 * Writes the N4 alias for the item's source only (never global; addTeamAlias audits
 * `scrape.alias.added`) and audits `scrape.alias.auto` with the evidence. Returns whether an
 * alias was created. The item closes when the observations re-resolve (reresolveUnresolved).
 */
export async function applyAutoAlias(
  tx: DbTransaction,
  item: ScrapeReviewItem,
  name: { sport: string; sourceId: string; raw: string },
  decision: AutoAliasDecision,
  lookup: FixtureContextLookup,
): Promise<boolean> {
  const aliasNorm = normalizeName(name.raw);
  const actor = { system: SCRAPER_ACTOR };
  let created: { id: string } | null = null;
  try {
    const added = await addTeamAlias(
      tx,
      { sportId: name.sport, aliasNorm, sourceId: name.sourceId, teamId: decision.teamId },
      actor,
    );
    if (added.created) created = { id: added.alias.id };
  } catch (error) {
    // The spelling already maps elsewhere for this source: a person decided; leave it.
    if (error instanceof ScrapeAliasConflictError) return false;
    throw error;
  }
  if (created === null) return false;
  const strong = lookup.result.strong!;
  await writeAudit(tx, {
    actorType: 'system',
    actorId: SCRAPER_ACTOR,
    action: 'scrape.alias.auto',
    targetType: 'team_alias',
    targetId: created.id,
    metadata: {
      rule: 'N4',
      reviewItemId: item.id,
      raw: name.raw,
      aliasNorm,
      sourceId: name.sourceId,
      teamId: decision.teamId,
      similarity: strong.score,
      matchedName: strong.matchedName,
      fullTimeUpstreams: decision.fullTimeUpstreams,
      sightings: lookup.sightings.map((s) => ({
        side: s.side,
        kickoff: s.kickoff.toISOString(),
        competitionId: s.competitionId,
        opponentId: s.opponentId,
      })),
    },
  });
  return true;
}
