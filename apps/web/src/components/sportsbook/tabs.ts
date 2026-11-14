/**
 * Home / sport list tabs, carried in the URL (`?tab=today&cursor=…`) so the
 * lists render on the server without client state. So are the day of the Today
 * tab (`?day=`) and the market shown on the rows (`?market=dc`).
 */
export const LIST_TABS = ['highlights', 'today', 'upcoming', 'leagues'] as const;
export type ListTab = (typeof LIST_TABS)[number];
export const DEFAULT_TAB: ListTab = 'highlights';

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseTab(value: SearchValue): ListTab {
  const tab = first(value);
  return (LIST_TABS as readonly string[]).includes(tab ?? '') ? (tab as ListTab) : DEFAULT_TAB;
}

/** An event-list cursor from the query string (opaque base64url from the API), or undefined. */
export function parseCursor(value: SearchValue): string | undefined {
  const cursor = first(value);
  return cursor !== undefined && /^[\w-]{1,512}$/.test(cursor) ? cursor : undefined;
}

/** The market of list rows (`?market=dc`): the main market, or double chance (football only). */
export const ROW_MARKETS = ['main', 'dc'] as const;
export type RowMarket = (typeof ROW_MARKETS)[number];

/** Sports whose lists can switch to double chance. */
export function hasRowMarkets(sport: string): boolean {
  return sport === 'football';
}

export function parseMarket(value: SearchValue, sport: string): RowMarket {
  return first(value) === 'dc' && hasRowMarkets(sport) ? 'dc' : 'main';
}

/** East Africa Time is UTC+3 all year (no daylight saving). */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
/** Day chips of the Today tab: today and the six days after it. */
export const DAY_CHIPS = 7;

/** The East Africa calendar dates (`YYYY-MM-DD`) of the day chips, today first. */
export function chipDays(now: Date = new Date()): string[] {
  const today = now.getTime() + EAT_OFFSET_MS;
  return Array.from({ length: DAY_CHIPS }, (_, index) =>
    new Date(today + index * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * A day of the Today tab from the query string (`?day=2026-11-15`): one of the
 * chip days after today, or undefined (today, or anything else).
 */
export function parseDay(value: SearchValue, now: Date = new Date()): string | undefined {
  const day = first(value);
  return day !== undefined && chipDays(now).indexOf(day) > 0 ? day : undefined;
}

/**
 * `/sport/basketball?tab=today&day=…&market=dc&cursor=…`; the default tab, today,
 * the main market and no cursor give the bare path.
 */
export function listHref(
  path: string,
  tab: ListTab,
  options: { cursor?: string | undefined; day?: string | undefined; market?: RowMarket } = {},
): string {
  const params = new URLSearchParams();
  if (tab !== DEFAULT_TAB) params.set('tab', tab);
  if (options.day !== undefined) params.set('day', options.day);
  if (options.market !== undefined && options.market !== 'main') {
    params.set('market', options.market);
  }
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}
