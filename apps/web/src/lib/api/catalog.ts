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
 */

export function getSports(): Promise<SportsResponse> {
  return serverGet<SportsResponse>('/sports');
}

/** Once per request: the home page's league shortcuts and its Leagues tab share the result. */
export const getCompetitions = cache((sport: string): Promise<CompetitionsResponse | null> =>
  serverGetOrNull<CompetitionsResponse>(`/sports/${encodeURIComponent(sport)}/competitions`),
);

export function getEvents(query: Partial<EventListQuery> = {}): Promise<EventListResponse> {
  return serverGet<EventListResponse>('/events', { query });
}

export function getEvent(eventId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/${encodeURIComponent(eventId)}`);
}

export function getEventByGameId(gameId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/by-game-id/${encodeURIComponent(gameId)}`);
}
