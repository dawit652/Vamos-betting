import { legalFormStripped, nameTokens, normalizeName } from './name';

/**
 * Rules N2 and N3 (docs/scraper.md section 6.4): resolving a raw team or
 * competition name to a catalogue id, and suggesting candidates to a person.
 *
 * Resolution is EXACT equality of normalised names, never fuzzy: a wrong
 * match attaches a fixture or a result to the wrong team, which is worse than
 * an unresolved name that a person maps once. The index is built once, is
 * immutable, and answers in O(1) (Map lookups).
 */

export interface AliasTeam {
  id: string;
  sportId: string;
  shortName: string;
  names: readonly string[];
}

export interface AliasCompetition {
  id: string;
  slug: string;
  sportId: string;
  names: readonly string[];
}

/** `sourceId` null = valid for every source. */
export interface TeamAliasRow {
  aliasNorm: string;
  sourceId: string | null;
  teamId: string;
}

export interface CompetitionAliasRow {
  aliasNorm: string;
  sourceId: string | null;
  competitionId: string;
}

export interface AliasIndexInput {
  teams: readonly AliasTeam[];
  teamAliases: readonly TeamAliasRow[];
  competitions: readonly AliasCompetition[];
  competitionAliases: readonly CompetitionAliasRow[];
}

export type Resolution =
  | { status: 'resolved'; id: string; via: 'source_alias' | 'alias' | 'name' | 'name_relaxed' }
  | { status: 'unknown' }
  | { status: 'ambiguous'; ids: string[] };

export interface ResolveQuery {
  sportId: string;
  sourceId: string;
  raw: string;
}

export interface SuggestQuery {
  sportId: string;
  raw: string;
  limit?: number;
}

export interface Suggestion {
  id: string;
  /** Similarity in permille (0..1000); higher is closer. */
  score: number;
  /** The normalised catalogue name that scored best. */
  matchedName: string;
}

interface EntityIndex {
  /** Catalogue names and short names: `sport SEP norm` -> ids. */
  byName: ReadonlyMap<string, readonly string[]>;
  /** Global aliases: `sport SEP norm` -> ids. */
  byAlias: ReadonlyMap<string, readonly string[]>;
  /** Source-specific aliases: `sport SEP source SEP norm` -> ids. */
  bySourceAlias: ReadonlyMap<string, readonly string[]>;
  /** Catalogue names with the legal form taken off (N1b): `sport SEP relaxed` -> ids. */
  byRelaxedName: ReadonlyMap<string, readonly string[]>;
  /** Per sport, for suggestions only (linear scan, review UI). */
  catalogue: ReadonlyMap<string, readonly CatalogueEntry[]>;
}

interface CatalogueEntry {
  id: string;
  /** Distinct normalised names with their token sets. */
  names: readonly { norm: string; tokens: readonly string[] }[];
}

/** Opaque, immutable lookup structure; build it with buildAliasIndex. */
export interface AliasIndex {
  readonly teams: EntityIndex;
  readonly competitions: EntityIndex;
}

const SEP = '\u0001';

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  let ids = map.get(key);
  if (!ids) {
    ids = new Set();
    map.set(key, ids);
  }
  ids.add(id);
}

/** Sets to sorted arrays: a stable, deterministic `ids` for ambiguous answers. */
function freeze(map: Map<string, Set<string>>): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [key, ids] of map) out.set(key, Object.freeze([...ids].sort()));
  return out;
}

interface RawEntity {
  id: string;
  sportId: string;
  names: readonly string[];
}

interface RawAlias {
  aliasNorm: string;
  sourceId: string | null;
  id: string;
}

function buildEntityIndex(
  entities: readonly RawEntity[],
  aliases: readonly RawAlias[],
): EntityIndex {
  const byName = new Map<string, Set<string>>();
  const byAlias = new Map<string, Set<string>>();
  const bySourceAlias = new Map<string, Set<string>>();
  const byRelaxedName = new Map<string, Set<string>>();
  const sportOf = new Map<string, string>();
  const catalogue = new Map<string, CatalogueEntry[]>();

  for (const entity of entities) {
    sportOf.set(entity.id, entity.sportId);
    const seen = new Map<string, readonly string[]>();
    for (const raw of entity.names) {
      const norm = normalizeName(raw);
      if (norm === '') continue;
      addTo(byName, entity.sportId + SEP + norm, entity.id);
      addTo(byRelaxedName, entity.sportId + SEP + legalFormStripped(norm), entity.id);
      if (!seen.has(norm)) seen.set(norm, nameTokens(norm));
    }
    const list = catalogue.get(entity.sportId) ?? [];
    list.push({
      id: entity.id,
      names: [...seen].map(([norm, tokens]) => ({ norm, tokens })),
    });
    catalogue.set(entity.sportId, list);
  }

  for (const alias of aliases) {
    // An alias of an entity the catalogue does not hold has no sport to
    // scope it to: it cannot be trusted, so it is ignored.
    const sportId = sportOf.get(alias.id);
    if (sportId === undefined) continue;
    // Stored aliases are in normal form already; normalising again is a no-op
    // (N1 is idempotent) and protects against rows written by older code.
    const norm = normalizeName(alias.aliasNorm);
    if (norm === '') continue;
    if (alias.sourceId === null) addTo(byAlias, sportId + SEP + norm, alias.id);
    else addTo(bySourceAlias, sportId + SEP + alias.sourceId + SEP + norm, alias.id);
  }

  for (const list of catalogue.values())
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    byName: freeze(byName),
    byAlias: freeze(byAlias),
    bySourceAlias: freeze(bySourceAlias),
    byRelaxedName: freeze(byRelaxedName),
    catalogue,
  };
}

