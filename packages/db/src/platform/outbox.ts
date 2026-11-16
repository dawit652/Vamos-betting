import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
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
 * LOCKED), so several workers can drain the outbox in parallel. With `now`,
 * rows whose next_attempt_at is still ahead (backing off after a failure)
 * are left out, so they never hold back newer rows; with `maxAttempts`,
 * dead letters are left out. Publish, then markOutboxPublished /
 * markOutboxFailed before the transaction commits.
 */
export async function claimOutboxBatch(
  tx: DbTransaction,
  limit: number,
  options: { maxAttempts?: number; now?: Date } = {},
): Promise<OutboxEvent[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('claimOutboxBatch: limit must be a positive integer');
  }
  const conditions: SQL[] = [isNull(outboxEvents.publishedAt)];
  if (options.maxAttempts !== undefined) {
    conditions.push(lt(outboxEvents.attempts, options.maxAttempts));
  }
  if (options.now !== undefined) {
    const due = or(
      isNull(outboxEvents.nextAttemptAt),
      lte(outboxEvents.nextAttemptAt, options.now),
    );
    if (due !== undefined) conditions.push(due);
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
    .set({ publishedAt: sql`now()`, nextAttemptAt: null })
    .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.publishedAt)));
}

export interface OutboxFailureOptions {
  /** Not claimed (by claimOutboxBatch with `now`) before this time. */
  retryAt?: Date;
  /**
   * false for an outage (the queue's Redis refusing writes, a timeout): the
   * error and retry time are recorded but `attempts` is not used up, so an
   * outage never dead-letters a row. Default true.
   */
  countAttempt?: boolean;
}

/** Records a failed publish attempt; the event stays unpublished for a retry. */
export async function markOutboxFailed(
  exec: DbExecutor,
  id: bigint,
  error: string,
  options: OutboxFailureOptions = {},
): Promise<void> {
  await exec
    .update(outboxEvents)
    .set({
      ...(options.countAttempt === false ? {} : { attempts: sql`${outboxEvents.attempts} + 1` }),
      lastError: error.slice(0, MAX_ERROR_LENGTH),
      nextAttemptAt: options.retryAt ?? null,
    })
    .where(eq(outboxEvents.id, id));
}

/** What is waiting in the outbox (for the worker's metrics). */
export interface OutboxBacklog {
  /** Rows not yet handed to the queues (rows backing off and dead letters included). */
  unpublished: number;
  /** Seconds since the oldest of them was written, by the database's clock (0: none). */
  oldestSeconds: number;
}

/**
 * The size and age of the dispatcher's backlog. A healthy outbox is empty or seconds old: an age
 * that keeps growing means the dispatcher is not running, Redis refuses jobs, or a dead letter is
 * waiting for a redrive. One index-only pass over the unpublished rows.
 */
export async function readOutboxBacklog(exec: DbExecutor): Promise<OutboxBacklog> {
  const [row] = await exec
    .select({
      unpublished: sql<number>`count(*)::int`,
      oldestSeconds: sql<number>`coalesce(floor(extract(epoch from now() - min(${outboxEvents.createdAt}))), 0)::int`,
    })
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt));
  return {
    unpublished: row?.unpublished ?? 0,
    oldestSeconds: Math.max(0, row?.oldestSeconds ?? 0),
  };
}

/** Unpublished events that reached `maxAttempts` (no longer claimed by the dispatcher). */
export async function countDeadLetteredOutbox(
  exec: DbExecutor,
  maxAttempts: number,
): Promise<number> {
  const [row] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.publishedAt), gte(outboxEvents.attempts, maxAttempts)));
  return row?.n ?? 0;
}

/**
 * Queues events again (an operator's redrive, e.g. after fixing what made
 * them dead-letter, or to re-run a consumer job that failed for good): they
 * become unpublished with no attempts and a new job_key, so the dispatcher
 * enqueues them under a new job id rather than finding the old (failed or
 * completed) job. Consumers are idempotent. Returns the ids redriven.
 */
export async function redriveOutboxEvents(exec: DbExecutor, ids: bigint[]): Promise<bigint[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .update(outboxEvents)
    .set({
      publishedAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      jobKey: sql`gen_random_uuid()`,
    })
    .where(inArray(outboxEvents.id, ids))
    .returning({ id: outboxEvents.id });
  return rows.map((row) => row.id);
}
