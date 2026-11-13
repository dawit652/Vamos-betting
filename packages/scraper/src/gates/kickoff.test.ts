import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  KICKOFF_CONFIRM_LEAD_MS,
  KICKOFF_EVIDENCE_WINDOW_MS,
  KICKOFF_STABLE_MS,
  KICKOFF_TOLERANCE_MS,
  MINUTE_MS,
} from '../constants';
import type { ExistingEvent } from '../types';
import { countIndependent } from './confirmation';
import {
  assessKickoff,
  earlierKickoffAction,
  kickoffEvidenceKey,
  type KickoffAssessment,
  type KickoffPersonRecord,
  type KickoffStatement,
} from './kickoff';
import { KICKOFF, makeEvent } from './testkit';

const START = KICKOFF;
/** Inside the lead window (72 h before the start), so C2 can apply. */
const NEAR = START - 24 * HOUR_MS;
/** Far from the start: only C1 or C3 can confirm. */
const FAR = START - 10 * DAY_MS;

interface Spec {
  source?: string;
  upstream?: string;
  kind?: KickoffStatement['kind'];
  status?: KickoffStatement['status'];
  /** Offset of the statement's kickoff from START. */
  offset?: number;
  /** Absolute changedAt (default: long before anything). */
  changedAt?: number;
  fresh?: boolean;
}

function st(spec: Spec = {}): KickoffStatement {
  const source = spec.source ?? 's1';
  return {
    sourceId: source,
    upstream: spec.upstream ?? `up-${source}`,
    kind: spec.kind ?? 'fixture',
    status: spec.status ?? 'scheduled',
    kickoff: new Date(START + (spec.offset ?? 0)),
    changedAt: new Date(spec.changedAt ?? START - 20 * DAY_MS),
    sourceFresh: spec.fresh ?? true,
  };
}

function assess(
  statements: readonly KickoffStatement[],
  opts: { now?: number; person?: KickoffPersonRecord | null; start?: number } = {},
): KickoffAssessment {
  return assessKickoff({
    start: new Date(opts.start ?? START),
    now: new Date(opts.now ?? FAR),
    statements,
    person: opts.person ?? null,
  });
}

const person = (over: Partial<KickoffPersonRecord> = {}): KickoffPersonRecord => ({
  startTime: new Date(START),
  confirmedAt: new Date(FAR),
  evidenceKey: 'a'.repeat(64),
  ...over,
});

