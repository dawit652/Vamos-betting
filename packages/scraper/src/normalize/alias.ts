import { legalFormStripped, nameTokens, normalizeName } from './name';
import { suspiciousAlias, variantConflict } from './variant';

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
  /**
   * L1: the competition's country, when it is one country's (its category has a country code);
   * null or absent for an international or regional competition.
   */
  countryCategoryId?: string | null;
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

/** L1: a competition a team has an event in (any status). */
export interface TeamCompetitionRow {
  teamId: string;
  competitionId: string;
}

/** L2: who produces a source's data (`scrape_sources.upstream`). */
export interface SourceUpstreamRow {
  sourceId: string;
  upstream: string;
}

export interface AliasIndexInput {
  teams: readonly AliasTeam[];
  teamAliases: readonly TeamAliasRow[];
  competitions: readonly AliasCompetition[];
  competitionAliases: readonly CompetitionAliasRow[];
  /** L1: where the targets of source-scoped team aliases play; without it L1 learns nothing. */
  teamCompetitions?: readonly TeamCompetitionRow[];
  /** L2: the upstream of each source; without it L2 learns nothing. */
  sourceUpstreams?: readonly SourceUpstreamRow[];
}

export type Resolution =
  | {
      status: 'resolved';
      id: string;
      via: 'source_alias' | 'alias' | 'name' | 'name_relaxed' | 'learned' | 'provider_id';
    }
  | { status: 'unknown' }
  | { status: 'ambiguous'; ids: string[] };

