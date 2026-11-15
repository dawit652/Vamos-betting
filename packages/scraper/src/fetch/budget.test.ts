import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../constants';
import {
  calendarSpanDays,
  daysUntilLeavesNormal,
  estimateOddsReadsPerDay,
  estimateScoresReadsPerDay,
  summariseCredits,
} from './budget';

const NOW = new Date('2030-03-10T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const HORIZON = 15 * DAY_MS;

describe('estimateOddsReadsPerDay', () => {
  it('reads nothing that costs credits when no match is listed (an empty answer is free)', () => {
    const reads = estimateOddsReadsPerDay({ now: NOW, kickoffs: [], days: 5, horizonMs: HORIZON });
    expect(reads).toEqual([0, 0, 0, 0, 0]);
  });

  it('one match 2 h ahead is read every 10 min until 10 min before its start, then every 6 h', () => {
    const reads = estimateOddsReadsPerDay({
      now: NOW,
      kickoffs: [at(2 * HOUR_MS)],
      days: 1,
      horizonMs: HORIZON,
    });
    // Reads at 0, 10, ..., 110 min (12): the one at 110 min still returns the match (10 min
    // ahead); with no match more than MIN_LEAD ahead the next read is 6 h away and the 6-hourly
    // ones after the kickoff return no match: free, not counted.
    expect(reads).toEqual([12]);
  });

  it('a match 5 days ahead is read every 2 h, closer ones more often', () => {
    const [first] = estimateOddsReadsPerDay({
      now: NOW,
      kickoffs: [at(5 * DAY_MS)],
      days: 1,
      horizonMs: HORIZON,
    });
    expect(first).toBe(12); // 24 h / 2 h
    const [second] = estimateOddsReadsPerDay({
      now: NOW,
      kickoffs: [at(20 * HOUR_MS)],
      days: 1,
      horizonMs: HORIZON,
    });
    // Within 24 h: every 30 min until it is within 3 h (from hour 17), then every 10 min.
    expect(second).toBeGreaterThan(30);
  });

  it('a match beyond the adapter horizon is not read for', () => {
    const reads = estimateOddsReadsPerDay({
      now: NOW,
      kickoffs: [at(20 * DAY_MS)],
      days: 3,
      horizonMs: HORIZON,
    });
    expect(reads).toEqual([0, 0, 0]);
  });

  it('economy reads less than normal; stop reads nothing', () => {
    const kickoffs = [at(6 * HOUR_MS), at(30 * HOUR_MS)];
    const sum = (mode: 'normal' | 'economy' | 'stop' | 'minimal') =>
      estimateOddsReadsPerDay({ now: NOW, kickoffs, days: 2, horizonMs: HORIZON, mode }).reduce(
        (a, b) => a + b,
        0,
      );
    expect(sum('economy')).toBeLessThan(sum('normal'));
    expect(sum('stop')).toBe(0);
    expect(sum('minimal')).toBeLessThan(sum('economy'));
  });
});

describe('estimateScoresReadsPerDay', () => {
  it('reads every 20 min from kickoff + 110 min to kickoff + 4 h, and not otherwise', () => {
    const reads = estimateScoresReadsPerDay({
      now: NOW,
      kickoffs: [at(1 * HOUR_MS)],
      days: 1,
    });
    // Window: 2:50 to 5:00 after now: reads at 170, 190, ..., 290 min => 7.
    expect(reads).toEqual([7]);
  });

  it('overlapping matches share one read, and no match means no reads', () => {
    const one = estimateScoresReadsPerDay({ now: NOW, kickoffs: [at(HOUR_MS)], days: 1 });
    const two = estimateScoresReadsPerDay({
      now: NOW,
      kickoffs: [at(HOUR_MS), at(HOUR_MS + 5 * MINUTE_MS)],
      days: 1,
    });
    expect(two[0]!).toBeLessThanOrEqual(one[0]! + 1);
    expect(estimateScoresReadsPerDay({ now: NOW, kickoffs: [], days: 3 })).toEqual([0, 0, 0]);
  });

  it('stop reads nothing', () => {
    expect(
      estimateScoresReadsPerDay({ now: NOW, kickoffs: [at(HOUR_MS)], days: 1, mode: 'stop' }),
    ).toEqual([0]);
  });

  it('property: reads are whole numbers, never negative, and more kickoffs never mean fewer reads', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -4 * 3600, max: 3 * 86_400 }), { maxLength: 15 }),
        fc.integer({ min: 0, max: 3 * 86_400 }),
        (secs, extra) => {
          const kickoffs = secs.map((s) => at(s * 1000));
          const base = estimateScoresReadsPerDay({ now: NOW, kickoffs, days: 3 });
          const more = estimateScoresReadsPerDay({
            now: NOW,
            kickoffs: [...kickoffs, at(extra * 1000)],
            days: 3,
          });
          for (const n of base) expect(Number.isInteger(n) && n >= 0).toBe(true);
          const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
          expect(total(more)).toBeGreaterThanOrEqual(total(base));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('estimateOddsReadsPerDay properties', () => {
  it('reads are whole numbers, and no read costs more often than every 10 minutes', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 * 86_400 }), { maxLength: 12 }), (secs) => {
        const reads = estimateOddsReadsPerDay({
          now: NOW,
          kickoffs: secs.map((s) => at(s * 1000)),
          days: 4,
          horizonMs: HORIZON,
        });
        expect(reads).toHaveLength(4);
        for (const n of reads) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(144); // every 10 min is the fastest tier
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('summariseCredits and calendarSpanDays', () => {
  it('averages over the calendar span and finds the peak day', () => {
    const s = summariseCredits([10, 30, 20, 0, 0], 2, 3);
    expect(s).toEqual({
      totalCredits: 120,
      avgCreditsPerDay: 40,
      avgReadsPerDay: 20,
      peakCredits: 60,
      peakDay: 1,
    });
  });

  it('is zero for an empty estimate and clamps the span to what exists', () => {
    expect(summariseCredits([], 2, 5)).toMatchObject({ totalCredits: 0, avgCreditsPerDay: 0 });
    expect(summariseCredits([4], 2, 99).avgCreditsPerDay).toBe(8);
  });

  it('spans up to the last kickoff, between 1 and the maximum', () => {
    expect(calendarSpanDays(NOW, [at(2 * HOUR_MS)], 30)).toBe(1);
    expect(calendarSpanDays(NOW, [at(2 * HOUR_MS), at(9.5 * DAY_MS)], 30)).toBe(10);
    expect(calendarSpanDays(NOW, [at(90 * DAY_MS)], 30)).toBe(30);
    expect(calendarSpanDays(NOW, [], 30)).toBe(30);
  });
});

describe('daysUntilLeavesNormal', () => {
  const base = { quota: 20_000, remaining: 15_000, daysLeftInMonth: 20 };

  it('never leaves normal at the planned monthly rate', () => {
    expect(daysUntilLeavesNormal({ ...base, creditsPerDay: 450 })).toEqual({
      days: null,
      mode: null,
    });
  });

  it('leaves at once when a day alone costs more than 7.5% of the quota', () => {
    expect(daysUntilLeavesNormal({ ...base, creditsPerDay: 1600 })).toEqual({
      days: 0,
      mode: 'economy',
    });
  });

  it('enters economy when 80% of the quota is spent, with more than 7 days left', () => {
    const r = daysUntilLeavesNormal({ ...base, creditsPerDay: 1000 });
    // 15000 - 4000 (20%) = 11000 credits to spend: 11 days at 1000 a day (quarter-day steps).
    expect(r.mode).toBe('economy');
    expect(r.days).toBeGreaterThan(10.9);
    expect(r.days).toBeLessThan(11.3);
  });

  it('no reading yet or an unusable rate: nothing to say', () => {
    expect(daysUntilLeavesNormal({ ...base, quota: null, creditsPerDay: 100 }).days).toBeNull();
    expect(daysUntilLeavesNormal({ ...base, creditsPerDay: Number.NaN }).days).toBeNull();
  });

  it('property: a higher rate never leaves normal later', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 100, max: 20_000 }),
        (a, b, remaining) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const input = { quota: 20_000, remaining, daysLeftInMonth: 25 };
          const lo = daysUntilLeavesNormal({ ...input, creditsPerDay: low }).days;
          const hi = daysUntilLeavesNormal({ ...input, creditsPerDay: high }).days;
          if (lo !== null) expect(hi).not.toBeNull();
          if (lo !== null && hi !== null) expect(hi).toBeLessThanOrEqual(lo);
        },
      ),
      { numRuns: 80 },
    );
  });
});
