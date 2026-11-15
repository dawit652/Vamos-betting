import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ResolvedObservation, ResultObservation } from '../types';
import {
  LADDER_MAJORITY_AFTER_MS,
  LADDER_MAJORITY_STAND_MS,
  LADDER_SINGLE_AFTER_MS,
  LADDER_SINGLE_STAND_MS,
  LADDER_VOID_AFTER_KICKOFF_MS,
  LADDER_VOID_REPORT_STAND_MS,
  type SourceTrustStats,
  decideLadder,
  trustLevel,
} from './ladder';
import { END, KICKOFF, makeEvent, resultObs, score } from './testkit';

const HOUR = 3_600_000;
const TRUSTED: SourceTrustStats = { compared: 1000, agreed: 999 };
const SECOND: SourceTrustStats = { compared: 1000, agreed: 996 };
const POOR: SourceTrustStats = { compared: 1000, agreed: 990 };

function trust(entries: Record<string, SourceTrustStats>): Map<string, SourceTrustStats> {
  return new Map(Object.entries(entries));
}

const at = (ms: number) => new Date(ms);

describe('trustLevel', () => {
  it('is measured: nothing below 500 comparisons, then 99.5% and 99.8%', () => {
    expect(trustLevel(undefined)).toBe('untrusted');
    expect(trustLevel({ compared: 499, agreed: 499 })).toBe('untrusted');
    expect(trustLevel({ compared: 500, agreed: 499 })).toBe('trusted');
    expect(trustLevel({ compared: 1000, agreed: 998 })).toBe('trusted');
    expect(trustLevel(SECOND)).toBe('second_source');
    expect(trustLevel(POOR)).toBe('untrusted');
    expect(trustLevel({ compared: 1000, agreed: 1001 })).toBe('untrusted');
    expect(trustLevel({ compared: 1000.5, agreed: 999 })).toBe('untrusted');
  });
});

describe('rung B: majority', () => {
  const observations = [
    resultObs({ source: 'a', score: score(2, 1) }),
    resultObs({ source: 'b', score: score(2, 1) }),
    resultObs({ source: 'c', score: score(1, 1) }),
  ];
  const sources = trust({ 'up-a': SECOND, 'up-b': SECOND, 'up-c': SECOND });

  it('waits for the 30 minutes, then for the 2 hours of standing, then applies the majority', () => {
    const event = makeEvent();
    expect(
      decideLadder({ event, observations, trust: sources, now: at(END + 10 * 60_000) }),
    ).toEqual({
      action: 'wait',
      until: at(END + LADDER_MAJORITY_STAND_MS),
      reason: 'majority_standing',
    });
    const decision = decideLadder({
      event,
      observations,
      trust: sources,
      now: at(END + LADDER_MAJORITY_STAND_MS),
    });
    expect(decision).toEqual({
      action: 'apply',
      rung: 'B',
      score: score(2, 1),
      upstreams: ['up-a', 'up-b'],
      dissent: ['up-c'],
    });
    expect(LADDER_MAJORITY_AFTER_MS).toBeLessThan(LADDER_MAJORITY_STAND_MS);
  });

  it('does not apply when a voter of the majority is not a second source', () => {
    const decision = decideLadder({
      event: makeEvent(),
      observations,
      trust: trust({ 'up-a': SECOND, 'up-b': POOR, 'up-c': SECOND }),
      now: at(END + 3 * HOUR),
    });
    expect(decision.action).toBe('wait');
  });

  it('does not apply against a trusted dissenter', () => {
    const decision = decideLadder({
      event: makeEvent(),
      observations,
      trust: trust({ 'up-a': SECOND, 'up-b': SECOND, 'up-c': TRUSTED }),
      now: at(KICKOFF + LADDER_VOID_AFTER_KICKOFF_MS),
    });
    expect(decision).toMatchObject({ action: 'void', reason: 'split', strict: false });
  });

  it('counts sources of one upstream once, and a 2-2 split never has a majority', () => {
    const split = [
      resultObs({ source: 'a', score: score(2, 1) }),
      resultObs({ source: 'a2', upstream: 'up-a', score: score(2, 1) }),
      resultObs({ source: 'b', score: score(2, 1) }),
      resultObs({ source: 'c', score: score(0, 0) }),
      resultObs({ source: 'd', score: score(0, 0) }),
    ];
    const all = trust({ 'up-a': SECOND, 'up-b': SECOND, 'up-c': SECOND, 'up-d': SECOND });
    expect(
      decideLadder({ event: makeEvent(), observations: split, trust: all, now: at(END + 5 * HOUR) })
        .action,
    ).toBe('wait');
  });

  it('is blocked by a not-played report and by a kickoff that is not the event’s', () => {
    for (const extra of [
      resultObs({ source: 'd', status: 'postponed' }),
      resultObs({ source: 'd', kickoff: KICKOFF + 6 * HOUR }),
    ]) {
      const decision = decideLadder({
        event: makeEvent(),
        observations: [...observations, extra],
        trust: trust({ 'up-a': SECOND, 'up-b': SECOND, 'up-c': SECOND, 'up-d': SECOND }),
        now: at(END + 5 * HOUR),
      });
      expect(decision.action).toBe('wait');
    }
  });
});

