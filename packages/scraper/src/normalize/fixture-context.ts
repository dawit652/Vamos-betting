import { nameSimilarity } from './alias';

/**
 * Rule N4 (docs/scraper.md section 6.4, U-4 of docs/feed-quality-plan.md): fixture-context
 * suggestions for an unknown team name. Pure, no I/O.
 *
 * A source shows "X vs Arsenal" where X is unknown but Arsenal resolved. The catalogue (scraped
 * events, and other sources' resolved observations) holds the fixtures of the same competition.
 * Arsenal plays one match within a day of that kickoff; the team on X's side of that match is
 * the candidate. The name gives the second, independent signal (N3 similarity). Only exactly one
 * candidate team with a similarity of at least STRONG_FIXTURE_SIMILARITY is a strong suggestion.
 */

/** Catalogue fixtures this far either side of the row's kickoff count (plan: ±24 h). */
export const FIXTURE_CONTEXT_WINDOW_MS = 24 * 3_600_000;
/** A lone candidate needs at least this name similarity (0..1) to be strong. */
export const STRONG_FIXTURE_SIMILARITY = 0.6;

export type FixtureSide = 'home' | 'away';

/** A fixture the catalogue knows, both teams resolved. Names are the catalogue's names of each team. */
export interface CatalogueFixture {
  competitionId: string;
  kickoff: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeNames: readonly string[];
  awayNames: readonly string[];
}

export interface FixtureContextQuery {
  /** The unknown raw name. */
  raw: string;
  /** The side the unknown name is on in the source's row. */
  side: FixtureSide;
  kickoff: Date;
  /** The row's resolved competition and the resolved team on the other side. */
  competitionId: string;
  opponentId: string;
}

export interface FixtureContextCandidate {
  teamId: string;
  /** N3 name similarity, 0..1 (permille / 1000). */
  score: number;
  /** The catalogue name (normalised) that scored best. */
  matchedName: string;
  /** Kickoff of the catalogue fixture that named it (the closest one to the row's kickoff). */
  kickoff: Date;
}

export interface FixtureContextResult {
  /** Distinct candidate teams, best score first (ties: team id). */
  candidates: FixtureContextCandidate[];
  /** The candidate when it is the only one and scores at least STRONG_FIXTURE_SIMILARITY; else null. */
  strong: FixtureContextCandidate | null;
}

function byScore(a: FixtureContextCandidate, b: FixtureContextCandidate): number {
  return b.score - a.score || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0);
}

function strongOf(candidates: readonly FixtureContextCandidate[]): FixtureContextCandidate | null {
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return only !== undefined && only.score >= STRONG_FIXTURE_SIMILARITY ? only : null;
}

/**
 * The catalogue fixtures of the query's competition within FIXTURE_CONTEXT_WINDOW_MS of its
 * kickoff whose team on the OTHER side is the resolved opponent; each gives the team on the
 * query's side as a candidate (one entry per team, its best score and closest kickoff). The
 * opponent itself is never a candidate.
 */
export function fixtureContextSuggestions(
  query: FixtureContextQuery,
  fixtures: readonly CatalogueFixture[],
): FixtureContextResult {
  const byTeam = new Map<string, FixtureContextCandidate>();
  const at = query.kickoff.getTime();
  for (const f of fixtures) {
    if (f.competitionId !== query.competitionId) continue;
    const distance = Math.abs(f.kickoff.getTime() - at);
    if (!(distance <= FIXTURE_CONTEXT_WINDOW_MS)) continue;
    const opponent = query.side === 'home' ? f.awayTeamId : f.homeTeamId;
    const teamId = query.side === 'home' ? f.homeTeamId : f.awayTeamId;
    if (opponent !== query.opponentId || teamId === query.opponentId) continue;
    const { score, matchedName } = nameSimilarity(
      query.raw,
      query.side === 'home' ? f.homeNames : f.awayNames,
    );
    const candidate = { teamId, score: score / 1000, matchedName, kickoff: f.kickoff };
    const have = byTeam.get(teamId);
    if (
      have === undefined ||
      candidate.score > have.score ||
      (candidate.score === have.score && distance < Math.abs(have.kickoff.getTime() - at))
    ) {
      byTeam.set(teamId, candidate);
    }
  }
  const candidates = [...byTeam.values()].sort(byScore);
  return { candidates, strong: strongOf(candidates) };
}

/**
 * Several sightings of one unknown name (rows of different fixtures): the union of their
 * candidates (one per team, best score). Strong only when, across ALL sightings, exactly one team
 * is a candidate and it scores at least STRONG_FIXTURE_SIMILARITY: two sightings that point at
 * different teams contradict each other, and nothing is strong.
 */
export function combineFixtureContexts(
  results: readonly FixtureContextResult[],
): FixtureContextResult {
  const byTeam = new Map<string, FixtureContextCandidate>();
  for (const result of results) {
    for (const c of result.candidates) {
      const have = byTeam.get(c.teamId);
      if (have === undefined || c.score > have.score) byTeam.set(c.teamId, c);
    }
  }
  const candidates = [...byTeam.values()].sort(byScore);
  return { candidates, strong: strongOf(candidates) };
}
