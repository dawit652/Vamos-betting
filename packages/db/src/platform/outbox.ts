import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { outboxEvents } from '../schema/platform';
import { toJsonSafe } from './json';

export type OutboxEvent = typeof outboxEvents.$inferSelect;

export interface OutboxEventInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const MAX_ERROR_LENGTH = 2000;

/**
 * Records a business event. Call it with the same transaction as the change
 * it describes so the event is published if and only if the change commits.
 * bigint / Date values in the payload are stored as strings.
 */
export async function enqueueOutbox(exec: DbExecutor, event: OutboxEventInput): Promise<bigint> {
  const [row] = await exec
    .insert(outboxEvents)
    .values({
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: toJsonSafe(event.payload),
    })
    .returning({ id: outboxEvents.id });
  if (!row) throw new Error('outbox insert returned no row');
  return row.id;
}

/**
 * Locks up to `limit` unpublished events (oldest first) for this transaction.
 * Rows already locked by another publisher are skipped (FOR UPDATE SKIP
 * LOCKED), so several workers can drain the outbox in parallel. Publish, then
 * markOutboxPublished / markOutboxFailed before the transaction commits.
 */
export async function claimOutboxBatch(
  tx: DbTransaction,
  limit: number,
  options: { maxAttempts?: number } = {},
): Promise<OutboxEvent[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('claimOutboxBatch: limit must be a positive integer');
  }
  const conditions: SQL[] = [isNull(outboxEvents.publishedAt)];
  if (options.maxAttempts !== undefined) {
    conditions.push(lt(outboxEvents.attempts, options.maxAttempts));
  }
  return tx
    .select()
    .from(outboxEvents)
    .where(and(...conditions))
    .orderBy(asc(outboxEvents.id))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/** Marks events as published (already-published ids are left untouched). */
export async function markOutboxPublished(exec: DbExecutor, ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  await exec
    .update(outboxEvents)
    .set({ publishedAt: sql`now()` })
    .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.publishedAt)));
}

/** Records a failed publish attempt; the event stays unpublished for a retry. */
export async function markOutboxFailed(exec: DbExecutor, id: bigint, error: string): Promise<void> {
  await exec
    .update(outboxEvents)
    .set({
      attempts: sql`${outboxEvents.attempts} + 1`,
      lastError: error.slice(0, MAX_ERROR_LENGTH),
    })
    .where(eq(outboxEvents.id, id));
}
