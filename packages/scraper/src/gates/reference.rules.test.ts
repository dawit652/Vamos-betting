import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../constants';
import {
  DEFAULT_UNKNOWN_DELAY_SECONDS,
  GUARD_MAX_PLAYER_EDGE,
  GUARD_UNCOMPETITIVE_EDGE,
  type GuardSelection,
  KICKOFF_MATCH_TOLERANCE_MS,
  MAX_MOVE,
  MIN_CLOSE_LEAD_MS,
  REFERENCE_TIERS,
  STEAM_MOVE,
  THERUNDOWN_PREMATCH_STATUSES,
  THERUNDOWN_STARTED_STATUSES,
  closeLeadMs,
  effectiveDelaySeconds,
  guardMarket,
  kickoffVerdict,
  moveVerdict,
  playerEdge,
  priceValidUntil,
  referenceAsOf,
  referenceTier,
} from './reference';

/*
 * The rules of the TheRundown reference (docs/therundown-plan/README.md): the
 * tiers, the delay, the close lead, the kickoff rule, the odds-error guard and
 * the moves. (reference.test.ts is the brute-force model test of the fixture
 * and result gates, a different thing.)
 */

const NUM_RUNS = 300;
const TOLERANCE = KICKOFF_MATCH_TOLERANCE_MS;
const INVALID = new Date(Number.NaN);

