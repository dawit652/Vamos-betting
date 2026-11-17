import type {
  EventDetail,
  EventSummary,
  LocalizedNameValue,
  MarketView,
  SelectionView,
} from '@vamos/contracts';
import {
  amharicName,
  factoryMarketName,
  factoryMarketSortOrder,
  factorySelectionLabel,
  findFactoryMarket,
  formatGameId,
  isFactoryOnlyMarketType,
  MARKET_TYPES,
  marketLineValue,
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

/** Switches of the catalogue views (config.features). */
export interface ViewOptions {
  /** FEATURE_FACTORY_MARKETS: also show the market factory's football markets. */
  factoryMarkets?: boolean;
}

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
  home: TeamRow;
  away: TeamRow;
  startTime: Date;
  status: EventStatus;
  bettingOpen: boolean;
  /** events.close_lead_ms: prematch betting closes this long before startTime. */
  closeLeadMs: number;
  liveMinute: number | null;
  period: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  htScoreHome: number | null;
  htScoreAway: number | null;
}

export interface MarketRow {
  id: string;
  eventId: string;
  type: string;
  line: string | null;
  status: MarketStatus;
  /** markets.price_valid_until (rule P7); null or absent never expires. */
  priceValidUntil?: Date | null;
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

/**
 * A copy holding only the known language keys (jsonb may carry anything). A team, competition or
 * country with no Amharic gets it from amharicName (@vamos/core; the feeds give English only, and
 * the owner wants every name in Amharic for an Amharic page); one written in Amharic stays.
 */
export function localized(name: LocalizedNameValue): LocalizedNameValue {
  const result: LocalizedNameValue = { en: name.en };
  result.am = name.am !== undefined && name.am.trim() !== '' ? name.am : amharicName(name.en);
  if (name.om !== undefined) result.om = name.om;
  if (name.ti !== undefined) result.ti = name.ti;
  return result;
}

/**
 * Whether a selection can be put on a bet slip at `now`: the shared rule of
 * isSelectionBettable (@vamos/db), which the odds deltas use too. Prematch
 * betting closes at the start time (minus the event's close lead) even before
 * the kick-off is recorded.
 */
export function isSelectionOpen(
  event: Pick<EventRow, 'status' | 'bettingOpen' | 'startTime' | 'closeLeadMs'>,
  market: Pick<MarketRow, 'status'>,
  selection: Pick<SelectionRow, 'status'>,
  now: Date,
): boolean {
  return isSelectionBettable(event, market.status, selection.status, now);
}

/**
 * The status a market is shown with at `now`: an open market whose price has expired (rule P7,
 * `price_valid_until` at or before `now`) is shown suspended, as bet placement already treats it
 * (task 1.10). Every other status is shown as stored.
 */
export function displayedMarketStatus(
  market: Pick<MarketRow, 'status' | 'priceValidUntil'>,
  now: Date,
): MarketStatus {
  const until = market.priceValidUntil;
  if (
    market.status === 'open' &&
    until !== null &&
    until !== undefined &&
    now.getTime() >= until.getTime()
  ) {
    return 'suspended';
  }
  return market.status;
}

/** The market fields both views share: the status shown at `now` and the expiry, if any. */
function marketStatusFields(
  market: MarketRow,
  now: Date,
): Pick<MarketView, 'status' | 'priceValidUntil'> {
  const until = market.priceValidUntil;
  return {
    status: displayedMarketStatus(market, now),
    ...(until === null || until === undefined ? {} : { priceValidUntil: until.toISOString() }),
  };
}

/** The numeric value of a market's line (a total or a handicap), or null when it is malformed. */
function lineValue(type: MarketTypeCode, line: string): number | null {
  try {
    return marketLineValue(type, line);
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
  options: ViewOptions = {},
): boolean {
  if (options.factoryMarkets === true && isDisplayableFactoryMarket(sport, market)) return true;
  if (!isMarketTypeCode(market.type) || !SPORT_MARKETS[sport].includes(market.type)) return false;
  if (!MARKET_TYPES[market.type].hasLine) return market.line === null;
  return market.line !== null && lineValue(market.type, market.line) !== null;
}

/**
 * A football market only the factory defines, stored with the factory's own
 * (canonical) line. Whether the selections fit is checked per selection.
 */
function isDisplayableFactoryMarket(
  sport: SportCode,
  market: Pick<MarketRow, 'type' | 'line'>,
): boolean {
  if (sport !== 'football' || !isFactoryOnlyMarketType(market.type)) return false;
  const definition = findFactoryMarket(market.type, market.line);
  return definition !== undefined && definition.line === market.line;
}

/** MARKET_TYPES sortOrder, then line (line-less first), then id. Unknown types go last. */
export function compareMarkets(a: Pick<MarketRow, 'type' | 'line' | 'id'>, b: typeof a): number {
  const typeOrder = (type: string, line: string | null) =>
    isMarketTypeCode(type)
      ? MARKET_TYPES[type].sortOrder
      : isFactoryOnlyMarketType(type)
        ? factoryMarketSortOrder(type, line)
        : Number.MAX_SAFE_INTEGER;
  const lineOrder = (type: string, line: string | null) =>
    line === null
      ? -1
      : ((isMarketTypeCode(type) ? lineValue(type, line) : null) ?? Number.MAX_SAFE_INTEGER);
  return (
    typeOrder(a.type, a.line) - typeOrder(b.type, b.line) ||
    lineOrder(a.type, a.line) - lineOrder(b.type, b.line) ||
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
  options: ViewOptions = {},
): MarketView | null {
  if (!isDisplayableMarket(event.sport, market, options)) return null;
  if (!isMarketTypeCode(market.type)) return factoryMarketView(event, market, selections, now);
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
        open: isSelectionOpen(
          event,
          { status: displayedMarketStatus(market, now) },
          selection,
          now,
        ),
      },
    });
  }
  views.sort((a, b) => a.index - b.index);

  return {
    id: market.id,
    type,
    line: market.line,
    name: { en: definition.name.en, am: definition.name.am },
    ...marketStatusFields(market, now),
    selections: views.map((entry) => entry.view),
  };
}

