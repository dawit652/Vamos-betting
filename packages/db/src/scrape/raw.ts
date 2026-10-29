import { and, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { scrapeRaw } from '../schema/scrape';
import { clampLimit } from './common';

export interface ScrapeRawRecord {
  id: string;
  runId: string;
  url: string;
  status: number;
  contentType: string | null;
  contentHash: string;
  bytes: number;
  fetchedAt: Date;
  keep: boolean;
  recordsSeen: number | null;
  recordsAccepted: number | null;
}

export interface RecordRawInput {
  runId: string;
  url: string;
  status: number;
  contentType: string | null;
  /** SHA-256 (hex) of the exact bytes archived. */
  contentHash: string;
  bytes: number;
  fetchedAt: Date;
  /** This document's parse yield, when known (S1 baseline). */
  recordsSeen?: number;
  recordsAccepted?: number;
}

/**
 * Records a stored snapshot. Idempotent per (run, url): a second call returns
 * the first row and leaves its bytes/hash alone (only a yield that was not
 * known before is filled in), so a retried step cannot rewrite what was
 * archived. `created` is false for that replay.
 */
export async function recordRaw(
  exec: DbExecutor,
  input: RecordRawInput,
): Promise<{ raw: ScrapeRawRecord; created: boolean }> {
  const [row] = await exec
    .insert(scrapeRaw)
    .values({
      runId: input.runId,
      url: input.url,
      status: input.status,
      contentType: input.contentType,
      contentHash: input.contentHash,
      bytes: input.bytes,
      fetchedAt: input.fetchedAt,
      recordsSeen: input.recordsSeen ?? null,
      recordsAccepted: input.recordsAccepted ?? null,
    })
    .onConflictDoUpdate({
      target: [scrapeRaw.runId, scrapeRaw.url],
      set: {
        recordsSeen: sql`coalesce(${scrapeRaw.recordsSeen}, excluded.records_seen)`,
        recordsAccepted: sql`coalesce(${scrapeRaw.recordsAccepted}, excluded.records_accepted)`,
      },
    })
    .returning({ ...getTableColumns(scrapeRaw), created: sql<boolean>`(xmax = 0)` });
  const { created, ...raw } = row!;
  return { raw, created };
}

/**
 * Marks every snapshot with one of these content hashes as evidence (`keep`):
 * the pages behind an applied result are never pruned. Returns the number of
 * rows newly marked.
 */
export async function markRawKeep(exec: DbExecutor, hashes: readonly string[]): Promise<number> {
  if (hashes.length === 0) return 0;
  const rows = await exec
    .update(scrapeRaw)
    .set({ keep: true })
    .where(and(inArray(scrapeRaw.contentHash, [...new Set(hashes)]), eq(scrapeRaw.keep, false)))
    .returning({ id: scrapeRaw.id });
  return rows.length;
}

/**
 * Snapshots older than `olderThan` that may be deleted, oldest first. Never
 * `keep` rows, and never a row whose content hash is shared with a `keep` row
 * (the archive stores one file per hash, so deleting it would destroy the
 * evidence).
 */
export async function listPrunableRaw(
  exec: DbExecutor,
  olderThan: Date,
  limit: number,
): Promise<ScrapeRawRecord[]> {
  return exec
    .select()
    .from(scrapeRaw)
    .where(
      and(
        eq(scrapeRaw.keep, false),
        lt(scrapeRaw.fetchedAt, olderThan),
        sql`NOT EXISTS (SELECT 1 FROM scrape_raw k WHERE k.content_hash = ${scrapeRaw.contentHash} AND k.keep)`,
      ),
    )
    .orderBy(scrapeRaw.fetchedAt, scrapeRaw.id)
    .limit(clampLimit(limit, 100, 5000));
}

/** Deletes snapshot rows after their archive files were removed. Rows marked `keep` are never deleted. */
export async function deleteRaw(exec: DbExecutor, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await exec
    .delete(scrapeRaw)
    .where(and(inArray(scrapeRaw.id, [...ids]), eq(scrapeRaw.keep, false)))
    .returning({ id: scrapeRaw.id });
  return rows.length;
}
