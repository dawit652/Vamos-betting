import { MIN_INDEPENDENT_SOURCES } from '../constants';
import type { CoverageEntry } from '../adapters/capabilities';
import { upstreamKey } from '../gates/confirmation';

/**
 * Tiered polling of the metered odds API (docs/feed-quality-plan.md C-2). Pure: no I/O.
 *
 * - A competition is `priority` (the odds schedule of 4.5: 10 min, 30 min, 2 h, 6 h by the next
 *   kickoff) or `standard` (30 min, 2 h, 6 h, 6 h: marketOddsPollIntervalMs with the tier).
 * - A metered scores source is redundant when its competition already has two other independent
 *   full-time upstreams (rule R2), one of them with half time: it would be a third upstream.
 */
export type CompetitionTier = 'priority' | 'standard';

/**
 * The tier of a source from the catalogue slugs of its competitions (null: a label that did not
 * resolve). `priority` null or empty (SCRAPER_PRIORITY_COMPETITIONS unset) makes everything
 * priority, as before C-2. A source with no resolved competition, or any unresolved label, stays
 * priority: an unknown competition is never slowed down by mistake. Slugs compare case-blind.
 */
export function competitionTier(
  slugs: readonly (string | null)[],
  priority: readonly string[] | null,
): CompetitionTier {
  if (priority === null || priority.length === 0) return 'priority';
  if (slugs.length === 0 || slugs.some((slug) => slug === null)) return 'priority';
  const wanted = new Set(priority.map((slug) => slug.trim().toLowerCase()));
  return slugs.some((slug) => slug !== null && wanted.has(slug.toLowerCase()))
    ? 'priority'
    : 'standard';
}

/** A metered scores source that may be skipped, in one competition (its catalogue id). */
export interface ScoresCandidate {
  sourceId: string;
  upstream: string;
  /** Null: the label did not resolve, so nothing is known about the competition's coverage. */
  competition: string | null;
}

/**
 * Is this metered scores source a redundant (third) upstream of its competition? True only when,
 * among `entries` (the enabled, healthy sources, as `coverageMatrix` takes them) that are NOT
 * themselves candidates for this skip and do not share the candidate's upstream, at least
 * MIN_INDEPENDENT_SOURCES distinct upstreams give a full-time score and at least one of them also
 * gives half time. Candidates never vouch for each other, so skipping every redundant candidate
 * at once still leaves each competition the two full-time upstreams rule R2 needs.
 */
export function redundantScoresSource(
  candidate: ScoresCandidate,
  entries: readonly CoverageEntry[],
  candidates: ReadonlySet<string>,
): boolean {
  if (candidate.competition === null) return false;
  const own = upstreamKey(candidate.upstream);
  const others = entries.filter(
    (e) =>
      e.competition === candidate.competition &&
      e.capabilities.fullTime &&
      !candidates.has(e.sourceId) &&
      upstreamKey(e.upstream) !== own,
  );
  const fullTime = new Set(others.map((e) => upstreamKey(e.upstream)));
  return fullTime.size >= MIN_INDEPENDENT_SOURCES && others.some((e) => e.capabilities.halfTime);
}
