import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  FIXTURE_HORIZON_MS,
  HOUR_MS,
  KICKOFF_TOLERANCE_MS,
  MATCH_WINDOW_MS,
  MIN_LEAD_MS,
  MINUTE_MS,
  SMALL_SHIFT_MS,
} from '../constants';
import type {
  CompetitionPolicy,
  ExistingEvent,
  FixtureObservation,
  ResolvedObservation,
} from '../types';
import { countIndependent } from './confirmation';
import { decideFixture, type FixtureDecision } from './fixture';
import { reviewsOf } from './review';
import { FEED_REF, fixtureObs, KICKOFF, makeEvent, makePolicy, NAMES } from './testkit';

const NOW = KICKOFF - 3 * DAY_MS;

interface Opts {
  candidates?: ExistingEvent[];
  policy?: Partial<CompetitionPolicy>;
  now?: number;
  calibrated?: boolean;
  pricesSane?: boolean;
}

function decide(
  observations: readonly ResolvedObservation<FixtureObservation>[],
  opts: Opts = {},
): FixtureDecision {
  return decideFixture({
    observations,
    candidates: opts.candidates ?? [],
    policy: makePolicy(opts.policy),
    now: new Date(opts.now ?? NOW),
    calibrated: opts.calibrated ?? true,
    pricesSane: opts.pricesSane ?? true,
  });
}

const reasons = (d: FixtureDecision): string[] =>
  reviewsOf(d).flatMap((r) => r.payload.reasons as string[]);
const at = (source: string, offset: number, upstream?: string) =>
  fixtureObs({
    source,
    kickoff: KICKOFF + offset,
    ...(upstream === undefined ? {} : { upstream }),
  });

describe('F2 create', () => {
  it('creates a fixture the sources agree on, with betting closed', () => {
    const d = decide([at('s1', 0), at('s2', 0)]);
    expect(d).toEqual({
      action: 'create',
      feedRef: FEED_REF,
      competitionId: NAMES.competitionId,
      homeTeamId: NAMES.homeTeamId,
      awayTeamId: NAMES.awayTeamId,
      kickoff: new Date(KICKOFF),
      bettingOpen: false,
      sources: ['s1', 's2'],
      openBetting: false,
      review: expect.objectContaining({ kind: 'odds_approval', subjectKey: FEED_REF }) as unknown,
    });
  });

  it('the window is (now + MIN_LEAD_MS, now + FIXTURE_HORIZON_MS]', () => {
    const kick = (ms: number) =>
      decide([fixtureObs({ source: 's1', kickoff: ms })], { now: ms - MIN_LEAD_MS }).action;
    expect(kick(KICKOFF)).toBe('none');
    expect(decide([at('s1', 0)], { now: KICKOFF - MIN_LEAD_MS - 1 }).action).toBe('create');
    expect(decide([at('s1', 0)], { now: KICKOFF - FIXTURE_HORIZON_MS }).action).toBe('create');
    expect(decide([at('s1', 0)], { now: KICKOFF - FIXTURE_HORIZON_MS - 1 })).toEqual({
      action: 'none',
      reason: 'outside_window',
    });
    expect(decide([at('s1', 0)], { now: KICKOFF + HOUR_MS }).action).toBe('none');
  });

  it('sources must agree within KICKOFF_TOLERANCE_MS; the earliest kickoff is created', () => {
    expect(decide([at('s1', 0), at('s2', KICKOFF_TOLERANCE_MS)])).toMatchObject({
      action: 'create',
      kickoff: new Date(KICKOFF),
    });
    const d = decide([at('s1', 0), at('s2', KICKOFF_TOLERANCE_MS + 1)]);
    expect(d.action === 'hold' && d.review.kind).toBe('fixture_conflict');
    expect(reasons(d)).toEqual(['kickoff_disagreement']);
  });

  it('needs a scheduled observation; a postponement next to it is a conflict', () => {
    const postponed = fixtureObs({ source: 's2', status: 'postponed' });
    expect(decide([postponed])).toEqual({ action: 'none', reason: 'not_scheduled' });
    expect(reasons(decide([at('s1', 0), postponed]))).toEqual(['status_disagreement']);
  });

  it('a disabled policy creates nothing but still raises conflicts (shadow mode)', () => {
    expect(decide([at('s1', 0)], { policy: { enabled: false } })).toEqual({
      action: 'none',
      reason: 'policy_disabled',
    });
    expect(decide([at('s1', 0), at('s2', HOUR_MS)], { policy: { enabled: false } }).action).toBe(
      'hold',
    );
  });

  it('the feed ref carries the UTC day of the created kickoff', () => {
    const late = Date.parse('2026-11-01T23:58:00.000Z');
    const d = decide([
      fixtureObs({ source: 's1', kickoff: late }),
      fixtureObs({ source: 's2', kickoff: late + 3 * MINUTE_MS }),
    ]);
    expect(d.action === 'create' && d.feedRef).toBe('fx|comp-1|team-h|team-a|2026-11-01');
  });
});

