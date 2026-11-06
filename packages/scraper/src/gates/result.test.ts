import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESULT_CONFIRM_MS,
  HOUR_MS,
  KICKOFF_TOLERANCE_MS,
  MIN_MATCH_DURATION_MS,
  MIN_RESULT_CONFIRM_MS,
  MINUTE_MS,
  UNVERIFIED_AFTER_MS,
} from '../constants';
import type {
  CompetitionPolicy,
  ExistingEvent,
  ResolvedObservation,
  ResultObservation,
} from '../types';
import { decideResult, type ResultDecision, type ResultExposure } from './result';
import { reviewsOf } from './review';
import { END, FEED_REF, KICKOFF, makeEvent, makePolicy, NAMES, resultObs, score } from './testkit';

const NOW = END + HOUR_MS;
const EXPOSURE: ResultExposure = { openBets: 3, totalStake: 12_345n };

interface Opts {
  event?: Partial<ExistingEvent>;
  policy?: Partial<CompetitionPolicy>;
  now?: number;
  confirmMs?: number;
  exposure?: ResultExposure | null;
}

function decide(
  observations: readonly ResolvedObservation<ResultObservation>[],
  opts: Opts = {},
): ResultDecision {
  return decideResult({
    event: makeEvent(opts.event),
    observations,
    policy: makePolicy(opts.policy),
    now: new Date(opts.now ?? NOW),
    confirmMs: opts.confirmMs ?? DEFAULT_RESULT_CONFIRM_MS,
    exposure: opts.exposure === undefined ? EXPOSURE : opts.exposure,
  });
}

const kinds = (d: ResultDecision): string[] => reviewsOf(d).map((r) => r.kind);
const reasons = (d: ResultDecision): string[] =>
  reviewsOf(d).flatMap((r) => r.payload.reasons as string[]);

const A = resultObs({ source: 's1' });
const B = resultObs({ source: 's2' });

describe('R1 eligible', () => {
  const stable = { changedAt: END - DEFAULT_RESULT_CONFIRM_MS };
  it('waits until kickoff + MIN_MATCH_DURATION_MS (one millisecond short)', () => {
    const obs = [resultObs({ source: 's1', ...stable }), resultObs({ source: 's2', ...stable })];
    expect(decide(obs, { now: END - 1 })).toEqual({
      action: 'wait',
      until: new Date(END),
      reason: 'match_not_over',
    });
    expect(decide(obs, { now: END }).action).toBe('apply');
  });

  it('measures from the event start, not from what a source says', () => {
    const obs = [resultObs({ source: 's1', ...stable }), resultObs({ source: 's2', ...stable })];
    const later = { startTime: new Date(KICKOFF + MINUTE_MS) };
    expect(decide(obs, { now: END, event: later }).action).toBe('wait');
  });

  it('only a scheduled event is eligible (scraped events never go live)', () => {
    expect(decide([A, B], { event: { status: 'live' } })).toEqual({
      action: 'none',
      reason: 'not_eligible',
    });
  });

  it('with no observation there is nothing to decide', () => {
    expect(decide([])).toEqual({ action: 'none', reason: 'no_observations' });
  });
});

