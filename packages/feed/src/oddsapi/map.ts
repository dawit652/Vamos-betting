import type { SportCode } from '@vamos/core';
import {
  marketConsensus,
  type BookQuote,
  type ConsensusOptions,
  type ConsensusResult,
} from '../consensus/consensus';
import { groupByLine, type LineQuote } from '../consensus/lines';
import type { EventConsensus, TotalConsensus } from '../consensus/price';
import type { OddsApiEvent, OddsApiMarket } from './schema';

/**
 * From an Odds API event to the consensus of its markets:
 * - `h2h` → the match result, in our selection order: [home, draw, away]
 *   for football, [home, away] otherwise. A bookmaker without exactly those
 *   outcomes (a two-way football price, an unknown name) is left out.
 * - `totals` → one consensus per half-point line, [over, under].
 * Outcome names are matched to the event's teams exactly, then ignoring case
 * and surrounding spaces.
 */

/** The bookmaker markets of the league endpoint this mapping reads. */
export const FEATURED_MARKETS: Readonly<Record<SportCode, readonly string[]>> = Object.freeze({
  football: Object.freeze(['h2h', 'totals']),
  basketball: Object.freeze(['h2h', 'totals']),
  tennis: Object.freeze(['h2h']),
  volleyball: Object.freeze(['h2h']),
});

const DRAW = 'draw';

export interface EventQuotes {
  result: BookQuote[];
  totals: LineQuote[];
}

/** Every bookmaker's usable quotes for an event's result and totals markets. */
export function eventQuotes(event: OddsApiEvent, sport: SportCode): EventQuotes {
  const quotes: EventQuotes = { result: [], totals: [] };
  if (event.homeTeam === null || event.awayTeam === null) return quotes;
  const home = event.homeTeam;
  const away = event.awayTeam;
  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      if (market.key === 'h2h') {
        const prices = resultPrices(market, sport, home, away);
        if (prices !== null) {
          quotes.result.push({ bookmaker: bookmaker.key, updatedAt: market.lastUpdate, prices });
        }
      } else if (market.key === 'totals' && FEATURED_MARKETS[sport].includes('totals')) {
        quotes.totals.push(...totalQuotes(market, bookmaker.key));
      }
    }
  }
  return quotes;
}

export interface EventConsensusDetail {
  consensus: EventConsensus;
  /** The raw result of each consensus, for logs and the back office. */
  result: ConsensusResult | null;
  totals: Array<{ line: number; result: ConsensusResult }>;
}

/** The consensus of an event's markets under the given filters. */
export function eventConsensus(
  event: OddsApiEvent,
  sport: SportCode,
  options: ConsensusOptions,
): EventConsensusDetail {
  const quotes = eventQuotes(event, sport);
  const outcomes = sport === 'football' ? 3 : 2;
  const result =
    quotes.result.length === 0 ? null : marketConsensus(quotes.result, outcomes, options);
  const totals: EventConsensusDetail['totals'] = [];
  const priced: TotalConsensus[] = [];
  for (const [line, lineQuotes] of groupByLine(quotes.totals)) {
    const consensus = marketConsensus(lineQuotes, 2, options);
    totals.push({ line, result: consensus });
    if (consensus.ok) {
      const [over = 0, under = 0] = consensus.probabilities;
      priced.push({ line, probabilities: [over, under], books: consensus.books.length });
    }
  }
  return {
    consensus: { sport, result: result?.ok === true ? result.probabilities : null, totals: priced },
    result,
    totals,
  };
}

function resultPrices(
  market: OddsApiMarket,
  sport: SportCode,
  home: string,
  away: string,
): number[] | null {
  const expected = sport === 'football' ? 3 : 2;
  if (market.outcomes.length !== expected) return null;
  const price = (name: string): number | undefined =>
    market.outcomes.find((outcome) => sameName(outcome.name, name))?.price;
  const homePrice = price(home);
  const awayPrice = price(away);
  if (homePrice === undefined || awayPrice === undefined || sameName(home, away)) return null;
  if (sport !== 'football') return [homePrice, awayPrice];
  const drawPrice = price(DRAW);
  return drawPrice === undefined ? null : [homePrice, drawPrice, awayPrice];
}

/** Over/under pairs on the same point (a book may list several lines in one market). */
function totalQuotes(market: OddsApiMarket, bookmaker: string): LineQuote[] {
  const byPoint = new Map<number, { over?: number; under?: number; count: number }>();
  for (const outcome of market.outcomes) {
    if (outcome.point === null) continue;
    const side = outcome.name.trim().toLowerCase();
    if (side !== 'over' && side !== 'under') continue;
    const entry = byPoint.get(outcome.point) ?? { count: 0 };
    entry[side] = outcome.price;
    entry.count++;
    byPoint.set(outcome.point, entry);
  }
  const quotes: LineQuote[] = [];
  for (const [line, entry] of byPoint) {
    if (entry.count !== 2 || entry.over === undefined || entry.under === undefined) continue;
    quotes.push({
      bookmaker,
      updatedAt: market.lastUpdate,
      prices: [entry.over, entry.under],
      line,
    });
  }
  return quotes;
}

function sameName(a: string, b: string): boolean {
  return a === b || a.trim().toLowerCase() === b.trim().toLowerCase();
}
