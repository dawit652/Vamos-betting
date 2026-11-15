import { CLUSTER_WINDOW_MS } from '../constants';
import type { FixtureObservation, ResolvedObservation, ResultObservation } from '../types';

/**
 * Rule F1 (docs/scraper.md section 6.1): which observations are the same
 * fixture. Observations of one `(competition, home, away)` pairing belong
 * together when their kickoffs chain within `CLUSTER_WINDOW_MS`; the pairing is
 * directional, so the return leg of a double round-robin or a two-legged cup
 * (home and away swapped) is a different fixture and is never merged, however
 * close the dates. Two meetings of the same direction months apart are
 * separate clusters too. Pure and independent of input order.
 */

export type ClusterItem = ResolvedObservation<FixtureObservation | ResultObservation>;

export interface FixtureCluster<T extends ClusterItem = ClusterItem> {
  competitionId: string;
  competitionSlug: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Sorted by kickoff, then sourceId, externalRef, kind, observedAt. */
  items: T[];
  firstKickoff: Date;
  lastKickoff: Date;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareItems(a: ClusterItem, b: ClusterItem): number {
  return (
    a.obs.kickoff.getTime() - b.obs.kickoff.getTime() ||
    cmp(a.obs.sourceId, b.obs.sourceId) ||
    cmp(a.obs.externalRef ?? '', b.obs.externalRef ?? '') ||
    cmp(a.obs.kind, b.obs.kind) ||
    a.obs.observedAt.getTime() - b.obs.observedAt.getTime()
  );
}

function checkWindow(windowMs: number): void {
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError('window must be a finite, non-negative number of milliseconds');
  }
}

export function clusterObservations<T extends ClusterItem>(
  items: readonly T[],
  windowMs: number = CLUSTER_WINDOW_MS,
): FixtureCluster<T>[] {
  checkWindow(windowMs);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    // A kickoff that is not a date cannot be ordered; dropping the item would
    // break the partition, so refuse loudly (adapters validate with zod).
    if (Number.isNaN(item.obs.kickoff.getTime()))
      throw new RangeError('observation with an invalid kickoff');
    const { competitionId, homeTeamId, awayTeamId } = item.names;
    const key = `${competitionId}\u0000${homeTeamId}\u0000${awayTeamId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const clusters: FixtureCluster<T>[] = [];
  for (const group of groups.values()) {
    group.sort(compareItems);
    let current: T[] = [];
    let previousMs = Number.NEGATIVE_INFINITY;
    const flush = (): void => {
      const first = current[0];
      const last = current[current.length - 1];
      if (!first || !last) return;
      clusters.push({
        competitionId: first.names.competitionId,
        competitionSlug: first.names.competitionSlug,
        homeTeamId: first.names.homeTeamId,
        awayTeamId: first.names.awayTeamId,
        items: current,
        firstKickoff: new Date(first.obs.kickoff.getTime()),
        lastKickoff: new Date(last.obs.kickoff.getTime()),
      });
    };
    for (const item of group) {
      const ms = item.obs.kickoff.getTime();
      // The gap is to the PREVIOUS item (chaining), so a long run of updates
      // each a day apart stays one fixture while a months-apart rematch does not.
      if (current.length > 0 && ms - previousMs > windowMs) {
        flush();
        current = [];
      }
      current.push(item);
      previousMs = ms;
    }
    flush();
  }

  return clusters.sort(
    (a, b) =>
      a.firstKickoff.getTime() - b.firstKickoff.getTime() ||
      cmp(a.competitionId, b.competitionId) ||
      cmp(a.homeTeamId, b.homeTeamId) ||
      cmp(a.awayTeamId, b.awayTeamId),
  );
}

export interface ReversedPair<T extends ClusterItem = ClusterItem> {
  first: FixtureCluster<T>;
  second: FixtureCluster<T>;
}

/** Distance between two kickoff ranges (0 when they overlap). */
function rangeGapMs(a: FixtureCluster, b: FixtureCluster): number {
  return Math.max(
    0,
    Math.max(a.firstKickoff.getTime(), b.firstKickoff.getTime()) -
      Math.min(a.lastKickoff.getTime(), b.lastKickoff.getTime()),
  );
}

/**
 * Pairs of clusters in one competition with home and away swapped whose
 * kickoffs are within the window: one source probably has the home/away
 * order wrong. A data-quality signal for a person; nothing merges them.
 * Each pair appears once, earlier cluster first.
 */
export function reversedPairs<T extends ClusterItem>(
  clusters: readonly FixtureCluster<T>[],
  windowMs: number = CLUSTER_WINDOW_MS,
): ReversedPair<T>[] {
  checkWindow(windowMs);
  const byKey = new Map<string, FixtureCluster<T>[]>();
  for (const cluster of clusters) {
    const [lo, hi] =
      cluster.homeTeamId < cluster.awayTeamId
        ? [cluster.homeTeamId, cluster.awayTeamId]
        : [cluster.awayTeamId, cluster.homeTeamId];
    const key = `${cluster.competitionId}\u0000${lo}\u0000${hi}`;
    const list = byKey.get(key);
    if (list) list.push(cluster);
    else byKey.set(key, [cluster]);
  }
  const pairs: ReversedPair<T>[] = [];
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i] as FixtureCluster<T>;
        const b = list[j] as FixtureCluster<T>;
        if (a.homeTeamId === b.homeTeamId || a.homeTeamId === a.awayTeamId) continue;
        if (rangeGapMs(a, b) > windowMs) continue;
        const aFirst =
          a.firstKickoff.getTime() - b.firstKickoff.getTime() ||
          cmp(a.homeTeamId, b.homeTeamId) ||
          cmp(a.awayTeamId, b.awayTeamId);
        pairs.push(aFirst <= 0 ? { first: a, second: b } : { first: b, second: a });
      }
    }
  }
  return pairs.sort(
    (x, y) =>
      x.first.firstKickoff.getTime() - y.first.firstKickoff.getTime() ||
      cmp(x.first.competitionId, y.first.competitionId) ||
      cmp(x.first.homeTeamId, y.first.homeTeamId) ||
      cmp(x.second.homeTeamId, y.second.homeTeamId) ||
      x.second.firstKickoff.getTime() - y.second.firstKickoff.getTime(),
  );
}
