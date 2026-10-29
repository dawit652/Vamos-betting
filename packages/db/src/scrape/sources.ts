import { SCRAPE_ADAPTERS, type ScrapeAdapterName } from '@vamos/core';
import { asc, eq, sql } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { scrapeSources } from '../schema/scrape';
import { actorLabel, auditScrape, type ScrapeActor } from './common';

/** A scraping source as the services and the back office see it. */
export interface ScrapeSource {
  id: string;
  name: string;
  adapter: ScrapeAdapterName;
  upstream: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface UpsertSourceInput {
  id: string;
  name: string;
  adapter: ScrapeAdapterName;
  upstream: string;
  config: Record<string, unknown>;
}

function toSource(row: typeof scrapeSources.$inferSelect): ScrapeSource {
  return { ...row, adapter: row.adapter as ScrapeAdapterName };
}

/**
 * Creates a source (DISABLED) or updates its name, adapter, upstream and
 * config. It never changes `enabled`: switching a source on is a person's
 * decision (setSourceEnabled), so a deploy that re-registers the configured
 * sources cannot turn one back on. Idempotent: an identical call writes and
 * audits nothing.
 */
export async function upsertSource(
  tx: DbTransaction,
  input: UpsertSourceInput,
  actor: ScrapeActor,
): Promise<ScrapeSource> {
  if (!SCRAPE_ADAPTERS.includes(input.adapter)) {
    throw domainUnprocessable('scrape_bad_adapter', `unknown adapter "${String(input.adapter)}"`);
  }
  const [changed] = await tx
    .insert(scrapeSources)
    .values({ ...input, enabled: false, updatedBy: actorLabel(actor) })
    .onConflictDoUpdate({
      target: scrapeSources.id,
      set: {
        name: input.name,
        adapter: input.adapter,
        upstream: input.upstream,
        config: input.config,
        updatedAt: sql`now()`,
        updatedBy: actorLabel(actor),
      },
      setWhere: sql`(${scrapeSources.name}, ${scrapeSources.adapter}, ${scrapeSources.upstream}, ${scrapeSources.config}) IS DISTINCT FROM (${input.name}, ${input.adapter}, ${input.upstream}, ${JSON.stringify(input.config)}::jsonb)`,
    })
    .returning();
  if (changed === undefined) {
    const existing = await getSource(tx, input.id);
    if (existing === null) throw domainNotFound('scrape source');
    return existing;
  }
  await auditScrape(tx, actor, {
    action: 'scrape.source.upserted',
    targetType: 'scrape_source',
    targetId: input.id,
    metadata: { name: input.name, adapter: input.adapter, upstream: input.upstream },
  });
  return toSource(changed);
}

export async function getSource(exec: DbExecutor, id: string): Promise<ScrapeSource | null> {
  const [row] = await exec.select().from(scrapeSources).where(eq(scrapeSources.id, id));
  return row === undefined ? null : toSource(row);
}

export async function listSources(exec: DbExecutor): Promise<ScrapeSource[]> {
  const rows = await exec.select().from(scrapeSources).orderBy(asc(scrapeSources.id));
  return rows.map(toSource);
}

/**
 * The kill switch (S4): enables or disables a source, audited. The row is
 * locked so two traders flipping it at once leave a consistent audit trail.
 * Setting the value it already has changes and audits nothing.
 */
export async function setSourceEnabled(
  tx: DbTransaction,
  id: string,
  enabled: boolean,
  actor: ScrapeActor,
): Promise<ScrapeSource> {
  const [current] = await tx
    .select()
    .from(scrapeSources)
    .where(eq(scrapeSources.id, id))
    .for('update');
  if (current === undefined) throw domainNotFound('scrape source');
  if (current.enabled === enabled) return toSource(current);
  const [row] = await tx
    .update(scrapeSources)
    .set({ enabled, updatedAt: sql`now()`, updatedBy: actorLabel(actor) })
    .where(eq(scrapeSources.id, id))
    .returning();
  await auditScrape(tx, actor, {
    action: enabled ? 'scrape.source.enabled' : 'scrape.source.disabled',
    targetType: 'scrape_source',
    targetId: id,
    metadata: { before: current.enabled, after: enabled },
  });
  return toSource(row!);
}
