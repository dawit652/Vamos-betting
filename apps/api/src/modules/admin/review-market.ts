import type { ReviewMarketComparison } from '@vamos/contracts';
import {
  CONSENSUS_SELECTIONS,
  consensusDeviation,
  marketConsensus,
  OPEN_TOLERANCE_BPS,
  withinConsensusTolerance,
} from '@vamos/core';
import { consensusRows, latestMarketOdds, marketsWithSelections, type DbExecutor } from '@vamos/db';
import { defaultMarginBps } from '@vamos/feed';
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

/** Our 1X2 margin the stored prices were made with (the prematch default of the pricing engine). */
export const OPEN_MARGIN_BPS = defaultMarginBps('1x2', false);
export { OPEN_TOLERANCE_BPS };

export interface OpenToleranceSelection {
  selection: string;
  oddsMilli: number;
  consensusProbability: number;
  deviation: number;
  within: boolean;
}

export interface OpenTolerance {
  ok: boolean;
  /** `no_consensus`, `no_prices` or `out_of_tolerance`; null when ok. */
  reason: 'no_consensus' | 'no_prices' | 'out_of_tolerance' | null;
  selections: OpenToleranceSelection[];
}

/**
 * The tolerance test of the bulk open (plan A-4), computed from the database, never from the
 * client: every 1X2 selection of the event's stored (open or suspended) prices must be within
 * OPEN_TOLERANCE_BPS of the fresh no-vig consensus after our margin (withinConsensusTolerance).
 * No fresh 1X2 consensus (the scraper's own freshness and book-count rules), or a missing 1X2
 * selection, is a refusal.
 */
export async function openTolerance(
  exec: DbExecutor,
  eventId: string,
  now: Date,
): Promise<OpenTolerance> {
  const consensus = marketConsensus(
    consensusRows(
      await latestMarketOdds(exec, { eventIds: [eventId], now, maxAgeMs: MARKET_ODDS_MAX_AGE_MS }),
    ),
  ).find((c) => c.market === '1x2');
  if (consensus === undefined) return { ok: false, reason: 'no_consensus', selections: [] };

  const stored = (await marketsWithSelections(exec, eventId)).find(
    (m) => m.type === '1x2' && m.line === null && (m.status === 'open' || m.status === 'suspended'),
  );
  const selections: OpenToleranceSelection[] = [];
  for (const code of CONSENSUS_SELECTIONS['1x2']) {
    const price = stored?.selections.find((s) => s.code === code)?.oddsMilli;
    const probability = consensus.probabilities[code];
    if (price === undefined || probability === undefined) {
      return { ok: false, reason: 'no_prices', selections };
    }
    selections.push({
      selection: code,
      oddsMilli: price,
      consensusProbability: probability,
      deviation: consensusDeviation({
        oddsMilli: price,
        probability,
        marginBps: OPEN_MARGIN_BPS,
      }),
      within: withinConsensusTolerance({
        oddsMilli: price,
        probability,
        marginBps: OPEN_MARGIN_BPS,
        toleranceBps: OPEN_TOLERANCE_BPS,
      }),
    });
  }
  const ok = selections.every((s) => s.within);
  return { ok, reason: ok ? null : 'out_of_tolerance', selections };
}
