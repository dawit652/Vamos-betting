import {
  eventListQueryAt,
  type CompetitionsResponse,
  type EventDetail,
  type EventListResponse,
  SearchQuery,
  type SearchResponse,
  type SportsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CatalogCache, stableKey } from '../../lib/catalog-cache';
import { notFound, parseInput } from '../../lib/errors';
import {
  getEventByGameId,
  getEventById,
  listCompetitions,
  listEvents,
  listSports,
  searchCatalog,
  getTeamLogo,
} from './queries';
import type { ViewOptions } from './views';

/** Lists change with every odds tick; a few seconds of caching absorbs refresh storms. */
export const LIST_CACHE_CONTROL = 'public, max-age=5';
/** Event pages carry live odds; clients follow changes over /live/stream. */
export const DETAIL_CACHE_CONTROL = 'public, max-age=2';

function cache(reply: FastifyReply, value: string): void {
  void reply.header('cache-control', value);
}

/**
 * Public sports catalogue (no authentication): sports, competitions, event
 * lists and event pages. The live updates stream (./live) is registered by
 * registerModules, as it depends on the API role.
 */
export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  /** Read per request, so the switch is the config's current value. */
  const viewOptions = (): ViewOptions => ({
    factoryMarkets: deps.config.features.factoryMarkets,
  });

  /**
   * Only the three public lists go through this cache (never event pages,
   * search, per-player data or betting). It follows the injected clock.
   */
  const lists = new CatalogCache({
    redis: deps.redis,
    clock: deps.clock,
    seconds: deps.config.api.catalogCacheSeconds,
  });

  app.get('/sports', async (_request, reply): Promise<SportsResponse> => {
    const body = await lists.get(stableKey({ route: 'sports' }), () =>
      listSports(deps.db, deps.clock()),
    );
    cache(reply, LIST_CACHE_CONTROL);
    return body;
  });

  app.get<{ Params: { sport: string } }>(
    '/sports/:sport/competitions',
    async (request, reply): Promise<CompetitionsResponse> => {
      const sport = request.params.sport;
      const body = await lists.get(stableKey({ route: 'competitions', sport }), () =>
        listCompetitions(deps.db, sport, deps.clock()),
      );
      if (body === null) throw notFound('Sport');
      cache(reply, LIST_CACHE_CONTROL);
      return body;
    },
  );

  app.get('/events', async (request, reply): Promise<EventListResponse> => {
    const now = deps.clock();
    const query = parseInput(eventListQueryAt(now), request.query);
    const options = viewOptions();
    // The normalised query (after zod defaults) plus the setting that changes the view.
    const key = stableKey({ route: 'events', ...query, factoryMarkets: options.factoryMarkets });
    const body = await lists.get(key, () => listEvents(deps.db, query, now, options));
    cache(reply, LIST_CACHE_CONTROL);
    return body;
  });

  // A team's logo (owner, 17 Nov 2026): the URL carries the logo's version (TeamView.logo), so it
  // may be kept a week.
  app.get<{ Params: { id: string } }>('/teams/:id/logo', async (request, reply) => {
    const png = await getTeamLogo(deps.db, request.params.id);
    if (png === null) throw notFound('Logo');
    void reply
      .type('image/png')
      .header('cache-control', 'public, max-age=604800, immutable')
      .header('x-content-type-options', 'nosniff');
    return png;
  });

  app.get('/search', async (request, reply): Promise<SearchResponse> => {
    const query = parseInput(SearchQuery, request.query);
    const body = await searchCatalog(deps.db, query, deps.clock(), viewOptions());
    cache(reply, LIST_CACHE_CONTROL);
    return body;
  });

  app.get<{ Params: { gameId: string } }>(
    '/events/by-game-id/:gameId',
    async (request, reply): Promise<EventDetail> => {
      const body = await getEventByGameId(
        deps.db,
        request.params.gameId,
        deps.clock(),
        viewOptions(),
      );
      if (body === null) throw notFound('Event');
      cache(reply, DETAIL_CACHE_CONTROL);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/events/:id',
    async (request, reply): Promise<EventDetail> => {
      const body = await getEventById(deps.db, request.params.id, deps.clock(), viewOptions());
      if (body === null) throw notFound('Event');
      cache(reply, DETAIL_CACHE_CONTROL);
      return body;
    },
  );
}