describe('K1 earlier-kickoff statements', () => {
  it('K1 fires one millisecond before start - tolerance, not at it', () => {
    const justEarlier = st({ offset: -KICKOFF_TOLERANCE_MS - 1 });
    const atTolerance = st({ source: 's2', offset: -KICKOFF_TOLERANCE_MS });
    expect(assess([justEarlier]).earlier).toEqual([justEarlier]);
    expect(assess([atTolerance]).earlier).toEqual([]);
    // At the tolerance the statement agrees with the start.
    expect(assess([atTolerance], { now: NEAR }).basis).toBe('C2');
  });

  it('K1 window edges: start - 7 d is in, start - 7 d - 1 ms is out', () => {
    const edge = st({ offset: -KICKOFF_EVIDENCE_WINDOW_MS });
    const outside = st({ offset: -KICKOFF_EVIDENCE_WINDOW_MS - 1 });
    expect(assess([edge]).earlier).toEqual([edge]);
    expect(assess([outside]).earlier).toEqual([]);
    // An outside statement is not a statement at all (it does not even dissent).
    expect(assess([outside]).reasons).toEqual(['no_statement']);
    // The later edge is symmetric for dissent: in at + 7 d, out one millisecond beyond.
    expect(assess([st({ offset: KICKOFF_EVIDENCE_WINDOW_MS })]).reasons).toEqual([
      'sources_disagree',
      // no agreeing statement, so no freshness or stability reason
    ]);
    expect(assess([st({ offset: KICKOFF_EVIDENCE_WINDOW_MS + 1 })]).reasons).toEqual([
      'no_statement',
    ]);
  });

  it('K1 a finished result earlier fires, and so is the past', () => {
    const played = st({ kind: 'result', status: 'finished', offset: -2 * DAY_MS });
    expect(assess([played], { now: START - HOUR_MS }).earlier).toEqual([played]);
    const old = st({ kind: 'result', status: 'finished', offset: -KICKOFF_EVIDENCE_WINDOW_MS });
    expect(assess([old]).earlier).toEqual([old]);
  });

  it('K1 a finished result at exactly start - tolerance is not earlier (still dissent), one millisecond before it is', () => {
    const at = st({ kind: 'result', status: 'finished', offset: -KICKOFF_TOLERANCE_MS });
    expect(assess([at]).earlier).toEqual([]);
    expect(assess([at]).reasons).toEqual(['result_reported']);
    const before = st({ kind: 'result', status: 'finished', offset: -KICKOFF_TOLERANCE_MS - 1 });
    expect(assess([before]).earlier).toEqual([before]);
  });

  it('K5 postponed, cancelled and abandoned statements are never earlier-kickoff statements', () => {
    const voids = [
      st({ source: 'a', status: 'postponed', offset: -DAY_MS }),
      st({ source: 'b', status: 'cancelled', offset: -DAY_MS }),
      st({ source: 'c', kind: 'result', status: 'postponed', offset: -DAY_MS }),
      st({ source: 'd', kind: 'result', status: 'cancelled', offset: -DAY_MS }),
      st({ source: 'e', kind: 'result', status: 'abandoned', offset: -DAY_MS }),
    ];
    for (const one of voids) {
      const a = assess([one]);
      expect(a.earlier, one.sourceId).toEqual([]);
      expect(a.reasons, one.sourceId).toContain('void_status_reported');
      expect(a.confirmed, one.sourceId).toBe(false);
    }
  });

  it('K1 later kickoffs and agreeing kickoffs are not earlier', () => {
    expect(assess([st({ offset: HOUR_MS }), st({ source: 's2', offset: 0 })]).earlier).toEqual([]);
  });

  it('K1 an acknowledged statement is silent; the same statement after it changed fires', () => {
    const changedAt = START - 4 * DAY_MS;
    const earlier = st({ offset: -3 * HOUR_MS, changedAt });
    const ack = person({ confirmedAt: new Date(changedAt) });
    expect(assess([earlier], { person: ack }).earlier).toEqual([]);
    const later = st({ offset: -3 * HOUR_MS, changedAt: changedAt + 1 });
    expect(assess([later], { person: ack }).earlier).toEqual([later]);
    // A different earlier time (the statement changed) is a new statement: not acknowledged.
    const moved = st({ offset: -5 * HOUR_MS, changedAt: changedAt + HOUR_MS });
    expect(assess([moved], { person: ack }).earlier).toEqual([moved]);
  });

  it('K1 a person record for another start is ignored', () => {
    const changedAt = START - 4 * DAY_MS;
    const earlier = st({ offset: -3 * HOUR_MS, changedAt });
    const other = person({ startTime: new Date(START + 1), confirmedAt: new Date(FAR) });
    expect(assess([earlier], { person: other })).toEqual(assess([earlier]));
    expect(assess([earlier], { person: other }).earlier).toEqual([earlier]);
    expect(assess([earlier], { person: other }).basis).toBeNull();
  });

  it('K1 earlier statements are listed in a fixed order whatever the input order', () => {
    const a = st({ source: 'a', offset: -HOUR_MS });
    const b = st({ source: 'b', offset: -2 * HOUR_MS });
    expect(assess([b, a]).earlier).toEqual([a, b]);
  });
});

describe('earlierKickoffAction (K1, K6)', () => {
  const earlier = [st({ offset: -HOUR_MS })];
  const now = new Date(START - DAY_MS);
  const act = (over: Partial<ExistingEvent> = {}, list: readonly KickoffStatement[] = earlier) =>
    earlierKickoffAction(makeEvent({ bettingOpen: true, ...over }), { earlier: list }, now);

  it('K1 closes an open, scheduled, unresulted event that has not started', () => {
    expect(act()).toBe('close');
  });

  it('K6 and P1 it changes nothing when betting is already closed', () => {
    expect(act({ bettingOpen: false })).toBe('none');
  });

  it('K1 needs an earlier statement, a scheduled unresulted event and a start after now', () => {
    expect(act({}, [])).toBe('none');
    for (const status of ['live', 'finished', 'postponed', 'cancelled', 'abandoned'] as const) {
      expect(act({ status }), status).toBe('none');
    }
    expect(act({ resultedAt: new Date(START) })).toBe('none');
    expect(act({ score: { home: 1, away: 0, htHome: null, htAway: null } })).toBe('none');
    expect(act({ startTime: new Date(now.getTime()) })).toBe('none');
    expect(act({ startTime: new Date(now.getTime() + 1) })).toBe('close');
    expect(act({ startTime: new Date(Number.NaN) })).toBe('none');
    expect(act({ bettingOpen: 'yes' as unknown as boolean })).toBe('none');
  });

  it('K1 runs whatever the confirmation basis (a C1 event whose second source moves earlier)', () => {
    const a = assess([
      st({ source: 'a' }),
      st({ source: 'b' }),
      st({ source: 'c', offset: -HOUR_MS }),
    ]);
    expect(a.confirmed).toBe(false);
    expect(act({}, a.earlier)).toBe('close');
  });

  it('rejects an invalid now', () => {
    expect(() => earlierKickoffAction(makeEvent(), { earlier }, new Date(Number.NaN))).toThrow(
      RangeError,
    );
  });
});

