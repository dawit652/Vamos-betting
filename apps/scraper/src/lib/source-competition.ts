import { listSources, loadAliasInputs, type Database, type ScrapeSource } from '@vamos/db';
import {
  buildAliasIndex,
  competitionTier,
  coverageMatrix,
  redundantScoresSource,
  resolveCompetition,
  sourceCapabilities,
  type CompetitionTier,
  type CoverageEntry,
} from '@vamos/scraper';

/** The competition a configured label resolves to: its catalogue id and slug, or the label as written. */
export interface ResolvedLabel {
  /** The slug when the label resolves, else `?<label>` (unresolved) so it can never pass for a slug. */
  key: string;
  id: string | null;
}

/**
 * Resolves competition labels of source configs the way the scheduler does (rule N2 for
 * competitions, through the source's own aliases first). Read-only.
 */
export async function competitionResolver(
  db: Database,
): Promise<(source: Pick<ScrapeSource, 'id' | 'config'>, label: string) => ResolvedLabel> {
  const inputs = await loadAliasInputs(db, 'football');
  const index = buildAliasIndex(inputs);
  const slugs = new Map(inputs.competitions.map((c) => [c.id, c.slug]));
  return (source, label) => {
    const sport = source.config.sport;
    const resolution = resolveCompetition(index, {
      sportId: typeof sport === 'string' ? sport : 'football',
      sourceId: source.id,
      raw: label,
    });
    if (resolution.status !== 'resolved') return { key: `?${label}`, id: null };
    return { key: slugs.get(resolution.id) ?? `?${label}`, id: resolution.id };
  };
}

/**
 * Distinct full-time upstreams per competition id among the ENABLED sources, compared as rule R2
 * does (`coverageMatrix`, the `sources coverage` command). A source that takes its competition
 * from each record, or a label that does not resolve, counts for no competition. Read-only.
 */
export async function fullTimeUpstreamsByCompetition(db: Database): Promise<Map<string, number>> {
  const resolve = await competitionResolver(db);
  const entries = coverageEntries(
    (await listSources(db)).filter((s) => s.enabled),
    resolve,
  );
  return new Map(coverageMatrix(entries).map((row) => [row.competition, row.fullTimeUpstreams]));
}

/** One coverage entry per source and resolved competition id (as `coverageMatrix` takes them). */
function coverageEntries(
  sources: readonly ScrapeSource[],
  resolve: (source: Pick<ScrapeSource, 'id' | 'config'>, label: string) => ResolvedLabel,
): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const source of sources) {
    const result = sourceCapabilities(source);
    if (!result.ok) continue;
    const ids = new Set(
      result.capabilities.competitions
        .map((label) => resolve(source, label).id)
        .filter((id): id is string => id !== null),
    );
    for (const competition of ids) {
      entries.push({
        competition,
        sourceId: source.id,
        upstream: source.upstream,
        capabilities: result.capabilities,
      });
    }
  }
  return entries;
}

/** How one metered source is read under C-2 (docs/feed-quality-plan.md). */
export interface MeteredPolling {
  /** The catalogue id of its configured `competition` label (null: none or unresolved). */
  competitionId: string | null;
  /** Its slug, else `?<label>` (as `ResolvedLabel.key`). */
  competition: string;
  tier: CompetitionTier;
  /** A scores source skipped as a redundant (third) upstream: SCRAPER_SKIP_REDUNDANT_SCORES=on only. */
  skipped: boolean;
}

/**
 * The tier of each metered odds or scores source, and which scores sources are skipped as
 * redundant (C-2), shared by the scheduler and `sources budget` so the estimate replays what the
 * scheduler does. `enabled` are all enabled sources; `failing` the ids whose last runs failed: a
 * failing source never vouches for a competition's coverage, so a scores source comes back as
 * soon as one of the upstreams it was skipped for is failing or switched off. Read-only.
 */
export async function meteredPolling(
  db: Database,
  input: {
    enabled: readonly ScrapeSource[];
    odds: readonly ScrapeSource[];
    scores: readonly ScrapeSource[];
    failing: ReadonlySet<string>;
    priorityCompetitions: readonly string[] | null;
    skipRedundantScores: boolean;
  },
): Promise<Map<string, MeteredPolling>> {
  const out = new Map<string, MeteredPolling>();
  if (input.odds.length === 0 && input.scores.length === 0) return out;
  const resolve = await competitionResolver(db);
  const candidates = new Set(input.scores.map((s) => s.id));
  const entries = input.skipRedundantScores
    ? coverageEntries(
        input.enabled.filter((s) => !input.failing.has(s.id)),
        resolve,
      )
    : [];
  for (const source of [...input.odds, ...input.scores]) {
    const configured = source.config.competition;
    const own =
      typeof configured === 'string' ? resolve(source, configured) : { key: source.id, id: null };
    const capabilities = sourceCapabilities(source);
    const labels = capabilities.ok ? capabilities.capabilities.competitions : [];
    const slugs = labels.map((label) => {
      const resolved = resolve(source, label);
      return resolved.id === null ? null : resolved.key;
    });
    const skipped =
      input.skipRedundantScores &&
      candidates.has(source.id) &&
      redundantScoresSource(
        { sourceId: source.id, upstream: source.upstream, competition: own.id },
        entries,
        candidates,
      );
    out.set(source.id, {
      competitionId: own.id,
      competition: own.key,
      tier: competitionTier(slugs, input.priorityCompetitions),
      skipped,
    });
  }
  return out;
}
