import { isCalendarDate, isEventDayInRange } from '@vamos/contracts';

/**
 * Home / sport list tabs, carried in the URL (`?tab=today&cursor=…`) so the
 * lists render on the server without client state.
 */
export const LIST_TABS = ['highlights', 'today', 'upcoming', 'leagues'] as const;
export type ListTab = (typeof LIST_TABS)[number];
/** The site opens on Today (owner, 23 Nov 2026: "the default screen should be football-today"). */
export const DEFAULT_TAB: ListTab = 'today';

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

/** List market shown on each row: 1X2 (default) or double chance. */
export const LIST_MARKETS = ['1x2', 'dc'] as const;
export type ListMarket = (typeof LIST_MARKETS)[number];

export function parseMarket(value: SearchValue): ListMarket {
  return first(value) === 'dc' ? 'dc' : '1x2';
}

/** A category slug from the query string, or undefined. */
export function parseCountry(value: SearchValue): string | undefined {
  const country = first(value);
  return country !== undefined && /^[a-z0-9-]{1,100}$/.test(country) ? country : undefined;
}

/** `?day=` when it is a real Addis Ababa date from today to today + 14, else undefined. */
export function parseDay(value: SearchValue, now: Date): string | undefined {
  const day = first(value);
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return isCalendarDate(day) && isEventDayInRange(day, now) ? day : undefined;
}

/** "Starts within" choices, in hours. */
export const STARTS_WITHIN_HOURS = [1, 3, 6, 12, 24] as const;

/** `?within=` when it is one of STARTS_WITHIN_HOURS, else undefined. */
export function parseWithin(value: SearchValue): number | undefined {
  const raw = first(value);
  if (raw === undefined || !/^\d{1,2}$/.test(raw)) return undefined;
  const hours = Number(raw);
  return (STARTS_WITHIN_HOURS as readonly number[]).includes(hours) ? hours : undefined;
}

/** The list parameters besides the tab and the cursor, kept across the controls' links. */
export interface ListFilters {
  within?: number | undefined;
  day?: string | undefined;
  country?: string | undefined;
  market?: ListMarket | undefined;
}

/**
 * `/sport/basketball?tab=today&day=2026-10-09&country=england&market=dc&cursor=…`;
 * defaults (highlights tab, 1X2) and absent values are left out, so no
 * parameters give the bare path. Changing any control omits the cursor.
 */
export function listHref(
  path: string,
  tab: ListTab,
  cursor?: string,
  filters: ListFilters = {},
): string {
  const params = new URLSearchParams();
  if (tab !== DEFAULT_TAB) params.set('tab', tab);
  if (filters.within !== undefined) params.set('within', String(filters.within));
  if (filters.day !== undefined) params.set('day', filters.day);
  if (filters.country !== undefined) params.set('country', filters.country);
  if (filters.market === 'dc') params.set('market', 'dc');
  if (cursor !== undefined) params.set('cursor', cursor);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}
