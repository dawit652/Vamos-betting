import { listSourceTrust, recordLadderShadow, type ScrapedEvent } from '@vamos/db';
import {
  decideLadder,
  type ResolvedObservation,
  type ResultObservation,
  type SourceTrustStats,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';

/**
 * The result ladder in shadow (plan task 1.6): for an event the gate did not apply, asks
 * `decideLadder` what rungs B to D would do and records an 'apply' or 'void' decision in
 * `scrape_ladder_shadow`. Measured trust is read once per pass. It changes nothing else: it never
 * results, voids, opens or closes anything, and a failure (of the trust read, the ladder or the
 * write) is logged as an alarm and goes no further, so result promotion never breaks on it.
 */
export function ladderShadow(
  ctx: ScraperContext,
  now: Date,
): {
  record: (
    event: ScrapedEvent,
    observations: readonly ResolvedObservation<ResultObservation>[],
  ) => Promise<void>;
} {
  let trust: ReadonlyMap<string, SourceTrustStats> | null = null;
  let trustFailed = false;
  const alarm = (error: unknown, eventId: string | null): void =>
    ctx.logger.error(
      { err: error, eventId, alarm: 'ladder_shadow_failed' },
      'ladder shadow failed; result promotion carries on',
    );
  return {
    record: async (event, observations) => {
      if (trustFailed) return;
      try {
        if (trust === null) {
          try {
            trust = await listSourceTrust(ctx.db, 'football');
          } catch (error) {
            // Once per pass, not once per event.
            trustFailed = true;
            alarm(error, null);
            return;
          }
        }
        const decision = decideLadder({
          event,
          observations,
          trust,
          // Goal events are not read yet: an empty map means "no events", which never blocks rung C.
          goalsAddUp: new Map<string, boolean>(),
          now,
        });
        if (decision.action === 'apply' || decision.action === 'void') {
          await recordLadderShadow(ctx.db, { eventId: event.eventId, decision, now });
        }
      } catch (error) {
        alarm(error, event.eventId);
      }
    },
  };
}