describe('R2 agreement', () => {
  it('two independent upstreams with the same regular-time score apply', () => {
    expect(decide([A, B])).toEqual({
      action: 'apply',
      eventId: 'ev-1',
      feedRef: FEED_REF,
      status: 'finished',
      score: score(2, 1),
      upstreams: ['up-s1', 'up-s2'],
      sources: ['s1', 's2'],
      confirmMs: DEFAULT_RESULT_CONFIRM_MS,
    });
  });

  it('sources sharing an upstream count once', () => {
    const d = decide([
      resultObs({ source: 's1', upstream: 'opta' }),
      resultObs({ source: 's2', upstream: 'opta' }),
    ]);
    expect(d).toEqual({
      action: 'wait',
      until: new Date(END + UNVERIFIED_AFTER_MS),
      reason: 'single_source',
    });
  });

  it('upstreams are compared trimmed and case-insensitively', () => {
    const d = decide([
      resultObs({ source: 's1', upstream: 'Opta' }),
      resultObs({ source: 's2', upstream: ' opta ' }),
    ]);
    expect(d.action).toBe('wait');
  });

  it('a source counts once even when its rows name different upstreams', () => {
    const d = decide([
      resultObs({ source: 's1', upstream: 'u1' }),
      resultObs({ source: 's1', upstream: 'u2' }),
    ]);
    expect(d.action).toBe('wait');
  });

  it('a duplicated observation adds no vote', () => {
    expect(decide([A, A, A]).action).toBe('wait');
  });

  it('three sources over two upstreams are two votes', () => {
    const d = decide([
      resultObs({ source: 's1', upstream: 'u1' }),
      resultObs({ source: 's2', upstream: 'u1' }),
      resultObs({ source: 's3', upstream: 'u2' }),
    ]);
    expect(d).toMatchObject({
      action: 'apply',
      upstreams: ['u1', 'u2'],
      sources: ['s1', 's2', 's3'],
    });
  });

  it('a finished score of another basis does not vote', () => {
    const d = decide([A, resultObs({ source: 's2', basis: 'unknown' })]);
    expect(d.action).toBe('hold');
    expect(kinds(d)).toEqual(['score_basis_unknown']);
  });

  describe('half time', () => {
    const needs = { event: { needsHalfTimeScore: true } };
    it('is required and identical when the event needs it', () => {
      const s1 = resultObs({ source: 's1', score: score(2, 1, [1, 0]) });
      const s2 = resultObs({ source: 's2', score: score(2, 1, [1, 0]) });
      expect(decide([s1, s2], needs)).toMatchObject({
        action: 'apply',
        score: score(2, 1, [1, 0]),
      });
      // The full time has two upstreams; the half time comes from the one that gives it.
      const bare = resultObs({ source: 's2', score: score(2, 1) });
      expect(decide([s1, bare], needs)).toMatchObject({
        action: 'apply',
        score: score(2, 1, [1, 0]),
      });
      // One upstream alone is still one vote, half time or not.
      expect(decide([s1], needs)).toMatchObject({ action: 'wait', reason: 'single_source' });
      const other = resultObs({ source: 's2', score: score(2, 1, [0, 0]) });
      const d = decide([s1, other], needs);
      expect(d.action === 'hold' && d.review.kind).toBe('result_conflict');
      expect(reasons(d)).toContain('half_time_disagreement');
    });

    it('is ignored when not needed, and applied only when all voters give the same one', () => {
      const h10 = resultObs({ source: 's1', score: score(2, 1, [1, 0]) });
      const h00 = resultObs({ source: 's2', score: score(2, 1, [0, 0]) });
      const bare = resultObs({ source: 's2', score: score(2, 1) });
      expect(decide([h10, h00])).toMatchObject({ action: 'apply', score: score(2, 1) });
      expect(decide([h10, bare])).toMatchObject({ action: 'apply', score: score(2, 1) });
      const same = resultObs({ source: 's2', score: score(2, 1, [1, 0]) });
      expect(decide([h10, same])).toMatchObject({ action: 'apply', score: score(2, 1, [1, 0]) });
    });
  });

  it('observations of another pairing neither vote nor dissent (home/away never swapped)', () => {
    const other = resultObs({ source: 's2', names: { homeTeamId: 'team-x' } });
    const swapped = resultObs({
      source: 's3',
      names: { homeTeamId: NAMES.awayTeamId, awayTeamId: NAMES.homeTeamId },
      score: score(1, 2),
    });
    const otherCompetition = resultObs({ source: 's4', names: { competitionId: 'cup' } });
    expect(decide([A, other, swapped, otherCompetition]).action).toBe('wait');
    const foreignDissent = resultObs({
      source: 's3',
      names: { homeTeamId: 'team-x' },
      score: score(0, 0),
    });
    expect(decide([A, B, foreignDissent]).action).toBe('apply');
  });
});

