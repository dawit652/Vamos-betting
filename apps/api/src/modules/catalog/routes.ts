import {
  EventListQuery,
  type CompetitionsResponse,
  type EventDetail,
  type EventListResponse,
  type SportsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import liveRoutes from './live';
import {
  getEventByGameId,
  getEventById,
  listCompetitions,
  listEvents,
  listSports,
} from './queries';

/** Lists change with every odds tick; a few seconds of caching absorbs refresh storms. */
export const LIST_CACHE_CONTROL = 'public, max-age=5';
/** Event pages carry live odds; clients follow changes over /live/stream. */
export const DETAIL_CACHE_CONTROL = 'public, max-age=2';

function cache(reply: FastifyReply, value: string): void {
  void reply.header('cache-control', value);
}

/**
 * Public sports catalogue (no authentication): sports, competitions, event
 * lists and event pages, plus the live updates stream (see ./live).
 */
export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/sports', async (_request, reply): Promise<SportsResponse> => {
    const body = await listSports(deps.db, deps.clock());
    cache(reply, LIST_CACHE_CONTROL);
    return body;
  });

  app.get<{ Params: { sport: string } }>(
    '/sports/:sport/competitions',
    async (request, reply): Promise<CompetitionsResponse> => {
      const body = await listCompetitions(deps.db, request.params.sport, deps.clock());
      if (body === null) throw notFound('Sport');
      cache(reply, LIST_CACHE_CONTROL);
      return body;
    },
  );

  app.get('/events', async (request, reply): Promise<EventListResponse> => {
    const query = parseInput(EventListQuery, request.query);
    const body = await listEvents(deps.db, query, deps.clock());
    cache(reply, LIST_CACHE_CONTROL);
    return body;
  });

  app.get<{ Params: { gameId: string } }>(
    '/events/by-game-id/:gameId',
    async (request, reply): Promise<EventDetail> => {
      const body = await getEventByGameId(deps.db, request.params.gameId);
      if (body === null) throw notFound('Event');
      cache(reply, DETAIL_CACHE_CONTROL);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/events/:id',
    async (request, reply): Promise<EventDetail> => {
      const body = await getEventById(deps.db, request.params.id);
      if (body === null) throw notFound('Event');
      cache(reply, DETAIL_CACHE_CONTROL);
      return body;
    },
  );

  await app.register(liveRoutes);
}
