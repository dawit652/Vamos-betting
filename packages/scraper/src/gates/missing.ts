import { MISSING_AFTER_MS } from '../constants';
import type { ExistingEvent } from '../types';
import { eventProblem, instant, isoOrNull, listOf, requireNow } from './internal';
import { buildReviews, type GateReview } from './review';

/**
 * Rule F5 (docs/scraper.md 6.1): absence never cancels.
 *
 * The output type can only hold review items (`fixture_missing`): there is no
 * way to express a status change, so a fixture that disappeared from every
 * page can never cancel, void or move anything. Unknown or invalid listing
 * times are flagged too (fail closed means "a person looks", and a flag
 * changes nothing).
 */

export interface MissingCheckInput {
  /** A scraped event; only scheduled, unresulted ones can be missing. */
  readonly event: ExistingEvent;
  /**
   * The last time any ENABLED source listed the fixture in a successful run,
   * or null when none ever did.
   */
  readonly lastListedAt: Date | null;
}

export interface MissingFixture {
  readonly eventId: string;
  readonly feedRef: string;
  readonly review: GateReview<'fixture_missing'>;
}

/**
 * The events to flag `fixture_missing`: not listed for MISSING_AFTER_MS or more
 * (exactly MISSING_AFTER_MS flags). An event given twice uses its latest
 * listing. Sorted by feedRef. Pure; throws only for an invalid `now`.
 */
export function findMissingFixtures(
  items: readonly MissingCheckInput[],
  now: Date,
): MissingFixture[] {
  const nowMs = requireNow(now);
  const latest = new Map<
    string,
    { event: ExistingEvent; listedMs: number | null; invalid: boolean }
  >();
  for (const item of listOf(items)) {
    const event = item?.event;
    if (eventProblem(event) !== null) continue;
    if (event.status !== 'scheduled' || event.resultedAt !== null || event.score !== null) continue;
    const listed = item.lastListedAt;
    const listedMs = listed === null ? null : instant(listed);
    const invalid = listed !== null && listedMs === null;
    const seen = latest.get(event.eventId);
    if (seen === undefined) {
      latest.set(event.eventId, { event, listedMs, invalid });
    } else if (listedMs !== null && (seen.listedMs === null || listedMs > seen.listedMs)) {
      latest.set(event.eventId, { event: seen.event, listedMs, invalid: false });
    }
  }

  const flagged: MissingFixture[] = [];
  for (const { event, listedMs, invalid } of latest.values()) {
    const reason = invalid
      ? 'invalid_listing_time'
      : listedMs === null
        ? 'never_listed'
        : nowMs - listedMs >= MISSING_AFTER_MS
          ? 'not_listed'
          : null;
    if (reason === null) continue;
    const [review] = buildReviews(
      event.feedRef,
      [{ kind: 'fixture_missing', rule: 'F5', reason }],
      () => ({
        eventId: event.eventId,
        feedRef: event.feedRef,
        eventStart: isoOrNull(event.startTime),
        lastListedAt: listedMs === null ? null : new Date(listedMs).toISOString(),
        missingForMs: listedMs === null ? null : nowMs - listedMs,
      }),
    );
    if (review === undefined) continue;
    flagged.push({
      eventId: event.eventId,
      feedRef: event.feedRef,
      review: { ...review, kind: 'fixture_missing' },
    });
  }
  return flagged.sort((a, b) =>
    a.feedRef === b.feedRef ? (a.eventId < b.eventId ? -1 : 1) : a.feedRef < b.feedRef ? -1 : 1,
  );
}
