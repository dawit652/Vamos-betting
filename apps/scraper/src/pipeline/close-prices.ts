import {
  bookFairProbabilities,
  CONSENSUS_MAX_PRICE_MILLI,
  CONSENSUS_MIN_PRICE_MILLI,
  CONSENSUS_SELECTIONS,
  marketConsensus,
  SCRAPE_ODDS_SELECTIONS,
  SCRAPED_FEED_PROVIDER,
  type ScrapeOddsMarket,
  type ScrapeOddsSelection,
} from '@vamos/core';
import {
  consensusRows,
  eventsWithClosePrices,
  latestMarketOdds,
  listEventPricing,
  marketsWithSelections,
  recordClosePrices,
  type ClosePrice,
  type DbExecutor,
} from '@vamos/db';
import { events as eventsTable } from '@vamos/db/schema';
import { MARKET_LAPSE_MAX_AGE_MS } from '@vamos/scraper';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { isMarketKey } from './event-pricing';

/** Prices are captured from this long before betting on an event closes (rule M1). */
export const CLOSE_CAPTURE_WINDOW_MS = 10 * 60_000;
/** The longest close lead an event can have (the events_close_lead_range check). */
const MAX_CLOSE_LEAD_MS = 6 * 60 * 60_000;
const PPM = 1_000_000;

export interface ClosePricesSummary {
  /** Events due for a capture this pass. */
  checked: number;
  /** Events whose prices at close this pass recorded. */
  captured: number;
  /** Events that raised an error (logged, the pass goes on with the next event). */
  failed: number;
}

/**
 * Rule M1 (docs/feed-quality-plan.md M-1, measurement): for every scraped, scheduled, unresulted
 * event with betting open whose betting closes within CLOSE_CAPTURE_WINDOW_MS (close = start -
 * close_lead_ms) or has closed before kickoff, and that has no capture yet, records once what we and
 * the market priced (scrape_close_prices): per selection of the 1X2 and every over/under line, our
 * offered price (open or suspended markets), the books' no-vig consensus from prices listed in the
 * last MARKET_LAPSE_MAX_AGE_MS (one voice per upstream and bookmaker, as for pricing), Pinnacle's
 * no-vig probability, the best price among the books, and where our prices came from (O5). Nothing
 * prices, opens or settles from it; the scorecard (M-2) reads it with the results. Read-only for
 * everything else.
 */
export async function captureClosePrices(ctx: ScraperContext): Promise<ClosePricesSummary> {
  const now = ctx.clock();
  const summary: ClosePricesSummary = { checked: 0, captured: 0, failed: 0 };
  const rows = await ctx.db
    .select({
      id: eventsTable.id,
      startTime: eventsTable.startTime,
      closeLeadMs: eventsTable.closeLeadMs,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(eventsTable.status, 'scheduled'),
        isNull(eventsTable.resultedAt),
        eq(eventsTable.bettingOpen, true),
        gt(eventsTable.startTime, now),
        lte(
          eventsTable.startTime,
          new Date(now.getTime() + MAX_CLOSE_LEAD_MS + CLOSE_CAPTURE_WINDOW_MS),
        ),
      ),
    )
    .orderBy(asc(eventsTable.startTime), asc(eventsTable.id));
  const due = rows.filter(
    (row) => now.getTime() >= row.startTime.getTime() - row.closeLeadMs - CLOSE_CAPTURE_WINDOW_MS,
  );
  if (due.length === 0) return summary;
  const done = await eventsWithClosePrices(
    ctx.db,
    due.map((row) => row.id),
  );
  for (const row of due) {
    if (done.has(row.id)) continue;
    summary.checked += 1;
    try {
      const written = await ctx.db.transaction(async (tx) =>
        recordClosePrices(tx, row.id, await closePrices(tx, row.id, now), now),
      );
      if (written > 0) summary.captured += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, eventId: row.id }, 'capturing prices at close failed');
    }
  }
  ctx.logger[summary.captured + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'close prices run',
  );
  return summary;
}

