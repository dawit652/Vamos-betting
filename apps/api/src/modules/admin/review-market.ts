import type { ReviewMarketComparison } from '@vamos/contracts';
import { CONSENSUS_SELECTIONS, marketConsensus } from '@vamos/core';
import { consensusRows, latestMarketOdds, type DbExecutor } from '@vamos/db';
import { MARKET_ODDS_MAX_AGE_MS } from '@vamos/scraper';

const PINNACLE = 'pinnacle';

/**
 * The bookmaker consensus an odds item is judged against, for the review page (A-3). Read-only and
 * display-only: no decision reads it. Only for an open odds_approval or ratings_uncalibrated item
 * whose payload names an event; null otherwise, or when the event has no fresh market prices.
 * Prices are the fresh ones the scraper itself would use (latestMarketOdds, consensusRows).
 */
export async function reviewMarketComparison(
  exec: DbExecutor,
  item: { kind: string; status: string; payload: unknown },
  now: Date,
): Promise<ReviewMarketComparison | null> {
  if (item.status !== 'open') return null;
  if (item.kind !== 'odds_approval' && item.kind !== 'ratings_uncalibrated') return null;
  const eventId = (item.payload as Record<string, unknown> | null)?.eventId;
  if (typeof eventId !== 'string') return null;
  const rows = consensusRows(
    await latestMarketOdds(exec, { eventIds: [eventId], now, maxAgeMs: MARKET_ODDS_MAX_AGE_MS }),
  );
  const consensus = marketConsensus(rows);
  if (consensus.length === 0) return null;

  const key = (market: string, line: string | null) =>
    line === null ? market : `${market}:${line}`;
  const pinnacle = new Map<string, number>();
  for (const row of rows) {
    if (row.bookmaker.split(':').pop()?.toLowerCase() !== PINNACLE) continue;
    const id = `${key(row.market, row.line)}|${row.selection}`;
    if (!pinnacle.has(id)) pinnacle.set(id, row.priceMilli);
  }
  return {
    consensus: consensus.map((c) => ({
      market: key(c.market, c.line),
      books: c.books,
      bookmakers: [...c.bookmakers],
      overround: c.overroundMedian,
    })),
    prices: consensus.flatMap((c) =>
      CONSENSUS_SELECTIONS[c.market].map((selection) => ({
        market: key(c.market, c.line),
        selection,
        consensusOddsMilli: Math.min(
          1_000_000,
          Math.max(1001, Math.round(1000 / (c.probabilities[selection] ?? 1))),
        ),
        pinnacleOddsMilli: pinnacle.get(`${key(c.market, c.line)}|${selection}`) ?? null,
      })),
    ),
  };
}