describe('F3 match an existing event', () => {
  const event = makeEvent();
  it('several candidates are ambiguous: nothing applied', () => {
    const d = decide([at('s1', HOUR_MS), at('s2', HOUR_MS)], {
      candidates: [event, makeEvent({ eventId: 'ev-2', feedRef: 'fx|other' })],
    });
    expect(d.action).toBe('hold');
    expect(reasons(d)).toEqual(['ambiguous_match']);
  });

  it('a candidate that does not fit the cluster is a conflict, never a new event', () => {
    for (const candidate of [
      makeEvent({ homeTeamId: 'team-x' }),
      makeEvent({ startTime: new Date(KICKOFF + MATCH_WINDOW_MS + 1) }),
      makeEvent({ startTime: new Date(Number.NaN) }),
    ]) {
      expect(reasons(decide([at('s1', 0)], { candidates: [candidate] }))).toEqual([
        'candidate_mismatch',
      ]);
    }
    // Exactly MATCH_WINDOW_MS away still matches: the move is then judged by F4 (one source, earlier: held).
    const edge = decide([at('s1', 0)], {
      candidates: [makeEvent({ startTime: new Date(KICKOFF + MATCH_WINDOW_MS) })],
    });
    expect(edge.action === 'hold' && edge.review.kind).toBe('kickoff_change');
  });

  it('the same candidate twice is one candidate; a mixed cluster is a conflict', () => {
    expect(decide([at('s1', 0)], { candidates: [event, { ...event }] })).toEqual({
      action: 'none',
      reason: 'unchanged',
    });
    const mixed = [at('s1', 0), fixtureObs({ source: 's2', names: { awayTeamId: 'team-x' } })];
    expect(reasons(decide(mixed))).toEqual(['mixed_cluster']);
  });
});

