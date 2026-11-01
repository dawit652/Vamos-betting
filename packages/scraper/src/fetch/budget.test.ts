import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../constants';
import {
  BUDGET_RESERVE_FRACTION,
  type BudgetLevel,
  type BudgetSnapshot,
  QUOTA_RETRY_THRESHOLD_MS,
  budgetLevel,
  expectedCost,
  isCostSpike,
  isQuotaExhausted,
  pollIntervalFor,
  readResponseMeters,
} from './budget';

const NOW = new Date('2026-11-10T09:30:00.000Z');
const NUM_RUNS = 300;

describe('readResponseMeters', () => {
  const FULL = {
    'x-datapoints': '27',
    'x-datapoints-used': '1250000',
    'x-datapoints-remaining': '23750000',
    'x-datapoints-reset': '2026-12-01T00:00:00Z',
    'x-rate-limit': '2',
    'x-data-delay-seconds': '60',
  };

  it('reads every meter of a response', () => {
    expect(readResponseMeters(FULL, NOW)).toEqual({
      cost: 27,
      snapshot: {
        used: 1_250_000,
        remaining: 23_750_000,
        resetAt: new Date('2026-12-01T00:00:00Z'),
        observedAt: NOW,
      },
      rateLimit: 2,
      delayHeader: '60',
    });
  });

  it('gives the snapshot its own copy of the time', () => {
    const meters = readResponseMeters(FULL, NOW);
    expect(meters.snapshot?.observedAt).not.toBe(NOW);
    expect(meters.snapshot?.observedAt.getTime()).toBe(NOW.getTime());
  });

  it('is all null for no headers', () => {
    expect(readResponseMeters({}, NOW)).toEqual({
      cost: null,
      snapshot: null,
      rateLimit: null,
      delayHeader: null,
    });
  });

  it('keeps a snapshot with only used or only remaining', () => {
    expect(readResponseMeters({ 'x-datapoints-used': '5' }, NOW).snapshot).toEqual({
      used: 5,
      remaining: null,
      resetAt: null,
      observedAt: NOW,
    });
    expect(readResponseMeters({ 'x-datapoints-remaining': '7' }, NOW).snapshot).toEqual({
      used: null,
      remaining: 7,
      resetAt: null,
      observedAt: NOW,
    });
  });

  it('has no snapshot when neither used nor remaining was read, whatever else was', () => {
    const others = {
      'x-datapoints': '27',
      'x-datapoints-reset': '2026-12-01T00:00:00Z',
      'x-rate-limit': '2',
    };
    expect(readResponseMeters(others, NOW).snapshot).toBeNull();
    expect(
      readResponseMeters(
        { ...others, 'x-datapoints-used': 'lots', 'x-datapoints-remaining': '' },
        NOW,
      ).snapshot,
    ).toBeNull();
  });

  it('reads the cost and rate whatever else is there', () => {
    const meters = readResponseMeters({ 'x-datapoints': '27', 'x-rate-limit': '2' }, NOW);
    expect(meters.cost).toBe(27);
    expect(meters.rateLimit).toBe(2);
  });

  describe('a value that is not a plain number gives null', () => {
    const NAMES = [
      'x-datapoints',
      'x-datapoints-used',
      'x-datapoints-remaining',
      'x-rate-limit',
    ] as const;
    const valueOf = (
      name: (typeof NAMES)[number],
      meters: ReturnType<typeof readResponseMeters>,
    ) =>
      name === 'x-datapoints'
        ? meters.cost
        : name === 'x-datapoints-used'
          ? (meters.snapshot?.used ?? null)
          : name === 'x-datapoints-remaining'
            ? (meters.snapshot?.remaining ?? null)
            : meters.rateLimit;

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['text', 'abc'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['an exponent', '1e3'],
      ['hex', '0x10'],
      ['thousands separators', '1,000'],
      ['a space inside', '1 000'],
      ['trailing text', '12abc'],
      ['two signs', '--5'],
      ['a plus sign', '+5'],
      ['a trailing point', '5.'],
      ['a leading point', '.5'],
      ['more digits than a number holds', '9'.repeat(400)],
    ])('for %s', (_name, value) => {
      for (const name of NAMES) {
        const meters = readResponseMeters(
          { 'x-datapoints-used': '1', 'x-datapoints-remaining': '1', [name]: value },
          NOW,
        );
        expect(valueOf(name, meters)).toBeNull();
      }
    });

    it('for a header value that is not a string', () => {
      const headers = { 'x-datapoints': 27, 'x-rate-limit': null } as unknown as Record<
        string,
        string
      >;
      const meters = readResponseMeters(headers, NOW);
      expect(meters.cost).toBeNull();
      expect(meters.rateLimit).toBeNull();
    });
  });

  it('reads whole and fractional numbers, with spaces around them', () => {
    expect(readResponseMeters({ 'x-datapoints': ' 27 ' }, NOW).cost).toBe(27);
    expect(readResponseMeters({ 'x-datapoints': '12.5' }, NOW).cost).toBe(12.5);
    expect(readResponseMeters({ 'x-datapoints': '0' }, NOW).cost).toBe(0);
    expect(readResponseMeters({ 'x-datapoints': '007' }, NOW).cost).toBe(7);
    expect(readResponseMeters({ 'x-rate-limit': '0.5' }, NOW).rateLimit).toBe(0.5);
  });

  it('gives null for a negative cost, use or rate, but keeps a negative remaining: overspent', () => {
    const meters = readResponseMeters(
      {
        'x-datapoints': '-1',
        'x-datapoints-used': '-1',
        'x-datapoints-remaining': '-250',
        'x-rate-limit': '-2',
      },
      NOW,
    );
    expect(meters.cost).toBeNull();
    expect(meters.rateLimit).toBeNull();
    expect(meters.snapshot?.used).toBeNull();
    expect(meters.snapshot?.remaining).toBe(-250);
  });

  it('reads a negative zero as 0', () => {
    const meters = readResponseMeters(
      { 'x-datapoints': '-0', 'x-datapoints-remaining': '-0' },
      NOW,
    );
    expect(Object.is(meters.cost, 0)).toBe(true);
    expect(Object.is(meters.snapshot?.remaining, 0)).toBe(true);
  });

  describe('x-datapoints-reset', () => {
    const resetOf = (value: string) =>
      readResponseMeters({ 'x-datapoints-used': '1', 'x-datapoints-reset': value }, NOW).snapshot
        ?.resetAt;

    it.each([
      ['UTC', '2026-12-01T00:00:00Z', '2026-12-01T00:00:00.000Z'],
      ['UTC with milliseconds', '2026-12-01T00:00:00.250Z', '2026-12-01T00:00:00.250Z'],
      ['UTC without seconds', '2026-12-01T06:30Z', '2026-12-01T06:30:00.000Z'],
      ['an offset', '2026-12-01T02:00:00+02:00', '2026-12-01T00:00:00.000Z'],
      ['a negative offset', '2026-11-30T18:00:00-06:00', '2026-12-01T00:00:00.000Z'],
      ['a date alone, at midnight UTC', '2026-12-01', '2026-12-01T00:00:00.000Z'],
      ['spaces around it', '  2026-12-01T00:00:00Z ', '2026-12-01T00:00:00.000Z'],
    ])('reads %s', (_name, value, expected) => {
      expect(resetOf(value)?.toISOString()).toBe(expected);
    });

    it.each([
      ['a time without a zone, which would depend on the machine', '2026-12-01T00:00:00'],
      ['a space instead of the T', '2026-12-01 00:00:00Z'],
      ['an offset without a colon', '2026-12-01T02:00:00+0200'],
      ['a Unix time', '1796083200'],
      ['a day and month first', '01/12/2026'],
      ['words', 'tomorrow'],
      ['an impossible month', '2026-13-45T00:00:00Z'],
      ['an impossible hour', '2026-12-01T25:00:00Z'],
      ['empty', ''],
    ])('does not read %s', (_name, value) => {
      expect(resetOf(value)).toBeNull();
    });
  });

  it('returns the delay header as it came, for effectiveDelaySeconds', () => {
    const delayOf = (value: string) =>
      readResponseMeters({ 'x-data-delay-seconds': value }, NOW).delayHeader;
    expect(delayOf('60')).toBe('60');
    expect(delayOf(' 60 ')).toBe(' 60 ');
    expect(delayOf('')).toBe('');
    expect(delayOf('abc')).toBe('abc');
    expect(readResponseMeters({}, NOW).delayHeader).toBeNull();
  });

  it('reads lower-case names only, as the fetcher gives them', () => {
    const meters = readResponseMeters({ 'X-Datapoints': '27', 'X-Data-Delay-Seconds': '60' }, NOW);
    expect(meters.cost).toBeNull();
    expect(meters.delayHeader).toBeNull();
  });

  it('does not read a header the object only inherits', () => {
    const headers = Object.create({ 'x-datapoints': '27' }) as Record<string, string>;
    expect(readResponseMeters(headers, NOW).cost).toBeNull();
  });

  it('never throws and only gives values it can stand behind (property)', () => {
    const names = [
      'x-datapoints',
      'x-datapoints-used',
      'x-datapoints-remaining',
      'x-datapoints-reset',
      'x-rate-limit',
      'x-data-delay-seconds',
      'x-other',
    ];
    const headers = fc.dictionary(
      fc.constantFrom(...names),
      fc.oneof(fc.string(), fc.nat().map(String), fc.integer().map(String)),
    );
    fc.assert(
      fc.property(headers, (given) => {
        const meters = readResponseMeters(given, NOW);
        for (const reading of [meters.cost, meters.rateLimit, meters.snapshot?.used ?? null]) {
          if (reading !== null) {
            expect(Number.isFinite(reading)).toBe(true);
            expect(reading).toBeGreaterThanOrEqual(0);
          }
        }
        if (meters.snapshot !== null) {
          expect(meters.snapshot.used !== null || meters.snapshot.remaining !== null).toBe(true);
          const { remaining, resetAt } = meters.snapshot;
          if (remaining !== null) expect(Number.isFinite(remaining)).toBe(true);
          if (resetAt !== null) expect(Number.isNaN(resetAt.getTime())).toBe(false);
        }
        expect(meters.delayHeader).toBe(given['x-data-delay-seconds'] ?? null);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('budgetLevel', () => {
  const QUOTA = 25_000_000;
  /** 5% of the quota. */
  const RESERVE = 1_250_000;
  const snap = (remaining: number | null, resetAt: Date | null = null): BudgetSnapshot => ({
    used: null,
    remaining,
    resetAt,
    observedAt: NOW,
  });
  const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);
  const level = (
    snapshot: BudgetSnapshot | null,
    spentToday = 0,
    over: Partial<Parameters<typeof budgetLevel>[0]> = {},
  ) => budgetLevel({ snapshot, quota: QUOTA, spentToday, now: NOW, ...over });

  it('keeps 5% of the quota back by default', () => {
    expect(BUDGET_RESERVE_FRACTION).toBe(0.05);
    expect(level(null).reserve).toBe(RESERVE);
  });

  it('rounds the reserve down and takes another share when told', () => {
    expect(level(null, 0, { quota: 99 }).reserve).toBe(4);
    expect(level(null, 0, { quota: 100 }).reserve).toBe(5);
    expect(level(null, 0, { quota: 19 }).reserve).toBe(0);
    expect(level(null, 0, { reserveFraction: 0.1 }).reserve).toBe(2_500_000);
    expect(level(null, 0, { reserveFraction: 0 }).reserve).toBe(0);
    expect(level(null, 0, { reserveFraction: 1 }).reserve).toBe(QUOTA);
  });

  describe('unknown', () => {
    it.each([
      ['no snapshot', null],
      ['a snapshot without remaining', snap(null)],
      ['a remaining that is NaN', snap(Number.NaN)],
      ['a remaining that is infinite', snap(Number.POSITIVE_INFINITY)],
    ])('with %s', (_name, snapshot) => {
      expect(level(snapshot, 999_999_999)).toEqual({
        level: 'unknown',
        dailyAllowance: null,
        reserve: RESERVE,
      });
    });

    it('does not use `used` when remaining is missing', () => {
      expect(level({ ...snap(null), used: 5 }).level).toBe('unknown');
    });
  });

  describe('red', () => {
    it('is red when what remains is the reserve or less', () => {
      expect(level(snap(RESERVE)).level).toBe('red');
      expect(level(snap(RESERVE - 1)).level).toBe('red');
      expect(level(snap(1)).level).toBe('red');
      expect(level(snap(0)).level).toBe('red');
      expect(level(snap(-100)).level).toBe('red');
    });

    it('is not red one point above the reserve', () => {
      expect(level(snap(RESERVE + 1, inDays(10))).level).toBe('green');
    });

    it('has an allowance of 0, and does not look at today or the reset', () => {
      expect(level(snap(RESERVE), 0)).toEqual({
        level: 'red',
        dailyAllowance: 0,
        reserve: RESERVE,
      });
      expect(level(snap(5, inDays(3)), 1_000_000).dailyAllowance).toBe(0);
    });

    it('goes with the reserve that was asked for', () => {
      expect(level(snap(2_000_000), 0, { reserveFraction: 0.1 }).level).toBe('red');
      expect(level(snap(2_000_000), 0, { reserveFraction: 0.05 }).level).toBe('green');
      expect(level(snap(0), 0, { reserveFraction: 0 }).level).toBe('red');
      expect(level(snap(1), 0, { reserveFraction: 0 }).level).toBe('green');
      expect(level(snap(QUOTA), 0, { reserveFraction: 1 }).level).toBe('red');
    });
  });

  describe('amber and green', () => {
    // 10 million over the reserve and 10 days to go: an allowance of 1 million a day.
    const REMAINING = RESERVE + 10_000_000;
    const reset = inDays(10);

    it('is green under the daily allowance', () => {
      expect(level(snap(REMAINING, reset), 0).level).toBe('green');
      expect(level(snap(REMAINING, reset), 999_999).level).toBe('green');
    });

    it('is amber exactly at the daily allowance', () => {
      const result = level(snap(REMAINING, reset), 1_000_000);
      expect(result.dailyAllowance).toBe(1_000_000);
      expect(result.level).toBe('amber');
      expect(result.reserve).toBe(RESERVE);
    });

    it('is amber over the daily allowance', () => {
      expect(level(snap(REMAINING, reset), 1_000_001).level).toBe('amber');
      expect(level(snap(REMAINING, reset), QUOTA).level).toBe('amber');
    });

    it('reports the allowance at green too', () => {
      expect(level(snap(REMAINING, reset), 5).dailyAllowance).toBe(1_000_000);
    });

    it('spreads what is left over the days to the reset, rounded up', () => {
      const allowanceAt = (resetAt: Date | null): number | null =>
        level(snap(REMAINING, resetAt)).dailyAllowance;
      expect(allowanceAt(inDays(10))).toBe(1_000_000);
      expect(allowanceAt(new Date(inDays(9).getTime() + 1))).toBe(1_000_000);
      expect(allowanceAt(new Date(inDays(10).getTime() + 1))).toBeCloseTo(10_000_000 / 11, 6);
      expect(allowanceAt(inDays(1))).toBe(10_000_000);
      expect(allowanceAt(new Date(NOW.getTime() + 12 * HOUR_MS))).toBe(10_000_000);
      expect(allowanceAt(new Date(NOW.getTime() + 1))).toBe(10_000_000);
      expect(allowanceAt(inDays(30))).toBeCloseTo(10_000_000 / 30, 6);
    });

    it('uses 30 days when the reset is unknown, past or unreadable', () => {
      // 300 000 over the reserve: 10 000 a day over 30 days.
      const remaining = RESERVE + 300_000;
      for (const resetAt of [
        null,
        NOW,
        new Date(NOW.getTime() - 1),
        inDays(-5),
        new Date(Number.NaN),
        '2026-12-01' as unknown as Date,
      ]) {
        const result = level(snap(remaining, resetAt), 10_000);
        expect(result.dailyAllowance).toBe(10_000);
        expect(result.level).toBe('amber');
        expect(level(snap(remaining, resetAt), 9_999).level).toBe('green');
      }
    });

    it('reads a reset a millisecond ahead as one day, not 30', () => {
      expect(level(snap(REMAINING, new Date(NOW.getTime() + 1))).dailyAllowance).toBe(10_000_000);
    });

    it('never has a negative allowance outside red', () => {
      expect(level(snap(RESERVE + 1, inDays(1))).dailyAllowance).toBe(1);
    });
  });

  describe('invalid arguments', () => {
    it.each([
      ['NaN', Number.NaN],
      ['negative', -1],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('refuses a quota that is %s', (_name, quota) => {
      expect(() => level(snap(1), 0, { quota })).toThrow(RangeError);
    });

    it.each([
      ['NaN', Number.NaN],
      ['negative', -1],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('refuses spentToday that is %s', (_name, spentToday) => {
      expect(() => level(snap(1), spentToday)).toThrow(RangeError);
    });

    it.each([
      ['NaN', Number.NaN],
      ['negative', -0.1],
      ['above 1', 1.1],
    ])('refuses a reserve fraction that is %s', (_name, reserveFraction) => {
      expect(() => level(snap(1), 0, { reserveFraction })).toThrow(RangeError);
    });

    it('refuses an invalid now', () => {
      expect(() => level(snap(1), 0, { now: new Date(Number.NaN) })).toThrow(RangeError);
    });

    it('accepts a quota of 0', () => {
      expect(level(snap(0), 0, { quota: 0 }).level).toBe('red');
      expect(level(snap(1), 0, { quota: 0 }).level).toBe('green');
    });
  });

  it('is red or unknown whatever today has spent, and else goes amber as spending grows (property)', () => {
    const remainingArb = fc.oneof(
      fc.constant(null),
      fc.integer({ min: -1000, max: QUOTA }),
      fc.integer({ min: RESERVE - 5, max: RESERVE + 5 }),
    );
    const resetArb = fc.oneof(
      fc.constant(null),
      fc
        .integer({ min: -3 * DAY_MS, max: 40 * DAY_MS })
        .map((offset) => new Date(NOW.getTime() + offset)),
    );
    const order: Record<BudgetLevel, number> = { unknown: 0, red: 0, green: 1, amber: 2 };
    fc.assert(
      fc.property(
        remainingArb,
        resetArb,
        fc.integer({ min: 0, max: QUOTA }),
        fc.integer({ min: 0, max: QUOTA }),
        (remaining, resetAt, spentA, spentB) => {
          const [low, high] = spentA <= spentB ? [spentA, spentB] : [spentB, spentA];
          const a = level(snap(remaining, resetAt), low);
          const b = level(snap(remaining, resetAt), high);
          expect(a.reserve).toBe(RESERVE);
          if (remaining === null) {
            expect(a.level).toBe('unknown');
            expect(a.dailyAllowance).toBeNull();
          } else if (remaining <= RESERVE) {
            expect(a.level).toBe('red');
            expect(b.level).toBe('red');
            expect(a.dailyAllowance).toBe(0);
          } else {
            expect(a.dailyAllowance).toBeGreaterThan(0);
            expect(a.dailyAllowance).toBeLessThanOrEqual(remaining - RESERVE);
            expect(b.dailyAllowance).toBe(a.dailyAllowance);
            expect(order[a.level]).toBeLessThanOrEqual(order[b.level]);
            expect(a.level === 'amber').toBe(low >= a.dailyAllowance!);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('pollIntervalFor', () => {
  const BASE = 60_000;
  const COUNT = 4;
  const at = (index: number, level: BudgetLevel, count = COUNT, base = BASE) =>
    pollIntervalFor(index, count, base, level);

  it('polls at the base interval at green and unknown, in every tier', () => {
    for (let i = 0; i < COUNT; i++) {
      expect(at(i, 'green')).toBe(BASE);
      expect(at(i, 'unknown')).toBe(BASE);
    }
  });

  it('polls the two slowest tiers half as often at amber, and the others as before', () => {
    expect([0, 1, 2, 3].map((i) => at(i, 'amber'))).toEqual([BASE, BASE, 2 * BASE, 2 * BASE]);
  });

  it('stops price polling at red, in every tier', () => {
    for (let i = 0; i < COUNT; i++) expect(at(i, 'red')).toBeNull();
  });

  it('counts the two slowest from the tier count', () => {
    expect(at(0, 'amber', 1)).toBe(2 * BASE);
    expect([0, 1].map((i) => at(i, 'amber', 2))).toEqual([2 * BASE, 2 * BASE]);
    expect([0, 1, 2].map((i) => at(i, 'amber', 3))).toEqual([BASE, 2 * BASE, 2 * BASE]);
    expect([0, 1, 2, 3, 4, 5].map((i) => at(i, 'amber', 6))).toEqual([
      BASE,
      BASE,
      BASE,
      BASE,
      2 * BASE,
      2 * BASE,
    ]);
  });

  it('works on whatever base interval it is given', () => {
    expect(at(3, 'amber', COUNT, 1_800_000)).toBe(3_600_000);
    expect(at(0, 'amber', COUNT, 1_800_000)).toBe(1_800_000);
    expect(at(3, 'green', COUNT, 0.5)).toBe(0.5);
  });

  it.each([
    ['a tier count of 0', () => pollIntervalFor(0, 0, BASE, 'green')],
    ['a tier count that is not whole', () => pollIntervalFor(0, 1.5, BASE, 'green')],
    ['a tier count that is NaN', () => pollIntervalFor(0, Number.NaN, BASE, 'green')],
    ['a negative tier', () => pollIntervalFor(-1, COUNT, BASE, 'green')],
    ['a tier equal to the count', () => pollIntervalFor(COUNT, COUNT, BASE, 'green')],
    ['a tier that is not whole', () => pollIntervalFor(1.5, COUNT, BASE, 'green')],
    ['a tier that is NaN', () => pollIntervalFor(Number.NaN, COUNT, BASE, 'green')],
    ['a base interval of 0', () => pollIntervalFor(0, COUNT, 0, 'green')],
    ['a negative base interval', () => pollIntervalFor(0, COUNT, -1, 'green')],
    ['a base interval that is NaN', () => pollIntervalFor(0, COUNT, Number.NaN, 'green')],
    [
      'an infinite base interval',
      () => pollIntervalFor(0, COUNT, Number.POSITIVE_INFINITY, 'green'),
    ],
    ['a level it does not know', () => pollIntervalFor(0, COUNT, BASE, 'purple' as BudgetLevel)],
  ])('refuses %s', (_name, call) => {
    expect(call).toThrow(RangeError);
  });

  it('never polls more often as the budget gets worse, and never faster in a slower tier (property)', () => {
    const levels: BudgetLevel[] = ['green', 'amber', 'red'];
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        (count, base) => {
          for (let i = 0; i < count; i++) {
            const [green, amber, red] = levels.map((l) => pollIntervalFor(i, count, base, l));
            expect(green).toBe(base);
            expect(amber).toBeGreaterThanOrEqual(green!);
            expect([base, 2 * base]).toContain(amber);
            expect(red).toBeNull();
            if (i > 0) {
              expect(pollIntervalFor(i, count, base, 'amber')!).toBeGreaterThanOrEqual(
                pollIntervalFor(i - 1, count, base, 'amber')!,
              );
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('isQuotaExhausted', () => {
  const retryIn = (ms: number): Date => new Date(NOW.getTime() + ms);
  const limited = (retryAt: Date | null) => ({ reason: 'rate_limited', retryAt });

  it('has a threshold of a minute', () => {
    expect(QUOTA_RETRY_THRESHOLD_MS).toBe(60_000);
  });

  it('is the quota when the 429 says nothing about when to retry', () => {
    expect(isQuotaExhausted(limited(null), NOW)).toBe(true);
  });

  it('is the quota when the retry is more than a minute away, not exactly a minute', () => {
    expect(isQuotaExhausted(limited(retryIn(QUOTA_RETRY_THRESHOLD_MS + 1)), NOW)).toBe(true);
    expect(isQuotaExhausted(limited(retryIn(QUOTA_RETRY_THRESHOLD_MS)), NOW)).toBe(false);
    expect(isQuotaExhausted(limited(retryIn(DAY_MS)), NOW)).toBe(true);
  });

  it('is a burst limit when the retry is soon or already past', () => {
    expect(isQuotaExhausted(limited(retryIn(1)), NOW)).toBe(false);
    expect(isQuotaExhausted(limited(retryIn(0)), NOW)).toBe(false);
    expect(isQuotaExhausted(limited(retryIn(-5000)), NOW)).toBe(false);
    expect(isQuotaExhausted(limited(retryIn(30_000)), NOW)).toBe(false);
  });

  it.each(['forbidden', 'robots', 'block_page', 'unauthorized', 'unavailable', ''])(
    'is never the quota for the reason "%s", however far the retry is',
    (reason) => {
      expect(isQuotaExhausted({ reason, retryAt: retryIn(DAY_MS) }, NOW)).toBe(false);
      expect(isQuotaExhausted({ reason, retryAt: null }, NOW)).toBe(false);
    },
  );

  it('says the quota is gone when the time cannot be read', () => {
    expect(isQuotaExhausted(limited(new Date(Number.NaN)), NOW)).toBe(true);
    expect(isQuotaExhausted(limited('2026-11-11' as unknown as Date), NOW)).toBe(true);
    expect(isQuotaExhausted(limited(retryIn(1000)), new Date(Number.NaN))).toBe(true);
  });
});

describe('expectedCost', () => {
  it('is 2 per event plus 1 per price', () => {
    // One football event, 5 books, 5 prices each: 2 + 25 (README 5.3).
    expect(expectedCost(1, 5, 5)).toBe(27);
    expect(expectedCost(1, 5, 4)).toBe(22);
    expect(expectedCost(300, 5, 5)).toBe(8100);
  });

  it('is 2 per event when there are no prices', () => {
    expect(expectedCost(10, 0, 5)).toBe(20);
    expect(expectedCost(10, 5, 0)).toBe(20);
    expect(expectedCost(0, 5, 5)).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a count that is %s', (_name, bad) => {
    expect(() => expectedCost(bad, 5, 5)).toThrow(RangeError);
    expect(() => expectedCost(1, bad, 5)).toThrow(RangeError);
    expect(() => expectedCost(1, 5, bad)).toThrow(RangeError);
  });

  it('is at least 2 per event and grows with each count (property)', () => {
    const count = fc.integer({ min: 0, max: 5000 });
    fc.assert(
      fc.property(count, count, count, (events, books, prices) => {
        const cost = expectedCost(events, books, prices);
        expect(cost).toBe(2 * events + events * books * prices);
        expect(cost).toBeGreaterThanOrEqual(2 * events);
        expect(expectedCost(events + 1, books, prices)).toBeGreaterThan(cost);
        expect(expectedCost(events, books + 1, prices)).toBeGreaterThanOrEqual(cost);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('isCostSpike', () => {
  it('needs more than twice the expected cost', () => {
    expect(isCostSpike(1000, 2000)).toBe(false);
    expect(isCostSpike(1000, 2001)).toBe(true);
    expect(isCostSpike(1000, 1500)).toBe(false);
    expect(isCostSpike(1000, 1000)).toBe(false);
    expect(isCostSpike(1000, 0)).toBe(false);
  });

  it('and more than 50 points above it, so a small response does not alert', () => {
    // Twice is passed (>) but the excess is not above 50.
    expect(isCostSpike(27, 54)).toBe(false);
    expect(isCostSpike(27, 55)).toBe(false);
    expect(isCostSpike(27, 77)).toBe(false);
    expect(isCostSpike(27, 78)).toBe(true);
    expect(isCostSpike(10, 60)).toBe(false);
    expect(isCostSpike(10, 61)).toBe(true);
  });

  it('is a spike for any cost over 50 when none was expected', () => {
    expect(isCostSpike(0, 50)).toBe(false);
    expect(isCostSpike(0, 51)).toBe(true);
    expect(isCostSpike(0, 0)).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('counts a number that is %s as a spike: it cannot be vouched for', (_name, bad) => {
    expect(isCostSpike(bad, 100)).toBe(true);
    expect(isCostSpike(100, bad)).toBe(true);
  });

  it('is exactly the two conditions, and once true stays true as the cost grows (property)', () => {
    const points = fc.integer({ min: 0, max: 1_000_000 });
    fc.assert(
      fc.property(points, points, points, (expected, actual, more) => {
        const spike = isCostSpike(expected, actual);
        expect(spike).toBe(actual > 2 * expected && actual - expected > 50);
        if (spike) expect(isCostSpike(expected, actual + more)).toBe(true);
        // A response at or under the expected cost is never a spike.
        expect(isCostSpike(expected, Math.min(actual, expected))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
