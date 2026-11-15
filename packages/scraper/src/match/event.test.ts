import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, KICKOFF_TOLERANCE_MS, MATCH_WINDOW_MS, MINUTE_MS } from '../constants';
import type { ExistingEvent, ScrapedEventStatus } from '../types';
import { kickoffSpread, matchEvent, sameKickoff } from './event';

const T0 = Date.UTC(2025, 7, 16, 14, 0, 0);

const cluster = (first = T0, last = first) => ({
  competitionId: 'c1',
  homeTeamId: 'a',
  awayTeamId: 'b',
  firstKickoff: new Date(first),
  lastKickoff: new Date(last),
});

function event(over: Partial<ExistingEvent> & { eventId: string }): ExistingEvent {
  return {
    feedRef: `fx|c1|a|b|2025-08-16|${over.eventId}`,
    competitionId: 'c1',
    homeTeamId: 'a',
    awayTeamId: 'b',
    startTime: new Date(T0),
    status: 'scheduled',
    bettingOpen: false,
    hasBets: false,
    needsHalfTimeScore: false,
    resultedAt: null,
    score: null,
    ...over,
  };
}

describe('F3 matchEvent', () => {
  it('F3 none -> new', () => {
    expect(matchEvent(cluster(), [])).toEqual({ kind: 'new' });
  });

  it('F3 exactly one -> existing, even when rescheduled (feed_ref is kept)', () => {
    const e = event({ eventId: 'e1', startTime: new Date(T0 - 20 * DAY_MS) });
    expect(matchEvent(cluster(), [e])).toEqual({ kind: 'existing', event: e });
    const e2 = event({ eventId: 'e2', startTime: new Date(T0 + 3 * DAY_MS) });
    expect(matchEvent(cluster(), [e2])).toEqual({ kind: 'existing', event: e2 });
  });

  it('F3 outside the window -> new (the same pairing months later is another fixture)', () => {
    const far = event({ eventId: 'e1', startTime: new Date(T0 + MATCH_WINDOW_MS + 1) });
    expect(matchEvent(cluster(), [far])).toEqual({ kind: 'new' });
    const edge = event({ eventId: 'e2', startTime: new Date(T0 + MATCH_WINDOW_MS) });
    expect(matchEvent(cluster(), [edge]).kind).toBe('existing');
  });

  it('F3 the window is measured from the whole kickoff range of the cluster', () => {
    const e = event({ eventId: 'e1', startTime: new Date(T0 + 30 * DAY_MS + 40 * DAY_MS) });
    expect(matchEvent(cluster(T0, T0 + 30 * DAY_MS), [e]).kind).toBe('existing');
    expect(matchEvent(cluster(T0, T0), [e]).kind).toBe('new');
  });

  it('F3 double round-robin: the reverse fixture is never a candidate', () => {
    const reverse = event({
      eventId: 'r',
      homeTeamId: 'b',
      awayTeamId: 'a',
      startTime: new Date(T0),
    });
    expect(matchEvent(cluster(), [reverse])).toEqual({ kind: 'new' });
  });

  it('F3 two-legged cup: each leg finds only its own event', () => {
    const leg1 = event({ eventId: 'l1', competitionId: 'cup', startTime: new Date(T0) });
    const leg2 = event({
      eventId: 'l2',
      competitionId: 'cup',
      homeTeamId: 'b',
      awayTeamId: 'a',
      startTime: new Date(T0 + 7 * DAY_MS),
    });
    const c1 = { ...cluster(), competitionId: 'cup' };
    const c2 = {
      ...cluster(T0 + 7 * DAY_MS),
      competitionId: 'cup',
      homeTeamId: 'b',
      awayTeamId: 'a',
    };
    expect(matchEvent(c1, [leg1, leg2])).toEqual({ kind: 'existing', event: leg1 });
    expect(matchEvent(c2, [leg1, leg2])).toEqual({ kind: 'existing', event: leg2 });
  });

  it('F3 other competitions or teams do not match', () => {
    expect(matchEvent(cluster(), [event({ eventId: 'e1', competitionId: 'c2' })])).toEqual({
      kind: 'new',
    });
    expect(matchEvent(cluster(), [event({ eventId: 'e1', homeTeamId: 'z' })])).toEqual({
      kind: 'new',
    });
    expect(matchEvent(cluster(), [event({ eventId: 'e1', awayTeamId: 'z' })])).toEqual({
      kind: 'new',
    });
  });

  it('F3 several candidates -> ambiguous, never the nearest; candidates sorted', () => {
    const near = event({ eventId: 'z-near', startTime: new Date(T0 + MINUTE_MS) });
    const far = event({ eventId: 'a-far', startTime: new Date(T0 + 20 * DAY_MS) });
    const r = matchEvent(cluster(), [far, near]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous')
      expect(r.candidates.map((e) => e.eventId)).toEqual(['z-near', 'a-far']);
  });

  it('F3 the same event listed twice is one candidate', () => {
    const e = event({ eventId: 'e1' });
    expect(matchEvent(cluster(), [e, { ...e }])).toEqual({ kind: 'existing', event: e });
  });

  it.each<ScrapedEventStatus>(['live', 'finished', 'cancelled', 'postponed', 'abandoned'])(
    'F3 a %s event still counts and is returned as-is (never re-created)',
    (status) => {
      const e = event({ eventId: 'e1', status, resultedAt: new Date(T0), hasBets: true });
      expect(matchEvent(cluster(), [e])).toEqual({ kind: 'existing', event: e });
    },
  );

  it('F3 a finished and a scheduled event of the pair are ambiguous', () => {
    const done = event({
      eventId: 'e1',
      status: 'finished',
      startTime: new Date(T0 - 30 * DAY_MS),
    });
    const next = event({ eventId: 'e2' });
    expect(matchEvent(cluster(), [done, next]).kind).toBe('ambiguous');
  });

  it('F3 custom window and bad arguments', () => {
    const e = event({ eventId: 'e1', startTime: new Date(T0 + 2 * DAY_MS) });
    expect(matchEvent(cluster(), [e], DAY_MS)).toEqual({ kind: 'new' });
    expect(() => matchEvent(cluster(), [e], -1)).toThrow(RangeError);
    expect(() => matchEvent(cluster(Number.NaN), [e])).toThrow(RangeError);
  });

  it('F3 property: the result matches a naive count of candidates, whatever the order', () => {
    const ev = fc.record({
      id: fc.integer({ min: 0, max: 5 }),
      home: fc.constantFrom('a', 'b'),
      away: fc.constantFrom('b', 'a'),
      days: fc.integer({ min: -100, max: 100 }),
    });
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 8 }), (rows) => {
        const events = rows.map((r) =>
          event({
            eventId: `e${r.id}`,
            homeTeamId: r.home,
            awayTeamId: r.away,
            startTime: new Date(T0 + r.days * DAY_MS),
          }),
        );
        const expected = new Set(
          events
            .filter(
              (e) =>
                e.homeTeamId === 'a' &&
                e.awayTeamId === 'b' &&
                Math.abs(e.startTime.getTime() - T0) <= MATCH_WINDOW_MS,
            )
            .map((e) => e.eventId),
        );
        const r = matchEvent(cluster(), events);
        if (expected.size === 0) expect(r.kind).toBe('new');
        else if (expected.size === 1) expect(r.kind).toBe('existing');
        else expect(r.kind).toBe('ambiguous');
        if (r.kind === 'ambiguous')
          expect(new Set(r.candidates.map((e) => e.eventId))).toEqual(expected);
        const reversed = matchEvent(cluster(), [...events].reverse());
        expect(reversed.kind).toBe(r.kind);
      }),
      { numRuns: 300 },
    );
  });
});

