import type { ResolutionInput } from '@vamos/core';
import {
  EventBettingRequest,
  EventSuspendRequest,
  EventTopMatchRequest,
  ResultEventRequest,
  ResultEventResponse,
  SetMarketStatusRequest,
  SetOddsRequest,
  SetOddsResponse,
  TradingEventListResponse,
  TradingEventQuery,
  TradingEventView,
  VoidRequest,
  VoidResponse,
  type ChangedResponse,
} from '@vamos/contracts';
import {
  getTradingEvent,
  searchTradingEvents,
  staffResultEvent,
  staffSetEventBettingOpen,
  staffSetEventSuspended,
  staffSetEventTopMatch,
  staffSetMarketStatus,
  staffSetOdds,
  staffVoidMarket,
  staffVoidSelection,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { inTx, optionalDate, parseUuid, publishLive, wire } from './common';

type IdParams = { Params: { id: string } };

/**
 * Trading (trading.view / .odds / .status / .result / .void) over the
 * catalogue services. Every change is audited with the staff actor in its
 * transaction; live deltas are published after COMMIT, and settlement
 * (re-)settles the bets from the outbox events the services write.
 */
export default async function adminTradingRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/trading/events', { config: { staff: 'trading.view' } }, async (request) => {
    const query = parseInput(TradingEventQuery, request.query);
    const page = await searchTradingEvents(deps.db, {
      ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
      ...(query.status === undefined || query.status.length === 0
        ? {}
        : { statuses: query.status }),
      ...(query.sport === undefined || query.sport === '' ? {} : { sportId: query.sport }),
      ...(query.from === undefined ? {} : { from: optionalDate(query.from) }),
      ...(query.to === undefined ? {} : { to: optionalDate(query.to) }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(TradingEventListResponse, page);
  });

  app.get<IdParams>(
    '/admin/trading/events/:id',
    { config: { staff: 'trading.view' } },
    async (request) => {
      const event = await getTradingEvent(deps.db, parseUuid(request.params.id, 'Event'));
      if (event === null) throw notFound('Event');
      return wire(TradingEventView, event);
    },
  );

  app.post<IdParams>(
    '/admin/trading/selections/:id/odds',
    { config: { staff: 'trading.odds' } },
    async (request) => {
      const selectionId = parseUuid(request.params.id, 'Selection');
      const input = parseInput(SetOddsRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const change = await inTx(deps, (tx) =>
        staffSetOdds(tx, {
          selectionId,
          oddsMilli: input.oddsMilli,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
          now,
        }),
      );
      await publishLive(app, change.messages);
      return wire(SetOddsResponse, change);
    },
  );

  app.post<IdParams>(
    '/admin/trading/markets/:id/status',
    { config: { staff: 'trading.status' } },
    async (request): Promise<ChangedResponse> => {
      const marketId = parseUuid(request.params.id, 'Market');
      const input = parseInput(SetMarketStatusRequest, request.body);
      const actor = staffActor(request);
      const change = await inTx(deps, (tx) =>
        staffSetMarketStatus(tx, {
          marketId,
          status: input.status,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
        }),
      );
      await publishLive(app, change.messages);
      return { changed: change.changed };
    },
  );

  for (const [path, suspended] of [
    ['suspend', true],
    ['resume', false],
  ] as const) {
    app.post<IdParams>(
      `/admin/trading/events/:id/${path}`,
      { config: { staff: 'trading.status' } },
      async (request): Promise<ChangedResponse> => {
        const eventId = parseUuid(request.params.id, 'Event');
        const input = parseInput(EventSuspendRequest, request.body ?? {});
        const actor = staffActor(request);
        const change = await inTx(deps, (tx) =>
          staffSetEventSuspended(tx, {
            eventId,
            suspended,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            actor,
          }),
        );
        await publishLive(app, change.messages);
        return { changed: change.changed };
      },
    );
  }

  app.post<IdParams>(
    '/admin/trading/events/:id/betting',
    { config: { staff: 'trading.status' } },
    async (request): Promise<ChangedResponse> => {
      const eventId = parseUuid(request.params.id, 'Event');
      const input = parseInput(EventBettingRequest, request.body);
      const actor = staffActor(request);
      const change = await inTx(deps, (tx) =>
        staffSetEventBettingOpen(tx, {
          eventId,
          open: input.open,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
        }),
      );
      await publishLive(app, change.messages);
      return { changed: change.changed };
    },
  );

  app.post<IdParams>(
    '/admin/trading/events/:id/top',
    { config: { staff: 'trading.status' } },
    async (request): Promise<ChangedResponse> => {
      const eventId = parseUuid(request.params.id, 'Event');
      const input = parseInput(EventTopMatchRequest, request.body);
      const actor = staffActor(request);
      const change = await inTx(deps, (tx) =>
        staffSetEventTopMatch(tx, {
          eventId,
          top: input.top,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
        }),
      );
      return { changed: change.changed };
    },
  );

  app.post<IdParams>(
    '/admin/trading/events/:id/result',
    { config: { staff: 'trading.result' } },
    async (request) => {
      const eventId = parseUuid(request.params.id, 'Event');
      const input = parseInput(ResultEventRequest, request.body);
      const result: ResolutionInput =
        input.status === 'finished'
          ? {
              status: 'finished',
              score: {
                home: input.score.home,
                away: input.score.away,
                htHome: input.score.htHome ?? null,
                htAway: input.score.htAway ?? null,
              },
            }
          : { status: input.status };
      const actor = staffActor(request);
      const now = deps.clock();
      const outcome = await inTx(deps, (tx) =>
        staffResultEvent(tx, {
          eventId,
          result,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
          now,
        }),
      );
      await publishLive(app, outcome.messages);
      return wire(ResultEventResponse, outcome);
    },
  );

  app.post<IdParams>(
    '/admin/trading/markets/:id/void',
    { config: { staff: 'trading.void' } },
    async (request) => {
      const marketId = parseUuid(request.params.id, 'Market');
      const input = parseInput(VoidRequest, request.body);
      const actor = staffActor(request);
      const outcome = await inTx(deps, (tx) =>
        staffVoidMarket(tx, { marketId, reason: input.reason, actor }),
      );
      await publishLive(app, outcome.messages);
      return wire(VoidResponse, outcome);
    },
  );

  app.post<IdParams>(
    '/admin/trading/selections/:id/void',
    { config: { staff: 'trading.void' } },
    async (request) => {
      const selectionId = parseUuid(request.params.id, 'Selection');
      const input = parseInput(VoidRequest, request.body);
      const actor = staffActor(request);
      const outcome = await inTx(deps, (tx) =>
        staffVoidSelection(tx, { selectionId, reason: input.reason, actor }),
      );
      await publishLive(app, outcome.messages);
      return wire(VoidResponse, outcome);
    },
  );
}
