import type {
  EventDetail,
  EventSummary,
  LocalizedNameValue,
  MarketView,
  SelectionView,
} from '@vamos/contracts';
import {
  formatGameId,
  MARKET_TYPES,
  parseLine,
  selectionLabel,
  selectionsFor,
  SPORT_MARKETS,
  type MarketTypeCode,
  type SportCode,
} from '@vamos/core';
import { isSelectionBettable } from '@vamos/db';

/**
 * Pure builders of the catalogue's wire views (no I/O). The queries load
 * rows; everything about labels, ordering and the `open` flag lives here.
 */

export type EventStatus = EventSummary['status'];
export type MarketStatus = MarketView['status'];
export type SelectionStatus = 'open' | 'suspended' | 'settled';

export interface TeamRow {
  id: string;
  name: LocalizedNameValue;
  shortName: string;
}

export interface EventRow {
  id: string;
  gameId: number;
  sport: SportCode;
  competitionSlug: string;
  competitionName: LocalizedNameValue;
  categoryName: LocalizedNameValue;
  categoryCountryCode: string | null;
  home: TeamRow;
  away: TeamRow;
  startTime: Date;
  status: EventStatus;
  bettingOpen: boolean;
  liveMinute: number | null;
  period: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  htScoreHome: number | null;
  htScoreAway: number | null;
  oddsUpdatedAt: Date | null;
  /** events.feed_provider: 'mock' is the simulated feed. */
  feedProvider: string;
}

export interface MarketRow {
  id: string;
  eventId: string;
  type: string;
  line: string | null;
  status: MarketStatus;
}

export interface SelectionRow {
  id: string;
  marketId: string;
  code: string;
  oddsMilli: number;
  status: SelectionStatus;
}

const SPORT_CODES: ReadonlySet<string> = new Set(Object.keys(SPORT_MARKETS));
/** Market statuses that count towards "+N markets". */
const LISTED_MARKET_STATUSES: ReadonlySet<MarketStatus> = new Set(['open', 'suspended']);

export function isSportCode(value: string): value is SportCode {
  return SPORT_CODES.has(value);
}

export function isMarketTypeCode(value: string): value is MarketTypeCode {
  return Object.hasOwn(MARKET_TYPES, value);
}

/** The market shown on a list row: 1X2, ML or winner (the first market of the sport). */
export function mainMarketType(sport: SportCode): MarketTypeCode {
  const type = SPORT_MARKETS[sport][0];
  if (type === undefined) throw new RangeError(`sport ${sport} has no markets`);
  return type;
}

/** A copy holding only the known language keys (jsonb may carry anything). */
export function localized(name: LocalizedNameValue): LocalizedNameValue {
  const result: LocalizedNameValue = { en: name.en };
  if (name.am !== undefined) result.am = name.am;
  if (name.om !== undefined) result.om = name.om;
  if (name.ti !== undefined) result.ti = name.ti;
  return result;
}

/**
 * Whether a selection can be put on a bet slip at `now`: the shared rule of
 * isSelectionBettable (@vamos/db), which the odds deltas use too. Prematch
 * betting closes at the start time even before the kick-off is recorded.
 */
export function isSelectionOpen(
  event: Pick<EventRow, 'status' | 'bettingOpen' | 'startTime'>,
  market: Pick<MarketRow, 'status'>,
  selection: Pick<SelectionRow, 'status'>,
  now: Date,
): boolean {
  return isSelectionBettable(event, market.status, selection.status, now);
}

/** The numeric value of a half-point line, or null when it is malformed. */
function lineValue(line: string): number | null {
  try {
    return parseLine(line);
  } catch {
    return null;
  }
}

/**
 * Whether a market row can be shown for a sport: a market type the sport
 * offers, with a well-formed line where the type needs one.
 */
export function isDisplayableMarket(
  sport: SportCode,
  market: Pick<MarketRow, 'type' | 'line'>,
): boolean {
  if (!isMarketTypeCode(market.type) || !SPORT_MARKETS[sport].includes(market.type)) return false;
  if (!MARKET_TYPES[market.type].hasLine) return market.line === null;
  return market.line !== null && lineValue(market.line) !== null;
}

