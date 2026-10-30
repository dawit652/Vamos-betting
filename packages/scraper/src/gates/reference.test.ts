import { describe, expect, it } from 'vitest';
import { DEFAULT_RESULT_CONFIRM_MS, DAY_MS, HOUR_MS, MINUTE_MS } from '../constants';
import type { FixtureObservation, ResolvedObservation, ResultObservation } from '../types';
import { decideFixture } from './fixture';
import { decideResult } from './result';
import { END, fixtureObs, KICKOFF, makeEvent, makePolicy, resultObs, score } from './testkit';

/**
 * Brute-force reference models. Each is a deliberately naive transcription of
 * the rules as written in docs/scraper.md (with the readings documented in the
 * gates), sharing no code with the implementation: plain loops, pairwise
 * comparisons, literal numbers. Every small input is enumerated (as multisets:
 * order is covered by the permutation property tests) and both models must
 * give the same answer. A disagreement is a bug in one of them; it is fixed by
 * re-reading the spec, never by weakening this test.
 */

type Outcome =
  | { action: 'apply'; score: string }
  | { action: 'hold'; kind: string }
  | { action: 'wait'; until: number }
  | { action: 'none' };

type RObs = ResolvedObservation<ResultObservation>;

/** Independent voices by repeated merging of groups sharing a source or an upstream. */
function naiveIndependent(voices: { source: string; upstream: string }[]): number {
  let groups: string[][] = [];
  for (const v of voices) {
    const keys = ['source=' + v.source, 'upstream=' + v.upstream.trim().toLowerCase()];
    const merged = [...keys];
    const keep: string[][] = [];
    for (const g of groups) {
      if (g.some((k) => keys.includes(k))) merged.push(...g);
      else keep.push(g);
    }
    groups = [...keep, merged];
  }
  return groups.length;
}

function text(s: {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}): string {
  return s.htHome === null ? `${s.home}-${s.away}` : `${s.home}-${s.away}/${s.htHome}-${s.htAway}`;
}

/** The policies that matter for R5: only all of auto_results, enabled and no extra time applies by itself. */
const POLICIES = [
  { autoResults: true, enabled: true, extraTime: false },
  { autoResults: false, enabled: true, extraTime: false },
  { autoResults: true, enabled: false, extraTime: false },
  { autoResults: true, enabled: true, extraTime: true },
];
const autoApply = (p: { autoResults: boolean; enabled: boolean; extraTime: boolean }): boolean =>
  p.autoResults && p.enabled && !p.extraTime;