describe('R3 dissent blocks', () => {
  it('a finished observation with another score blocks two agreeing upstreams', () => {
    const d = decide([A, B, resultObs({ source: 's3', score: score(1, 1) })]);
    expect(d.action === 'hold' && d.review.kind).toBe('result_conflict');
    expect(reasons(d)).toEqual(['score_disagreement']);
  });

  it.each(['cancelled', 'abandoned', 'postponed'] as const)('a %s observation blocks', (status) => {
    const d = decide([A, B, resultObs({ source: 's3', status })]);
    expect(d.action).toBe('hold');
    expect(kinds(d)).toEqual(['result_conflict', 'cancellation_proposed']);
    expect(reasons(d)).toEqual(['status_disagreement', 'void_status_reported']);
  });

  it('dissent of another basis blocks too', () => {
    const d = decide([
      A,
      B,
      resultObs({ source: 's3', basis: 'includes_extra_time', score: score(3, 1) }),
    ]);
    expect(kinds(d)).toEqual(['result_conflict', 'score_basis_unknown']);
  });

  it('a different full time from the same upstream still blocks', () => {
    const d = decide([A, resultObs({ source: 's1b', upstream: 'up-s1', score: score(1, 1) }), B]);
    expect(d.action === 'hold' && d.review.kind).toBe('result_conflict');
  });

  it('a source that has not caught up is silence, not dissent', () => {
    // s3 publishes nothing for the fixture yet: there is simply no observation of it.
    expect(decide([A, B]).action).toBe('apply');
  });

  it('a kickoff off by more than KICKOFF_TOLERANCE_MS blocks (exactly the tolerance does not)', () => {
    const at = (ms: number) => resultObs({ source: 's2', kickoff: KICKOFF + ms });
    expect(decide([A, at(KICKOFF_TOLERANCE_MS)]).action).toBe('apply');
    expect(decide([A, at(-KICKOFF_TOLERANCE_MS)]).action).toBe('apply');
    const d = decide([A, at(KICKOFF_TOLERANCE_MS + 1)]);
    expect(reasons(d)).toEqual(['kickoff_mismatch']);
    expect(decide([A, at(-KICKOFF_TOLERANCE_MS - 1)]).action).toBe('hold');
  });

  it('nothing is judged before the match can be over', () => {
    const d = decide([A, resultObs({ source: 's2', score: score(0, 0) })], { now: END - 1 });
    expect(d).toMatchObject({ action: 'wait', reason: 'match_not_over' });
  });
});

