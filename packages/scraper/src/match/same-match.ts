import { nameSimilarity } from '../normalize/alias';
import { STRONG_FIXTURE_SIMILARITY } from '../normalize/fixture-context';

/**
 * Two boards' listings of one real match (docs/plans/narobet-events.md, "Never a second copy"):
 * Hulusport and Narobet name clubs their own way, so a match both list must not become two events.
 * Pure: no I/O.
 *
 * Likely the same match when the kickoffs are within SAME_MATCH_KICKOFF_MS of each other and both
 * team names are alike in the same orientation (home with home): `nameSimilarity` at or above
 * STRONG_FIXTURE_SIMILARITY (0.6), the bar the league binding already uses (match/bind.ts). It is
 * meant to fail closed: a likely duplicate is not listed.
 */
export const SAME_MATCH_KICKOFF_MS = 15 * 60_000;

export interface MatchListing {
  home: string;
  away: string;
  kickoff: Date;
}

/** True when both names are alike (symmetric: the better of the two directions; scores are milli). */
function alike(a: string, b: string): boolean {
  const score = Math.max(nameSimilarity(a, [b]).score, nameSimilarity(b, [a]).score) / 1000;
  return score >= STRONG_FIXTURE_SIMILARITY;
}

export function sameMatchLikely(a: MatchListing, b: MatchListing): boolean {
  if (Math.abs(a.kickoff.getTime() - b.kickoff.getTime()) > SAME_MATCH_KICKOFF_MS) return false;
  return alike(a.home, b.home) && alike(a.away, b.away);
}