describe('C1 two upstreams', () => {
  it('C1 two sources of one upstream do not confirm; two upstreams do', () => {
    const same = [st({ source: 'a', upstream: 'opta' }), st({ source: 'b', upstream: ' OPTA ' })];
    expect(assess(same).confirmed).toBe(false);
    const two = [st({ source: 'a', upstream: 'opta' }), st({ source: 'b', upstream: 'statsbomb' })];
    const a = assess(two);
    expect(a).toMatchObject({ confirmed: true, basis: 'C1', reasons: [], earlier: [] });
  });

  it('C1 one of the two sources not fresh does not confirm', () => {
    const a = assess([st({ source: 'a' }), st({ source: 'b', fresh: false })]);
    expect(a.confirmed).toBe(false);
    expect(a.reasons).toEqual(['too_early_for_single_source']);
  });

  it('C1 needs no lead time and no stability (far from the kickoff, just changed)', () => {
    const a = assess([st({ source: 'a', changedAt: FAR }), st({ source: 'b', changedAt: FAR })], {
      now: FAR,
    });
    expect(a.basis).toBe('C1');
  });

  it('C1 any dissenting statement blocks it', () => {
    const two = [st({ source: 'a' }), st({ source: 'b' })];
    for (const dissent of [
      st({ source: 'c', offset: HOUR_MS }),
      st({ source: 'c', offset: -HOUR_MS, fresh: false }),
      st({ source: 'c', status: 'postponed' }),
      st({ source: 'c', kind: 'result', status: 'finished', offset: -2 * DAY_MS }),
    ]) {
      expect(assess([...two, dissent]).confirmed).toBe(false);
    }
  });

  it('C1 a not-fresh row naming another upstream for a source cannot widen independence', () => {
    const a = assess([
      st({ source: 'a', upstream: 'u2' }),
      st({ source: 'b', upstream: 'u1' }),
      st({ source: 'a', upstream: 'u1', fresh: false }),
    ]);
    expect(a.confirmed).toBe(false);
  });

  describe('plan task 1.4: the free fixture list and the spine are two kickoff voices', () => {
    const oddsApi = (over: Spec = {}) =>
      st({ source: 'theoddsapi-events-en1', upstream: 'TheOddsAPI', ...over });
    const spine = (over: Spec = {}) =>
      st({ source: 'apifootball-bydate', upstream: 'API-Sports', ...over });

    it('two agreeing times confirm (C1) 10 days ahead with no person, no lead time and no stability', () => {
      const a = assess([oddsApi({ changedAt: FAR }), spine({ changedAt: FAR })], { now: FAR });
      expect(a).toMatchObject({ confirmed: true, basis: 'C1', reasons: [], earlier: [] });
    });

    it('times within the tolerance of the start agree; one just outside it does not', () => {
      const within = KICKOFF_TOLERANCE_MS - MINUTE_MS;
      expect(assess([oddsApi({ offset: within }), spine({ offset: -within })]).basis).toBe('C1');
      const out = assess([oddsApi({ offset: KICKOFF_TOLERANCE_MS + MINUTE_MS }), spine()]);
      expect(out.confirmed).toBe(false);
      expect(out.reasons).toContain('sources_disagree');
    });

    it('disagreeing times do not confirm, and the earlier one is an earlier-kickoff statement (K1)', () => {
      const a = assess([oddsApi({ offset: -3 * HOUR_MS }), spine()]);
      expect(a.confirmed).toBe(false);
      expect(a.reasons).toContain('earlier_kickoff_reported');
      expect(a.earlier.map((e) => e.sourceId)).toEqual(['theoddsapi-events-en1']);
      const later = assess([oddsApi({ offset: 3 * HOUR_MS }), spine()]);
      expect(later.confirmed).toBe(false);
      expect(later.reasons).toContain('sources_disagree');
    });

    it('a lone voice still waits far from the kickoff, and one stale voice does not confirm', () => {
      expect(assess([spine()]).reasons).toEqual(['too_early_for_single_source']);
      expect(assess([oddsApi(), spine({ fresh: false })]).confirmed).toBe(false);
    });

    it('several sources of one upstream with the second upstream still count as two', () => {
      const a = assess([
        oddsApi(),
        st({ source: 'theoddsapi-en1', upstream: 'theoddsapi ' }),
        spine(),
      ]);
      expect(countIndependent(a.earlier)).toBe(0);
      expect(a.basis).toBe('C1');
    });
  });

  it('C1 sources sharing an upstream transitively count once', () => {
    const a = assess([
      st({ source: 'a', upstream: 'u1' }),
      st({ source: 'b', upstream: 'u1' }),
      st({ source: 'b', upstream: 'u2' }),
    ]);
    expect(a.confirmed).toBe(false);
  });
});