describe('R4 stability', () => {
  const at = (changedAt: number) => [
    resultObs({ source: 's1', changedAt: NOW - HOUR_MS }),
    resultObs({ source: 's2', changedAt }),
  ];
  it('applies exactly at changedAt + delay, waits one millisecond before', () => {
    expect(decide(at(NOW - DEFAULT_RESULT_CONFIRM_MS)).action).toBe('apply');
    expect(decide(at(NOW - DEFAULT_RESULT_CONFIRM_MS + 1))).toEqual({
      action: 'wait',
      until: new Date(NOW + 1),
      reason: 'not_stable',
    });
  });

  it.each([0, 1, MIN_RESULT_CONFIRM_MS - 1])(
    'a delay of %i is raised to MIN_RESULT_CONFIRM_MS',
    (ms) => {
      expect(decide(at(NOW - MIN_RESULT_CONFIRM_MS), { confirmMs: ms })).toMatchObject({
        action: 'apply',
        confirmMs: MIN_RESULT_CONFIRM_MS,
      });
      expect(decide(at(NOW - MIN_RESULT_CONFIRM_MS + 1), { confirmMs: ms }).action).toBe('wait');
    },
  );

  it('a configured delay above the minimum is honoured', () => {
    const d = decide(at(NOW - 20 * MINUTE_MS), { confirmMs: 30 * MINUTE_MS });
    expect(d).toEqual({
      action: 'wait',
      until: new Date(NOW + 10 * MINUTE_MS),
      reason: 'not_stable',
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a delay of %d is a programmer error',
    (ms) => {
      expect(() => decide([A, B], { confirmMs: ms })).toThrow(RangeError);
    },
  );

  it('every observation of the fixture must be unchanged, not only the voters', () => {
    const needs = { event: { needsHalfTimeScore: true } };
    const v1 = resultObs({ source: 's1', score: score(2, 1, [1, 0]) });
    const v2 = resultObs({ source: 's2', score: score(2, 1, [1, 0]) });
    const fresh = resultObs({ source: 's3', score: score(2, 1), changedAt: NOW - MINUTE_MS });
    expect(decide([v1, v2], needs).action).toBe('apply');
    expect(decide([v1, v2, fresh], needs)).toMatchObject({ action: 'wait', reason: 'not_stable' });
  });

  it('a row first seen after its changedAt is as young as its first sighting', () => {
    const young = resultObs({ source: 's2', changedAt: END, firstSeenAt: NOW - MINUTE_MS });
    expect(decide([A, young]).action).toBe('wait');
  });

  it('a change in the future is not stable', () => {
    expect(decide([A, resultObs({ source: 's2', changedAt: NOW + MINUTE_MS })]).action).toBe(
      'wait',
    );
  });
});

describe('R5 apply', () => {
  it('auto_results off asks a person (result_ready) with the agreed score', () => {
    const d = decide([A, B], { policy: { autoResults: false } });
    expect(d.action).toBe('hold');
    if (d.action !== 'hold') return;
    expect(d.review).toMatchObject({
      kind: 'result_ready',
      subjectKey: FEED_REF,
      severity: 'warning',
    });
    expect(d.review.payload).toMatchObject({
      score: { home: 2, away: 1, htHome: null, htAway: null },
      upstreams: ['up-s1', 'up-s2'],
      rules: ['R5'],
    });
    expect(d.also).toEqual([]);
  });

  it('review finding 5: a disabled policy or an extra-time competition never auto-applies', () => {
    for (const policy of [{ enabled: false }, { extraTime: true }]) {
      const d = decide([A, B], { policy: { autoResults: true, ...policy } });
      expect(d.action).toBe('hold');
      if (d.action !== 'hold') return;
      expect(d.review).toMatchObject({ kind: 'result_ready', subjectKey: FEED_REF });
      expect(d.review.payload).toMatchObject({ score: { home: 2, away: 1 } });
    }
    expect(decide([A, B], { policy: { autoResults: true } }).action).toBe('apply');
  });

  it('a decision can only ever carry the status finished', () => {
    const d = decide([A, B]);
    expect(d.action === 'apply' && d.status).toBe('finished');
  });
});

describe('R6 single source', () => {
  it('waits until UNVERIFIED_AFTER_MS after the earliest end, then asks a person', () => {
    const until = END + UNVERIFIED_AFTER_MS;
    expect(decide([A], { now: until - 1 })).toEqual({
      action: 'wait',
      until: new Date(until),
      reason: 'single_source',
    });
    const d = decide([A], { now: until });
    expect(d.action === 'hold' && d.review.kind).toBe('result_unverified');
    if (d.action !== 'hold') return;
    expect(d.review.payload).toMatchObject({ score: { home: 2, away: 1 }, upstreams: ['up-s1'] });
  });

  it('final scores without the needed half time end the same way', () => {
    const needs = { event: { needsHalfTimeScore: true } };
    expect(decide([A, B], needs)).toMatchObject({ action: 'wait', reason: 'half_time_missing' });
    const d = decide([A, B], { ...needs, now: END + UNVERIFIED_AFTER_MS });
    expect(kinds(d)).toEqual(['result_unverified']);
    expect(reasons(d)).toEqual(['half_time_missing']);
  });
});

describe('R7 no automatic cancel/void', () => {
  it.each(['cancelled', 'abandoned', 'postponed'] as const)(
    '%s opens cancellation_proposed at once, even before kickoff',
    (status) => {
      const d = decide([resultObs({ source: 's1', status }), resultObs({ source: 's2', status })], {
        now: KICKOFF - HOUR_MS,
      });
      expect(d.action).toBe('hold');
      if (d.action !== 'hold') return;
      expect(d.review).toMatchObject({ kind: 'cancellation_proposed', severity: 'critical' });
      expect(d.review.payload.details).toEqual({
        void_status_reported: [`s1:${status}`, `s2:${status}`],
      });
    },
  );
});

describe('R8 corrections', () => {
  const resulted = {
    status: 'finished' as const,
    resultedAt: new Date(NOW - HOUR_MS),
    score: score(2, 1),
  };
  it('the same score again changes nothing', () => {
    expect(decide([A, B], { event: resulted })).toEqual({
      action: 'none',
      reason: 'already_resulted',
    });
  });

  it('one current observation with another score opens result_correction', () => {
    const d = decide([A, resultObs({ source: 's2', score: score(2, 2) })], { event: resulted });
    expect(d.action).toBe('hold');
    if (d.action !== 'hold') return;
    expect(d.review).toMatchObject({ kind: 'result_correction', severity: 'critical' });
    expect(d.review.payload).toMatchObject({
      appliedStatus: 'finished',
      appliedScore: { home: 2, away: 1, htHome: null, htAway: null },
    });
  });

  it('a void status after a finished result is a correction; void after void is not', () => {
    const d = decide([resultObs({ source: 's1', status: 'abandoned' })], { event: resulted });
    expect(kinds(d)).toEqual(['result_correction']);
    const voided = { status: 'cancelled' as const, resultedAt: new Date(NOW), score: null };
    expect(
      decide([resultObs({ source: 's1', status: 'postponed' })], { event: voided }).action,
    ).toBe('none');
    expect(kinds(decide([A], { event: voided }))).toEqual(['result_correction']);
  });

  it('half time counts only when the event needs it, and only when a source gives it', () => {
    const ht = { ...resulted, score: score(2, 1, [1, 0]), needsHalfTimeScore: true };
    expect(
      kinds(decide([resultObs({ source: 's1', score: score(2, 1, [0, 0]) })], { event: ht })),
    ).toEqual(['result_correction']);
    expect(decide([resultObs({ source: 's1', score: score(2, 1) })], { event: ht }).action).toBe(
      'none',
    );
    const noHt = { ...ht, needsHalfTimeScore: false };
    expect(
      decide([resultObs({ source: 's1', score: score(2, 1, [0, 0]) })], { event: noHt }).action,
    ).toBe('none');
  });
});

describe('R9 impact', () => {
  it('items asking for a result decision carry the exposure as decimal strings', () => {
    const d = decide([A, B], { policy: { autoResults: false } });
    expect(d.action === 'hold' && d.review.payload.exposure).toEqual({
      openBets: 3,
      totalStake: '12345',
    });
    const unknown = decide([A, B], { policy: { autoResults: false }, exposure: null });
    expect(unknown.action === 'hold' && unknown.review.payload.exposure).toBeNull();
  });

  it('every result item kind carries it; the basis notice does not need it', () => {
    const d = decide([A, B, resultObs({ source: 's3', status: 'cancelled' })]);
    for (const review of reviewsOf(d))
      expect(review.payload.exposure).toEqual({ openBets: 3, totalStake: '12345' });
    const basis = decide([resultObs({ source: 's1', basis: 'unknown' })]);
    expect(basis.action === 'hold' && 'exposure' in basis.review.payload).toBe(false);
  });
});

describe('R10 basis', () => {
  it('opens score_basis_unknown once per fixture and never applies automatically', () => {
    const odd = [
      resultObs({ source: 's3', basis: 'unknown' }),
      resultObs({ source: 's4', basis: 'includes_extra_time' }),
    ];
    const d = decide([A, B, ...odd]);
    expect(d.action).toBe('hold');
    expect(kinds(d)).toEqual(['result_ready', 'score_basis_unknown']);
    expect(reviewsOf(d).map((r) => r.subjectKey)).toEqual([FEED_REF, FEED_REF]);
  });

  it('scores of another basis alone are held, even where extra time is impossible', () => {
    const d = decide(
      [
        resultObs({ source: 's1', basis: 'includes_extra_time' }),
        resultObs({ source: 's2', basis: 'unknown' }),
      ],
      {
        policy: { extraTime: false },
      },
    );
    expect(kinds(d)).toEqual(['score_basis_unknown']);
  });
});

describe('R11 idempotent', () => {
  it('the same input gives the same decision, and the applied result is not applied again', () => {
    expect(decide([A, B])).toEqual(decide([A, B]));
    const d = decide([A, B]);
    if (d.action !== 'apply') throw new Error('expected apply');
    const after = { status: 'finished' as const, resultedAt: new Date(NOW), score: d.score };
    expect(decide([A, B], { event: after })).toEqual({
      action: 'none',
      reason: 'already_resulted',
    });
  });
});

describe('fail closed on bad input', () => {
  const broken = (mutate: (o: ResolvedObservation<ResultObservation>) => void) => {
    const o = resultObs({ source: 's3' });
    mutate(o);
    return decide([A, B, o]);
  };
  it.each([
    [
      'NaN kickoff',
      (o: ResolvedObservation<ResultObservation>) => (o.obs.kickoff = new Date(Number.NaN)),
    ],
    ['NaN changedAt', (o: ResolvedObservation<ResultObservation>) => (o.changedAt = new Date('x'))],
    ['finished without score', (o: ResolvedObservation<ResultObservation>) => (o.obs.score = null)],
    [
      'half time above full time',
      (o: ResolvedObservation<ResultObservation>) => (o.obs.score = score(1, 0, [2, 0])),
    ],
    ['negative goals', (o: ResolvedObservation<ResultObservation>) => (o.obs.score = score(-1, 0))],
    [
      'unknown status',
      (o: ResolvedObservation<ResultObservation>) =>
        ((o.obs as { status: string }).status = 'live'),
    ],
    ['blank upstream', (o: ResolvedObservation<ResultObservation>) => (o.upstream = ' ')],
    [
      'wrong kind',
      (o: ResolvedObservation<ResultObservation>) => ((o.obs as { kind: string }).kind = 'fixture'),
    ],
  ])('%s holds result_conflict', (_name, mutate) => {
    const d = broken(mutate);
    expect(d.action === 'hold' && d.review.kind).toBe('result_conflict');
    expect(reasons(d)).toEqual(['invalid_observation']);
  });

  it('an invalid event row holds; an invalid clock or policy is a programmer error', () => {
    const d = decide([A, B], { event: { startTime: new Date(Number.NaN) } });
    expect(reasons(d)).toEqual(['invalid_event']);
    expect(() => decide([A, B], { now: Number.NaN })).toThrow(RangeError);
    expect(() => decide([A, B], { policy: { competitionId: 'other' } })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Properties

const SOURCES: readonly (readonly [string, string])[] = [
  ['s1', 'u1'],
  ['s2', 'u2'],
  ['s3', 'u1'],
  ['s4', ' U2 '],
  ['s5', 'u3'],
];
const FULL_TIMES = [
  [2, 1],
  [1, 1],
  [0, 0],
] as const;

const obsSpec = fc.record({
  src: fc.integer({ min: 0, max: SOURCES.length - 1 }),
  status: fc.constantFrom(
    'finished',
    'finished',
    'finished',
    'cancelled',
    'postponed',
    'abandoned',
  ),
  ft: fc.integer({ min: 0, max: FULL_TIMES.length - 1 }),
  ht: fc.constantFrom<[number, number] | null>(null, [0, 0], [1, 0]),
  basis: fc.constantFrom(
    'regular_time',
    'regular_time',
    'regular_time',
    'unknown',
    'includes_extra_time',
  ),
  kickoffOff: fc.constantFrom(0, 0, 0, 0, 4 * MINUTE_MS, -KICKOFF_TOLERANCE_MS, 6 * MINUTE_MS),
  changedOff: fc.integer({ min: -HOUR_MS, max: 8 * HOUR_MS }),
  foreign: fc.constantFrom(false, false, false, false, false, false, false, true),
});
type ObsSpec = typeof obsSpec extends fc.Arbitrary<infer T> ? T : never;

function build(spec: ObsSpec): ResolvedObservation<ResultObservation> {
  const [source, upstream] = SOURCES[spec.src] ?? ['s1', 'u1'];
  const [home, away] = FULL_TIMES[spec.ft] ?? [2, 1];
  const ht = spec.ht !== null && spec.ht[0] <= home && spec.ht[1] <= away ? spec.ht : undefined;
  return resultObs({
    source,
    upstream,
    status: spec.status,
    score: spec.status === 'finished' ? score(home, away, ht) : null,
    basis: spec.basis,
    kickoff: KICKOFF + spec.kickoffOff,
    changedAt: END + spec.changedOff,
    names: spec.foreign ? { homeTeamId: 'team-x' } : {},
  });
}

const scenario = fc.record({
  specs: fc.array(obsSpec, { maxLength: 6 }),
  nowOff: fc.integer({ min: -30 * MINUTE_MS, max: 8 * HOUR_MS }),
  needsHalfTime: fc.boolean(),
  autoResults: fc.boolean(),
  enabled: fc.boolean(),
  extraTime: fc.boolean(),
  confirmMs: fc.constantFrom(0, MIN_RESULT_CONFIRM_MS, DEFAULT_RESULT_CONFIRM_MS, 30 * MINUTE_MS),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

/** Mostly agreeing, stable observations: the inputs where a mistake would become an apply. */
const likely = <T>(usual: T, ...rare: T[]): fc.Arbitrary<T> =>
  fc.oneof(
    { weight: 9, arbitrary: fc.constant(usual) },
    { weight: 1, arbitrary: fc.constantFrom(usual, ...rare) },
  );
const agreeingSpec = fc.record({
  src: fc.integer({ min: 0, max: SOURCES.length - 1 }),
  status: likely<ObsSpec['status']>('finished', 'cancelled'),
  ft: likely(0, 1),
  ht: fc.constantFrom<[number, number] | null>(null, [1, 0]),
  basis: likely<ObsSpec['basis']>('regular_time', 'unknown'),
  kickoffOff: likely(0, 6 * MINUTE_MS),
  changedOff: fc.integer({ min: -HOUR_MS, max: 0 }),
  foreign: likely(false, true),
});
const agreeingScenario = fc.record({
  specs: fc.array(agreeingSpec, { minLength: 2, maxLength: 5 }),
  nowOff: fc.integer({ min: 0, max: 8 * HOUR_MS }),
  needsHalfTime: fc.boolean(),
  autoResults: likely(true, false),
  enabled: likely(true, false),
  extraTime: likely(false, true),
  confirmMs: fc.constantFrom(0, MIN_RESULT_CONFIRM_MS, DEFAULT_RESULT_CONFIRM_MS, 30 * MINUTE_MS),
});
const anyScenario = fc.oneof(scenario, agreeingScenario);

function run(s: Scenario, observations = s.specs.map(build)): ResultDecision {
  return decide(observations, {
    now: END + s.nowOff,
    event: { needsHalfTimeScore: s.needsHalfTime },
    policy: { autoResults: s.autoResults, enabled: s.enabled, extraTime: s.extraTime },
    confirmMs: s.confirmMs,
  });
}

const belongs = (o: ResolvedObservation<ResultObservation>): boolean =>
  o.names.homeTeamId === NAMES.homeTeamId;

/** A source whose every observation is clean and agrees with every other finished observation. */
function agreeingSources(
  s: Scenario,
  observations: ResolvedObservation<ResultObservation>[],
): string[] {
  const nowMs = END + s.nowOff;
  const confirm = Math.max(s.confirmMs, MIN_RESULT_CONFIRM_MS);
  const mine = observations.filter(belongs);
  const finished = mine.filter((o) => o.obs.status === 'finished');
  const clean = (o: ResolvedObservation<ResultObservation>): boolean => {
    const sc = o.obs.score;
    return (
      o.obs.status === 'finished' &&
      sc !== null &&
      o.obs.scoreBasis === 'regular_time' &&
      Math.abs(o.obs.kickoff.getTime() - KICKOFF) <= KICKOFF_TOLERANCE_MS &&
      Math.max(o.changedAt.getTime(), o.firstSeenAt.getTime()) + confirm <= nowMs &&
      (!s.needsHalfTime || sc.htHome !== null) &&
      finished.every((other) => {
        const os = other.obs.score;
        if (os === null || os.home !== sc.home || os.away !== sc.away) return false;
        if (!s.needsHalfTime || os.htHome === null) return true;
        return os.htHome === sc.htHome && os.htAway === sc.htAway;
      })
    );
  };
  const ids = new Set(mine.map((o) => o.obs.sourceId));
  return [...ids].filter((id) => mine.filter((o) => o.obs.sourceId === id).every(clean));
}

describe('properties', () => {
  it('permuting the observations never changes the decision', () => {
    fc.assert(
      fc.property(
        anyScenario.chain((s) =>
          fc.tuple(fc.constant(s), fc.shuffledSubarray(s.specs, { minLength: s.specs.length })),
        ),
        ([s, shuffled]) => {
          expect(run(s, shuffled.map(build))).toEqual(run(s));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('duplicating an observation never changes the decision (never adds a vote)', () => {
    fc.assert(
      fc.property(anyScenario, fc.nat(), (s, pick) => {
        const observations = s.specs.map(build);
        const copy = observations[pick % Math.max(observations.length, 1)];
        if (copy === undefined) return;
        expect(run(s, [...observations, copy])).toEqual(run(s, observations));
      }),
      { numRuns: 400 },
    );
  });

  it('adding a dissenting observation never yields apply', () => {
    const dissent = fc.oneof(
      fc
        .constantFrom('cancelled', 'abandoned', 'postponed')
        .map((status) => ({ status, score: null })),
      fc.constant({ status: 'finished' as const, score: score(5, 5) }),
    );
    fc.assert(
      fc.property(anyScenario, dissent, fc.constantFrom('s1', 's2', 's9'), (s, d, source) => {
        const extra = resultObs({
          source,
          upstream: `up-${source}`,
          status: d.status,
          score: d.score,
        });
        const decision = run(s, [...s.specs.map(build), extra]);
        expect(decision.action).not.toBe('apply');
      }),
      { numRuns: 500 },
    );
  });

  it('removing an agreeing source never turns a hold, wait or none into apply', () => {
    let removals = 0;
    fc.assert(
      fc.property(anyScenario, fc.nat(), (s, pick) => {
        const observations = s.specs.map(build);
        if (run(s, observations).action === 'apply') return;
        const agreeing = agreeingSources(s, observations);
        const removed = agreeing[pick % Math.max(agreeing.length, 1)];
        if (removed === undefined) return;
        const rest = observations.filter((o) => o.obs.sourceId !== removed);
        removals++;
        expect(run(s, rest).action).not.toBe('apply');
      }),
      { numRuns: 500 },
    );
    expect(removals).toBeGreaterThan(20);
  });

  it('an apply satisfies R1-R5 when recomputed independently', () => {
    let applies = 0;
    fc.assert(
      fc.property(anyScenario, (s) => {
        const observations = s.specs.map(build);
        const decision = run(s, observations);
        if (decision.action !== 'apply') return;
        applies++;
        const nowMs = END + s.nowOff;
        expect(KICKOFF + MIN_MATCH_DURATION_MS).toBeLessThanOrEqual(nowMs);
        expect([s.autoResults, s.enabled, s.extraTime]).toEqual([true, true, false]);
        const mine = observations.filter(belongs);
        // R2: the full time has two upstreams among all finished scores; a needed half time
        // comes from at least one of them (checked below against every score that gives one).
        const voters = mine;
        const upstreams = new Set(voters.map((o) => o.upstream.trim().toLowerCase()));
        expect(upstreams.size).toBeGreaterThanOrEqual(2);
        if (s.needsHalfTime) expect(decision.score.htHome).not.toBeNull();
        for (const o of mine) {
          expect(o.obs.status).toBe('finished');
          expect(o.obs.scoreBasis).toBe('regular_time');
          expect([o.obs.score?.home, o.obs.score?.away]).toEqual([
            decision.score.home,
            decision.score.away,
          ]);
          if (s.needsHalfTime && o.obs.score?.htHome !== null) {
            expect([o.obs.score?.htHome, o.obs.score?.htAway]).toEqual([
              decision.score.htHome,
              decision.score.htAway,
            ]);
          }
          const since = Math.max(o.changedAt.getTime(), o.firstSeenAt.getTime());
          expect(since + Math.max(s.confirmMs, MIN_RESULT_CONFIRM_MS)).toBeLessThanOrEqual(nowMs);
          expect(Math.abs(o.obs.kickoff.getTime() - KICKOFF)).toBeLessThanOrEqual(
            KICKOFF_TOLERANCE_MS,
          );
        }
      }),
      { numRuns: 1000 },
    );
    expect(applies).toBeGreaterThan(20);
  });

  it('sources of one upstream never produce an apply', () => {
    fc.assert(
      fc.property(anyScenario, (s) => {
        const sameUpstream = s.specs.map((spec) => ({ ...spec, src: spec.src % 2 === 0 ? 0 : 2 }));
        expect(run(s, sameUpstream.map(build)).action).not.toBe('apply');
      }),
      { numRuns: 400 },
    );
  });

  it('no observation at all never changes anything', () => {
    fc.assert(
      fc.property(scenario, fc.boolean(), (s, resulted) => {
        const event = resulted
          ? { status: 'finished' as const, resultedAt: new Date(END), score: score(2, 1) }
          : {};
        const d = decide([], {
          now: END + s.nowOff,
          event,
          policy: { autoResults: s.autoResults },
        });
        expect(d.action).toBe('none');
      }),
    );
  });
});
