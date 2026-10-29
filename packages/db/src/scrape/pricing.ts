import { inArray, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { scrapeEventPricing } from '../schema/scrape';

/** What is known about the ratings behind an event's stored prices (rule O3). */
export interface EventPricing {
  eventId: string;
  /** Fingerprint of the ratings the prices were computed from; null when not known. */
  ratingsKey: string | null;
  pricedAt: Date | null;
  /** Fingerprint of the last proposal a person was asked about. */
  heldKey: string | null;
}

/** The pricing stamps of some events (events without a stamp are absent). */
export async function listEventPricing(
  exec: DbExecutor,
  eventIds: readonly string[],
): Promise<Map<string, EventPricing>> {
  if (eventIds.length === 0) return new Map();
  const rows = await exec
    .select()
    .from(scrapeEventPricing)
    .where(inArray(scrapeEventPricing.eventId, [...new Set(eventIds)]));
  return new Map(
    rows.map((row) => [
      row.eventId,
      {
        eventId: row.eventId,
        ratingsKey: row.ratingsKey,
        pricedAt: row.pricedAt,
        heldKey: row.heldKey,
      },
    ]),
  );
}

/**
 * Records that the stored prices of an event now come from the ratings
 * `ratingsKey` (clears any held proposal). Call it in the transaction that
 * wrote the prices.
 */
export async function recordEventPriced(
  tx: DbTransaction,
  eventId: string,
  ratingsKey: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(scrapeEventPricing)
    .values({ eventId, ratingsKey, pricedAt: now, heldKey: null, updatedAt: now })
    .onConflictDoUpdate({
      target: scrapeEventPricing.eventId,
      set: { ratingsKey, pricedAt: now, heldKey: null, updatedAt: now },
    });
}

/**
 * Records that a proposal made from the ratings `heldKey` went to a person: the
 * stored prices are untouched (the price stamp is kept), but the same ratings
 * are not proposed again.
 */
export async function recordEventHeld(
  tx: DbTransaction,
  eventId: string,
  heldKey: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(scrapeEventPricing)
    .values({ eventId, heldKey, updatedAt: now })
    .onConflictDoUpdate({
      target: scrapeEventPricing.eventId,
      set: { heldKey, updatedAt: sql`${now.toISOString()}::timestamptz` },
    });
}