export interface ResolveQuery {
  sportId: string;
  sourceId: string;
  raw: string;
  /** L1: the record's resolved competition; without it a team name is not learned. */
  competitionId?: string | null;
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

/** Rules L1 and L2 (docs/plans/name-learning.md): what other sources' mappings teach. */
interface LearnedIndex {
  /** Source-scoped team aliases of every source: `sport SEP norm` -> team ids. */
  teamsByNorm: ReadonlyMap<string, readonly string[]>;
  /** The competitions each of those teams has an event in. */
  playsIn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Competition -> its country's category, for one country's competitions only. */
  countryOf: ReadonlyMap<string, string>;
  /** Source-scoped competition aliases with a provider id: `sport SEP norm` -> competition ids. */
  competitionsByNorm: ReadonlyMap<string, readonly string[]>;
  /** The same, by provider: `sport SEP upstream SEP id` -> competition ids. */
  competitionsByProviderId: ReadonlyMap<string, readonly string[]>;
  /** Source id -> upstream. */
  upstreamOf: ReadonlyMap<string, string>;
  /** Team id -> its catalogue names and short name (L3's guard). */
  namesOf: ReadonlyMap<string, readonly string[]>;
}

/** Opaque, immutable lookup structure; build it with buildAliasIndex. */
export interface AliasIndex {
  readonly teams: EntityIndex;
  readonly competitions: EntityIndex;
  readonly learned: LearnedIndex;
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
    learned: buildLearnedIndex(input),
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

/** A competition name that carries its provider's id, as API-Football's do: "England - Premier League [39]". */
const PROVIDER_ID = /\[(\d{1,9})\]\s*$/;

function providerIdOf(raw: string): string | null {
  return PROVIDER_ID.exec(raw)?.[1] ?? null;
}

function buildLearnedIndex(input: AliasIndexInput): LearnedIndex {
  const sportOfTeam = new Map(input.teams.map((t) => [t.id, t.sportId]));
  const sportOfCompetition = new Map(input.competitions.map((c) => [c.id, c.sportId]));
  const upstreamOf = new Map((input.sourceUpstreams ?? []).map((s) => [s.sourceId, s.upstream]));
  const teamsByNorm = new Map<string, Set<string>>();
  for (const alias of input.teamAliases) {
    const sportId = sportOfTeam.get(alias.teamId);
    const norm = normalizeName(alias.aliasNorm);
    if (alias.sourceId === null || sportId === undefined || norm === '') continue;
    addTo(teamsByNorm, sportId + SEP + norm, alias.teamId);
  }
  const playsIn = new Map<string, Set<string>>();
  for (const row of input.teamCompetitions ?? []) addTo(playsIn, row.teamId, row.competitionId);
  const countryOf = new Map<string, string>();
  for (const c of input.competitions) {
    if (c.countryCategoryId !== undefined && c.countryCategoryId !== null) {
      countryOf.set(c.id, c.countryCategoryId);
    }
  }
  const competitionsByNorm = new Map<string, Set<string>>();
  const competitionsByProviderId = new Map<string, Set<string>>();
  for (const alias of input.competitionAliases) {
    const sportId = sportOfCompetition.get(alias.competitionId);
    const norm = normalizeName(alias.aliasNorm);
    if (alias.sourceId === null || sportId === undefined || norm === '') continue;
    // Only a spelling whose last word is a number can carry a provider id; the stored alias is
    // normalised (the brackets are gone), so the query side checks for them (learnedCompetition).
    const id = /(?:^| )(\d{1,9})$/.exec(norm)?.[1];
    if (id === undefined) continue;
    addTo(competitionsByNorm, sportId + SEP + norm, alias.competitionId);
    const upstream = upstreamOf.get(alias.sourceId);
    if (upstream !== undefined) {
      addTo(competitionsByProviderId, sportId + SEP + upstream + SEP + id, alias.competitionId);
    }
  }
  return {
    teamsByNorm: freeze(teamsByNorm),
    playsIn,
    countryOf,
    competitionsByNorm: freeze(competitionsByNorm),
    competitionsByProviderId: freeze(competitionsByProviderId),
    upstreamOf,
    namesOf: new Map(input.teams.map((t) => [t.id, [...t.names, t.shortName]])),
  };
}

/**
 * Whether team T fits competition C for L1: T has an event in C, or C is one country's and T has
 * an event in a competition of the same country. An international competition needs the first.
 */
function fitsCompetition(learned: LearnedIndex, teamId: string, competitionId: string): boolean {
  const plays = learned.playsIn.get(teamId);
  if (plays === undefined) return false;
  if (plays.has(competitionId)) return true;
  const country = learned.countryOf.get(competitionId);
  if (country === undefined) return false;
  for (const other of plays) if (learned.countryOf.get(other) === country) return true;
  return false;
}

/**
 * Rule L1 for teams: a name no level knows, mapped for ANOTHER source by a person (or by N4),
 * resolves to that team when exactly one such team fits the record's competition
 * (`fitsCompetition`). Without a resolved competition, or with none or several fitting, the name
 * stays unknown and a person is asked, as before.
 */
function learnedTeam(
  learned: LearnedIndex,
  teams: EntityIndex,
  query: ResolveQuery,
): Resolution | null {
  const competitionId = query.competitionId;
  if (competitionId === undefined || competitionId === null) return null;
  const norm = normalizeName(query.raw);
  if (norm === '') return null;
  const ids = learned.teamsByNorm.get(query.sportId + SEP + norm) ?? [];
  if (ids.length === 0 || sharedSpelling(teams, query.sportId, norm)) return null;
  // L3: a mapping that looks wrong (another side of the club, a national team, or a telling word
  // the team's names lack: the daily alias check's rule) is never spread to other sources.
  const fitting = ids.filter(
    (id) =>
      fitsCompetition(learned, id, competitionId) &&
      suspiciousAlias(query.raw, learned.namesOf.get(id) ?? []) === null,
  );
  const only = fitting.length === 1 ? fitting[0] : undefined;
  return only === undefined ? null : { status: 'resolved', id: only, via: 'learned' };
}

/**
 * Rules L1 and L2 for competitions, only for a name that carries its provider's id
 * ("England - Premier League [39]"): the same spelling mapped for another source (L1), else the
 * same id from a source of the same upstream under another spelling (L2, a renamed league). A
 * plain name such as "Ligue 1" is never learned: several countries use it.
 */
function learnedCompetition(learned: LearnedIndex, query: ResolveQuery): Resolution | null {
  const id = providerIdOf(query.raw);
  if (id === null) return null;
  const norm = normalizeName(query.raw);
  const sameSpelling = learned.competitionsByNorm.get(query.sportId + SEP + norm);
  if (sameSpelling !== undefined && sameSpelling.length === 1) {
    return { status: 'resolved', id: sameSpelling[0] as string, via: 'learned' };
  }
  if (sameSpelling !== undefined) return null;
  const upstream = learned.upstreamOf.get(query.sourceId);
  if (upstream === undefined) return null;
  const byId = learned.competitionsByProviderId.get(query.sportId + SEP + upstream + SEP + id);
  return byId !== undefined && byId.length === 1
    ? { status: 'resolved', id: byId[0] as string, via: 'provider_id' }
    : null;
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
 * name none of them knows, the catalogue name without the legal form (N2b); then what other
 * sources' mappings teach (L1, `learnedTeam`).
 */
export function resolveTeam(index: AliasIndex, query: ResolveQuery): Resolution {
  const found = resolve(index.teams, query, true);
  if (found.status !== 'unknown') return found;
  return learnedTeam(index.learned, index.teams, query) ?? found;
}

/**
 * L1: whether the names of more than one catalogue team of the sport contain every word of the
 * spelling ("dynamo": Dynamo Dresden, BFC Dynamo, Dynamo Kyiv). Such a spelling means different
 * clubs to different sources, even in one country, so a mapping of it is never spread.
 */
function sharedSpelling(teams: EntityIndex, sportId: string, norm: string): boolean {
  const words = nameTokens(norm);
  let count = 0;
  for (const entry of teams.catalogue.get(sportId) ?? []) {
    const has = entry.names.some((n) => words.every((w) => n.tokens.includes(w)));
    if (has && ++count > 1) return true;
  }
  return false;
}

/** Rule N2 for competitions; then, for an unknown name with a provider id, L1 and L2. */
export function resolveCompetition(index: AliasIndex, query: ResolveQuery): Resolution {
  const found = resolve(index.competitions, query, false);
  if (found.status !== 'unknown') return found;
  return learnedCompetition(index.learned, query) ?? found;
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

/** The N3 similarity of two token lists in permille: Jaccard overlap plus the first-token prefix bonus. */
function similarityPermille(a: readonly string[], b: readonly string[]): number {
  let score = jaccardPermille(a, b);
  if (sharesFirstTokenPrefix(a, b)) score += PREFIX_BONUS;
  return Math.min(1000, score);
}

/**
 * The best N3 similarity (permille, 0..1000) of a raw name against a list of names, with the name
 * that scored it (normalised; ties to the alphabetically first). Both sides are normalised (N1)
 * first; an exact normalised match scores 1000. `{ score: 0, matchedName: '' }` for no names.
 */
export function nameSimilarity(
  raw: string,
  names: readonly string[],
): { score: number; matchedName: string } {
  const norm = normalizeName(raw);
  const tokens = nameTokens(norm);
  let best = { score: 0, matchedName: '' };
  for (const name of names) {
    const other = normalizeName(name);
    if (other === '') continue;
    const score = other === norm ? 1000 : similarityPermille(tokens, nameTokens(other));
    if (
      best.matchedName === '' ||
      score > best.score ||
      (score === best.score && other < best.matchedName)
    ) {
      best = { score, matchedName: other };
    }
  }
  return best;
}

/** The catalogue names (normalised, N1) of a team of the sport; empty for an unknown id. */
export function teamCatalogueNames(index: AliasIndex, sportId: string, teamId: string): string[] {
  const entry = (index.teams.catalogue.get(sportId) ?? []).find((e) => e.id === teamId);
  return entry === undefined ? [] : entry.names.map((n) => n.norm);
}

function suggest(
  index: EntityIndex,
  query: SuggestQuery,
  keep: (entry: CatalogueEntry) => boolean = () => true,
): Suggestion[] {
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
      const score = similarityPermille(tokens, name.tokens);
      if (
        best === null ||
        score > best.score ||
        (score === best.score && name.norm < best.matchedName)
      ) {
        best = { id: entry.id, score, matchedName: name.norm };
      }
    }
    if (best !== null && best.score >= SUGGESTION_MIN_SCORE && keep(entry)) out.push(best);
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, limit);
}

/** Rule N3: up to `limit` (default 3) catalogue teams that look like the raw name. Never applied. */
export function suggestTeams(index: AliasIndex, query: SuggestQuery): Suggestion[] {
  // L3: never another side of a club (reserve, youth, women's) or a national team.
  return suggest(
    index.teams,
    query,
    (entry) =>
      variantConflict(
        query.raw,
        entry.names.map((n) => n.norm),
      ) === null,
  );
}

/** Rule N3 for competitions. */
export function suggestCompetitions(index: AliasIndex, query: SuggestQuery): Suggestion[] {
  return suggest(index.competitions, query);
}
