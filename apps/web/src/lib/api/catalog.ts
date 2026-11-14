import 'server-only';
import type {
  CompetitionsResponse,
  EventDetail,
  EventListQuery,
  EventListResponse,
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
 */

export const getSports = cache((): Promise<SportsResponse> => serverGet<SportsResponse>('/sports'));

export const getCompetitions = cache((sport: string): Promise<CompetitionsResponse | null> =>
  serverGetOrNull<CompetitionsResponse>(`/sports/${encodeURIComponent(sport)}/competitions`),
);

export function getEvents(query: Partial<EventListQuery> = {}): Promise<EventListResponse> {
  return serverGet<EventListResponse>('/events', { query });
}

/** Live and coming matches by team, competition or Game ID (`q` of 2 to 60 characters). */
export function searchEvents(q: string): Promise<EventListResponse> {
  return serverGet<EventListResponse>('/events/search', { query: { q } });
}

export function getEvent(eventId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/${encodeURIComponent(eventId)}`);
}

export function getEventByGameId(gameId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/by-game-id/${encodeURIComponent(gameId)}`);
}
