import 'server-only';
import type {
  CompetitionsResponse,
  EventDetail,
  EventListQuery,
  EventListResponse,
  SportsResponse,
} from '@vamos/contracts';
import { serverGet, serverGetOrNull } from './server';

/**
 * Typed public catalogue calls for server components. Lists render on the
 * server; client islands only patch odds from the live stream.
 */

export function getSports(): Promise<SportsResponse> {
  return serverGet<SportsResponse>('/sports');
}

export function getCompetitions(sport: string): Promise<CompetitionsResponse | null> {
  return serverGetOrNull<CompetitionsResponse>(`/sports/${encodeURIComponent(sport)}/competitions`);
}

export function getEvents(query: Partial<EventListQuery> = {}): Promise<EventListResponse> {
  return serverGet<EventListResponse>('/events', { query });
}

export function getEvent(eventId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/${encodeURIComponent(eventId)}`);
}

export function getEventByGameId(gameId: string): Promise<EventDetail | null> {
  return serverGetOrNull<EventDetail>(`/events/by-game-id/${encodeURIComponent(gameId)}`);
}
