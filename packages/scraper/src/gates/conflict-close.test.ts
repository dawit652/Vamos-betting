import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MATCH_WINDOW_MS } from '../constants';
import type { ExistingEvent, FixtureObservation, ResolvedObservation } from '../types';
import {
  agreedPassesOf,
  agreementCovers,
  CONFLICT_AGREED_PASSES,
  CONFLICT_AGREED_RESOLUTION,
  conflictClosesOnAgreement,
  nextConflictStep,
  sourcesAgree,
  type FixtureAgreement,
} from './conflict-close';
import { decideFixture, holdSeveralClusters, type FixtureDecision } from './fixture';
import { buildReviews, fixtureFeedRef, parseFixtureFeedRef, reviewsOf } from './review';
import { FEED_REF, fixtureObs, KICKOFF, makeEvent, makePolicy, NAMES } from './testkit';

const NOW = KICKOFF - 3 * DAY_MS;

function decide(
  observations: readonly ResolvedObservation<FixtureObservation>[],
  opts: { candidates?: ExistingEvent[]; enabled?: boolean; now?: number } = {},
): FixtureDecision {
  return decideFixture({
    observations,
    candidates: opts.candidates ?? [],
    policy: makePolicy({ enabled: opts.enabled ?? true }),
    now: new Date(opts.now ?? NOW),
    calibrated: true,
    pricesSane: true,
    kickoffConfirmed: true,
  });
}
const at = (source: string, offset = 0, status: FixtureObservation['status'] = 'scheduled') =>
  fixtureObs({ source, kickoff: KICKOFF + offset, status });
/** The payload of the decision's fixture_conflict, as the runner stores it. */
const conflictPayload = (decision: FixtureDecision) => {
  const review = reviewsOf(decision).find((r) => r.kind === 'fixture_conflict');
  if (review === undefined) throw new Error('no fixture_conflict');
  return review.payload;
};
const payloadOf = (reasons: string[], extra: Record<string, unknown> = {}) => ({
  detail: 'Sources disagree about a fixture',
  rules: ['F6'],
  reasons,
  ...extra,
});
const agreement = (over: Partial<FixtureAgreement> = {}): FixtureAgreement => ({
  ...NAMES,
  firstKickoff: new Date(KICKOFF),
  lastKickoff: new Date(KICKOFF),
  feedRefs: [FEED_REF],
  ...over,
});

describe('F6c which fixture conflicts may close by themselves', () => {
  it('the conflicts the gate raises for source disagreement qualify', () => {
    const status = decide([at('a'), at('b', 0, 'postponed')]);
    expect(conflictPayload(status).reasons).toEqual(['status_disagreement']);
    expect(conflictClosesOnAgreement(conflictPayload(status))).toBe(true);

    const kickoff = decide([at('a'), at('b', 2 * HOUR_MS)]);
    expect(conflictPayload(kickoff).reasons).toEqual(['kickoff_disagreement']);
    expect(conflictClosesOnAgreement(conflictPayload(kickoff))).toBe(true);

    const several = holdSeveralClusters({
      pairing: NAMES,
      clusters: [[at('a')], [at('b', 3 * DAY_MS)]],
    });
    expect(conflictPayload(several).reasons).toEqual(['sources_disagree']);
    expect(conflictClosesOnAgreement(conflictPayload(several))).toBe(true);
  });

  it('feed_ref_exists and the other person-only reasons never qualify', () => {
    const [taken] = buildReviews(
      FEED_REF,
      [{ kind: 'fixture_conflict', rule: 'F3', reason: 'feed_ref_exists' }],
      () => ({ feedRef: FEED_REF }),
    );
    expect(conflictClosesOnAgreement(taken!.payload)).toBe(false);

    const ambiguous = decide([at('a')], {
      candidates: [makeEvent(), makeEvent({ eventId: 'ev-2', feedRef: `${FEED_REF}x` })],
    });
    expect(conflictPayload(ambiguous).reasons).toEqual(['ambiguous_match']);
    expect(conflictClosesOnAgreement(conflictPayload(ambiguous))).toBe(false);

    const mixed = decide([at('a'), fixtureObs({ source: 'b', names: { awayTeamId: 'other' } })]);
    expect(conflictPayload(mixed).reasons).toEqual(['mixed_cluster']);
    expect(conflictClosesOnAgreement(conflictPayload(mixed))).toBe(false);

    for (const reasons of [
      ['feed_ref_exists'],
      ['status_disagreement', 'feed_ref_exists'],
      ['candidate_mismatch'],
      ['invalid_observation'],
      [],
    ]) {
      expect(conflictClosesOnAgreement(payloadOf(reasons))).toBe(false);
    }
    for (const payload of [null, undefined, 'x', 3, {}, { reasons: 'status_disagreement' }]) {
      expect(conflictClosesOnAgreement(payload)).toBe(false);
    }
  });
});

