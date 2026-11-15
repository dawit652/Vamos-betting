import {
  enqueueOwnerAlert,
  listSourceTrust,
  recordLadderShadow,
  type ScrapedEvent,
} from '@vamos/db';
import {
  decideLadder,
  type ResolvedObservation,
  type ResultObservation,
  type SourceTrustStats,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';

/**
 * Tells the owner the ladder shadow failed (plan task 1.11): one outbox row in a small transaction
 * of its own, as the alarm is only a log line. Never throws: a failure to queue is logged and
 * goes no further, so the alarm cannot break what it watches.
 */
export async function alertLadderShadowFailed(ctx: ScraperContext, now: Date): Promise<void> {
  try {
    await enqueueOwnerAlert(ctx.db, ctx.config.ownerAlerts, { alarm: 'ladder_shadow_failed' }, now);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'owner alert for the ladder shadow could not be queued');
  }
}

/**
 * The result ladder in shadow (plan task 1.6): for an event the gate did not apply, asks
 * `decideLadder` what rungs B to D would do and records an 'apply' or 'void' decision in
 * `scrape_ladder_shadow`. Measured trust is read once per pass. It changes nothing else: it never
 * results, voids, opens or closes anything, and a failure (of the trust read, the ladder or the
 * write) is logged as an alarm and goes no further, so result promotion never breaks on it. With an
 * owner number configured the alarm also queues one `owner.alert` per pass (plan task 1.11).
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
  let alerted = false;
  const alarm = async (error: unknown, eventId: string | null): Promise<void> => {
    ctx.logger.error(
      { err: error, eventId, alarm: 'ladder_shadow_failed' },
      'ladder shadow failed; result promotion carries on',
    );
    // One alert per pass, however many events fail.
    if (!alerted) {
      alerted = true;
      await alertLadderShadowFailed(ctx, now);
    }
  };
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
            await alarm(error, null);
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
        await alarm(error, event.eventId);
      }
    },
  };
}
