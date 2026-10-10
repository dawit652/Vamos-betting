import type { EventSummary, MarketView, SelectionView } from '@vamos/contracts';
import type { NewSlipLeg } from '@/lib/betslip/state';

/**
 * Pure helpers shared by the match lists, the event page and the odds buttons
 * (no React, no I/O) so they are unit tested.
 */

/** The event fields a betslip leg needs: passed once per row / market island. */
export type EventRef = Pick<
  NewSlipLeg,
  'eventId' | 'gameId' | 'sport' | 'home' | 'away' | 'startTime' | 'live'
>;

export function eventRef(event: EventSummary): EventRef {
  return {
    eventId: event.id,
    gameId: event.gameId,
    sport: event.sport,
    home: event.home.name,
    away: event.away.name,
    startTime: event.startTime,
    live: event.status === 'live',
  };
}

/** The betslip leg for a tap on `selection` (odds as shown, possibly patched live). */
export function slipLeg(
  event: EventRef,
  market: Pick<MarketView, 'name'>,
  selection: Pick<SelectionView, 'id' | 'label'>,
  oddsMilli: number,
): NewSlipLeg {
  return {
    ...event,
    selectionId: selection.id,
    oddsMilli,
    marketName: market.name,
    selectionName: selection.label,
  };
}

export type MarketStatus = MarketView['status'];

/** What an odds-button island needs of a market (kept small: it is serialised per row). */
export type OddsMarket = Pick<MarketView, 'id' | 'name' | 'status' | 'selections'>;

export function oddsMarket(market: MarketView): OddsMarket {
  return { id: market.id, name: market.name, status: market.status, selections: market.selections };
}

/** Markets worth showing: open or suspended (closed, settled and void ones are hidden). */
export function isListedMarket(status: MarketStatus): boolean {
  return status === 'open' || status === 'suspended';
}

/**
 * Whether a selection can be added to the slip right now, from the server view
 * patched with live deltas: the market is open, the selection is open, the
 * event takes bets and the price is valid.
 */
export function isBettable(input: {
  marketStatus: MarketStatus;
  selectionOpen: boolean;
  bettingOpen: boolean;
  oddsMilli: number;
}): boolean {
  return (
    input.marketStatus === 'open' &&
    input.selectionOpen &&
    input.bettingOpen &&
    Number.isInteger(input.oddsMilli) &&
    input.oddsMilli > 1000
  );
}

export interface MarketGroup {
  /** Market type, e.g. `ou`; also the accordion's key. */
  type: string;
  name: MarketView['name'];
  markets: MarketView[];
}

/**
 * Groups an event's listed markets by type in API order, so every
 * Over/Under line sits in one accordion. Lines are sorted numerically.
 */
export function groupMarkets(markets: readonly MarketView[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();
  for (const market of markets) {
    if (!isListedMarket(market.status)) continue;
    let group = groups.get(market.type);
    if (group === undefined) {
      group = { type: market.type, name: market.name, markets: [] };
      groups.set(market.type, group);
    }
    group.markets.push(market);
  }
  for (const group of groups.values()) {
    group.markets.sort((a, b) => lineValue(a.line) - lineValue(b.line));
  }
  return [...groups.values()];
}

function lineValue(line: string | null): number {
  if (line === null) return 0;
  const value = Number(line);
  return Number.isFinite(value) ? value : 0;
}

/** Short label of a list-row odds button: the selection code ("1", "X", "2"). */
export function shortLabel(code: string): string {
  return code.length <= 3 ? code.toUpperCase() : code;
}

export type MatchClock =
  | { kind: 'minute'; minute: number }
  | { kind: 'halfTime' }
  | { kind: 'period'; period: string }
  | { kind: 'none' };

/** What a live row shows next to the score: 53', HT, Q2, S3. */
export function matchClock(input: {
  sport: string;
  minute: number | null;
  period: string | null;
}): MatchClock {
  if (input.period === 'HT') return { kind: 'halfTime' };
  if (input.sport === 'football' && input.minute !== null && input.minute >= 0) {
    return { kind: 'minute', minute: input.minute };
  }
  if (input.period !== null && input.period !== '' && input.period !== 'NS') {
    return { kind: 'period', period: input.period };
  }
  return { kind: 'none' };
}

/** Live-stream filter ids: unique, at most the API's 50. */
export function streamEventIds(ids: readonly string[], max = 50): string[] {
  return [...new Set(ids)].slice(0, max);
}
