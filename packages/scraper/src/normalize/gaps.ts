import { normalizeName } from './name';

/**
 * Catalogue gaps (docs/feed-quality-plan.md U-6): the team spellings sources use that the
 * catalogue does not know, grouped by competition and normalised spelling. Pure.
 */

/** One current observation of a source, reduced to what the grouping needs. */
export interface GapObservation {
  sourceId: string;
  /** The competition it belongs to: a slug, or any label that stands for an unresolved one. */
  competition: string;
  homeRaw: string;
  awayRaw: string;
  /** Whether each side resolved to a catalogue team. Only a side that did not is a gap. */
  homeResolved: boolean;
  awayResolved: boolean;
  firstSeenAt: Date;
}

export interface GapRow {
  competition: string;
  /** The spelling as sources write it (the commonest one in the group; ties: the first alphabetically). */
  spelling: string;
  /** The normalised spelling the rows are grouped by. */
  normalized: string;
  /** The sources that wrote it, sorted. */
  sources: string[];
  /** Observations (fixtures and results, any source) that use it. */
  rows: number;
  firstSeen: Date;
}

/**
 * Groups the unresolved team names of `observations`. `wanted` limits the result to some
 * normalised spellings (the ones with an open review item); null keeps all. An observation counts
 * once per spelling even when both sides use it. Sorted by competition, then most rows first, then
 * spelling.
 */
export function catalogueGaps(
  observations: readonly GapObservation[],
  options: { wanted?: ReadonlySet<string> | null } = {},
): GapRow[] {
  interface Group {
    competition: string;
    normalized: string;
    raws: Map<string, number>;
    sources: Set<string>;
    rows: number;
    firstSeen: Date;
  }
  const groups = new Map<string, Group>();
  for (const o of observations) {
    const sides: Array<[string, boolean]> = [
      [o.homeRaw, o.homeResolved],
      [o.awayRaw, o.awayResolved],
    ];
    const counted = new Set<string>();
    for (const [raw, resolved] of sides) {
      if (resolved) continue;
      const normalized = normalizeName(raw);
      if (normalized === '') continue;
      if (
        options.wanted !== undefined &&
        options.wanted !== null &&
        !options.wanted.has(normalized)
      )
        continue;
      const key = `${o.competition}\u0000${normalized}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          competition: o.competition,
          normalized,
          raws: new Map(),
          sources: new Set(),
          rows: 0,
          firstSeen: o.firstSeenAt,
        };
        groups.set(key, group);
      }
      group.raws.set(raw, (group.raws.get(raw) ?? 0) + 1);
      group.sources.add(o.sourceId);
      if (!counted.has(key)) {
        counted.add(key);
        group.rows += 1;
      }
      if (o.firstSeenAt.getTime() < group.firstSeen.getTime()) group.firstSeen = o.firstSeenAt;
    }
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...groups.values()]
    .map((g) => {
      const spelling = [...g.raws.entries()].sort(
        (a, b) => b[1] - a[1] || compare(a[0], b[0]),
      )[0]![0];
      return {
        competition: g.competition,
        spelling,
        normalized: g.normalized,
        sources: [...g.sources].sort(compare),
        rows: g.rows,
        firstSeen: g.firstSeen,
      };
    })
    .sort(
      (a, b) =>
        compare(a.competition, b.competition) ||
        b.rows - a.rows ||
        compare(a.normalized, b.normalized),
    );
}