describe('C2 close and stable', () => {
  const fresh = (changedAt: number) => [st({ changedAt })];

  it('C2 passes at start - 72 h and fails one millisecond before', () => {
    const at = START - KICKOFF_CONFIRM_LEAD_MS;
    expect(assess(fresh(at - 2 * DAY_MS), { now: at })).toMatchObject({
      confirmed: true,
      basis: 'C2',
    });
    const early = assess(fresh(at - 2 * DAY_MS), { now: at - 1 });
    expect(early).toMatchObject({ confirmed: false, basis: null });
    expect(early.reasons).toEqual(['too_early_for_single_source']);
  });

  it('C2 changed_at = now - 24 h passes, one millisecond later fails', () => {
    expect(assess(fresh(NEAR - KICKOFF_STABLE_MS), { now: NEAR }).basis).toBe('C2');
    const unstable = assess(fresh(NEAR - KICKOFF_STABLE_MS + 1), { now: NEAR });
    expect(unstable.confirmed).toBe(false);
    expect(unstable.reasons).toEqual(['not_stable']);
  });

  it('C2 a source whose freshness is unknown or stale (sourceFresh false) does not confirm', () => {
    const a = assess([st({ fresh: false })], { now: NEAR });
    expect(a).toMatchObject({ confirmed: false, basis: null });
    expect(a.reasons).toEqual(['source_not_fresh']);
  });

  it('C2 needs a fresh stable statement; an unstable fresh one next to a stable stale one fails', () => {
    const a = assess(
      [st({ source: 'a', fresh: false }), st({ source: 'b', changedAt: NEAR - HOUR_MS })],
      { now: NEAR },
    );
    expect(a.confirmed).toBe(false);
    expect(a.reasons).toEqual(['not_stable']);
  });

  it('C2 any dissent blocks it', () => {
    for (const dissent of [
      st({ source: 'b', offset: HOUR_MS }),
      st({ source: 'b', offset: -HOUR_MS }),
      st({ source: 'b', status: 'cancelled' }),
      st({ source: 'b', kind: 'result', status: 'finished', offset: -DAY_MS }),
      st({ source: 'b', fresh: false, offset: KICKOFF_TOLERANCE_MS + 1 }),
    ]) {
      expect(assess([st({ source: 'a' }), dissent], { now: NEAR }).confirmed).toBe(false);
    }
  });

  it('C2 a statement that changed in the future is not stable', () => {
    expect(assess(fresh(NEAR + HOUR_MS), { now: NEAR }).reasons).toEqual(['not_stable']);
  });
});

describe('C3 person', () => {
  const dissent = (changedAt: number) =>
    st({ source: 'b', offset: -3 * HOUR_MS, changedAt, fresh: true });

  it('C3 a record for this start confirms with no statements at all', () => {
    expect(assess([], { person: person() })).toMatchObject({
      confirmed: true,
      basis: 'C3',
      reasons: [],
    });
    expect(assess([]).reasons).toEqual(['no_statement']);
  });

  it('C3 every dissenting statement must be acknowledged', () => {
    const changedAt = FAR - HOUR_MS;
    const ack = person({ confirmedAt: new Date(changedAt) });
    expect(assess([dissent(changedAt)], { person: ack })).toMatchObject({
      confirmed: true,
      basis: 'C3',
      earlier: [],
    });
    const late = assess(
      [dissent(changedAt), dissent(changedAt + 1)].map((s, i) => ({
        ...s,
        sourceId: `x${i}`,
      })),
      { person: ack },
    );
    expect(late).toMatchObject({ confirmed: false, basis: null });
    expect(late.earlier).toHaveLength(1);
    expect(late.reasons).toEqual(['earlier_kickoff_reported']);
  });

  it('C3 acknowledged dissent is not listed as a reason', () => {
    const changedAt = FAR - HOUR_MS;
    const ack = person({ confirmedAt: new Date(changedAt) });
    const ackedLater = st({ source: 'c', offset: HOUR_MS, changedAt });
    const newVoid = st({ source: 'd', status: 'postponed', changedAt: changedAt + 5 });
    const a = assess([dissent(changedAt), ackedLater, newVoid], { person: ack });
    expect(a.reasons).toEqual(['void_status_reported']);
  });

  it('C3 a record for another start never confirms (any kickoff move voids it)', () => {
    const moved = person({ startTime: new Date(START - HOUR_MS) });
    expect(assess([], { person: moved }).confirmed).toBe(false);
    expect(assess([], { person: moved }).reasons).toEqual(['no_statement']);
  });

  it('C3 a person record with an invalid date never confirms', () => {
    expect(assess([], { person: person({ confirmedAt: new Date(Number.NaN) }) }).confirmed).toBe(
      false,
    );
    expect(assess([], { person: person({ startTime: new Date(Number.NaN) }) }).confirmed).toBe(
      false,
    );
  });

  it('C1 is reported before C2 before C3 when several hold', () => {
    const two = [st({ source: 'a', changedAt: NEAR - 2 * DAY_MS }), st({ source: 'b' })];
    expect(assess(two, { now: NEAR, person: person() }).basis).toBe('C1');
    expect(assess([two[0]!], { now: NEAR, person: person() }).basis).toBe('C2');
    expect(assess([two[0]!], { now: FAR, person: person() }).basis).toBe('C3');
  });
});

