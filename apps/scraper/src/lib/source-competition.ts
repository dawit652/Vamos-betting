import { listSources, loadAliasInputs, type Database, type ScrapeSource } from '@vamos/db';
import {
  buildAliasIndex,
  coverageMatrix,
  resolveCompetition,
  sourceCapabilities,
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
  const entries: CoverageEntry[] = [];
  for (const source of (await listSources(db)).filter((s) => s.enabled)) {
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
  return new Map(coverageMatrix(entries).map((row) => [row.competition, row.fullTimeUpstreams]));
}