describe('F4 kickoff change', () => {
  const event = makeEvent();
  const withEvent = (over: Partial<ExistingEvent> = {}, opts: Opts = {}) => ({
    ...opts,
    candidates: [makeEvent(over)],
  });

  it('changes within KICKOFF_TOLERANCE_MS are no change', () => {
    expect(decide([at('s1', KICKOFF_TOLERANCE_MS)], withEvent())).toEqual({
      action: 'none',
      reason: 'unchanged',
    });
    expect(
      decide([at('s1', -KICKOFF_TOLERANCE_MS), at('s2', KICKOFF_TOLERANCE_MS)], withEvent()).action,
    ).toBe('none');
    expect(decide([at('s1', KICKOFF_TOLERANCE_MS + 1)], withEvent()).action).toBe('update-kickoff');
  });

  it('(a) independent upstreams agreeing apply either way, with or without bets', () => {
    for (const shift of [3 * HOUR_MS, -3 * HOUR_MS, 30 * HOUR_MS]) {
      const d = decide([at('s1', shift), at('s2', shift)], withEvent({ hasBets: true }));
      expect(d).toEqual({
        action: 'update-kickoff',
        eventId: event.eventId,
        feedRef: FEED_REF,
        from: new Date(KICKOFF),
        to: new Date(KICKOFF + shift),
        rule: 'F4a',
        upstreams: ['up-s1', 'up-s2'],
      });
    }
  });

  it('(b) one source may move later by at most SMALL_SHIFT_MS, only without bets', () => {
    expect(decide([at('s1', SMALL_SHIFT_MS)], withEvent())).toMatchObject({
      action: 'update-kickoff',
      rule: 'F4b',
    });
    const tooFar = decide([at('s1', SMALL_SHIFT_MS + 1)], withEvent());
    expect(tooFar.action === 'hold' && tooFar.review.kind).toBe('kickoff_change');
    expect(decide([at('s1', HOUR_MS)], withEvent({ hasBets: true })).action).toBe('hold');
    // Two sources of one upstream are one source.
    expect(
      decide([at('s1', HOUR_MS, 'opta'), at('s2', HOUR_MS, 'OPTA')], withEvent({ hasBets: true }))
        .action,
    ).toBe('hold');
  });

  it('an earlier time from one source is never applied, and is critical', () => {
    for (const hasBets of [false, true]) {
      const d = decide([at('s1', -HOUR_MS)], withEvent({ hasBets }));
      expect(d.action).toBe('hold');
      if (d.action !== 'hold') return;
      expect(d.review).toMatchObject({ kind: 'kickoff_change', severity: 'critical' });
      expect(d.review.payload).toMatchObject({
        proposedKickoff: new Date(KICKOFF - HOUR_MS).toISOString(),
      });
    }
  });

  it('a new time at or before now + MIN_LEAD_MS is never applied', () => {
    const now = KICKOFF - 2 * HOUR_MS;
    const to = (offsetFromNow: number) => {
      const t = now + offsetFromNow - KICKOFF;
      return decide([at('s1', t), at('s2', t)], withEvent({}, { now }));
    };
    expect(reasons(to(MIN_LEAD_MS))).toEqual(['new_time_too_close']);
    expect(to(MIN_LEAD_MS + 1).action).toBe('update-kickoff');
  });

  it('an event that starts within MIN_LEAD_MS (or has started) is not moved', () => {
    const obs = [at('s1', HOUR_MS), at('s2', HOUR_MS)];
    expect(reasons(decide(obs, withEvent({}, { now: KICKOFF - MIN_LEAD_MS })))).toEqual([
      'event_about_to_start',
    ]);
    expect(decide(obs, withEvent({}, { now: KICKOFF - MIN_LEAD_MS - 1 })).action).toBe(
      'update-kickoff',
    );
    expect(decide(obs, withEvent({}, { now: KICKOFF + HOUR_MS })).action).toBe('hold');
  });

  it('the new time needs the sources within KICKOFF_TOLERANCE_MS of each other (exactly is agreement)', () => {
    const shift = 3 * HOUR_MS;
    expect(
      decide([at('s1', shift), at('s2', shift + KICKOFF_TOLERANCE_MS)], withEvent()),
    ).toMatchObject({
      action: 'update-kickoff',
      to: new Date(KICKOFF + shift),
    });
    expect(
      reasons(decide([at('s1', shift), at('s2', shift + KICKOFF_TOLERANCE_MS + 1)], withEvent())),
    ).toEqual(['sources_disagree']);
  });

  it('every source must give the new time: one still elsewhere is a conflict', () => {
    const d = decide([at('s1', 3 * HOUR_MS), at('s2', 3 * HOUR_MS), at('s3', 0)], withEvent());
    expect(reasons(d)).toEqual(['sources_disagree']);
  });

  it('a closed or resulted event is left alone', () => {
    for (const over of [
      { status: 'finished' as const },
      { status: 'live' as const },
      { resultedAt: new Date(KICKOFF) },
    ]) {
      expect(decide([at('s1', HOUR_MS), at('s2', HOUR_MS)], withEvent(over))).toEqual({
        action: 'none',
        reason: 'event_closed',
      });
    }
  });
});

describe('F6 postponed / cancelled', () => {
  it.each(['postponed', 'cancelled'] as const)(
    '%s opens cancellation_proposed, never a status change',
    (status) => {
      const d = decide([at('s1', 0), fixtureObs({ source: 's2', status })], {
        candidates: [makeEvent()],
      });
      expect(d.action).toBe('hold');
      if (d.action !== 'hold') return;
      expect(d.review).toMatchObject({
        kind: 'cancellation_proposed',
        severity: 'critical',
        subjectKey: FEED_REF,
      });
      expect(d.review.payload.details).toEqual({ void_status_reported: [`s2:${status}`] });
    },
  );

  it('a new date for an event held as postponed goes to a person', () => {
    const postponed = makeEvent({ status: 'postponed' });
    const d = decide([at('s1', 7 * DAY_MS)], { candidates: [postponed] });
    expect(reasons(d)).toEqual(['event_not_scheduled']);
    expect(decide([at('s1', -7 * DAY_MS)], { candidates: [postponed] }).action).toBe('none');
  });
});

