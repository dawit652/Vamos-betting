import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLUSTER_WINDOW_MS, DAY_MS, HOUR_MS } from '../constants';
import type { FixtureObservation, ResolvedObservation } from '../types';
import { clusterObservations, reversedPairs } from './cluster';

const T0 = Date.UTC(2025, 7, 16, 14, 0, 0);

function item(
  home: string,
  away: string,
  kickoffMs: number,
  extra: { sourceId?: string; externalRef?: string | null; competitionId?: string } = {},
): ResolvedObservation<FixtureObservation> {
  const competitionId = extra.competitionId ?? 'c1';
  return {
    upstream: 'up',
    names: {
      competitionId,
      competitionSlug: `slug-${competitionId}`,
      homeTeamId: home,
      awayTeamId: away,
    },
    obs: {
      kind: 'fixture',
      sourceId: extra.sourceId ?? 's1',
      externalRef: extra.externalRef ?? null,
      sport: 'football',
      competition: 'Premier League',
      home,
      away,
      kickoff: new Date(kickoffMs),
      observedAt: new Date(T0),
      status: 'scheduled',
      round: null,
    },
    firstSeenAt: new Date(T0),
    changedAt: new Date(T0),
    lastSeenAt: new Date(T0),
  };
}

describe('F1 clusterObservations', () => {
  it('F1 sources agreeing within the window form one cluster', () => {
    const clusters = clusterObservations([
      item('a', 'b', T0, { sourceId: 's2' }),
      item('a', 'b', T0 + 30 * 60_000, { sourceId: 's1' }),
    ]);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    expect(cluster?.items.map((i) => i.obs.sourceId)).toEqual(['s2', 's1']);
    expect(cluster?.firstKickoff.getTime()).toBe(T0);
    expect(cluster?.lastKickoff.getTime()).toBe(T0 + 30 * 60_000);
    expect(cluster?.competitionSlug).toBe('slug-c1');
  });

  it('F1 rescheduling: same pair moved a day still clusters', () => {
    const clusters = clusterObservations([item('a', 'b', T0), item('a', 'b', T0 + DAY_MS)]);
    expect(clusters).toHaveLength(1);
  });

  it('F1 double round-robin: swapped home/away months apart are separate fixtures', () => {
    const clusters = clusterObservations([item('a', 'b', T0), item('b', 'a', T0 + 120 * DAY_MS)]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => `${c.homeTeamId}-${c.awayTeamId}`)).toEqual(['a-b', 'b-a']);
  });

  it('F1 home and away are never swapped to make a match, even on the same day', () => {
    const clusters = clusterObservations([item('a', 'b', T0), item('b', 'a', T0 + HOUR_MS)]);
    expect(clusters).toHaveLength(2);
    expect(reversedPairs(clusters)).toHaveLength(1);
  });

  it('F1 two-legged cup: legs a week apart with swapped sides stay separate', () => {
    const clusters = clusterObservations([
      item('a', 'b', T0, { competitionId: 'cup' }),
      item('b', 'a', T0 + 7 * DAY_MS, { competitionId: 'cup' }),
      item('a', 'b', T0 + 1_000, { competitionId: 'cup', sourceId: 's2' }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.items).toHaveLength(2);
    expect(clusters[1]?.homeTeamId).toBe('b');
  });

  it('F1 same direction months apart (a league and its replay) is two clusters', () => {
    const clusters = clusterObservations([item('a', 'b', T0), item('a', 'b', T0 + 90 * DAY_MS)]);
    expect(clusters).toHaveLength(2);
  });

  it('F1 competitions are separate', () => {
    expect(
      clusterObservations([
        item('a', 'b', T0, { competitionId: 'x' }),
        item('a', 'b', T0, { competitionId: 'y' }),
      ]),
    ).toHaveLength(2);
  });

  it('F1 the gap is to the previous item (chaining), boundary inclusive', () => {
    const w = CLUSTER_WINDOW_MS;
    expect(clusterObservations([item('a', 'b', T0), item('a', 'b', T0 + w)])).toHaveLength(1);
    expect(clusterObservations([item('a', 'b', T0), item('a', 'b', T0 + w + 1)])).toHaveLength(2);
    const chain = clusterObservations([
      item('a', 'b', T0),
      item('a', 'b', T0 + w),
      item('a', 'b', T0 + 2 * w),
    ]);
    expect(chain).toHaveLength(1);
  });

  it('F1 duplicate names: an exact duplicate observation is kept, in one cluster', () => {
    const one = item('a', 'b', T0, { externalRef: 'x' });
    const clusters = clusterObservations([one, { ...one }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.items).toHaveLength(2);
  });

  it('F1 custom window and bad arguments', () => {
    expect(
      clusterObservations([item('a', 'b', T0), item('a', 'b', T0 + 2 * HOUR_MS)], HOUR_MS),
    ).toHaveLength(2);
    expect(clusterObservations([])).toEqual([]);
    expect(() => clusterObservations([], -1)).toThrow(RangeError);
    expect(() => clusterObservations([], Number.NaN)).toThrow(RangeError);
    expect(() => clusterObservations([item('a', 'b', Number.NaN)])).toThrow(RangeError);
  });

  it('F1 reversedPairs only reports swapped sides inside one competition within the window', () => {
    const clusters = clusterObservations([
      item('a', 'b', T0),
      item('b', 'a', T0 + 10 * HOUR_MS),
      item('c', 'd', T0),
      item('d', 'c', T0 + 90 * DAY_MS),
      item('e', 'f', T0, { competitionId: 'x' }),
      item('f', 'e', T0, { competitionId: 'y' }),
    ]);
    const pairs = reversedPairs(clusters);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.first.homeTeamId).toBe('a');
    expect(pairs[0]?.second.homeTeamId).toBe('b');
  });

  const itemArb = fc.record({
    home: fc.constantFrom('a', 'b', 'c'),
    away: fc.constantFrom('x', 'y', 'a'),
    day: fc.integer({ min: 0, max: 200 }),
    hour: fc.integer({ min: 0, max: 23 }),
    comp: fc.constantFrom('c1', 'c2'),
    src: fc.constantFrom('s1', 's2', 's3'),
  });
  type Row = {
    home: string;
    away: string;
    day: number;
    hour: number;
    comp: string;
    src: string;
  };
  const build = (rows: Row[]) =>
    rows
      .filter((r) => r.home !== r.away)
      .map((r, i) =>
        item(r.home, r.away, T0 + r.day * DAY_MS + r.hour * HOUR_MS, {
          competitionId: r.comp,
          sourceId: r.src,
          externalRef: `r${i}`,
        }),
      );

  it('F1 property: clusters partition the input; one pair per cluster; gaps respect the window', () => {
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 5 * DAY_MS }),
        (rows, windowMs) => {
          const items = build(rows);
          const clusters = clusterObservations(items, windowMs);
          const flat = clusters.flatMap((c) => c.items);
          expect(flat).toHaveLength(items.length);
          expect(new Set(flat)).toEqual(new Set(items));
          for (const c of clusters) {
            for (const i of c.items) {
              expect([i.names.competitionId, i.names.homeTeamId, i.names.awayTeamId]).toEqual([
                c.competitionId,
                c.homeTeamId,
                c.awayTeamId,
              ]);
            }
            const times = c.items.map((i) => i.obs.kickoff.getTime());
            expect(times).toEqual([...times].sort((x, y) => x - y));
            for (let k = 1; k < times.length; k += 1) {
              expect((times[k] as number) - (times[k - 1] as number)).toBeLessThanOrEqual(windowMs);
            }
            expect(c.firstKickoff.getTime()).toBe(times[0]);
            expect(c.lastKickoff.getTime()).toBe(times[times.length - 1]);
          }
          // Between clusters of one pair the gap exceeds the window.
          for (const a of clusters) {
            for (const b of clusters) {
              if (a === b) continue;
              if (
                a.competitionId === b.competitionId &&
                a.homeTeamId === b.homeTeamId &&
                a.awayTeamId === b.awayTeamId
              ) {
                const gap =
                  b.firstKickoff.getTime() >= a.lastKickoff.getTime()
                    ? b.firstKickoff.getTime() - a.lastKickoff.getTime()
                    : a.firstKickoff.getTime() - b.lastKickoff.getTime();
                expect(gap).toBeGreaterThan(windowMs);
              }
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('F1 property: independent of input order', () => {
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 30 }), fc.nat(), (rows, seed) => {
        const items = build(rows);
        const shuffled = [...items];
        // Deterministic Fisher-Yates from the seed.
        let state = seed + 1;
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
          const j = state % (i + 1);
          [shuffled[i], shuffled[j]] = [
            shuffled[j] as (typeof items)[number],
            shuffled[i] as (typeof items)[number],
          ];
        }
        expect(clusterObservations(shuffled)).toEqual(clusterObservations(items));
        expect(reversedPairs(clusterObservations(shuffled))).toEqual(
          reversedPairs(clusterObservations(items)),
        );
      }),
      { numRuns: 200 },
    );
  });
});