/** A factory-only market (already checked displayable): labels from the factory, its group. */
function factoryMarketView(
  event: EventRow,
  market: MarketRow,
  selections: readonly SelectionRow[],
  now: Date,
): MarketView | null {
  const definition = findFactoryMarket(market.type, market.line);
  if (definition === undefined) return null;
  const position = new Map(definition.selections.map((code, index) => [code, index]));
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
          en: factorySelectionLabel(market.type, selection.code, en, market.line).en,
          am: factorySelectionLabel(market.type, selection.code, am, market.line).am,
        },
        oddsMilli: selection.oddsMilli,
        open: isSelectionOpen(
          event,
          { status: displayedMarketStatus(market, now) },
          selection,
          now,
        ),
      },
    });
  }
  views.sort((a, b) => a.index - b.index);
  const name = factoryMarketName(market.type, market.line);
  return {
    id: market.id,
    type: market.type,
    line: market.line,
    name: { en: name.en, am: name.am },
    group: definition.group,
    ...marketStatusFields(market, now),
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

function summaryFields(
  event: EventRow,
): Omit<EventSummary, 'mainMarket' | 'marketCount' | 'optionCount'> {
  return {
    id: event.id,
    gameId: formatGameId(event.gameId),
    sport: event.sport,
    competition: {
      slug: event.competitionSlug,
      name: localized(event.competitionName),
      category: localized(event.categoryName),
    },
    home: teamView(event.home),
    away: teamView(event.away),
    startTime: event.startTime.toISOString(),
    status: event.status,
    liveMinute: event.liveMinute,
    period: event.period,
    score: scoreOf(event.status, event.scoreHome, event.scoreAway),
  };
}

/**
 * The main (line-less) market among `markets`, if any: the sport's first
 * market type, or `type` when given (double chance on a list row).
 */
export function findMainMarket(
  event: EventRow,
  markets: readonly MarketRow[],
  type: MarketTypeCode = mainMarketType(event.sport),
): MarketRow | null {
  return markets.find((market) => market.type === type && market.line === null) ?? null;
}

/**
 * A list row. `markets` are all of the event's markets; `mainSelections`
 * the selections of its main market. marketCount counts the other markets
 * that are open or suspended ("+N markets"); optionCount sums the selections of
 * those same markets, from `selectionCounts` (market id to number of selections).
 */
export function eventSummaryView(
  event: EventRow,
  markets: readonly MarketRow[],
  mainSelections: readonly SelectionRow[],
  now: Date,
  mainType?: MarketTypeCode,
  options: ViewOptions = {},
  selectionCounts?: ReadonlyMap<string, number>,
): EventSummary {
  const main = findMainMarket(event, markets, mainType);
  const counted = markets.filter(
    (market) =>
      market !== main &&
      LISTED_MARKET_STATUSES.has(market.status) &&
      isDisplayableMarket(event.sport, market, options),
  );
  const marketCount = counted.length;
  return {
    ...summaryFields(event),
    mainMarket: main === null ? null : marketView(event, main, mainSelections, now),
    marketCount,
    ...(selectionCounts === undefined
      ? {}
      : {
          optionCount: counted.reduce(
            (sum, market) => sum + (selectionCounts.get(market.id) ?? 0),
            0,
          ),
        }),
  };
}

/** The event page: every market, ordered for display, with all selections. */
export function eventDetailView(
  event: EventRow,
  markets: readonly MarketRow[],
  selectionsByMarket: ReadonlyMap<string, readonly SelectionRow[]>,
  now: Date,
  options: ViewOptions = {},
): EventDetail {
  const views = [...markets]
    .sort(compareMarkets)
    .map((market) =>
      marketView(event, market, selectionsByMarket.get(market.id) ?? [], now, options),
    )
    .filter((view): view is MarketView => view !== null);
  const main = findMainMarket(event, markets);
  const summary = eventSummaryView(
    event,
    markets,
    main === null ? [] : (selectionsByMarket.get(main.id) ?? []),
    now,
    undefined,
    options,
    new Map([...selectionsByMarket].map(([id, rows]) => [id, rows.length])),
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
