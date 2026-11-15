import { describe, expect, it } from 'vitest';
import { rng } from './odds-lib';
import {
  compareSource,
  isMismatch,
  latencyMinutes,
  latestPerSource,
  median,
  percentile,
  summariseAudit,
  type AuditScore,
  type SourceResult,
} from './result-audit';

const applied: AuditScore = { home: 2, away: 1, htHome: 1, htAway: 0 };
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
const source = (over: Partial<SourceResult>): SourceResult => ({
  sourceId: 's',
  upstream: 'u',
  status: 'finished',
  scoreBasis: 'regular_time',
  score: { home: 2, away: 1, htHome: 1, htAway: 0 },
  changedAt: at(0),
  ...over,
});

describe('latencyMinutes', () => {
  it('counts from kickoff plus 105 minutes, and may be negative', () => {
    expect(latencyMinutes(at(0), at(125))).toBe(20);
    expect(latencyMinutes(at(0), at(100))).toBe(-5);
  });
});

describe('percentile and median', () => {
  it('uses the nearest rank', () => {
    const ten = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(ten, 0.9)).toBe(9);
    expect(percentile(ten, 1)).toBe(10);
    expect(percentile(ten, 0.1)).toBe(1);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([], 0.9)).toBeNull();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  // fast-check is not a dependency of this app: a seeded generator (rng, odds-lib) draws the cases.
  it('is a member of the input, within its range, and does not reorder it (property)', () => {
    const rand = rng(20261110);
    for (let i = 0; i < 300; i++) {
      const values = Array.from({ length: 1 + Math.floor(rand() * 40) }, () =>
        Math.floor(rand() * 1001 - 500),
      );
      const p = 0.01 + rand() * 0.99;
      const copy = [...values];
      const v = percentile(values, p) as number;
      expect(values).toEqual(copy);
      expect(values).toContain(v);
      expect(v).toBeGreaterThanOrEqual(Math.min(...values));
      expect(v).toBeLessThanOrEqual(Math.max(...values));
      expect(percentile(values, 0.5) as number).toBeLessThanOrEqual(
        percentile(values, 0.9) as number,
      );
    }
  });
});

describe('compareSource', () => {
  it('agrees, or differs in full time, half time or both', () => {
    expect(compareSource(applied, source({})).verdict).toBe('match');
    expect(compareSource(applied, source({ score: { ...applied, home: 3 } })).verdict).toBe('ft');
    expect(compareSource(applied, source({ score: { ...applied, htHome: 0 } })).verdict).toBe('ht');
    expect(
      compareSource(applied, source({ score: { home: 0, away: 0, htHome: 0, htAway: 1 } })).verdict,
    ).toBe('ft_ht');
  });
  it('compares half time only when both sides have it', () => {
    const noHt = { ...applied, htHome: null, htAway: null };
    expect(compareSource(applied, source({ score: noHt })).verdict).toBe('match');
    expect(compareSource(noHt, source({})).verdict).toBe('match');
  });
  it('does not compare unfinished rows or extra-time scores', () => {
    expect(compareSource(applied, source({ status: 'postponed', score: null })).verdict).toBe(
      'not_finished',
    );
    expect(
      compareSource(applied, source({ scoreBasis: 'extra_time', score: { ...applied, home: 5 } }))
        .verdict,
    ).toBe('other_basis');
    expect(isMismatch('not_finished')).toBe(false);
    expect(isMismatch('other_basis')).toBe(false);
    expect(isMismatch('match')).toBe(false);
    expect(isMismatch('ft_ht')).toBe(true);
  });
});

describe('latestPerSource', () => {
  it('keeps the most recently changed row of each source, ordered by source', () => {
    const rows = [
      source({ sourceId: 'b', changedAt: at(1) }),
      source({ sourceId: 'a', changedAt: at(1), score: { ...applied, home: 9 } }),
      source({ sourceId: 'a', changedAt: at(5) }),
    ];
    const latest = latestPerSource(rows);
    expect(latest.map((r) => r.sourceId)).toEqual(['a', 'b']);
    expect(latest[0]?.score?.home).toBe(2);
  });
});

describe('summariseAudit', () => {
  const item = (competition: string, latency: number, verdict: 'match' | 'ft') => ({
    competition,
    latencyMinutes: latency,
    comparisons: [
      compareSource(applied, source(verdict === 'ft' ? { score: { ...applied, home: 7 } } : {})),
    ],
  });
  it('counts mismatches and compares the latency with the targets per competition', () => {
    const { overall, byCompetition } = summariseAudit([
      item('b', 40, 'match'),
      item('a', 10, 'match'),
      item('a', 30, 'ft'),
      item('a', 20, 'match'),
    ]);
    expect(byCompetition.map((c) => c.competition)).toEqual(['a', 'b']);
    expect(byCompetition[0]).toMatchObject({
      count: 3,
      mismatches: 1,
      medianLatencyMinutes: 20,
      p90LatencyMinutes: 30,
      meetsTargets: true,
    });
    expect(byCompetition[1]).toMatchObject({ meetsTargets: false });
    expect(overall).toMatchObject({ count: 4, mismatches: 1, p90LatencyMinutes: 40 });
  });
  it('is empty without results', () => {
    expect(summariseAudit([]).overall).toEqual({
      competition: 'all',
      count: 0,
      mismatches: 0,
      medianLatencyMinutes: null,
      p90LatencyMinutes: null,
      meetsTargets: null,
    });
  });
});
