import {
  SCRAPE_REVIEW_KINDS,
  SCRAPER_ACTOR,
  type ScrapeReviewKind,
  type ScrapeReviewStatus,
  type ScrapeSeverity,
} from '@vamos/core';
import { and, desc, eq, getTableColumns, lt, or, sql, type SQL } from 'drizzle-orm';
import { domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { toJsonSafe } from '../platform/json';
import { scrapeReviewItems } from '../schema/scrape';
import {
  actorLabel,
  auditScrape,
  clampLimit,
  ScrapeReviewStateError,
  type ScrapeActor,
} from './common';

export interface ScrapeReviewItem {
  id: string;
  kind: ScrapeReviewKind;
  subjectKey: string;
  status: ScrapeReviewStatus;
  severity: ScrapeSeverity;
  title: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

export interface OpenReviewItemInput {
  kind: ScrapeReviewKind;
  subjectKey: string;
  severity: ScrapeSeverity;
  title: string;
  payload: Record<string, unknown>;
  now?: Date;
}

const toItem = (row: typeof scrapeReviewItems.$inferSelect): ScrapeReviewItem => ({
  ...row,
  kind: row.kind as ScrapeReviewKind,
  status: row.status as ScrapeReviewStatus,
  severity: row.severity as ScrapeSeverity,
});

/**
 * Opens a review item, or refreshes the one already open for the same
 * (kind, subject_key): at most one open item exists per pair (a partial
 * unique index), so concurrent callers converge on one row. Refreshing
 * replaces payload, title and severity and moves updated_at; created_at,
 * and the person's view of the item, stay. After the item is resolved or
 * dismissed, calling this again opens a NEW item.
 */
export async function openReviewItem(
  tx: DbTransaction,
  input: OpenReviewItemInput,
): Promise<{ item: ScrapeReviewItem; created: boolean }> {
  const now = input.now ?? new Date();
  const payload = toJsonSafe(input.payload) as Record<string, unknown>;
  const [row] = await tx
    .insert(scrapeReviewItems)
    .values({
      kind: input.kind,
      subjectKey: input.subjectKey,
      severity: input.severity,
      title: input.title,
      payload,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [scrapeReviewItems.kind, scrapeReviewItems.subjectKey],
      targetWhere: sql`${scrapeReviewItems.status} = 'open'`,
      set: {
        payload,
        title: input.title,
        severity: input.severity,
        updatedAt: sql`greatest(${scrapeReviewItems.updatedAt}, ${now.toISOString()}::timestamptz)`,
      },
    })
    .returning({ ...getTableColumns(scrapeReviewItems), created: sql<boolean>`(xmax = 0)` });
  const { created, ...item } = row!;
  return { item: toItem(item), created };
}

export interface ListReviewItemsQuery {
  status?: ScrapeReviewStatus;
  kind?: ScrapeReviewKind;
  limit?: number;
  /** Keyset cursor: the last item of the previous page (newest first). */
  after?: { createdAt: Date; id: string };
}

/** Review items, newest first, paged by (created_at, id). */
export async function listReviewItems(
  exec: DbExecutor,
  query: ListReviewItemsQuery = {},
): Promise<ScrapeReviewItem[]> {
  const filters: Array<SQL | undefined> = [
    query.status === undefined ? undefined : eq(scrapeReviewItems.status, query.status),
    query.kind === undefined ? undefined : eq(scrapeReviewItems.kind, query.kind),
    query.after === undefined
      ? undefined
      : or(
          lt(scrapeReviewItems.createdAt, query.after.createdAt),
          and(
            eq(scrapeReviewItems.createdAt, query.after.createdAt),
            lt(scrapeReviewItems.id, query.after.id),
          ),
        ),
  ];
  const rows = await exec
    .select()
    .from(scrapeReviewItems)
    .where(and(...filters))
    .orderBy(desc(scrapeReviewItems.createdAt), desc(scrapeReviewItems.id))
    .limit(clampLimit(query.limit, 50));
  return rows.map(toItem);
}

export async function getReviewItem(
  exec: DbExecutor,
  id: string,
): Promise<ScrapeReviewItem | null> {
  const [row] = await exec.select().from(scrapeReviewItems).where(eq(scrapeReviewItems.id, id));
  return row === undefined ? null : toItem(row);
}

/**
 * Closes an OPEN item as resolved or dismissed, recording who and why
 * (audited). The update is conditional on status = 'open', so two people
 * resolving at once get one winner and one ScrapeReviewStateError; resolving a
 * closed item changes nothing.
 */
export async function resolveReviewItem(
  tx: DbTransaction,
  id: string,
  input: { status: 'resolved' | 'dismissed'; resolution: string; actor: ScrapeActor; now?: Date },
): Promise<ScrapeReviewItem> {
  const [row] = await tx
    .update(scrapeReviewItems)
    .set({
      status: input.status,
      resolution: input.resolution,
      resolvedBy: actorLabel(input.actor),
      resolvedAt: input.now ?? new Date(),
      updatedAt: input.now ?? new Date(),
    })
    .where(and(eq(scrapeReviewItems.id, id), eq(scrapeReviewItems.status, 'open')))
    .returning();
  if (row === undefined) {
    const existing = await getReviewItem(tx, id);
    if (existing === null) throw domainNotFound('review item');
    throw new ScrapeReviewStateError(id, existing.status);
  }
  await auditScrape(tx, input.actor, {
    action: `scrape.review.${input.status}`,
    targetType: 'scrape_review_item',
    targetId: id,
    metadata: { kind: row.kind, subjectKey: row.subjectKey, resolution: input.resolution },
  });
  return toItem(row);
}

/**
 * Closes every open item about a subject whose cause has gone away (resolved
 * by the system, audited per item). Returns the closed items; none is not an
 * error. `kinds` limits it to some kinds.
 */
export async function closeReviewItemsBySubject(
  tx: DbTransaction,
  subjectKey: string,
  options: { kinds?: readonly ScrapeReviewKind[]; resolution?: string; now?: Date } = {},
): Promise<ScrapeReviewItem[]> {
  const now = options.now ?? new Date();
  const resolution = options.resolution ?? 'the cause disappeared';
  const kinds = options.kinds === undefined ? SCRAPE_REVIEW_KINDS : options.kinds;
  if (kinds.length === 0) return [];
  const rows = await tx
    .update(scrapeReviewItems)
    .set({
      status: 'resolved',
      resolution,
      resolvedBy: SCRAPER_ACTOR,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scrapeReviewItems.subjectKey, subjectKey),
        eq(scrapeReviewItems.status, 'open'),
        sql`${scrapeReviewItems.kind} IN (${sql.join(
          kinds.map((kind) => sql`${kind}`),
          sql`, `,
        )})`,
      ),
    )
    .returning();
  for (const row of rows) {
    await auditScrape(
      tx,
      { system: SCRAPER_ACTOR },
      {
        action: 'scrape.review.resolved',
        targetType: 'scrape_review_item',
        targetId: row.id,
        metadata: { kind: row.kind, subjectKey, resolution },
      },
    );
  }
  return rows.map(toItem);
}

/** Item counts per kind for one status (default open), for the health page; every kind is present. */
export async function countReviewItemsByKind(
  exec: DbExecutor,
  status: ScrapeReviewStatus = 'open',
): Promise<Record<ScrapeReviewKind, number>> {
  const rows = await exec
    .select({ kind: scrapeReviewItems.kind, n: sql<number>`count(*)::int` })
    .from(scrapeReviewItems)
    .where(eq(scrapeReviewItems.status, status))
    .groupBy(scrapeReviewItems.kind);
  const counts = Object.fromEntries(SCRAPE_REVIEW_KINDS.map((kind) => [kind, 0])) as Record<
    ScrapeReviewKind,
    number
  >;
  for (const row of rows) counts[row.kind as ScrapeReviewKind] = row.n;
  return counts;
}