describe('F6c what counts as the sources agreeing', () => {
  it('a creation, a kickoff move, an unchanged event and a shadow-mode fixture agree', () => {
    expect(decide([at('a'), at('b')]).action).toBe('create');
    expect(sourcesAgree(decide([at('a'), at('b')]))).toBe(true);

    const shadow = decide([at('a'), at('b')], { enabled: false });
    expect(shadow).toEqual({ action: 'none', reason: 'policy_disabled' });
    expect(sourcesAgree(shadow)).toBe(true);

    const unchanged = decide([at('a'), at('b')], { candidates: [makeEvent()] });
    expect(unchanged).toEqual({ action: 'none', reason: 'unchanged' });
    expect(sourcesAgree(unchanged)).toBe(true);

    const moved = decide([at('a', HOUR_MS), at('b', HOUR_MS)], { candidates: [makeEvent()] });
    expect(moved.action).toBe('update-kickoff');
    expect(sourcesAgree(moved)).toBe(true);
  });

  it('a hold, and nothing decided for another reason, do not agree', () => {
    const notAgreeing: FixtureDecision[] = [
      decide([at('a'), at('b', 0, 'postponed')]),
      decide([at('a'), at('b', 2 * HOUR_MS)]),
      decide([at('a', HOUR_MS), at('b')], { candidates: [makeEvent()] }),
      decide([at('a', 0, 'postponed')], { candidates: [makeEvent()] }),
      decide([]),
      decide([at('a'), at('b')], { now: KICKOFF + HOUR_MS }),
      decide([at('a', 0, 'postponed'), at('b', 0, 'cancelled')]),
      decide([at('a')], { candidates: [makeEvent({ status: 'finished' })] }),
    ];
    expect(notAgreeing.map((d) => (d.action === 'none' ? d.reason : d.action))).toEqual([
      'hold',
      'hold',
      'hold',
      'hold',
      'no_observations',
      'outside_window',
      'not_scheduled',
      'event_closed',
    ]);
    for (const decision of notAgreeing) expect(sourcesAgree(decision)).toBe(false);
  });
});

describe('F6c which conflicts an agreeing cluster answers', () => {
  it('its own feed refs, whatever their form', () => {
    expect(
      agreementCovers(agreement({ feedRefs: ['not-a-fixture-key'] }), 'not-a-fixture-key'),
    ).toBe(true);
    expect(agreementCovers(agreement(), FEED_REF)).toBe(true);
  });

  it('a fixture key of the same pairing on another day within MATCH_WINDOW_MS', () => {
    const later = agreement({
      firstKickoff: new Date(KICKOFF + DAY_MS),
      lastKickoff: new Date(KICKOFF + DAY_MS),
      feedRefs: [fixtureFeedRef(NAMES, new Date(KICKOFF + DAY_MS))],
    });
    expect(agreementCovers(later, FEED_REF)).toBe(true);
    const dayOf = (ms: number) => fixtureFeedRef(NAMES, new Date(ms));
    const start = Date.parse('2026-11-01T00:00:00Z');
    const edge = agreement({
      firstKickoff: new Date(start + DAY_MS - 1 + MATCH_WINDOW_MS),
      lastKickoff: new Date(start + DAY_MS - 1 + MATCH_WINDOW_MS),
      feedRefs: [],
    });
    expect(agreementCovers(edge, dayOf(start))).toBe(true);
    expect(
      agreementCovers(
        {
          ...edge,
          firstKickoff: new Date(edge.firstKickoff.getTime() + 1),
          lastKickoff: new Date(edge.lastKickoff.getTime() + 1),
        },
        dayOf(start),
      ),
    ).toBe(false);
  });

  it('never another pairing, the reversed pairing, or an unreadable key', () => {
    const a = agreement({ feedRefs: [] });
    expect(agreementCovers(a, FEED_REF.replace('comp-1', 'comp-2'))).toBe(false);
    expect(
      agreementCovers(
        a,
        fixtureFeedRef(
          { ...NAMES, homeTeamId: NAMES.awayTeamId, awayTeamId: NAMES.homeTeamId },
          new Date(KICKOFF),
        ),
      ),
    ).toBe(false);
    for (const key of ['fx|comp-1|team-h|team-a|unknown', 'fx|comp-1|team-h|team-a', '']) {
      expect(agreementCovers(a, key)).toBe(false);
    }
    expect(agreementCovers({ ...a, firstKickoff: new Date(Number.NaN) }, FEED_REF)).toBe(false);
  });

  it('parseFixtureFeedRef is strict and gives fixtureFeedRef back', () => {
    expect(parseFixtureFeedRef(FEED_REF)).toEqual({
      pairing: { competitionId: 'comp-1', homeTeamId: 'team-h', awayTeamId: 'team-a' },
      day: new Date('2026-11-01T00:00:00Z'),
    });
    for (const key of [
      'fx|comp-1|team-h|team-a|2026-02-30',
      'fx|comp-1|team-h|team-a|2026-11-1',
      'fx||team-h|team-a|2026-11-01',
      'fx|comp|1|team-h|team-a|2026-11-01',
      'ev|comp-1|team-h|team-a|2026-11-01',
    ]) {
      expect(parseFixtureFeedRef(key)).toBeNull();
    }
    const id = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
    fc.assert(
      fc.property(
        id,
        id,
        id,
        fc.integer({ min: Date.parse('2000-01-01'), max: Date.parse('2100-01-01') }),
        (competitionId, homeTeamId, awayTeamId, ms) => {
          const pairing = { competitionId, homeTeamId, awayTeamId };
          const key = fixtureFeedRef(pairing, new Date(ms));
          const parsed = parseFixtureFeedRef(key);
          expect(parsed?.pairing).toEqual(pairing);
          expect(fixtureFeedRef(parsed!.pairing, parsed!.day)).toBe(key);
        },
      ),
    );
  });
});