describe('F7 betting stays closed', () => {
  it('opens only with auto_open, calibrated teams and sane prices', () => {
    const open = decide([at('s1', 0)], { policy: { autoOpen: true } });
    expect(open).toMatchObject({
      action: 'create',
      bettingOpen: false,
      openBetting: true,
      review: null,
    });
    const cases: [Opts, string, string][] = [
      [{ policy: { autoOpen: false } }, 'odds_approval', 'auto_open_off'],
      [{ policy: { autoOpen: true }, pricesSane: false }, 'odds_approval', 'prices_not_sane'],
      [
        { policy: { autoOpen: true }, calibrated: false },
        'ratings_uncalibrated',
        'ratings_uncalibrated',
      ],
    ];
    for (const [opts, kind, reason] of cases) {
      const d = decide([at('s1', 0)], opts);
      expect(d).toMatchObject({ action: 'create', bettingOpen: false, openBetting: false });
      expect(reviewsOf(d).map((r) => [r.kind, r.payload.reasons])).toEqual([[kind, [reason]]]);
    }
  });

  it('anything but true counts as false', () => {
    const d = decideFixture({
      observations: [at('s1', 0)],
      candidates: [],
      policy: makePolicy({ autoOpen: true }),
      now: new Date(NOW),
      calibrated: 'yes' as unknown as boolean,
      pricesSane: 1 as unknown as boolean,
    });
    expect(d).toMatchObject({ action: 'create', openBetting: false });
  });
});

