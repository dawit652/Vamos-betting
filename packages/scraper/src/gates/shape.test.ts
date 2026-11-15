import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SHAPE_BASELINE_RUNS, SHAPE_MIN_BASELINE_RUNS, SHAPE_MIN_RATIO } from '../constants';
import type { ParseIssue } from '../types';
import { checkShape, sourceBrokenReview } from './shape';

const stats = (accepted: number, seen = Math.max(accepted, 100)) => ({
  recordsAccepted: accepted,
  recordsSeen: seen,
});
const fatal: ParseIssue = { severity: 'error', code: 'bad_json', message: 'x', fatal: true };

describe('S1 shape', () => {
  it('learns below SHAPE_MIN_BASELINE_RUNS successful runs', () => {
    expect(checkShape(stats(0), [], [10, 10])).toEqual({
      status: 'learning',
      accepted: 0,
      runs: 2,
    });
    expect(checkShape(stats(0), [], [10, 10, 10]).status).toBe('broken');
  });

  it('a fatal issue is broken, even while learning', () => {
    expect(checkShape(stats(50), [fatal], [])).toMatchObject({
      status: 'broken',
      reason: 'fatal_issue',
    });
    expect(checkShape(stats(50), [{ ...fatal, fatal: false }], []).status).toBe('learning');
  });

  it('broken below SHAPE_MIN_RATIO of the median (exactly the ratio is healthy)', () => {
    expect(checkShape(stats(5), [], [10, 10, 10])).toEqual({
      status: 'ok',
      accepted: 5,
      baseline: 10,
    });
    expect(checkShape(stats(4), [], [10, 10, 10])).toMatchObject({
      status: 'broken',
      reason: 'low_yield',
    });
    // Median of an even count is the mean of the middle two: 11, so 5.5 is the bound.
    expect(checkShape(stats(6), [], [8, 14, 10, 12]).status).toBe('ok');
    expect(checkShape(stats(5), [], [8, 14, 10, 12]).status).toBe('broken');
    // The median ignores one outlier run.
    expect(checkShape(stats(6), [], [10, 1000, 10]).status).toBe('ok');
  });

  it('uses only the newest SHAPE_BASELINE_RUNS runs', () => {
    const recent = [...Array<number>(SHAPE_BASELINE_RUNS).fill(10), 1000, 1000, 1000];
    expect(checkShape(stats(5), [], recent)).toMatchObject({ status: 'ok', baseline: 10 });
  });

  it('zero records where the baseline is positive is broken; a zero baseline is not', () => {
    expect(checkShape(stats(0), [], [0, 1, 1])).toMatchObject({
      status: 'broken',
      reason: 'zero_records',
    });
    expect(checkShape(stats(0), [], [0, 0, 0])).toEqual({ status: 'ok', accepted: 0, baseline: 0 });
  });

  it('malformed stats or baseline fail closed', () => {
    for (const bad of [stats(-1), stats(Number.NaN), stats(1.5), stats(5, 4)]) {
      expect(checkShape(bad, [], [10, 10, 10])).toMatchObject({
        status: 'broken',
        reason: 'invalid_stats',
      });
    }
    expect(checkShape(stats(5), [], [10, Number.NaN, 10])).toMatchObject({
      reason: 'invalid_baseline',
    });
  });

  it('opens one source_broken item per source', () => {
    const check = checkShape(stats(0), [fatal], []);
    if (check.status !== 'broken') throw new Error('expected broken');
    expect(sourceBrokenReview('src-1', 'https://example.test/a', check, 'run-1')).toMatchObject({
      kind: 'source_broken',
      subjectKey: 'source|src-1',
      payload: { sourceId: 'src-1', url: 'https://example.test/a', reasons: ['fatal_issue'] },
    });
  });

  it('property: broken exactly when fatal or below the ratio of the median, whatever the order', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 60 }),
        fc.array(fc.nat({ max: 60 }), {
          minLength: SHAPE_MIN_BASELINE_RUNS,
          maxLength: SHAPE_BASELINE_RUNS,
        }),
        fc.boolean(),
        (accepted, runs, isFatal) => {
          const check = checkShape(stats(accepted), isFatal ? [fatal] : [], runs);
          const sorted = [...runs].sort((a, b) => a - b);
          const n = sorted.length;
          const med =
            n % 2
              ? (sorted[(n - 1) / 2] ?? 0)
              : ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2;
          expect(check.status === 'broken').toBe(isFatal || accepted < SHAPE_MIN_RATIO * med);
          expect(checkShape(stats(accepted), isFatal ? [fatal] : [], [...runs].reverse())).toEqual(
            check,
          );
        },
      ),
    );
  });
});