describe('K2 reasons', () => {
  it('K2 no_statement: nothing, or only statements outside the window', () => {
    expect(assess([]).reasons).toEqual(['no_statement']);
  });

  it('K2 earlier_kickoff_reported and sources_disagree: scheduled statements before and after the start', () => {
    expect(assess([st({ offset: -HOUR_MS })]).reasons).toEqual(['earlier_kickoff_reported']);
    expect(assess([st({ offset: HOUR_MS })]).reasons).toEqual(['sources_disagree']);
    expect(
      assess([st({ source: 'a', offset: -HOUR_MS }), st({ source: 'b', offset: HOUR_MS })]).reasons,
    ).toEqual(['earlier_kickoff_reported', 'sources_disagree']);
  });

  it('K2 void_status_reported: a postponed or cancelled fixture', () => {
    expect(assess([st({ status: 'postponed' })]).reasons).toEqual(['void_status_reported']);
    expect(assess([st({ status: 'cancelled', offset: 2 * HOUR_MS })]).reasons).toEqual([
      'void_status_reported',
    ]);
  });

  it('K2 result_reported: any result statement (a finished one, and a void result reports both)', () => {
    expect(assess([st({ kind: 'result', status: 'finished', offset: 0 })]).reasons).toEqual([
      'result_reported',
    ]);
    expect(assess([st({ kind: 'result', status: 'abandoned' })]).reasons).toEqual([
      'result_reported',
      'void_status_reported',
    ]);
  });

  it('K2 source_not_fresh, too_early_for_single_source and not_stable, all that apply, sorted', () => {
    const a = assess([st({ fresh: false })], { now: FAR });
    expect(a.reasons).toEqual(['source_not_fresh', 'too_early_for_single_source']);
    const b = assess([st({ changedAt: FAR })], { now: FAR });
    expect(b.reasons).toEqual(['not_stable', 'too_early_for_single_source']);
    const sorted = [...b.reasons].sort();
    expect(b.reasons).toEqual(sorted);
  });

  it('K2 dissent and the single-source reasons are listed together', () => {
    const a = assess([st({ source: 'a', fresh: false }), st({ source: 'b', offset: -HOUR_MS })], {
      now: FAR,
    });
    expect(a.reasons).toEqual([
      'earlier_kickoff_reported',
      'source_not_fresh',
      'too_early_for_single_source',
    ]);
  });

  it('K2 a confirmed kickoff has no reasons', () => {
    expect(assess([st({ source: 'a' }), st({ source: 'b' })]).reasons).toEqual([]);
  });

  it('K2 a statement with an invalid kickoff cannot be placed: it dissents', () => {
    const bad = { ...st({ source: 'b' }), kickoff: new Date(Number.NaN) };
    const a = assess([st({ source: 'a' }), bad], { now: NEAR });
    expect(a.confirmed).toBe(false);
    expect(a.reasons).toContain('sources_disagree');
    expect(a.earlier).toEqual([]);
    expect(() => kickoffEvidenceKey(new Date(START), [bad])).not.toThrow();
  });

  it('rejects an invalid start or now (programmer errors)', () => {
    expect(() => assess([], { start: Number.NaN })).toThrow(RangeError);
    expect(() => assess([], { now: Number.NaN })).toThrow(RangeError);
  });
});