type MarketLine = { market: ScrapeOddsMarket; line: string | null };
const lineKey = (market: ScrapeOddsMarket, line: string | null): string =>
  `${market}|${line ?? ''}`;
/** A half-point line as the consensus writes it ('02.50' → '2.5'); anything else as it is. */
const canonLine = (line: string | null): string | null =>
  line === null || !Number.isFinite(Number(line)) ? line : String(Number(line));
const isSelection = (code: string): code is ScrapeOddsSelection =>
  (SCRAPE_ODDS_SELECTIONS as readonly string[]).includes(code);

/** What we and the market priced for one event, now (rule M1). */
async function closePrices(exec: DbExecutor, eventId: string, now: Date): Promise<ClosePrice[]> {
  const stamp = (await listEventPricing(exec, [eventId])).get(eventId);
  const pricingSource = isMarketKey(stamp?.ratingsKey) ? 'market' : 'model';

  // Ours: the 1X2 and the over/under lines we offer.
  const ours = new Map<string, number>();
  const lines = new Map<string, MarketLine>();
  for (const market of await marketsWithSelections(exec, eventId)) {
    if (market.status !== 'open' && market.status !== 'suspended') continue;
    if (market.type !== '1x2' && market.type !== 'ou') continue;
    const line = market.type === 'ou' ? canonLine(market.line) : null;
    lines.set(lineKey(market.type, line), { market: market.type, line });
    for (const s of market.selections) {
      if (isSelection(s.code)) ours.set(`${lineKey(market.type, line)}|${s.code}`, s.oddsMilli);
    }
  }

  // The market's: fresh prices only, one voice per book.
  const rows = consensusRows(
    await latestMarketOdds(exec, { eventIds: [eventId], now, maxAgeMs: MARKET_LAPSE_MAX_AGE_MS }),
  );
  const consensus = new Map(
    marketConsensus(rows, { minBooks: 1 }).map((c) => [lineKey(c.market, c.line), c]),
  );
  for (const c of consensus.values()) {
    lines.set(lineKey(c.market, c.line), { market: c.market, line: c.line });
  }
  const best = new Map<string, { odds: number; bookmaker: string }>();
  const pinnacle = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const line = row.market === '1x2' ? null : canonLine(row.line);
    const at = lineKey(row.market, line);
    if (
      row.priceMilli >= CONSENSUS_MIN_PRICE_MILLI &&
      row.priceMilli <= CONSENSUS_MAX_PRICE_MILLI
    ) {
      const seen = best.get(`${at}|${row.selection}`);
      if (seen === undefined || row.priceMilli > seen.odds) {
        best.set(`${at}|${row.selection}`, { odds: row.priceMilli, bookmaker: row.bookmaker });
      }
    }
    if (row.bookmaker.endsWith(':pinnacle')) {
      let book = pinnacle.get(at);
      if (book === undefined) pinnacle.set(at, (book = new Map<string, number>()));
      book.set(row.selection, row.priceMilli);
    }
  }

  const out: ClosePrice[] = [];
  for (const [at, { market, line }] of lines) {
    const c = consensus.get(at);
    const codes = CONSENSUS_SELECTIONS[market];
    const book = pinnacle.get(at);
    const fair =
      book === undefined
        ? null
        : bookFairProbabilities(codes.map((code) => book.get(code) ?? Number.NaN));
    codes.forEach((code, i) => {
      const probability = c?.probabilities[code];
      const top = best.get(`${at}|${code}`);
      out.push({
        market,
        line,
        selection: code as ScrapeOddsSelection,
        pricingSource,
        ourOddsMilli: ours.get(`${at}|${code}`) ?? null,
        consensusPpm: probability === undefined ? null : Math.round(probability * PPM),
        pinnaclePpm: fair === null ? null : Math.round(fair.probabilities[i]! * PPM),
        bestOddsMilli: top?.odds ?? null,
        bestBookmaker: top?.bookmaker ?? null,
        books: c?.books ?? 0,
        overroundPpm: c === undefined ? null : Math.round(c.overroundMedian * PPM),
      });
    });
  }
  return out;
}