/** R1–R7 and R10 for a scheduled, unresulted event starting at KICKOFF. */
function referenceResult(
  all: RObs[],
  needsHt: boolean,
  autoResults: boolean,
  now: number,
  configuredConfirm: number,
): Outcome {
  const mine = all.filter(
    (o) => o.names.homeTeamId === 'team-h' && o.names.awayTeamId === 'team-a',
  );
  if (mine.length === 0) return { action: 'none' };
  let anyVoid = false;
  let anyFinished = false;
  for (const o of mine) {
    if (o.obs.status === 'finished') anyFinished = true;
    else anyVoid = true;
  }
  // R7 (+R3): never applied, raised at once.
  if (anyVoid)
    return { action: 'hold', kind: anyFinished ? 'result_conflict' : 'cancellation_proposed' };
  // R1
  const earliestEnd = KICKOFF + 105 * 60 * 1000;
  if (now < earliestEnd) return { action: 'wait', until: earliestEnd };
  // R3, pairwise; kickoffs within 5 minutes of the event start.
  for (const a of mine) {
    if (Math.abs(a.obs.kickoff.getTime() - KICKOFF) > 5 * 60 * 1000)
      return { action: 'hold', kind: 'result_conflict' };
    for (const b of mine) {
      const sa = a.obs.score;
      const sb = b.obs.score;
      if (sa === null || sb === null) return { action: 'hold', kind: 'result_conflict' };
      if (sa.home !== sb.home || sa.away !== sb.away)
        return { action: 'hold', kind: 'result_conflict' };
      if (needsHt && sa.htHome !== null && sb.htHome !== null) {
        if (sa.htHome !== sb.htHome || sa.htAway !== sb.htAway)
          return { action: 'hold', kind: 'result_conflict' };
      }
    }
  }
  const basisDoubt = mine.some((o) => o.obs.scoreBasis !== 'regular_time');
  const voters = mine.filter(
    (o) => o.obs.scoreBasis === 'regular_time' && (!needsHt || o.obs.score?.htHome !== null),
  );
  const independent = naiveIndependent(
    voters.map((o) => ({ source: o.obs.sourceId, upstream: o.upstream })),
  );
  if (independent >= 2) {
    // R4: never below five minutes; every observation unchanged that long.
    const confirm = configuredConfirm < 5 * 60 * 1000 ? 5 * 60 * 1000 : configuredConfirm;
    let lastChange = 0;
    for (const o of mine) {
      lastChange = Math.max(lastChange, o.changedAt.getTime(), o.firstSeenAt.getTime());
    }
    if (now - lastChange < confirm) {
      return basisDoubt
        ? { action: 'hold', kind: 'score_basis_unknown' }
        : { action: 'wait', until: lastChange + confirm };
    }
    if (basisDoubt || !autoResults) return { action: 'hold', kind: 'result_ready' };
    const first = voters[0]?.obs.score;
    if (!first) throw new Error('reference: no voter');
    const sameHt = voters.every(
      (v) => v.obs.score?.htHome === first.htHome && v.obs.score?.htAway === first.htAway,
    );
    return {
      action: 'apply',
      score: text(sameHt ? first : { ...first, htHome: null, htAway: null }),
    };
  }
  const regular = mine.filter((o) => o.obs.scoreBasis === 'regular_time');
  if (regular.length > 0) {
    // R6: six hours after the earliest possible end.
    if (now >= earliestEnd + 6 * 60 * 60 * 1000)
      return { action: 'hold', kind: 'result_unverified' };
    return basisDoubt
      ? { action: 'hold', kind: 'score_basis_unknown' }
      : { action: 'wait', until: earliestEnd + 6 * 60 * 60 * 1000 };
  }
  return { action: 'hold', kind: 'score_basis_unknown' };
}

function actual(d: ReturnType<typeof decideResult>): Outcome {
  switch (d.action) {
    case 'apply':
      return { action: 'apply', score: text(d.score) };
    case 'hold':
      return { action: 'hold', kind: d.review.kind };
    case 'wait':
      return { action: 'wait', until: d.until.getTime() };
    default:
      return { action: 'none' };
  }
}

/** Every multiset of at most `max` options. */
function multisets<T>(options: readonly T[], max: number): T[][] {
  const out: T[][] = [[]];
  const grow = (prefix: T[], start: number): void => {
    if (prefix.length === max) return;
    for (let i = start; i < options.length; i++) {
      const next = [...prefix, options[i] as T];
      out.push(next);
      grow(next, i);
    }
  };
  grow([], 0);
  return out;
}