describe('F6c the streak', () => {
  const conflict = payloadOf(['status_disagreement']);

  it('one agreeing pass counts, the second closes', () => {
    expect(CONFLICT_AGREED_PASSES).toBe(2);
    expect(CONFLICT_AGREED_RESOLUTION).toBe('auto: sources agree again (2 passes)');
    expect(nextConflictStep(conflict, true)).toEqual({ action: 'count', agreedPasses: 1 });
    expect(nextConflictStep({ ...conflict, agreedPasses: 1 }, true)).toEqual({
      action: 'close',
      agreedPasses: 2,
    });
  });

  it('a pass that does not agree resets a streak, and writes nothing without one', () => {
    expect(nextConflictStep({ ...conflict, agreedPasses: 1 }, false)).toEqual({
      action: 'reset',
      agreedPasses: 0,
    });
    expect(nextConflictStep(conflict, false)).toEqual({ action: 'keep' });
    expect(nextConflictStep({ ...conflict, agreedPasses: 0 }, false)).toEqual({ action: 'keep' });
  });

  it('a person-only conflict is never counted or closed', () => {
    const taken = payloadOf(['feed_ref_exists'], { agreedPasses: 5 });
    expect(nextConflictStep(taken, true)).toEqual({ action: 'keep' });
    expect(nextConflictStep(taken, false)).toEqual({ action: 'keep' });
  });

  it('a malformed counter counts as 0', () => {
    for (const agreedPasses of [-1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agreedPassesOf({ ...conflict, agreedPasses })).toBe(0);
      expect(nextConflictStep({ ...conflict, agreedPasses }, true)).toEqual({
        action: 'count',
        agreedPasses: 1,
      });
    }
  });

  it('property: the item closes exactly at the second consecutive agreeing pass since it was last raised', () => {
    type Pass = 'raised' | 'agree' | 'other';
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Pass>('raised', 'agree', 'other'), { maxLength: 30 }),
        (passes) => {
          // The runner: raising refreshes the item (payload replaced, no counter).
          let payload: Record<string, unknown> = conflict;
          let closedAt: number | null = null;
          for (const [i, pass] of passes.entries()) {
            if (pass === 'raised') {
              payload = { ...conflict };
              continue;
            }
            const step = nextConflictStep(payload, pass === 'agree');
            if (step.action === 'close') {
              closedAt = i;
              break;
            }
            if (step.action !== 'keep') payload = { ...payload, agreedPasses: step.agreedPasses };
          }
          const expected = passes.findIndex(
            (pass, i) => pass === 'agree' && i > 0 && passes[i - 1] === 'agree',
          );
          expect(closedAt).toBe(expected === -1 ? null : expected);
        },
      ),
    );
  });
});