/** MARKET_TYPES sortOrder, then line (line-less first), then id. Unknown types go last. */
export function compareMarkets(a: Pick<MarketRow, 'type' | 'line' | 'id'>, b: typeof a): number {
  const typeOrder = (type: string) =>
    isMarketTypeCode(type) ? MARKET_TYPES[type].sortOrder : Number.MAX_SAFE_INTEGER;
  const lineOrder = (line: string | null) =>
    line === null ? -1 : (lineValue(line) ?? Number.MAX_SAFE_INTEGER);
  return (
    typeOrder(a.type) - typeOrder(b.type) ||
    lineOrder(a.line) - lineOrder(b.line) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The market's wire view, or null when the row cannot be shown (a type the
 * sport does not offer, or a malformed line). Selections are put in selectionsFor order;
 * codes the market type does not have are dropped.
 */
export function marketView(
  event: EventRow,
  market: MarketRow,
  selections: readonly SelectionRow[],
  now: Date,
): MarketView | null {
  if (!isMarketTypeCode(market.type) || !isDisplayableMarket(event.sport, market)) return null;
  const type = market.type;
  const definition = MARKET_TYPES[type];

  const codes = selectionsFor(type);
  const position = new Map(codes.map((code, index) => [code, index]));
  const en = { home: event.home.name.en, away: event.away.name.en };
  const am = { home: event.home.name.am ?? en.home, away: event.away.name.am ?? en.away };
  const views: Array<{ index: number; view: SelectionView }> = [];
  for (const selection of selections) {
    const index = position.get(selection.code);
    if (index === undefined) continue;
    views.push({
      index,
      view: {
        id: selection.id,
        code: selection.code,
        label: {
          en: selectionLabel(type, selection.code, en, market.line).en,
          am: selectionLabel(type, selection.code, am, market.line).am,
        },
        oddsMilli: selection.oddsMilli,
        open: isSelectionOpen(event, market, selection, now),
      },
    });
  }
  views.sort((a, b) => a.index - b.index);

  return {
    id: market.id,
    type,
    line: market.line,
    name: { en: definition.name.en, am: definition.name.am },
    status: market.status,
    selections: views.map((entry) => entry.view),
  };
}

function scoreOf(
  status: EventStatus,
  home: number | null,
  away: number | null,
): { home: number; away: number } | null {
  if (status === 'scheduled' || home === null || away === null) return null;
  return { home, away };
}

function teamView(team: TeamRow): EventSummary['home'] {
  return { id: team.id, name: localized(team.name), shortName: team.shortName };
}

function summaryFields(event: EventRow): Omit<EventSummary, 'mainMarket' | 'marketCount'> {
  return {
    id: event.id,
    gameId: formatGameId(event.gameId),
    sport: event.sport,
    competition: {
      slug: event.competitionSlug,
      name: localized(event.competitionName),
      category: localized(event.categoryName),
      countryCode: event.categoryCountryCode,
    },
    home: teamView(event.home),
    away: teamView(event.away),
    startTime: event.startTime.toISOString(),
    status: event.status,
    liveMinute: event.liveMinute,
    period: event.period,
    score: scoreOf(event.status, event.scoreHome, event.scoreAway),
    oddsUpdatedAt: event.oddsUpdatedAt === null ? null : event.oddsUpdatedAt.toISOString(),
    simulated: event.feedProvider === 'mock',
  };
}

function isMainMarket(event: EventRow, market: MarketRow): boolean {
  return market.type === mainMarketType(event.sport) && market.line === null;
}

/** The main (line-less) market of the event's sport among `markets`, if any. */
export function findMainMarket(event: EventRow, markets: readonly MarketRow[]): MarketRow | null {
  return markets.find((market) => isMainMarket(event, market)) ?? null;
}

/**
 * A list row. `markets` are all of the event's markets; `mainSelections`
 * the selections of its main market. marketCount counts the other markets
 * that are open or suspended ("+N markets").
 */
export function eventSummaryView(
  event: EventRow,
  markets: readonly MarketRow[],
  mainSelections: readonly SelectionRow[],
  now: Date,
): EventSummary {
  const main = findMainMarket(event, markets);
  const marketCount = markets.filter(
    (market) =>
      market !== main &&
      LISTED_MARKET_STATUSES.has(market.status) &&
      isDisplayableMarket(event.sport, market),
  ).length;
  return {
    ...summaryFields(event),
    mainMarket: main === null ? null : marketView(event, main, mainSelections, now),
    marketCount,
  };
}

/** The event page: every market, ordered for display, with all selections. */
export function eventDetailView(
  event: EventRow,
  markets: readonly MarketRow[],
  selectionsByMarket: ReadonlyMap<string, readonly SelectionRow[]>,
  now: Date,
): EventDetail {
  const views = [...markets]
    .sort(compareMarkets)
    .map((market) => marketView(event, market, selectionsByMarket.get(market.id) ?? [], now))
    .filter((view): view is MarketView => view !== null);
  const main = findMainMarket(event, markets);
  const summary = eventSummaryView(
    event,
    markets,
    main === null ? [] : (selectionsByMarket.get(main.id) ?? []),
    now,
  );
  const htScore =
    event.status === 'scheduled' || event.htScoreHome === null || event.htScoreAway === null
      ? null
      : { home: event.htScoreHome, away: event.htScoreAway };
  return { ...summary, markets: views, htScore };
}

/** Groups rows by a key, keeping their order. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [row]);
    else group.push(row);
  }
  return groups;
}
