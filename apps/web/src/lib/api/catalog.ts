import 'server-only';
import type {
  CompetitionsResponse,
  EventDetail,
  EventListQuery,
  EventListResponse,
  SearchResponse,
  SportsResponse,
} from '@vamos/contracts';
import { cache } from 'react';
import { serverGet, serverGetOrNull } from './server';

/**
 * Typed public catalogue calls for server components. Lists render on the
 * server; client islands only patch odds from the live stream.
 *
 * `getSports` and `getCompetitions` are shared by the page and its navigation
 * (SportsbookFrame), so they are deduplicated per request with React `cache`.
 *
 * The three list calls (sports, competitions, events) are also shared between requests for 2 s
 * (CATALOG_REUSE_MS, see ./reuse). A single event, a game id and the search are not: they stay
 * current, and nothing under /me or /admin comes through here at all.
 */

export const getSports = cache((): Promise<SportsResponse> =>
  serverGet<SportsResponse>('/sports', { reuse: true }),
);

/** Once per request: the home page's league shortcuts and its Leagues tab share the result. */
export const getCompetitions = cache((sport: string): Promise<CompetitionsResponse | null> =>
  serverGetOrNull<CompetitionsResponse>(`/sports/${encodeURIComponent(sport)}/competitions`, {
    reuse: true,
  }),
);

export function getEvents(query: Partial<EventListQuery> = {}): Promise<EventListResponse> {
  return serverGet<EventListResponse>('/events', { query, reuse: true });
}

export function getEvent(eventId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/${encodeURIComponent(eventId)}`);
}

export function getEventByGameId(gameId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/by-game-id/${encodeURIComponent(gameId)}`);
}

export function searchCatalog(q: string): Promise<SearchResponse> {
  return serverGet<SearchResponse>('/search', { query: { q } });
}