describe('F2 sameKickoff / kickoffSpread', () => {
  it('F2 sameKickoff is inclusive of the tolerance and symmetric', () => {
    const a = new Date(T0);
    expect(sameKickoff(a, new Date(T0 + KICKOFF_TOLERANCE_MS))).toBe(true);
    expect(sameKickoff(new Date(T0 + KICKOFF_TOLERANCE_MS), a)).toBe(true);
    expect(sameKickoff(a, new Date(T0 + KICKOFF_TOLERANCE_MS + 1))).toBe(false);
    expect(sameKickoff(a, new Date(T0 - KICKOFF_TOLERANCE_MS - 1))).toBe(false);
    expect(sameKickoff(a, new Date(T0 + 60_000), 0)).toBe(false);
    expect(sameKickoff(a, new Date(Number.NaN))).toBe(false);
  });

  it('F2 kickoffSpread', () => {
    expect(kickoffSpread([])).toBe(0);
    expect(kickoffSpread([new Date(T0)])).toBe(0);
    expect(
      kickoffSpread([new Date(T0), new Date(T0 + 7 * MINUTE_MS), new Date(T0 + MINUTE_MS)]),
    ).toBe(7 * MINUTE_MS);
    expect(kickoffSpread([new Date(T0), new Date(Number.NaN)])).toBe(Number.POSITIVE_INFINITY);
  });

  it('F2 property: spread is order independent and bounds every pair', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1e12 }), { minLength: 1, maxLength: 10 }),
        (ms) => {
          const dates = ms.map((m) => new Date(m));
          const spread = kickoffSpread(dates);
          expect(kickoffSpread([...dates].reverse())).toBe(spread);
          for (const x of dates)
            for (const y of dates)
              expect(Math.abs(x.getTime() - y.getTime())).toBeLessThanOrEqual(spread);
          expect(sameKickoff(new Date(Math.min(...ms)), new Date(Math.max(...ms)), spread)).toBe(
            true,
          );
        },
      ),
    );
  });
});
