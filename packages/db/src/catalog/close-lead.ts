import { and, eq, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { events } from '../schema/catalog';
import { MAX_CLOSE_LEAD_MS } from './live';

/**
 * Makes prematch betting on a scheduled event close at least `leadMs` before its start time
 * (events.close_lead_ms; see prematchClosesAt), because the data its prices come from arrives
 * late. It only ever raises the lead: a lead a trader or an earlier call set is never lowered.
 * `leadMs` is rounded up and held to 0..MAX_CLOSE_LEAD_MS. Returns whether the lead changed and
 * the lead the event has now (null when the event is not scheduled or does not exist).
 */
export async function raiseCloseLead(
  tx: DbTransaction,
  eventId: string,
  leadMs: number,
): Promise<{ changed: boolean; closeLeadMs: number | null }> {
  if (typeof leadMs !== 'number' || Number.isNaN(leadMs)) {
    throw new RangeError(`leadMs must be a number, got ${String(leadMs)}`);
  }
  const lead = Math.min(MAX_CLOSE_LEAD_MS, Math.max(0, Math.ceil(leadMs)));
  const [updated] = await tx
    .update(events)
    .set({ closeLeadMs: lead, updatedAt: sql`now()` })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, 'scheduled'),
        sql`${events.closeLeadMs} < ${lead}`,
      ),
    )
    .returning({ closeLeadMs: events.closeLeadMs });
  if (updated !== undefined) return { changed: true, closeLeadMs: updated.closeLeadMs };
  const [current] = await tx
    .select({ closeLeadMs: events.closeLeadMs, status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  return {
    changed: false,
    closeLeadMs: current?.status === 'scheduled' ? current.closeLeadMs : null,
  };
}
