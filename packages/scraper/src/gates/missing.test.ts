import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, MISSING_AFTER_MS } from '../constants';
import type { ExistingEvent } from '../types';
import { findMissingFixtures, type MissingCheckInput } from './missing';
import { FEED_REF, KICKOFF, makeEvent } from './testkit';

const NOW = KICKOFF - 24 * HOUR_MS;
const item = (
  lastListedAt: number | null,
  over: Partial<ExistingEvent> = {},
): MissingCheckInput => ({
  event: makeEvent(over),
  lastListedAt: lastListedAt === null ? null : new Date(lastListedAt),
});

describe('F5 absence never cancels', () => {
  it('flags at exactly MISSING_AFTER_MS, not one millisecond before', () => {
    expect(findMissingFixtures([item(NOW - MISSING_AFTER_MS + 1)], new Date(NOW))).toEqual([]);
    const [flag, ...rest] = findMissingFixtures([item(NOW - MISSING_AFTER_MS)], new Date(NOW));
    expect(rest).toEqual([]);
    expect(flag).toMatchObject({
      eventId: 'ev-1',
      feedRef: FEED_REF,
      review: {
        kind: 'fixture_missing',
        subjectKey: FEED_REF,
        payload: { reasons: ['not_listed'], rules: ['F5'], missingForMs: MISSING_AFTER_MS },
      },
    });
  });

  it('a fixture never listed, or with an unreadable listing time, is flagged too', () => {
    expect(findMissingFixtures([item(null)], new Date(NOW))[0]?.review.payload.reasons).toEqual([
      'never_listed',
    ]);
    expect(
      findMissingFixtures([item(Number.NaN)], new Date(NOW))[0]?.review.payload.reasons,
    ).toEqual(['invalid_listing_time']);
  });

  it('only scheduled, unresulted events can be missing', () => {
    const old = NOW - 10 * MISSING_AFTER_MS;
    for (const over of [
      { status: 'finished' as const },
      { status: 'cancelled' as const },
      { resultedAt: new Date(NOW) },
      { startTime: new Date(Number.NaN) },
    ]) {
      expect(findMissingFixtures([item(old, over)], new Date(NOW))).toEqual([]);
    }
  });

  it('a match that has kicked off is never missing: it is listed by its result, not as a fixture', () => {
    const old = KICKOFF - 10 * MISSING_AFTER_MS;
    expect(findMissingFixtures([item(old)], new Date(KICKOFF))).toEqual([]);
    expect(findMissingFixtures([item(null)], new Date(KICKOFF + 3 * MISSING_AFTER_MS))).toEqual([]);
    // One millisecond before the kickoff it still is.
    expect(findMissingFixtures([item(old)], new Date(KICKOFF - 1))).toHaveLength(1);
  });

  it('an event given twice uses its latest listing', () => {
    const items = [item(NOW - 10 * MISSING_AFTER_MS), item(NOW - HOUR_MS), item(null)];
    expect(findMissingFixtures(items, new Date(NOW))).toEqual([]);
  });

  it('an invalid clock is a programmer error; no input flags nothing', () => {
    expect(() => findMissingFixtures([], new Date(Number.NaN))).toThrow(RangeError);
    expect(findMissingFixtures([], new Date(NOW))).toEqual([]);
  });

  it('the output can only open review items, never flags a recent listing, ignores order', () => {
    const arb = fc.array(
      fc.record({
        id: fc.constantFrom('ev-1', 'ev-2', 'ev-3'),
        ago: fc.option(fc.integer({ min: -HOUR_MS, max: 4 * MISSING_AFTER_MS }), { nil: null }),
        status: fc.constantFrom('scheduled', 'scheduled', 'finished', 'postponed'),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(arb, (rows) => {
        const items = rows.map((r) =>
          item(r.ago === null ? null : NOW - r.ago, {
            eventId: r.id,
            feedRef: `fx|${r.id}`,
            status: r.status as ExistingEvent['status'],
          }),
        );
        const out = findMissingFixtures(items, new Date(NOW));
        expect(findMissingFixtures([...items].reverse(), new Date(NOW))).toEqual(out);
        for (const flag of out) {
          expect(Object.keys(flag).sort()).toEqual(['eventId', 'feedRef', 'review']);
          expect(flag.review.kind).toBe('fixture_missing');
          const listings = rows.filter((r) => r.id === flag.eventId && r.status === 'scheduled');
          expect(listings.length).toBeGreaterThan(0);
          expect(listings.every((r) => r.ago === null || r.ago >= MISSING_AFTER_MS)).toBe(true);
        }
      }),
    );
  });
});