describe('rung C: one trusted source', () => {
  const lone = [resultObs({ source: 'spine', score: score(1, 0, [0, 0]) })];

  it('applies a trusted lone score after 6 hours of standing', () => {
    const event = makeEvent();
    const sources = trust({ 'up-spine': TRUSTED });
    expect(
      decideLadder({ event, observations: lone, trust: sources, now: at(END + 2 * HOUR) }),
    ).toEqual({
      action: 'wait',
      until: at(END + LADDER_SINGLE_AFTER_MS),
      reason: 'single_not_due',
    });
    expect(
      decideLadder({
        event,
        observations: lone,
        trust: sources,
        now: at(END + LADDER_SINGLE_STAND_MS),
      }),
    ).toEqual({
      action: 'apply',
      rung: 'C',
      score: score(1, 0, [0, 0]),
      upstreams: ['up-spine'],
      dissent: [],
    });
  });

  it('needs trust, goal events that add up and the half time when the event needs it', () => {
    const late = at(END + 7 * HOUR);
    expect(
      decideLadder({
        event: makeEvent(),
        observations: lone,
        trust: trust({ 'up-spine': SECOND }),
        now: late,
      }).action,
    ).toBe('wait');
    expect(
      decideLadder({
        event: makeEvent(),
        observations: lone,
        trust: trust({ 'up-spine': TRUSTED }),
        goalsAddUp: new Map([['spine', false]]),
        now: late,
      }).action,
    ).toBe('wait');
    const noHalf = [resultObs({ source: 'spine', score: score(1, 0) })];
    expect(
      decideLadder({
        event: makeEvent({ needsHalfTimeScore: true }),
        observations: noHalf,
        trust: trust({ 'up-spine': TRUSTED }),
        now: late,
      }).action,
    ).toBe('wait');
  });

  it('never uses a score of another basis', () => {
    const decision = decideLadder({
      event: makeEvent(),
      observations: [resultObs({ source: 'spine', score: score(3, 2), basis: 'unknown' })],
      trust: trust({ 'up-spine': TRUSTED }),
      now: at(END + 8 * HOUR),
    });
    expect(decision.action).toBe('wait');
  });
});

describe('rung D: the 48-hour rule (shadow)', () => {
  const voidAt = KICKOFF + LADDER_VOID_AFTER_KICKOFF_MS;

  it('is strict for two not-played reports that stood 6 hours', () => {
    const observations = [
      resultObs({ source: 'a', status: 'postponed', changedAt: KICKOFF }),
      resultObs({ source: 'b', status: 'cancelled', changedAt: KICKOFF }),
    ];
    expect(
      decideLadder({ event: makeEvent(), observations, trust: new Map(), now: at(voidAt - 1) }),
    ).toEqual({
      action: 'wait',
      until: at(voidAt),
      reason: 'void_not_due',
    });
    expect(
      decideLadder({ event: makeEvent(), observations, trust: new Map(), now: at(voidAt) }),
    ).toEqual({
      action: 'void',
      rung: 'D',
      reason: 'not_played',
      strict: true,
      notPlayed: ['up-a', 'up-b'],
    });
  });

  it('waits for a fresh not-played report to stand 6 hours', () => {
    const observations = [
      resultObs({ source: 'a', status: 'abandoned', changedAt: voidAt - HOUR }),
    ];
    expect(
      decideLadder({ event: makeEvent(), observations, trust: new Map(), now: at(voidAt) }),
    ).toEqual({
      action: 'wait',
      until: at(voidAt - HOUR + LADDER_VOID_REPORT_STAND_MS),
      reason: 'void_report_standing',
    });
  });

  it('reports the cases the strict text does not cover as not strict', () => {
    const now = at(voidAt);
    expect(
      decideLadder({ event: makeEvent(), observations: [], trust: new Map(), now }),
    ).toMatchObject({
      action: 'void',
      reason: 'no_result',
      strict: false,
    });
    expect(
      decideLadder({
        event: makeEvent(),
        observations: [
          resultObs({ source: 'a', status: 'postponed', changedAt: KICKOFF }),
          resultObs({ source: 'b', score: score(1, 0) }),
        ],
        trust: new Map(),
        now,
      }),
    ).toMatchObject({ action: 'void', reason: 'status_conflict', strict: false });
    expect(
      decideLadder({
        event: makeEvent(),
        observations: [resultObs({ source: 'b', score: score(1, 0) })],
        trust: new Map(),
        now,
      }),
    ).toMatchObject({ action: 'void', reason: 'unverified', strict: false });
  });

  it('does not cut a rung C result short at 48 hours', () => {
    const observations = [
      resultObs({ source: 'spine', score: score(1, 0), changedAt: voidAt - HOUR }),
    ];
    expect(
      decideLadder({
        event: makeEvent(),
        observations,
        trust: trust({ 'up-spine': TRUSTED }),
        now: at(voidAt),
      }),
    ).toEqual({
      action: 'wait',
      until: at(voidAt - HOUR + LADDER_SINGLE_STAND_MS),
      reason: 'single_standing',
    });
  });
});