/** Builds the immutable lookup structure. Aliases are re-normalised on load. */
export function buildAliasIndex(input: AliasIndexInput): AliasIndex {
  return Object.freeze({
    teams: buildEntityIndex(
      input.teams.map((t) => ({ id: t.id, sportId: t.sportId, names: [...t.names, t.shortName] })),
      input.teamAliases.map((a) => ({
        aliasNorm: a.aliasNorm,
        sourceId: a.sourceId,
        id: a.teamId,
      })),
    ),
    competitions: buildEntityIndex(
      input.competitions.map((c) => ({ id: c.id, sportId: c.sportId, names: c.names })),
      input.competitionAliases.map((a) => ({
        aliasNorm: a.aliasNorm,
        sourceId: a.sourceId,
        id: a.competitionId,
      })),
    ),
  });
}

function fromLevel(
  ids: readonly string[] | undefined,
  via: 'source_alias' | 'alias' | 'name',
): Resolution | null {
  if (ids === undefined || ids.length === 0) return null;
  if (ids.length === 1) return { status: 'resolved', id: ids[0] as string, via };
  return { status: 'ambiguous', ids: [...ids] };
}

function resolve(index: EntityIndex, query: ResolveQuery, relaxed: boolean): Resolution {
  const norm = normalizeName(query.raw);
  if (norm === '') return { status: 'unknown' };
  // The first level that knows the name decides, even if it is ambiguous:
  // falling through to a weaker level would hide a conflict.
  return (
    fromLevel(
      index.bySourceAlias.get(query.sportId + SEP + query.sourceId + SEP + norm),
      'source_alias',
    ) ??
    fromLevel(index.byAlias.get(query.sportId + SEP + norm), 'alias') ??
    fromLevel(index.byName.get(query.sportId + SEP + norm), 'name') ??
    (relaxed ? relaxedName(index, query.sportId, norm) : null) ?? { status: 'unknown' }
  );
}

/**
 * Rule N2b: a name no level knows is compared once more with the legal form taken off both sides
 * (N1b: "Besiktas JK" and "Beşiktaş", "Falkirk F.C." and "Falkirk FC"). It resolves only when
 * exactly one catalogue entity matches; anything else stays unknown, as without the rule.
 */
function relaxedName(index: EntityIndex, sportId: string, norm: string): Resolution | null {
  const ids = index.byRelaxedName.get(sportId + SEP + legalFormStripped(norm));
  if (ids === undefined || ids.length !== 1) return null;
  return { status: 'resolved', id: ids[0] as string, via: 'name_relaxed' };
}

/**
 * Rule N2 for teams: source alias, then global alias, then catalogue name, exactly; then, for a
 * name none of them knows, the catalogue name without the legal form (N2b).
 */
export function resolveTeam(index: AliasIndex, query: ResolveQuery): Resolution {
  return resolve(index.teams, query, true);
}

/** Rule N2 for competitions. */
export function resolveCompetition(index: AliasIndex, query: ResolveQuery): Resolution {
  return resolve(index.competitions, query, false);
}

// ---------------------------------------------------------------------------
// Suggestions (N3)

/** Below this (permille) a candidate is noise and is not shown. */
export const SUGGESTION_MIN_SCORE = 250;
/** Permille added when the first tokens share a prefix of at least 3 letters. */
const PREFIX_BONUS = 100;
const MAX_LIMIT = 20;

function jaccardPermille(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : Math.floor((shared * 1000) / union);
}

function sharesFirstTokenPrefix(a: readonly string[], b: readonly string[]): boolean {
  const x = a[0];
  const y = b[0];
  if (x === undefined || y === undefined) return false;
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n >= 3;
}

function suggest(index: EntityIndex, query: SuggestQuery): Suggestion[] {
  const norm = normalizeName(query.raw);
  const limit = Math.min(MAX_LIMIT, Math.floor(query.limit ?? 3));
  if (norm === '' || !(limit > 0)) return [];
  const tokens = nameTokens(norm);
  const out: Suggestion[] = [];
  for (const entry of index.catalogue.get(query.sportId) ?? []) {
    // An entity the query already equals is an exact match, not a suggestion.
    if (entry.names.some((n) => n.norm === norm)) continue;
    let best: Suggestion | null = null;
    for (const name of entry.names) {
      let score = jaccardPermille(tokens, name.tokens);
      if (sharesFirstTokenPrefix(tokens, name.tokens)) score += PREFIX_BONUS;
      score = Math.min(1000, score);
      if (
        best === null ||
        score > best.score ||
        (score === best.score && name.norm < best.matchedName)
      ) {
        best = { id: entry.id, score, matchedName: name.norm };
      }
    }
    if (best !== null && best.score >= SUGGESTION_MIN_SCORE) out.push(best);
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, limit);
}

/** Rule N3: up to `limit` (default 3) catalogue teams that look like the raw name. Never applied. */
export function suggestTeams(index: AliasIndex, query: SuggestQuery): Suggestion[] {
  return suggest(index.teams, query);
}

/** Rule N3 for competitions. */
export function suggestCompetitions(index: AliasIndex, query: SuggestQuery): Suggestion[] {
  return suggest(index.competitions, query);
}
