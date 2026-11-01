import { deleteRaw, listPrunableRaw, pruneMarketOdds } from '@vamos/db';
import { scrapeRaw } from '@vamos/db/schema';
import { DAY_MS } from '@vamos/scraper';
import { notInArray } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';

export const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Snapshots older than this go, except the evidence behind applied results. */
export const RAW_RETENTION_MS = 30 * DAY_MS;
/** Bookmaker prices last listed longer ago than this are deleted (pricing reads the last few hours only). */
export const MARKET_ODDS_RETENTION_MS = 7 * DAY_MS;
const BATCH = 500;
const MAX_BATCHES = 10;

/**
 * Deletes old raw snapshots: the archive files first, then the rows. A file
 * is kept while any row that stays (a newer one, or evidence marked `keep`)
 * refers to its hash.
 */
export async function pruneRaw(
  ctx: ScraperContext,
  retentionMs: number = RAW_RETENTION_MS,
): Promise<number> {
  const olderThan = new Date(ctx.clock().getTime() - retentionMs);
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await listPrunableRaw(ctx.db, olderThan, BATCH);
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.id);
    const staying = await ctx.db
      .selectDistinct({ hash: scrapeRaw.contentHash })
      .from(scrapeRaw)
      .where(notInArray(scrapeRaw.id, ids));
    await ctx.archive.prune({ olderThan, keep: new Set(staying.map((row) => row.hash)) });
    removed += await deleteRaw(ctx.db, ids);
    if (rows.length < BATCH) break;
  }
  if (removed > 0) ctx.logger.info({ removed }, 'raw snapshots pruned');
  return removed;
}

/** Deletes bookmaker price rows no fetch has listed for MARKET_ODDS_RETENTION_MS. */
export async function pruneOldMarketOdds(
  ctx: ScraperContext,
  retentionMs: number = MARKET_ODDS_RETENTION_MS,
): Promise<number> {
  const olderThan = new Date(ctx.clock().getTime() - retentionMs);
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const n = await pruneMarketOdds(ctx.db, olderThan, BATCH);
    removed += n;
    if (n < BATCH) break;
  }
  if (removed > 0) ctx.logger.info({ removed }, 'market odds pruned');
  return removed;
}

export function pruneTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-prune',
    intervalMs: PRUNE_INTERVAL_MS,
    logger: ctx.logger,
    run: async () => {
      await pruneRaw(ctx);
      await pruneOldMarketOdds(ctx);
    },
    runOnStart: false,
  });
}