describe('what the ladder leaves alone', () => {
  it('rung A agreement, resulted events, events not scheduled and invalid observations', () => {
    const agree = [resultObs({ source: 'a' }), resultObs({ source: 'b' })];
    const now = at(END + 9 * HOUR);
    expect(
      decideLadder({ event: makeEvent(), observations: agree, trust: new Map(), now }),
    ).toEqual({
      action: 'none',
      reason: 'agreement',
    });
    expect(
      decideLadder({
        event: makeEvent({ resultedAt: at(END), score: score(2, 1) }),
        observations: agree,
        trust: new Map(),
        now,
      }),
    ).toEqual({ action: 'none', reason: 'already_resulted' });
    expect(
      decideLadder({
        event: makeEvent({ status: 'live' }),
        observations: agree,
        trust: new Map(),
        now,
      }),
    ).toEqual({ action: 'none', reason: 'not_eligible' });
    const broken = resultObs({ source: 'a' });
    (broken.obs as { score: unknown }).score = { home: -1, away: 0, htHome: null, htAway: null };
    expect(
      decideLadder({ event: makeEvent(), observations: [broken], trust: new Map(), now }),
    ).toEqual({
      action: 'none',
      reason: 'invalid_observation',
    });
  });

  it('waits for the earliest end of the match', () => {
    expect(
      decideLadder({ event: makeEvent(), observations: [], trust: new Map(), now: at(END - 1) }),
    ).toEqual({
      action: 'wait',
      until: at(END),
      reason: 'match_not_over',
    });
  });
});

describe('properties', () => {
  const upstreams = ['u1', 'u2', 'u3', 'u4', 'u5'];
  const observationArb = fc.record({
    upstream: fc.constantFrom(...upstreams),
    kind: fc.constantFrom('score', 'score', 'score', 'postponed', 'other_basis'),
    home: fc.integer({ min: 0, max: 3 }),
    away: fc.integer({ min: 0, max: 3 }),
    changedAfterEnd: fc.integer({ min: 0, max: 60 * HOUR }),
  });
  const trustArb = fc.dictionary(
    fc.constantFrom(...upstreams),
    fc.constantFrom(TRUSTED, SECOND, POOR),
  );

  interface Spec {
    upstream: string;
    kind: string;
    home: number;
    away: number;
    changedAfterEnd: number;
  }

  function build(specs: readonly Spec[]) {
    return specs.map((s, i): ResolvedObservation<ResultObservation> =>
      resultObs({
        source: `${s.upstream}-s${i}`,
        upstream: s.upstream,
        status: s.kind === 'postponed' ? 'postponed' : 'finished',
        score: s.kind === 'postponed' ? null : score(s.home, s.away),
        basis: s.kind === 'other_basis' ? 'unknown' : 'regular_time',
        changedAt: END + s.changedAfterEnd,
      }),
    );
  }

  it('never applies a score that a trusted source contradicts, nor with a not-played report', () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { maxLength: 7 }),
        trustArb,
        fc.integer({ min: 0, max: 80 * HOUR }),
        (specs, trusts, offset) => {
          const observations = build(specs);
          const decision = decideLadder({
            event: makeEvent(),
            observations,
            trust: new Map(Object.entries(trusts)),
            now: at(END + offset),
          });
          if (decision.action !== 'apply') return;
          const applied = `${decision.score.home}-${decision.score.away}`;
          for (const o of observations) {
            expect(o.obs.status).toBe('finished');
            if (o.obs.scoreBasis !== 'regular_time' || o.obs.score === null) continue;
            const said = `${o.obs.score.home}-${o.obs.score.away}`;
            if (said !== applied) {
              expect(trustLevel(trusts[o.upstream])).not.toBe('trusted');
              expect(decision.rung).toBe('B');
              expect(decision.dissent).toEqual([o.upstream]);
            }
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('never voids before 48 hours after kickoff, and voids strictly only without any score', () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { maxLength: 7 }),
        trustArb,
        fc.integer({ min: 0, max: 80 * HOUR }),
        (specs, trusts, offset) => {
          const observations = build(specs);
          const now = END + offset;
          const decision = decideLadder({
            event: makeEvent(),
            observations,
            trust: new Map(Object.entries(trusts)),
            now: at(now),
          });
          if (decision.action !== 'void') return;
          expect(now).toBeGreaterThanOrEqual(KICKOFF + LADDER_VOID_AFTER_KICKOFF_MS);
          if (decision.strict) {
            const regularScores = observations.filter(
              (o) => o.obs.status === 'finished' && o.obs.scoreBasis === 'regular_time',
            );
            expect(regularScores).toEqual([]);
            expect(decision.notPlayed.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});