describe('K2 evidence key', () => {
  const base = [
    st({ source: 'a', changedAt: START - DAY_MS }),
    st({ source: 'b', offset: -HOUR_MS }),
  ];
  const key = (statements: readonly KickoffStatement[], start = START) =>
    kickoffEvidenceKey(new Date(start), statements);

  it('is SHA-256 hex of the canonical JSON [startISO, [[sourceId, kind, status, kickoffISO, changedAtISO]]]', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          new Date(START).toISOString(),
          base.map((s) => [
            s.sourceId,
            s.kind,
            s.status,
            s.kickoff.toISOString(),
            s.changedAt.toISOString(),
          ]),
        ]),
      )
      .digest('hex');
    expect(key(base)).toBe(expected);
    expect(key(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(assess(base).evidenceKey).toBe(expected);
  });

  it('changes with the start and with any field of any statement', () => {
    const k = key(base);
    const first = base[0]!;
    const variants: KickoffStatement[] = [
      { ...first, sourceId: 'z' },
      { ...first, kind: 'result', status: 'finished' },
      { ...first, status: 'postponed' },
      { ...first, kickoff: new Date(first.kickoff.getTime() + 1) },
      { ...first, changedAt: new Date(first.changedAt.getTime() + 1) },
    ];
    for (const variant of variants) {
      expect(key([variant, base[1]!]), JSON.stringify(variant)).not.toBe(k);
    }
    expect(key(base, START + 1)).not.toBe(k);
    expect(key([...base, st({ source: 'c' })])).not.toBe(k);
    expect(key([])).not.toBe(k);
  });

  it('does not change with the statement order, upstream or freshness', () => {
    const k = key(base);
    expect(key([...base].reverse())).toBe(k);
    expect(key(base.map((s) => ({ ...s, upstream: 'other', sourceFresh: !s.sourceFresh })))).toBe(
      k,
    );
  });

  it('does not depend on statements outside the window (they are not statements)', () => {
    const outside = st({ source: 'z', offset: -KICKOFF_EVIDENCE_WINDOW_MS - 1 });
    expect(assess([...base, outside]).evidenceKey).toBe(assess(base).evidenceKey);
  });
});

// ---------------------------------------------------------------------------
// Properties P1 to P9 (docs/scraper-plan/kickoff-safety.md 7.2)

const SOURCES = ['s1', 's2', 's3', 's4'] as const;
const UPSTREAMS = ['u1', 'U1 ', ' u2', 'u3', 'u1'] as const;
const OFFSETS = [
  0,
  MINUTE_MS,
  -MINUTE_MS,
  KICKOFF_TOLERANCE_MS,
  -KICKOFF_TOLERANCE_MS,
  KICKOFF_TOLERANCE_MS + 1,
  -KICKOFF_TOLERANCE_MS - 1,
  HOUR_MS,
  -HOUR_MS,
  -19 * HOUR_MS,
  3 * DAY_MS,
  -3 * DAY_MS,
  KICKOFF_EVIDENCE_WINDOW_MS,
  -KICKOFF_EVIDENCE_WINDOW_MS,
  KICKOFF_EVIDENCE_WINDOW_MS + 1,
  -KICKOFF_EVIDENCE_WINDOW_MS - 1,
] as const;
const CHANGED_AGO = [
  0,
  HOUR_MS,
  KICKOFF_STABLE_MS - 1,
  KICKOFF_STABLE_MS,
  5 * DAY_MS,
  -HOUR_MS,
] as const;
const NOW_OFFSETS = [
  -10 * DAY_MS,
  -KICKOFF_CONFIRM_LEAD_MS - 1,
  -KICKOFF_CONFIRM_LEAD_MS,
  -48 * HOUR_MS,
  -DAY_MS,
  -HOUR_MS,
] as const;

const statementArb: fc.Arbitrary<KickoffStatement> = fc
  .record({
    sourceId: fc.constantFrom(...SOURCES),
    upstream: fc.constantFrom(...UPSTREAMS),
    kind: fc.constantFrom('fixture', 'fixture', 'fixture', 'result'),
    fixtureStatus: fc.constantFrom('scheduled', 'scheduled', 'scheduled', 'postponed', 'cancelled'),
    resultStatus: fc.constantFrom('finished', 'finished', 'postponed', 'cancelled', 'abandoned'),
    offset: fc.constantFrom(...OFFSETS),
    changedAgo: fc.constantFrom(...CHANGED_AGO),
    fresh: fc.boolean(),
  })
  .map((r) => ({
    sourceId: r.sourceId,
    upstream: r.upstream,
    kind: r.kind,
    status: r.kind === 'fixture' ? r.fixtureStatus : r.resultStatus,
    kickoff: new Date(START + r.offset),
    // changedAt is relative to the evaluation time `NEAR` used by the properties' fixed-now cases.
    changedAt: new Date(NEAR - r.changedAgo),
    sourceFresh: r.fresh,
  }));