describe('reference model: results R1-R7, R10 (exhaustive)', () => {
  it('agrees on every combination of up to three observations (no half time)', () => {
    const sources = [
      ['s1', 'u1'],
      ['s2', 'u2'],
      ['s3', 'u1'],
      ['s4', ' U2'],
    ] as const;
    const states = [
      { status: 'finished', score: score(2, 1), basis: 'regular_time' },
      { status: 'finished', score: score(1, 1), basis: 'regular_time' },
      { status: 'finished', score: score(2, 1), basis: 'unknown' },
      { status: 'cancelled', score: null, basis: 'regular_time' },
    ] as const;
    const options: RObs[] = [];
    for (const [source, upstream] of sources) {
      for (const st of states) {
        for (const changedAt of [END, END + 50 * MINUTE_MS]) {
          options.push(
            resultObs({
              source,
              upstream,
              status: st.status,
              score: st.score,
              basis: st.basis,
              changedAt,
            }),
          );
        }
      }
    }
    let compared = 0;
    const seen = new Set<string>();
    for (const combo of multisets(options, 3)) {
      for (const now of [END - 1, END + HOUR_MS, END + 7 * HOUR_MS]) {
        for (const policy of POLICIES) {
          const autoResults = autoApply(policy);
          for (const confirmMs of [0, DEFAULT_RESULT_CONFIRM_MS]) {
            const expected = referenceResult(combo, false, autoResults, now, confirmMs);
            const got = actual(
              decideResult({
                event: makeEvent(),
                observations: combo,
                policy: makePolicy(policy),
                now: new Date(now),
                confirmMs,
                exposure: null,
              }),
            );
            if (JSON.stringify(got) !== JSON.stringify(expected)) {
              expect({
                combo: combo.map((o) => [
                  o.obs.sourceId,
                  o.obs.status,
                  o.obs.score,
                  o.obs.scoreBasis,
                  o.changedAt,
                ]),
                now,
                autoResults,
                confirmMs,
                got,
              }).toEqual({
                combo: combo.map((o) => [
                  o.obs.sourceId,
                  o.obs.status,
                  o.obs.score,
                  o.obs.scoreBasis,
                  o.changedAt,
                ]),
                now,
                autoResults,
                confirmMs,
                got: expected,
              });
            }
            seen.add(
              JSON.stringify(expected)
                .replace(/"until":\d+/, '')
                .replace(/"score":"[^"]*"/, ''),
            );
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(70_000);
    // The space reaches every outcome the rules can produce.
    expect([...seen].sort()).toEqual(
      [
        '{"action":"apply",}',
        '{"action":"hold","kind":"cancellation_proposed"}',
        '{"action":"hold","kind":"result_conflict"}',
        '{"action":"hold","kind":"result_ready"}',
        '{"action":"hold","kind":"result_unverified"}',
        '{"action":"hold","kind":"score_basis_unknown"}',
        '{"action":"none"}',
        '{"action":"wait",}',
      ].sort(),
    );
  });

  it('agrees with half time required and kickoff mismatches', () => {
    const sources = [
      ['s1', 'u1'],
      ['s2', 'u2'],
      ['s3', 'u1'],
    ] as const;
    const states = [
      { score: score(2, 1, [1, 0]), basis: 'regular_time', kickoff: KICKOFF },
      { score: score(2, 1, [0, 0]), basis: 'regular_time', kickoff: KICKOFF },
      { score: score(2, 1), basis: 'regular_time', kickoff: KICKOFF },
      { score: score(2, 1, [1, 0]), basis: 'regular_time', kickoff: KICKOFF + 6 * MINUTE_MS },
      { score: score(2, 1), basis: 'includes_extra_time', kickoff: KICKOFF - 5 * MINUTE_MS },
    ] as const;
    const options: RObs[] = [];
    for (const [source, upstream] of sources) {
      for (const st of states)
        options.push(
          resultObs({ source, upstream, score: st.score, basis: st.basis, kickoff: st.kickoff }),
        );
    }
    for (const combo of multisets(options, 3)) {
      for (const now of [END - 1, END + HOUR_MS, END + 7 * HOUR_MS]) {
        for (const policy of POLICIES) {
          const expected = referenceResult(
            combo,
            true,
            autoApply(policy),
            now,
            DEFAULT_RESULT_CONFIRM_MS,
          );
          const got = actual(
            decideResult({
              event: makeEvent({ needsHalfTimeScore: true }),
              observations: combo,
              policy: makePolicy(policy),
              now: new Date(now),
              confirmMs: DEFAULT_RESULT_CONFIRM_MS,
              exposure: null,
            }),
          );
          expect(got).toEqual(expected);
        }
      }
    }
  });
});

type FObs = ResolvedObservation<FixtureObservation>;
type KickoffOutcome =
  { action: 'update'; to: number; rule: string } | { action: 'hold' } | { action: 'none' };

/** F4 for a scheduled, unresulted event starting at KICKOFF (all observations scheduled). */
function referenceKickoff(
  all: FObs[],
  hasBets: boolean,
  now: number,
  enabled: boolean,
  bettingOpen: boolean,
): KickoffOutcome {
  const five = 5 * 60 * 1000;
  const ten = 10 * 60 * 1000;
  const ks = all.map((o) => o.obs.kickoff.getTime());
  if (ks.length === 0) return { action: 'none' };
  if (ks.every((k) => Math.abs(k - KICKOFF) <= five)) return { action: 'none' };
  for (const a of ks) for (const b of ks) if (Math.abs(a - b) > five) return { action: 'hold' };
  const to = Math.min(...ks);
  if (Math.abs(to - KICKOFF) <= five) return { action: 'none' };
  if (KICKOFF <= now + ten) return { action: 'hold' };
  if (to <= now + ten) return { action: 'hold' };
  // A disabled policy only proposes: the kill switch stops every move.
  if (!enabled) return { action: 'hold' };
  const independent = naiveIndependent(
    all.map((o) => ({ source: o.obs.sourceId, upstream: o.upstream })),
  );
  if (independent >= 2) return { action: 'update', to, rule: 'F4a' };
  if (independent === 1 && to > KICKOFF && to - KICKOFF <= 2 * 60 * 60 * 1000 && !hasBets) {
    // K4: the one-source move needs betting closed.
    return bettingOpen ? { action: 'hold' } : { action: 'update', to, rule: 'F4b' };
  }
  return { action: 'hold' };
}

describe('reference model: F4 kickoff change (exhaustive)', () => {
  it('agrees on every combination of up to three observations', () => {
    const offsets = [
      0,
      3 * MINUTE_MS,
      5 * MINUTE_MS,
      5 * MINUTE_MS + 1,
      HOUR_MS,
      2 * HOUR_MS,
      2 * HOUR_MS + 1,
      -HOUR_MS,
      -5 * MINUTE_MS - 1,
      HOUR_MS + 5 * MINUTE_MS,
    ];
    const options: FObs[] = [];
    for (const [source, upstream] of [
      ['s1', 'u1'],
      ['s2', 'u2'],
      ['s3', 'u1'],
    ] as const) {
      for (const offset of offsets)
        options.push(fixtureObs({ source, upstream, kickoff: KICKOFF + offset }));
    }
    const outcomes = new Set<string>();
    let compared = 0;
    for (const combo of multisets(options, 3)) {
      if (combo.length === 0) continue;
      for (const [hasBets, enabled, bettingOpen] of [
        [false, true, false],
        [false, true, true],
        [true, true, false],
        [true, true, true],
        [false, false, false],
      ] as const) {
        for (const now of [
          KICKOFF - DAY_MS,
          KICKOFF - 70 * MINUTE_MS,
          KICKOFF - 10 * MINUTE_MS,
          KICKOFF - 10 * MINUTE_MS - 1,
        ]) {
          const expected = referenceKickoff(combo, hasBets, now, enabled, bettingOpen);
          const d = decideFixture({
            observations: combo,
            candidates: [makeEvent({ hasBets, bettingOpen })],
            policy: makePolicy({ enabled }),
            now: new Date(now),
            calibrated: true,
            pricesSane: true,
            kickoffConfirmed: true,
          });
          const got: KickoffOutcome =
            d.action === 'update-kickoff'
              ? { action: 'update', to: d.to.getTime(), rule: d.rule }
              : d.action === 'hold'
                ? { action: 'hold' }
                : { action: 'none' };
          if (d.action === 'hold') expect(d.review.kind).toBe('kickoff_change');
          expect(got).toEqual(expected);
          outcomes.add(got.action === 'update' ? got.rule : got.action);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(30_000);
    expect([...outcomes].sort()).toEqual(['F4a', 'F4b', 'hold', 'none']);
  });
});
