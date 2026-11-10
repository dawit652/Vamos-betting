import type { ScrapeOddsMarket, ScrapeOddsSelection, ScrapePricingSource } from '@vamos/core';
import { and, asc, gte, inArray, lt } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { scrapeClosePrices } from '../schema/scrape';

/**
 * One selection's prices at betting close (rule M1, table scrape_close_prices): ours and the
 * market's. Probabilities are in parts per million.
 */
export interface ClosePrice {
  market: ScrapeOddsMarket;
  /** Half-point line for 'ou', null for '1x2'. */
  line: string | null;
  selection: ScrapeOddsSelection;
  pricingSource: ScrapePricingSource;
  ourOddsMilli: number | null;
  consensusPpm: number | null;
  pinnaclePpm: number | null;
  bestOddsMilli: number | null;
  bestBookmaker: string | null;
  books: number;
  overroundPpm: number | null;
}

export interface StoredClosePrice extends ClosePrice {
  eventId: string;
  capturedAt: Date;
}

/**
 * Records an event's prices at betting close, once (rule M1): a row already recorded stays as it
 * is. Returns how many rows were written.
 */
export async function recordClosePrices(
  tx: DbTransaction,
  eventId: string,
  prices: readonly ClosePrice[],
  capturedAt: Date,
): Promise<number> {
  if (prices.length === 0) return 0;
  const rows = await tx
    .insert(scrapeClosePrices)
    .values(prices.map((price) => ({ ...price, line: price.line ?? '', eventId, capturedAt })))
    .onConflictDoNothing()
    .returning({ eventId: scrapeClosePrices.eventId });
  return rows.length;
}

/** The events among `eventIds` whose prices at close are recorded. */
export async function eventsWithClosePrices(
  exec: DbExecutor,
  eventIds: readonly string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await exec
    .selectDistinct({ eventId: scrapeClosePrices.eventId })
    .from(scrapeClosePrices)
    .where(inArray(scrapeClosePrices.eventId, [...new Set(eventIds)]));
  return new Set(rows.map((row) => row.eventId));
}

/** The prices at close captured in [from, to), by event, market, line and selection (for M-2). */
export async function listClosePrices(
  exec: DbExecutor,
  query: { from: Date; to: Date },
): Promise<StoredClosePrice[]> {
  const rows = await exec
    .select()
    .from(scrapeClosePrices)
    .where(
      and(
        gte(scrapeClosePrices.capturedAt, query.from),
        lt(scrapeClosePrices.capturedAt, query.to),
      ),
    )
    .orderBy(
      asc(scrapeClosePrices.eventId),
      asc(scrapeClosePrices.market),
      asc(scrapeClosePrices.line),
      asc(scrapeClosePrices.selection),
    );
  return rows.map((row) => ({
    ...row,
    market: row.market as ScrapeOddsMarket,
    line: row.line === '' ? null : row.line,
    selection: row.selection as ScrapeOddsSelection,
    pricingSource: row.pricingSource as ScrapePricingSource,
  }));
}