/** A statement that agrees with the start (a scheduled fixture within the tolerance). */
const agreeingArb: fc.Arbitrary<KickoffStatement> = fc
  .tuple(
    statementArb,
    fc.constantFrom(0, MINUTE_MS, -KICKOFF_TOLERANCE_MS, KICKOFF_TOLERANCE_MS),
    fc.boolean(),
  )
  .map(([s, offset, fresh]) => ({
    ...s,
    kind: 'fixture' as const,
    status: 'scheduled' as const,
    kickoff: new Date(START + offset),
    sourceFresh: fresh || s.sourceFresh,
  }));
// Most of the mass on sets that can confirm, so the properties meet C1, C2 and C3 often.
const statementsArb = fc.oneof(
  { weight: 3, arbitrary: fc.array(agreeingArb, { maxLength: 4 }) },
  { weight: 3, arbitrary: fc.array(fc.oneof(agreeingArb, statementArb), { maxLength: 6 }) },
  { weight: 1, arbitrary: fc.array(statementArb, { maxLength: 6 }) },
);
const nowArb = fc.constantFrom(...NOW_OFFSETS).map((o) => START + o);
const personArb: fc.Arbitrary<KickoffPersonRecord | null> = fc.oneof(
  fc.constant(null),
  fc
    .record({
      startOff: fc.constantFrom(0, 0, 0, 1, -HOUR_MS),
      confirmedAgo: fc.constantFrom(...CHANGED_AGO),
    })
    .map((r) => ({
      startTime: new Date(START + r.startOff),
      confirmedAt: new Date(NEAR - r.confirmedAgo),
      evidenceKey: 'b'.repeat(64),
    })),
);
const inputArb = fc.record({ statements: statementsArb, now: nowArb, person: personArb });

const NUM_RUNS = 600;

/** Independent restatement of "agreeing" (a scheduled fixture within the tolerance). */
const agrees = (s: KickoffStatement): boolean =>
  s.kind === 'fixture' &&
  s.status === 'scheduled' &&
  Math.abs(s.kickoff.getTime() - START) <= KICKOFF_TOLERANCE_MS;

const run = (
  statements: readonly KickoffStatement[],
  now: number,
  p: KickoffPersonRecord | null,
): KickoffAssessment => assess(statements, { now, person: p });

