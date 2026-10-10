/**
 * Home / sport list tabs, carried in the URL (`?tab=today&cursor=…`) so the
 * lists render on the server without client state.
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

/** `/sport/basketball?tab=today&cursor=…`; the default tab and no cursor give the bare path. */
export function listHref(path: string, tab: ListTab, cursor?: string): string {
  const params = new URLSearchParams();
  if (tab !== DEFAULT_TAB) params.set('tab', tab);
  if (cursor !== undefined) params.set('cursor', cursor);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}
