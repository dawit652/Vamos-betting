import type { EventSummary } from '@vamos/contracts';

/** Matches shown before "Show more". */
export const MATCHES_PAGE = 20;

/**
 * The matches a cashier may sell from the list: scheduled, not yet kicked off, with an open main
 * market. The catalogue already filters, but a list left open past kick-off must not offer one.
 */
export function sellableMatches(events: readonly EventSummary[], nowMs: number): EventSummary[] {
  return events
    .filter((e) => {
      const market = e.mainMarket;
      return (
        e.status === 'scheduled' &&
        Date.parse(e.startTime) > nowMs &&
        market !== null &&
        market.status === 'open'
      );
    })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** Keeps the matches where a team name (any language) contains the typed text, ignoring case. */
export function filterMatchesByTeam(
  events: readonly EventSummary[],
  query: string,
): EventSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...events];
  return events.filter((e) =>
    [e.home.name.en, e.home.name.am, e.away.name.en, e.away.name.am].some(
      (name) => name !== undefined && name.toLowerCase().includes(needle),
    ),
  );
}