describe('properties', () => {
  it('P1 never opens: the action is none or close, and close needs open betting', () => {
    const eventArb = fc.record({
      status: fc.constantFrom(
        'scheduled',
        'live',
        'finished',
        'cancelled',
        'postponed',
        'abandoned',
      ),
      bettingOpen: fc.boolean(),
      startOff: fc.constantFrom(-DAY_MS, 0, 1, DAY_MS),
      resulted: fc.boolean(),
    });
    fc.assert(
      fc.property(inputArb, eventArb, ({ statements, now, person: p }, e) => {
        const a = run(statements, now, p);
        const event = makeEvent({
          status: e.status,
          bettingOpen: e.bettingOpen,
          startTime: new Date(now + e.startOff),
          resultedAt: e.resulted ? new Date(now) : null,
        });
        const action = earlierKickoffAction(event, a, new Date(now));
        expect(['none', 'close']).toContain(action);
        if (action === 'close') {
          expect(event.bettingOpen).toBe(true);
          expect(event.status).toBe('scheduled');
          expect(a.earlier.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P2 closing is monotone in evidence: close(S) implies close(S + o)', () => {
    const closes = (
      statements: readonly KickoffStatement[],
      now: number,
      p: KickoffPersonRecord | null,
    ) =>
      earlierKickoffAction(
        makeEvent({ bettingOpen: true, startTime: new Date(START) }),
        run(statements, now, p),
        new Date(now),
      ) === 'close';
    let closed = 0;
    fc.assert(
      fc.property(inputArb, statementArb, ({ statements, now, person: p }, o) => {
        if (closes(statements, now, p)) {
          closed++;
          expect(closes([...statements, o], now, p)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(closed).toBeGreaterThan(20);
  });

  it('P3 confirmation is anti-monotone in dissent: o not agreeing, confirmed(S + o) implies confirmed(S)', () => {
    let confirmedWith = 0;
    fc.assert(
      fc.property(inputArb, statementArb, ({ statements, now, person: p }, o) => {
        fc.pre(!agrees(o));
        if (run([...statements, o], now, p).confirmed) {
          confirmedWith++;
          expect(run(statements, now, p).confirmed).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS * 3 },
    );
    expect(confirmedWith).toBeGreaterThan(5);
  });

  it('P4 one upstream needs the lead or a person', () => {
    let confirmed = 0;
    fc.assert(
      fc.property(inputArb, ({ statements, now, person: p }) => {
        const voices = statements.filter(agrees).map((s) => ({
          sourceId: s.sourceId,
          upstream: s.upstream,
        }));
        fc.pre(countIndependent(voices) < 2);
        const a = run(statements, now, p);
        if (a.confirmed) {
          confirmed++;
          expect(now >= START - KICKOFF_CONFIRM_LEAD_MS || a.basis === 'C3').toBe(true);
        }
      }),
      { numRuns: NUM_RUNS * 2 },
    );
    expect(confirmed).toBeGreaterThan(10);
  });

  it('P5 independence: a copy under another source id with the same upstream never changes confirmed', () => {
    fc.assert(
      fc.property(inputArb, fc.nat(5), ({ statements, now, person: p }, index) => {
        fc.pre(statements.length > 0);
        const original = statements[index % statements.length]!;
        const copy: KickoffStatement = {
          ...original,
          sourceId: 'copy-of-source',
          upstream: ` ${original.upstream.toUpperCase()}  `,
        };
        expect(run([...statements, copy], now, p).confirmed).toBe(
          run(statements, now, p).confirmed,
        );
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });

  it('P6 tolerance: a statement within KICKOFF_TOLERANCE_MS of the start is never earlier', () => {
    fc.assert(
      fc.property(inputArb, statementArb, ({ statements, now, person: p }, o) => {
        const near: KickoffStatement = {
          ...o,
          kickoff: new Date(
            START + (o.kickoff.getTime() % (2 * KICKOFF_TOLERANCE_MS + 1)) - KICKOFF_TOLERANCE_MS,
          ),
        };
        expect(Math.abs(near.kickoff.getTime() - START)).toBeLessThanOrEqual(KICKOFF_TOLERANCE_MS);
        expect(run([...statements, near], now, p).earlier).not.toContain(near);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P7 acknowledgement: a record for another start is ignored; for this start it silences what it saw', () => {
    fc.assert(
      fc.property(inputArb, ({ statements, now, person: p }) => {
        fc.pre(p !== null);
        const other: KickoffPersonRecord = {
          ...p,
          startTime: new Date(START + (p.startTime.getTime() === START ? 1 : 0)),
        };
        fc.pre(other.startTime.getTime() !== START);
        expect(run(statements, now, other)).toEqual(run(statements, now, null));
        const mine: KickoffPersonRecord = { ...p, startTime: new Date(START) };
        const a = run(statements, now, mine);
        for (const s of a.earlier) {
          expect(s.changedAt.getTime()).toBeGreaterThan(mine.confirmedAt.getTime());
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P8 order: permuting the statements changes nothing, the evidence key included', () => {
    fc.assert(
      fc.property(
        inputArb.chain((i) =>
          fc.tuple(
            fc.constant(i),
            fc.shuffledSubarray(i.statements, { minLength: i.statements.length }),
          ),
        ),
        ([{ statements, now, person: p }, shuffled]) => {
          expect(run(shuffled, now, p)).toEqual(run(statements, now, p));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P9 freshness: with no fresh agreeing statement the basis is never C1 or C2', () => {
    fc.assert(
      fc.property(inputArb, ({ statements, now, person: p }) => {
        fc.pre(!statements.some((s) => agrees(s) && s.sourceFresh));
        expect(['C1', 'C2']).not.toContain(run(statements, now, p).basis);
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });

  it('confirmed, basis and reasons agree: reasons are empty exactly when confirmed, and sorted', () => {
    const seen = { C1: 0, C2: 0, C3: 0, none: 0 };
    fc.assert(
      fc.property(inputArb, ({ statements, now, person: p }) => {
        const a = run(statements, now, p);
        expect(a.confirmed).toBe(a.basis !== null);
        expect(a.reasons.length === 0).toBe(a.confirmed);
        expect([...a.reasons].sort()).toEqual([...a.reasons]);
        expect(a.evidenceKey).toMatch(/^[0-9a-f]{64}$/);
        seen[a.basis ?? 'none']++;
      }),
      { numRuns: NUM_RUNS * 2 },
    );
    expect(seen.C1).toBeGreaterThan(0);
    expect(seen.C2).toBeGreaterThan(0);
    expect(seen.C3).toBeGreaterThan(0);
    expect(seen.none).toBeGreaterThan(0);
  });
});