describe('fail closed on bad input', () => {
  it('a malformed observation is a conflict; bad clock or policy is a programmer error', () => {
    const bad = at('s2', 0);
    bad.obs.kickoff = new Date(Number.NaN);
    expect(reasons(decide([at('s1', 0), bad]))).toEqual(['invalid_observation']);
    expect(() => decide([at('s1', 0)], { now: Number.NaN })).toThrow(RangeError);
    expect(() => decide([at('s1', 0)], { policy: { competitionId: 'cup' } })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Properties

const SOURCES = [
  ['s1', 'u1'],
  ['s2', 'u2'],
  ['s3', 'u1'],
  ['s4', 'u3'],
] as const;
const OFFSETS = [
  0,
  3 * MINUTE_MS,
  -3 * MINUTE_MS,
  KICKOFF_TOLERANCE_MS + 1,
  HOUR_MS,
  SMALL_SHIFT_MS,
  SMALL_SHIFT_MS + 1,
  -HOUR_MS,
  -2 * HOUR_MS,
  3 * DAY_MS,
];
const scenario = fc.record({
  obs: fc.array(
    fc.record({
      src: fc.integer({ min: 0, max: SOURCES.length - 1 }),
      status: fc.constantFrom(
        'scheduled',
        'scheduled',
        'scheduled',
        'scheduled',
        'postponed',
        'cancelled',
      ),
      offset: fc.constantFrom(...OFFSETS),
      foreign: fc.constantFrom(false, false, false, false, false, false, false, false, false, true),
    }),
    { maxLength: 5 },
  ),
  existing: fc.boolean(),
  hasBets: fc.boolean(),
  nowOff: fc.constantFrom(
    -3 * DAY_MS,
    -15 * DAY_MS,
    -2 * HOUR_MS,
    -70 * MINUTE_MS,
    -MIN_LEAD_MS,
    -MIN_LEAD_MS - 1,
    HOUR_MS,
  ),
  enabled: fc.boolean(),
  autoOpen: fc.boolean(),
  calibrated: fc.boolean(),
  pricesSane: fc.boolean(),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;
/** Every source agreeing on one kickoff, policy on: the inputs that can create or move. */
const agreeingScenario = scenario.chain((s) =>
  fc.constantFrom(...OFFSETS).map((offset) => ({
    ...s,
    enabled: true,
    obs: s.obs.map((o) => ({ ...o, status: 'scheduled' as const, offset, foreign: false })),
  })),
);
const anyScenario = fc.oneof(scenario, agreeingScenario);

function buildObs(s: Scenario): ResolvedObservation<FixtureObservation>[] {
  return s.obs.map((o) => {
    const [source, upstream] = SOURCES[o.src] ?? SOURCES[0];
    return fixtureObs({
      source,
      upstream,
      status: o.status,
      kickoff: KICKOFF + o.offset,
      names: o.foreign ? { homeTeamId: 'team-x' } : {},
    });
  });
}

function runScenario(s: Scenario, observations = buildObs(s)): FixtureDecision {
  return decide(observations, {
    candidates: s.existing ? [makeEvent({ hasBets: s.hasBets })] : [],
    now: KICKOFF + s.nowOff,
    policy: { enabled: s.enabled, autoOpen: s.autoOpen },
    calibrated: s.calibrated,
    pricesSane: s.pricesSane,
  });
}

describe('properties', () => {
  it('permuting the observations never changes the decision', () => {
    fc.assert(
      fc.property(
        anyScenario.chain((s) =>
          fc.tuple(fc.constant(s), fc.shuffledSubarray(buildObs(s), { minLength: s.obs.length })),
        ),
        ([s, shuffled]) => {
          expect(runScenario(s, shuffled)).toEqual(runScenario(s));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('no kickoff at or before now + MIN_LEAD_MS is ever created or applied', () => {
    fc.assert(
      fc.property(anyScenario, (s) => {
        const d = runScenario(s);
        const nowMs = KICKOFF + s.nowOff;
        if (d.action === 'create') expect(d.kickoff.getTime()).toBeGreaterThan(nowMs + MIN_LEAD_MS);
        if (d.action === 'update-kickoff')
          expect(d.to.getTime()).toBeGreaterThan(nowMs + MIN_LEAD_MS);
      }),
      { numRuns: 1000 },
    );
  });

  it('F4/F7 invariants hold for every change, recomputed independently', () => {
    const seen = { create: 0, update: 0 };
    fc.assert(
      fc.property(anyScenario, (s) => {
        const observations = buildObs(s);
        const d = runScenario(s, observations);
        expect(['create', 'update-kickoff', 'hold', 'none']).toContain(d.action);
        if (d.action === 'create') {
          seen.create++;
          expect(d.bettingOpen).toBe(false);
          expect(s.enabled).toBe(true);
          expect(observations.every((o) => o.obs.status === 'scheduled')).toBe(true);
          if (d.openBetting)
            expect([s.autoOpen, s.calibrated, s.pricesSane]).toEqual([true, true, true]);
          else expect(d.review.kind).toBe(s.calibrated ? 'odds_approval' : 'ratings_uncalibrated');
        }
        if (d.action === 'update-kickoff') {
          seen.update++;
          const voices = observations.map((o) => ({
            sourceId: o.obs.sourceId,
            upstream: o.upstream,
          }));
          expect(observations.every((o) => o.obs.status === 'scheduled')).toBe(true);
          expect(
            observations.every(
              (o) => Math.abs(o.obs.kickoff.getTime() - d.to.getTime()) <= KICKOFF_TOLERANCE_MS,
            ),
          ).toBe(true);
          if (d.to.getTime() < KICKOFF || s.hasBets) expect(d.rule).toBe('F4a');
          if (d.rule === 'F4a') expect(countIndependent(voices)).toBeGreaterThanOrEqual(2);
          if (d.rule === 'F4b') {
            expect(d.to.getTime() - KICKOFF).toBeLessThanOrEqual(SMALL_SHIFT_MS);
            expect(d.to.getTime()).toBeGreaterThan(KICKOFF);
            expect(s.hasBets).toBe(false);
          }
        }
      }),
      { numRuns: 1000 },
    );
    expect(seen.create).toBeGreaterThan(20);
    expect(seen.update).toBeGreaterThan(20);
  });

  it('no observation at all never changes anything', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        expect(runScenario(s, [])).toEqual({ action: 'none', reason: 'no_observations' });
      }),
      { numRuns: 100 },
    );
  });
});