describe('REFERENCE_TIERS', () => {
  it('are the cadence of the plan, in milliseconds', () => {
    expect(REFERENCE_TIERS).toEqual([
      {
        name: 'near',
        upToMs: 10_800_000,
        pollMs: 60_000,
        maxAgeMs: 180_000,
        maxBookAgeMs: 1_800_000,
      },
      {
        name: 'day',
        upToMs: 43_200_000,
        pollMs: 300_000,
        maxAgeMs: 900_000,
        maxBookAgeMs: 21_600_000,
      },
      {
        name: 'two_days',
        upToMs: 172_800_000,
        pollMs: 1_200_000,
        maxAgeMs: 3_600_000,
        maxBookAgeMs: 21_600_000,
      },
      {
        name: 'week',
        upToMs: 604_800_000,
        pollMs: 3_600_000,
        maxAgeMs: 10_800_000,
        maxBookAgeMs: 21_600_000,
      },
    ]);
  });

  it('are frozen, and so is the list', () => {
    expect(Object.isFrozen(REFERENCE_TIERS)).toBe(true);
    for (const tier of REFERENCE_TIERS) expect(Object.isFrozen(tier)).toBe(true);
    expect(() => {
      (REFERENCE_TIERS as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('poll slower and keep their reference longer the further out the kickoff is', () => {
    for (let i = 1; i < REFERENCE_TIERS.length; i++) {
      const closer = REFERENCE_TIERS[i - 1]!;
      const further = REFERENCE_TIERS[i]!;
      expect(further.upToMs).toBeGreaterThan(closer.upToMs);
      expect(further.pollMs).toBeGreaterThan(closer.pollMs);
      expect(further.maxAgeMs).toBeGreaterThan(closer.maxAgeMs);
      expect(further.maxBookAgeMs).toBeGreaterThanOrEqual(closer.maxBookAgeMs);
    }
  });

  it('let a reference live at least as long as one poll interval', () => {
    // Else it would expire between two healthy polls and stop betting for nothing.
    for (const tier of REFERENCE_TIERS) expect(tier.maxAgeMs).toBeGreaterThanOrEqual(tier.pollMs);
  });
});

describe('referenceTier', () => {
  const START = new Date('2026-11-07T19:00:00.000Z');
  const ahead = (ms: number): Date => new Date(START.getTime() - ms);
  const nameAt = (ms: number): string | undefined => referenceTier(START, ahead(ms))?.name;

  it('picks the tier whose limit covers the time to kickoff, on each limit', () => {
    expect(nameAt(1)).toBe('near');
    expect(nameAt(3 * HOUR_MS)).toBe('near');
    expect(nameAt(3 * HOUR_MS + 1)).toBe('day');
    expect(nameAt(12 * HOUR_MS)).toBe('day');
    expect(nameAt(12 * HOUR_MS + 1)).toBe('two_days');
    expect(nameAt(48 * HOUR_MS)).toBe('two_days');
    expect(nameAt(48 * HOUR_MS + 1)).toBe('week');
    expect(nameAt(7 * DAY_MS)).toBe('week');
  });

  it('returns the tier itself', () => {
    expect(referenceTier(START, ahead(HOUR_MS))).toBe(REFERENCE_TIERS[0]);
    expect(referenceTier(START, ahead(5 * DAY_MS))).toBe(REFERENCE_TIERS[3]);
  });

  it('is null once the event has started, at the start itself included', () => {
    expect(referenceTier(START, START)).toBeNull();
    expect(referenceTier(START, new Date(START.getTime() + 1))).toBeNull();
    expect(referenceTier(START, new Date(START.getTime() + DAY_MS))).toBeNull();
  });

  it('is null when the event starts more than 7 days ahead', () => {
    expect(nameAt(7 * DAY_MS + 1)).toBeUndefined();
    expect(nameAt(30 * DAY_MS)).toBeUndefined();
  });

  it('is null for an invalid date', () => {
    expect(referenceTier(INVALID, START)).toBeNull();
    expect(referenceTier(START, INVALID)).toBeNull();
    expect(referenceTier(INVALID, INVALID)).toBeNull();
  });

  it('never gets slower as the kickoff gets closer (property)', () => {
    const timeToKickoff = fc.integer({ min: 1, max: 8 * DAY_MS });
    fc.assert(
      fc.property(timeToKickoff, timeToKickoff, (a, b) => {
        const closer = referenceTier(START, ahead(Math.min(a, b)));
        const further = referenceTier(START, ahead(Math.max(a, b)));
        if (closer === null) {
          // Only a kickoff more than a week away has no tier.
          expect(Math.min(a, b)).toBeGreaterThan(7 * DAY_MS);
          expect(further).toBeNull();
          return;
        }
        if (further === null) return;
        expect(REFERENCE_TIERS.indexOf(closer)).toBeLessThanOrEqual(
          REFERENCE_TIERS.indexOf(further),
        );
        expect(closer.pollMs).toBeLessThanOrEqual(further.pollMs);
        expect(closer.maxAgeMs).toBeLessThanOrEqual(further.maxAgeMs);
        expect(closer.maxBookAgeMs).toBeLessThanOrEqual(further.maxBookAgeMs);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('has a tier at every moment of the last 7 days and none after (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2 * DAY_MS, max: 9 * DAY_MS }), (untilKickoff) => {
        const tier = referenceTier(START, ahead(untilKickoff));
        expect(tier === null).toBe(untilKickoff <= 0 || untilKickoff > 7 * DAY_MS);
        if (tier !== null) expect(untilKickoff).toBeLessThanOrEqual(tier.upToMs);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('effectiveDelaySeconds (A1)', () => {
  it('trusts a header that is not less than the plan', () => {
    expect(effectiveDelaySeconds('60', 60)).toBe(60);
    expect(effectiveDelaySeconds('90', 60)).toBe(90);
    expect(effectiveDelaySeconds(' 90 ', 60)).toBe(90);
    expect(effectiveDelaySeconds('0090', 60)).toBe(90);
  });

  it('never goes under what the plan says', () => {
    expect(effectiveDelaySeconds('30', 60)).toBe(60);
    expect(effectiveDelaySeconds('0', 60)).toBe(60);
  });

  it('believes a header of 0 only on a plan with no delay', () => {
    expect(effectiveDelaySeconds('0', 0)).toBe(0);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['text', 'abc'],
    ['a fraction', '60.5'],
    ['a negative number', '-5'],
    ['a signed number', '+60'],
    ['an exponent', '1e2'],
    ['with units', '60s'],
    ['hex', '0x3c'],
    ['a list', '60, 60'],
  ])('counts a header that is %s as the unknown delay, never 0', (_name, header) => {
    expect(effectiveDelaySeconds(header, 0)).toBe(DEFAULT_UNKNOWN_DELAY_SECONDS);
    expect(effectiveDelaySeconds(header, 60)).toBe(300);
    expect(effectiveDelaySeconds(header, 600)).toBe(600);
  });

  it('is 300 s for the unknown delay', () => {
    expect(DEFAULT_UNKNOWN_DELAY_SECONDS).toBe(300);
  });

  it('is clamped to a day', () => {
    expect(effectiveDelaySeconds('86400', 60)).toBe(86_400);
    expect(effectiveDelaySeconds('86401', 60)).toBe(86_400);
    expect(effectiveDelaySeconds('99999999999999999999999', 60)).toBe(86_400);
    expect(effectiveDelaySeconds('9'.repeat(400), 60)).toBe(86_400);
    expect(effectiveDelaySeconds('1', 1_000_000)).toBe(86_400);
    expect(effectiveDelaySeconds(null, Number.POSITIVE_INFINITY)).toBe(300);
  });

  it('treats a plan delay that is not a number of at least 0 as the unknown delay, a fraction as rounded up', () => {
    expect(effectiveDelaySeconds('0', Number.NaN)).toBe(300);
    expect(effectiveDelaySeconds('0', -5)).toBe(300);
    expect(effectiveDelaySeconds('0', 60.2)).toBe(61);
  });

  it('is a whole number of seconds from 0 to 86400, at least the plan, and 300 or more without a header (property)', () => {
    const header = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.nat({ max: 200_000 }).map(String),
      fc.integer({ min: -1000, max: -1 }).map(String),
      fc.double({ noNaN: true, noDefaultInfinity: true }).map(String),
    );
    fc.assert(
      fc.property(header, fc.integer({ min: 0, max: 100_000 }), (value, plan) => {
        const delay = effectiveDelaySeconds(value, plan);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(86_400);
        expect(delay).toBeGreaterThanOrEqual(Math.min(plan, 86_400));
        if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) {
          expect(delay).toBeGreaterThanOrEqual(DEFAULT_UNKNOWN_DELAY_SECONDS);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('closeLeadMs', () => {
  it('is the 5 minute floor while twice the delay plus a poll is under it', () => {
    expect(MIN_CLOSE_LEAD_MS).toBe(300_000);
    expect(closeLeadMs(0)).toBe(300_000);
    // Starter: a 60 s delay and a 60 s poll make 3 minutes by the formula.
    expect(closeLeadMs(60)).toBe(300_000);
    // The two meet at 120 s: 2 * 120 s + 60 s = 300 s.
    expect(closeLeadMs(120)).toBe(300_000);
  });

  it('is twice the delay plus a poll above that', () => {
    expect(closeLeadMs(121)).toBe(302_000);
    expect(closeLeadMs(300)).toBe(660_000);
    expect(closeLeadMs(3600)).toBe(7_260_000);
  });

  it('takes the poll interval of the near tier from the second argument', () => {
    expect(closeLeadMs(300, 30_000)).toBe(630_000);
    expect(closeLeadMs(300, 0)).toBe(600_000);
    expect(closeLeadMs(10, 400_000)).toBe(420_000);
  });

  it('counts a delay that is not a finite number of at least 0 as the unknown delay', () => {
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(closeLeadMs(bad)).toBe(660_000);
    }
  });

  it('counts a bad poll interval as one minute', () => {
    expect(closeLeadMs(300, Number.NaN)).toBe(660_000);
    expect(closeLeadMs(300, -1)).toBe(660_000);
    expect(closeLeadMs(300, Number.POSITIVE_INFINITY)).toBe(660_000);
  });

  it('is capped at 6 hours, what the database allows', () => {
    expect(closeLeadMs(10_000)).toBe(20_060_000);
    expect(closeLeadMs(10_800)).toBe(21_600_000);
    expect(closeLeadMs(86_400)).toBe(21_600_000);
    expect(closeLeadMs(1e300)).toBe(21_600_000);
    expect(closeLeadMs(10, 1e12)).toBe(21_600_000);
  });

  it('is rounded up to a whole millisecond', () => {
    expect(closeLeadMs(1000.0004)).toBe(2_060_001);
    expect(Number.isSafeInteger(closeLeadMs(1234.5678, 12.34))).toBe(true);
  });

  it('is at least the floor and twice the delay, and a whole number of ms up to 6 h (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3600, noNaN: true }),
        fc.integer({ min: 0, max: 600_000 }),
        (delay, poll) => {
          const lead = closeLeadMs(delay, poll);
          expect(lead).toBeGreaterThanOrEqual(MIN_CLOSE_LEAD_MS);
          expect(lead).toBeGreaterThanOrEqual(2 * delay * 1000);
          expect(lead).toBeGreaterThanOrEqual(2 * delay * 1000 + poll);
          expect(Number.isSafeInteger(lead)).toBe(true);
          expect(lead).toBeLessThanOrEqual(6 * HOUR_MS);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never closes sooner for a longer delay (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (a, b) => {
          expect(closeLeadMs(Math.min(a, b))).toBeLessThanOrEqual(closeLeadMs(Math.max(a, b)));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('referenceAsOf and priceValidUntil', () => {
  const FETCHED = new Date('2026-11-07T12:00:00.000Z');

  it('puts the prices a delay before the fetch', () => {
    expect(referenceAsOf(FETCHED, 60).toISOString()).toBe('2026-11-07T11:59:00.000Z');
    expect(referenceAsOf(FETCHED, 0).toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(referenceAsOf(FETCHED, 300).toISOString()).toBe('2026-11-07T11:55:00.000Z');
    expect(referenceAsOf(FETCHED, 0.5).getTime()).toBe(FETCHED.getTime() - 500);
  });

  it('does not change its input and returns a new Date', () => {
    const before = FETCHED.getTime();
    const asOf = referenceAsOf(FETCHED, 60);
    expect(asOf).not.toBe(FETCHED);
    expect(FETCHED.getTime()).toBe(before);
  });

  it('counts a delay that is not a finite number of at least 0 as the unknown delay', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(referenceAsOf(FETCHED, bad).toISOString()).toBe('2026-11-07T11:55:00.000Z');
    }
  });

  it('gives an invalid Date for an invalid fetch time', () => {
    expect(Number.isNaN(referenceAsOf(INVALID, 60).getTime())).toBe(true);
  });

  it('keeps a reference valid for the tier max age after its as-of time', () => {
    const asOf = new Date('2026-11-07T11:59:00.000Z');
    const until = (index: number): string =>
      priceValidUntil(asOf, REFERENCE_TIERS[index]!).toISOString();
    expect(until(0)).toBe('2026-11-07T12:02:00.000Z'); // near: 3 min
    expect(until(1)).toBe('2026-11-07T12:14:00.000Z'); // day: 15 min
    expect(until(2)).toBe('2026-11-07T12:59:00.000Z'); // two_days: 60 min
    expect(until(3)).toBe('2026-11-07T14:59:00.000Z'); // week: 3 h
    expect(asOf.toISOString()).toBe('2026-11-07T11:59:00.000Z');
  });

  it('is invalid when the as-of time is', () => {
    expect(Number.isNaN(priceValidUntil(INVALID, REFERENCE_TIERS[0]!).getTime())).toBe(true);
  });

  it('puts the end of the validity a delay and a max age after the fetch (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 86_400 }),
        fc.constantFrom(...REFERENCE_TIERS),
        (delay, tier) => {
          const validUntil = priceValidUntil(referenceAsOf(FETCHED, delay), tier);
          expect(validUntil.getTime()).toBe(FETCHED.getTime() - delay * 1000 + tier.maxAgeMs);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- The kickoff rule ------------------------------------------------------------------------

const STARTED = [
  'STATUS_IN_PROGRESS',
  'STATUS_HALFTIME',
  'STATUS_END_PERIOD',
  'STATUS_END_OF_REGULATION',
  'STATUS_OVERTIME',
  'STATUS_FIRST_HALF',
  'STATUS_SECOND_HALF',
  'STATUS_FULL_TIME',
  'STATUS_FINAL',
  'STATUS_FINAL_AET',
  'STATUS_FINAL_PEN',
  'STATUS_SHOOTOUT',
  'STATUS_SUSPENDED',
  'STATUS_FORFEIT',
];
const NOT_SCHEDULED = [
  'STATUS_POSTPONED',
  'STATUS_CANCELED',
  'STATUS_CANCELLED',
  'STATUS_DELAYED',
  'STATUS_TBD',
  'STATUS_RAIN_DELAY',
  'STATUS_NOT_AVAILABLE',
  'STATUS_ABANDONED',
  'STATUS_SOMETHING_NEW',
  'SCHEDULED',
  'status_scheduled',
  ' STATUS_SCHEDULED',
  'STATUS_SCHEDULED ',
  '',
];

describe('kickoffVerdict', () => {
  const NOW = new Date('2026-11-07T12:00:00.000Z');
  const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
  const verdict = (
    over: Partial<{ ourStart: Date; theirKickoff: Date; theirStatus: string; now: Date }> = {},
  ) =>
    kickoffVerdict({
      ourStart: at(6 * HOUR_MS),
      theirKickoff: at(6 * HOUR_MS),
      theirStatus: 'STATUS_SCHEDULED',
      now: NOW,
      ...over,
    });
  const closed = (reason: 'started' | 'not_scheduled' | 'earlier_kickoff') => ({
    action: 'close',
    reason,
  });

  it('knows the statuses', () => {
    expect([...THERUNDOWN_PREMATCH_STATUSES]).toEqual(['STATUS_SCHEDULED']);
    expect([...THERUNDOWN_STARTED_STATUSES].sort()).toEqual([...STARTED].sort());
    for (const status of THERUNDOWN_STARTED_STATUSES) {
      expect(THERUNDOWN_PREMATCH_STATUSES.has(status)).toBe(false);
    }
    expect(KICKOFF_MATCH_TOLERANCE_MS).toBe(300_000);
  });

  it('does nothing for a plain scheduled match at our time', () => {
    expect(verdict()).toEqual({ action: 'none' });
  });

  it.each(STARTED)('closes on %s as started', (status) => {
    expect(verdict({ theirStatus: status })).toEqual(closed('started'));
  });

  it.each(NOT_SCHEDULED)('closes on the status "%s" as not scheduled', (status) => {
    expect(verdict({ theirStatus: status })).toEqual(closed('not_scheduled'));
  });

  it('closes on a status that is not a string', () => {
    expect(verdict({ theirStatus: undefined as unknown as string })).toEqual(
      closed('not_scheduled'),
    );
    expect(verdict({ theirStatus: null as unknown as string })).toEqual(closed('not_scheduled'));
  });

  it('closes when their kickoff is earlier than ours by more than the tolerance, not exactly by it', () => {
    const ours = at(6 * HOUR_MS);
    expect(verdict({ theirKickoff: new Date(ours.getTime() - TOLERANCE - 1) })).toEqual(
      closed('earlier_kickoff'),
    );
    expect(verdict({ theirKickoff: new Date(ours.getTime() - TOLERANCE) })).toEqual({
      action: 'none',
    });
    expect(verdict({ theirKickoff: new Date(ours.getTime() - TOLERANCE + 1) })).toEqual({
      action: 'none',
    });
    expect(verdict({ theirKickoff: at(HOUR_MS) })).toEqual(closed('earlier_kickoff'));
  });

  it('does nothing when their kickoff is later than ours', () => {
    expect(verdict({ theirKickoff: at(6 * HOUR_MS + 1) })).toEqual({ action: 'none' });
    expect(verdict({ theirKickoff: at(30 * HOUR_MS) })).toEqual({ action: 'none' });
  });

  it('closes when their kickoff has passed while ours has not', () => {
    // Ours in 2 minutes; theirs a minute ago (3 minutes earlier, inside the tolerance).
    const ourStart = at(2 * MINUTE_MS);
    expect(verdict({ ourStart, theirKickoff: at(-MINUTE_MS) })).toEqual(closed('started'));
    // Their kickoff is this instant: passed (<= now).
    expect(verdict({ ourStart, theirKickoff: at(0) })).toEqual(closed('started'));
    // A millisecond from now: not yet.
    expect(verdict({ ourStart, theirKickoff: at(1) })).toEqual({ action: 'none' });
  });

  it('does nothing once our start has passed: our own betting is closed by then', () => {
    expect(verdict({ ourStart: at(-HOUR_MS), theirKickoff: at(-HOUR_MS) })).toEqual({
      action: 'none',
    });
    expect(verdict({ ourStart: at(0), theirKickoff: at(0) })).toEqual({ action: 'none' });
    expect(verdict({ ourStart: at(-1), theirKickoff: at(-2) })).toEqual({ action: 'none' });
    // One millisecond before our start it is not yet ours to ignore.
    expect(verdict({ ourStart: at(1), theirKickoff: at(0) })).toEqual(closed('started'));
  });

  it('says earlier_kickoff before started when both hold', () => {
    expect(verdict({ ourStart: at(HOUR_MS), theirKickoff: at(-10 * MINUTE_MS) })).toEqual(
      closed('earlier_kickoff'),
    );
  });

  it('fails closed on an invalid date of a scheduled match', () => {
    expect(verdict({ ourStart: INVALID })).toEqual(closed('not_scheduled'));
    expect(verdict({ theirKickoff: INVALID })).toEqual(closed('not_scheduled'));
    expect(verdict({ now: INVALID })).toEqual(closed('not_scheduled'));
    expect(verdict({ ourStart: '2026-11-07T18:00:00Z' as unknown as Date })).toEqual(
      closed('not_scheduled'),
    );
  });

  it('names a status before looking at the dates', () => {
    expect(verdict({ theirStatus: 'STATUS_FINAL', ourStart: INVALID })).toEqual(closed('started'));
    expect(verdict({ theirStatus: 'STATUS_POSTPONED', theirKickoff: INVALID })).toEqual(
      closed('not_scheduled'),
    );
  });

  it('never has an action that opens betting', () => {
    const results = [
      verdict(),
      verdict({ theirStatus: 'STATUS_FINAL' }),
      verdict({ ourStart: INVALID }),
    ];
    for (const result of results) expect(['none', 'close']).toContain(result.action);
  });

  const statusArb = fc.oneof(
    fc.constantFrom(...STARTED, ...NOT_SCHEDULED, 'STATUS_SCHEDULED'),
    fc.string(),
  );
  const dateArb = fc.oneof(
    fc.integer({ min: -2 * DAY_MS, max: 2 * DAY_MS }).map(at),
    fc.constant(INVALID),
  );

  it('never does nothing for a status outside the prematch ones (property)', () => {
    fc.assert(
      fc.property(
        statusArb.filter((status) => !THERUNDOWN_PREMATCH_STATUSES.has(status)),
        dateArb,
        dateArb,
        dateArb,
        (theirStatus, ourStart, theirKickoff, now) => {
          const result = kickoffVerdict({ ourStart, theirKickoff, theirStatus, now });
          expect(result.action).toBe('close');
          if (result.action === 'close') {
            expect(result.reason).toBe(
              THERUNDOWN_STARTED_STATUSES.has(theirStatus) ? 'started' : 'not_scheduled',
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('for a scheduled match matches the rule written out, around every limit (property)', () => {
    const ourOffset = fc.constantFrom(
      -HOUR_MS,
      -MINUTE_MS,
      -1,
      0,
      1,
      MINUTE_MS,
      2 * MINUTE_MS,
      TOLERANCE,
      TOLERANCE + 1,
      HOUR_MS,
      DAY_MS,
    );
    const theirShift = fc.constantFrom(
      -DAY_MS,
      -HOUR_MS,
      -TOLERANCE - 1,
      -TOLERANCE,
      -TOLERANCE + 1,
      -MINUTE_MS,
      -1,
      0,
      1,
      MINUTE_MS,
      TOLERANCE,
      HOUR_MS,
      DAY_MS,
    );
    fc.assert(
      fc.property(ourOffset, theirShift, (ourOff, shift) => {
        const result = kickoffVerdict({
          ourStart: at(ourOff),
          theirKickoff: at(ourOff + shift),
          theirStatus: 'STATUS_SCHEDULED',
          now: NOW,
        });
        const expected =
          shift < -TOLERANCE
            ? closed('earlier_kickoff')
            : ourOff + shift <= 0 && ourOff > 0
              ? closed('started')
              : { action: 'none' };
        expect(result).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- The odds-error guard ----------------------------------------------------------------------

describe('playerEdge', () => {
  it('is the probability times our odds, minus 1', () => {
    expect(playerEdge(0.5, 2000)).toBe(0);
    expect(playerEdge(0.5, 2060)).toBeCloseTo(0.03, 12);
    expect(playerEdge(0.4, 2500)).toBeCloseTo(0, 12);
    expect(playerEdge(0.25, 3000)).toBeCloseTo(-0.25, 12);
    expect(playerEdge(0.6, 2000)).toBeCloseTo(0.2, 12);
  });
});

describe('guardMarket (P6)', () => {
  const FAIR = { home: 0.5, draw: 0.3, away: 0.2 };
  /** Fair prices of FAIR in milli: 2.00, 3.33, 5.00 (a hair under, as a house would price). */
  const sel = (code: string, oddsMilli: number, selectionId = `sel-${code}`): GuardSelection => ({
    selectionId,
    code,
    oddsMilli,
  });
  const ON_MARKET = [sel('home', 1900), sel('draw', 3100), sel('away', 4700)];

  it('has the limits of the plan', () => {
    expect(GUARD_MAX_PLAYER_EDGE).toEqual({ high: 0.03, normal: 0.03, low: 0.05 });
    expect(Object.isFrozen(GUARD_MAX_PLAYER_EDGE)).toBe(true);
    expect(GUARD_UNCOMPETITIVE_EDGE).toBe(-0.15);
  });

  it('does nothing for a market priced under the consensus, and lists the edges in order', () => {
    const result = guardMarket(ON_MARKET, FAIR, 'normal');
    expect(result.action).toBe('none');
    expect(result.edges.map((e) => e.code)).toEqual(['home', 'draw', 'away']);
    expect(result.edges.map((e) => e.selectionId)).toEqual(['sel-home', 'sel-draw', 'sel-away']);
    expect(result.edges[0]!.edge).toBeCloseTo(-0.05, 12);
    expect(result.edges[1]!.edge).toBeCloseTo(-0.07, 12);
    expect(result.edges[2]!.edge).toBeCloseTo(-0.06, 12);
    expect('worst' in result).toBe(false);
  });

  describe('suspend', () => {
    it('suspends when an edge is above 3% at high or normal confidence', () => {
      for (const confidence of ['high', 'normal'] as const) {
        const result = guardMarket([sel('home', 2061)], FAIR, confidence);
        expect(result.action).toBe('suspend');
      }
    });

    it('does not suspend an edge exactly on 3% at high or normal confidence', () => {
      // 0.5 * 2.060 - 1 is 0.030000000000000027 in floats: still "on" the limit.
      for (const confidence of ['high', 'normal'] as const) {
        const result = guardMarket([sel('home', 2060)], FAIR, confidence);
        expect(result.action).toBe('none');
        expect(result.edges[0]!.edge).toBeCloseTo(0.03, 12);
      }
      expect(guardMarket([sel('home', 2059)], FAIR, 'high').action).toBe('none');
    });

    it('allows 5% at low confidence, and suspends above it', () => {
      expect(guardMarket([sel('home', 2061)], FAIR, 'low').action).toBe('none');
      expect(guardMarket([sel('home', 2100)], FAIR, 'low').action).toBe('none');
      expect(guardMarket([sel('home', 2101)], FAIR, 'low').action).toBe('suspend');
    });

    it('suspends 5% at high and normal confidence', () => {
      expect(guardMarket([sel('home', 2100)], FAIR, 'high').action).toBe('suspend');
      expect(guardMarket([sel('home', 2100)], FAIR, 'normal').action).toBe('suspend');
    });

    it('names the largest edge as the worst, the first of equal ones, and lists every edge', () => {
      const result = guardMarket(
        [
          sel('home', 2100, 'a'),
          sel('draw', 3600, 'b'),
          sel('away', 5400, 'c'),
          sel('home', 2200, 'd'),
        ],
        FAIR,
        'normal',
      );
      expect(result.action).toBe('suspend');
      if (result.action !== 'suspend') return;
      // Edges: +5%, +8%, +8%, +10%.
      expect(result.worst.selectionId).toBe('d');
      expect(result.worst.edge).toBeCloseTo(0.1, 12);
      expect(result.edges.map((e) => e.selectionId)).toEqual(['a', 'b', 'c', 'd']);
      const ties = guardMarket([sel('draw', 3600, 'b'), sel('away', 5400, 'c')], FAIR, 'normal');
      if (ties.action !== 'suspend') throw new Error('expected a suspension');
      expect(ties.worst.selectionId).toBe('b');
    });

    it('suspends for one bad selection among good ones', () => {
      const result = guardMarket(
        [sel('home', 1900), sel('draw', 3100), sel('away', 5300)],
        FAIR,
        'normal',
      );
      expect(result.action).toBe('suspend');
      if (result.action === 'suspend') expect(result.worst.code).toBe('away');
    });

    it.each([
      ['below the least price', 1000],
      ['above the greatest price', 1_000_001],
      ['zero', 0],
      ['negative', -2000],
      ['a fraction', 2000.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a string', '2000' as unknown as number],
    ])(
      'suspends a selection whose odds are %s: a broken price must not stay open',
      (_name, odds) => {
        for (const confidence of ['high', 'normal', 'low'] as const) {
          const result = guardMarket([sel('home', 1900), sel('draw', odds)], FAIR, confidence);
          expect(result.action).toBe('suspend');
          if (result.action !== 'suspend') continue;
          expect(result.worst).toEqual({
            selectionId: 'sel-draw',
            code: 'draw',
            edge: Number.POSITIVE_INFINITY,
          });
        }
      },
    );

    it('accepts odds exactly on both ends of the valid range', () => {
      expect(guardMarket([sel('home', 1001)], FAIR, 'normal').edges[0]!.edge).toBeCloseTo(
        0.5 * 1.001 - 1,
        12,
      );
      const longest = guardMarket([sel('home', 1_000_000)], FAIR, 'normal');
      expect(longest.edges[0]!.edge).toBeCloseTo(499, 9);
      expect(longest.action).toBe('suspend');
    });

    it('uses the strictest limit for a confidence it does not know', () => {
      const odds = [sel('home', 2061)];
      expect(guardMarket(odds, FAIR, 'bogus' as unknown as 'low').action).toBe('suspend');
    });
  });

  describe('info', () => {
    it('only informs when every price is worse than the consensus by more than 15%', () => {
      // Edges -20%, -40%, -52%.
      const far = [sel('home', 1600), sel('draw', 1800), sel('away', 2400)];
      const result = guardMarket(far, FAIR, 'normal');
      expect(result.action).toBe('info');
      if (result.action !== 'info') return;
      // The largest (least negative) edge is the worst.
      expect(result.worst.code).toBe('home');
      expect(result.worst.edge).toBeCloseTo(-0.2, 12);
      expect(result.edges).toHaveLength(3);
    });

    it('does not inform for an edge exactly on -15%', () => {
      // 0.5 * 1.700 - 1 is -0.15000000000000002 in floats: still "on" the limit.
      expect(guardMarket([sel('home', 1700)], FAIR, 'normal').action).toBe('none');
      expect(guardMarket([sel('home', 1699)], FAIR, 'normal').action).toBe('info');
      expect(guardMarket([sel('home', 1701)], FAIR, 'normal').action).toBe('none');
    });

    it('does not inform unless every compared price is far worse', () => {
      expect(guardMarket([sel('home', 1600), sel('draw', 3000)], FAIR, 'normal').action).toBe(
        'none',
      );
      expect(guardMarket([sel('home', 1600), sel('draw', 3300)], FAIR, 'normal').action).toBe(
        'none',
      );
    });

    it('informs on the selections that were compared, though the market has more', () => {
      const result = guardMarket(
        [sel('home', 1600), sel('x', 1500), sel('away', 2400)],
        FAIR,
        'normal',
      );
      expect(result.action).toBe('info');
      expect(result.edges.map((e) => e.code)).toEqual(['home', 'away']);
    });

    it('is the same at every confidence', () => {
      for (const confidence of ['high', 'normal', 'low'] as const) {
        expect(guardMarket([sel('home', 1600)], FAIR, confidence).action).toBe('info');
      }
    });

    it('is beaten by a suspension', () => {
      const result = guardMarket([sel('home', 1000), sel('draw', 1800)], FAIR, 'normal');
      expect(result.action).toBe('suspend');
    });
  });

  describe('what is compared', () => {
    it('skips selections whose code has no fair probability', () => {
      const result = guardMarket([sel('home', 1900), sel('corners', 99_999)], FAIR, 'normal');
      expect(result.action).toBe('none');
      expect(result.edges.map((e) => e.code)).toEqual(['home']);
    });

    it('does nothing when nothing could be compared', () => {
      expect(guardMarket([], FAIR, 'normal')).toEqual({ action: 'none', edges: [] });
      expect(guardMarket([sel('home', 1900)], {}, 'normal')).toEqual({ action: 'none', edges: [] });
      expect(guardMarket([sel('home', 1000)], { draw: 0.3 }, 'normal')).toEqual({
        action: 'none',
        edges: [],
      });
    });

    it('does not read inherited properties as probabilities', () => {
      expect(guardMarket([sel('toString', 3000)], {}, 'normal').edges).toEqual([]);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['negative', -0.1],
      ['above one', 1.5],
      ['a string', '0.5' as unknown as number],
    ])('skips a fair probability that is %s', (_name, bad) => {
      const result = guardMarket([sel('home', 99_999)], { home: bad }, 'normal');
      expect(result).toEqual({ action: 'none', edges: [] });
    });

    it('compares a probability of exactly 0 and exactly 1', () => {
      expect(guardMarket([sel('home', 1500)], { home: 1 }, 'normal').action).toBe('suspend');
      const zero = guardMarket([sel('home', 1500)], { home: 0 }, 'normal');
      expect(zero.action).toBe('info');
      expect(zero.edges[0]!.edge).toBe(-1);
    });

    it('does not change its inputs', () => {
      const selections = Object.freeze(ON_MARKET.map((s) => Object.freeze({ ...s })));
      const fair = Object.freeze({ ...FAIR });
      expect(() => guardMarket(selections, fair, 'normal')).not.toThrow();
    });
  });

  describe('properties', () => {
    const codes = ['home', 'draw', 'away'];
    const oddsArb = fc.oneof(
      { weight: 6, arbitrary: fc.integer({ min: 1001, max: 12_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 12_001, max: 1_000_000 }) },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          0,
          1000,
          1_000_001,
          -5,
          1500.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ),
      },
    );
    const selectionsArb = fc.array(
      fc.record({
        selectionId: fc.string({ minLength: 1, maxLength: 4 }),
        code: fc.constantFrom(...codes, 'other'),
        oddsMilli: oddsArb,
      }),
      { maxLength: 6 },
    );
    const fairArb = fc.record({
      home: fc.double({ min: 0.01, max: 0.98, noNaN: true }),
      draw: fc.double({ min: 0.01, max: 0.98, noNaN: true }),
      away: fc.double({ min: 0.01, max: 0.98, noNaN: true }),
    });
    const confidenceArb = fc.constantFrom('high', 'normal', 'low');
    const valid = (odds: number): boolean =>
      Number.isInteger(odds) && odds >= 1001 && odds <= 1_000_000;

    it('matches the rule written out, and describes what it saw (property)', () => {
      fc.assert(
        fc.property(selectionsArb, fairArb, confidenceArb, (selections, fair, confidence) => {
          const result = guardMarket(selections, fair, confidence);
          const compared = selections.filter((s) => codes.includes(s.code));
          const edges = compared.map((s) =>
            valid(s.oddsMilli)
              ? (fair[s.code as keyof typeof fair] * s.oddsMilli) / 1000 - 1
              : Infinity,
          );
          expect(result.edges.map((e) => e.edge)).toEqual(edges);
          expect(result.edges.map((e) => e.selectionId)).toEqual(
            compared.map((s) => s.selectionId),
          );
          const limit = confidence === 'low' ? 0.05 : 0.03;
          // Edges that fall within float noise of a limit are not the point of this test.
          fc.pre(edges.every((e) => Math.abs(e - limit) > 1e-6 && Math.abs(e + 0.15) > 1e-6));
          if (edges.some((e) => e > limit)) {
            expect(result.action).toBe('suspend');
          } else if (edges.length > 0 && edges.every((e) => e < -0.15)) {
            expect(result.action).toBe('info');
          } else {
            expect(result.action).toBe('none');
          }
          if (result.action !== 'none') {
            expect(result.worst.edge).toBe(Math.max(...edges));
            expect(result.edges).toContainEqual(result.worst);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('always suspends a market with a broken price, whatever else it has (property)', () => {
      fc.assert(
        fc.property(
          selectionsArb,
          fairArb,
          confidenceArb,
          fc.constantFrom(0, 1000, 1_000_001, 1500.5, Number.NaN, Number.POSITIVE_INFINITY),
          fc.constantFrom(...codes),
          (selections, fair, confidence, broken, code) => {
            const withBroken = [...selections, { selectionId: 'broken', code, oddsMilli: broken }];
            expect(guardMarket(withBroken, fair, confidence).action).toBe('suspend');
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('never suspends prices at or under the consensus (property)', () => {
      fc.assert(
        fc.property(
          fairArb,
          confidenceArb,
          fc.array(fc.constantFrom(...codes), { minLength: 1, maxLength: 6 }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (fair, confidence, picked, share) => {
            const selections = picked.map((code, i) => {
              // At most the fair price: odds = floor(1000 / p), scaled down to share of it.
              const fairOdds = 1000 / fair[code as keyof typeof fair];
              const odds = Math.max(1001, Math.floor(fairOdds * (0.5 + 0.5 * share)));
              return { selectionId: `s${i}`, code, oddsMilli: Math.min(1_000_000, odds) };
            });
            fc.pre(
              selections.every(
                (s) => (fair[s.code as keyof typeof fair] * s.oddsMilli) / 1000 <= 1,
              ),
            );
            expect(guardMarket(selections, fair, confidence).action).not.toBe('suspend');
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

// --- Moves ---------------------------------------------------------------------------------------

describe('moveVerdict (P8)', () => {
  const PREVIOUS = { home: 0.5, draw: 0.3, away: 0.2 };

  it('has the limits of the plan', () => {
    expect(MAX_MOVE).toBe(0.08);
    expect(STEAM_MOVE).toBe(0.03);
  });

  it('is ok for no move or a small one', () => {
    expect(moveVerdict(PREVIOUS, PREVIOUS)).toBe('ok');
    expect(moveVerdict(PREVIOUS, { home: 0.51, draw: 0.3, away: 0.19 })).toBe('ok');
    expect(moveVerdict(PREVIOUS, { home: 0.4999, draw: 0.3001, away: 0.2 })).toBe('ok');
  });

  it('is steam for a move over 3 pp up to 8 pp, either way', () => {
    expect(moveVerdict(PREVIOUS, { home: 0.5301, draw: 0.3, away: 0.1699 })).toBe('steam');
    expect(moveVerdict(PREVIOUS, { home: 0.4699, draw: 0.3, away: 0.2301 })).toBe('steam');
    expect(moveVerdict(PREVIOUS, { home: 0.56, draw: 0.3, away: 0.14 })).toBe('steam');
  });

  it('is large_move for a move over 8 pp, either way', () => {
    expect(moveVerdict(PREVIOUS, { home: 0.5801, draw: 0.3, away: 0.1199 })).toBe('large_move');
    expect(moveVerdict(PREVIOUS, { home: 0.4199, draw: 0.3, away: 0.2801 })).toBe('large_move');
    expect(moveVerdict(PREVIOUS, { home: 0.9, draw: 0.05, away: 0.05 })).toBe('large_move');
  });

  it('does not count a move exactly on a limit as over it', () => {
    // Differences of exactly 0.03 and 0.08 that floats give as a hair more.
    expect(0.28 - 0.25).toBeGreaterThan(0.03);
    expect(moveVerdict({ home: 0.25 }, { home: 0.28 })).toBe('ok');
    expect(moveVerdict({ home: 0.28 }, { home: 0.25 })).toBe('ok');
    expect(0.14 - 0.06).toBeGreaterThan(0.08);
    expect(moveVerdict({ home: 0.06 }, { home: 0.14 })).toBe('steam');
    expect(moveVerdict({ home: 0.14 }, { home: 0.06 })).toBe('steam');
    expect(moveVerdict({ home: 0.5 }, { home: 0.53 })).toBe('ok');
    expect(moveVerdict({ home: 0.5 }, { home: 0.58 })).toBe('steam');
  });

  it('goes by the largest move of any outcome', () => {
    expect(moveVerdict(PREVIOUS, { home: 0.5, draw: 0.39, away: 0.2 })).toBe('large_move');
    expect(moveVerdict(PREVIOUS, { home: 0.51, draw: 0.3, away: 0.24 })).toBe('steam');
  });

  it('compares only the outcomes both have', () => {
    expect(moveVerdict(PREVIOUS, { home: 0.5 })).toBe('ok');
    expect(moveVerdict({ home: 0.5 }, { home: 0.5, extra: 0.9 })).toBe('ok');
    expect(moveVerdict(PREVIOUS, { over: 0.9, under: 0.1 })).toBe('ok');
    expect(moveVerdict({}, {})).toBe('ok');
    expect(moveVerdict(PREVIOUS, {})).toBe('ok');
    expect(moveVerdict({ home: 0.5 }, { toString: 0.9 })).toBe('ok');
  });

  it('counts a change that is not a finite number as a large move, not as none', () => {
    expect(moveVerdict(PREVIOUS, { ...PREVIOUS, home: Number.NaN })).toBe('large_move');
    expect(moveVerdict(PREVIOUS, { ...PREVIOUS, home: Number.POSITIVE_INFINITY })).toBe(
      'large_move',
    );
    expect(moveVerdict({ ...PREVIOUS, away: Number.NaN }, PREVIOUS)).toBe('large_move');
  });

  it('ignores a value that is not a number at all', () => {
    expect(moveVerdict(PREVIOUS, { ...PREVIOUS, home: undefined as unknown as number })).toBe('ok');
    expect(moveVerdict(PREVIOUS, { ...PREVIOUS, home: '0.9' as unknown as number })).toBe('ok');
  });

  it('is the same looking forward and back, and ok for no move at all (property)', () => {
    const probabilities = fc.dictionary(
      fc.constantFrom('home', 'draw', 'away', 'over', 'under'),
      fc.double({ min: 0, max: 1, noNaN: true }),
    );
    fc.assert(
      fc.property(probabilities, probabilities, (a, b) => {
        expect(moveVerdict(a, b)).toBe(moveVerdict(b, a));
        expect(moveVerdict(a, a)).toBe('ok');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('only gets worse when an outcome is added (property)', () => {
    const rank = { ok: 0, steam: 1, large_move: 2 } as const;
    const value = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(value, value, value, value, (a1, a2, b1, b2) => {
        const one = moveVerdict({ home: a1 }, { home: a2 });
        const two = moveVerdict({ home: a1, draw: b1 }, { home: a2, draw: b2 });
        expect(rank[two]).toBeGreaterThanOrEqual(rank[one]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
