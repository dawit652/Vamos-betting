import {
  JackpotEntryRequest,
  JackpotListQuery,
  MyJackpotEntriesQuery,
  type JackpotEntryView,
  type JackpotListResponse,
  type JackpotRoundView,
  type MyJackpotEntriesResponse,
  type PromotionsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput } from '../../lib/errors';
import { IDEMPOTENT_REPLAYED_HEADER, readIdempotencyKey } from '../../lib/idempotency';
import { requireUser } from '../../plugins/session';
import {
  getJackpot,
  getMyJackpotEntry,
  listJackpots,
  listMyJackpotEntries,
  listPromotions,
  placePlayerJackpotEntry,
} from './service';

const MINUTE_MS = 60_000;

/** Per-route limits (requests per minute). */
export const JACKPOT_RATE_LIMITS = {
  /** Per player: placing jackpot entries. */
  placeEntry: 30,
} as const;

/**
 * Round lists and pages change when a round opens, closes or settles (and
 * the games' odds and scores, shown for information); a few seconds of
 * caching absorbs refresh storms.
 */
export const JACKPOT_CACHE_CONTROL = 'public, max-age=5';

/** After the session hook, so a logged-in player gets their own budget. */
function perPlayer(name: string, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: MINUTE_MS,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) =>
        request.user === null
          ? `${name}|ip|${clientAddressKey(request.ip)}`
          : `${name}|user|${request.user.id}`,
    },
  };
}

function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

function publicCache(reply: FastifyReply): void {
  void reply.header('cache-control', JACKPOT_CACHE_CONTROL);
}

/**
 * Jackpots (Phase 8; see jackpots.ts in @vamos/contracts): the public round
 * lists and pages, entry placement and the player's entries (My Bets
 * jackpot tab), and the public promotions summary. Placement runs
 * placeJackpotEntry (@vamos/db) in one transaction; its DomainErrors (404,
 * 409 jackpot_closed, 422 jackpot_entry_invalid / insufficient_funds /
 * idempotency_key_reused / limits, 403 exclusions) are rendered by the
 * app's error handler.
 */
export default async function jackpotRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/jackpots', async (request, reply): Promise<JackpotListResponse> => {
    const query = parseInput(JackpotListQuery, request.query);
    const body = await listJackpots(deps, query);
    publicCache(reply);
    return body;
  });

  app.get<{ Params: { id: string } }>(
    '/jackpots/:id',
    async (request, reply): Promise<JackpotRoundView> => {
      const body = await getJackpot(deps, request.params.id);
      publicCache(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/jackpots/:id/entries',
    {
      preHandler: app.requireAuth,
      config: perPlayer('jackpot-entry', JACKPOT_RATE_LIMITS.placeEntry),
    },
    async (request, reply): Promise<JackpotEntryView> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(JackpotEntryRequest, request.body);
      const result = await placePlayerJackpotEntry(deps, {
        userId: user.id,
        roundId: request.params.id,
        idempotencyKey,
        request: input,
        ip: request.ip,
      });
      if (result.replayed) {
        void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
        void reply.status(200);
      } else {
        void reply.status(201);
      }
      noStore(reply);
      return result.entry;
    },
  );

  app.get(
    '/me/jackpot-entries',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<MyJackpotEntriesResponse> => {
      const user = requireUser(request);
      const query = parseInput(MyJackpotEntriesQuery, request.query);
      const body = await listMyJackpotEntries(deps, user.id, query);
      noStore(reply);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/me/jackpot-entries/:id',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<JackpotEntryView> => {
      const user = requireUser(request);
      const body = await getMyJackpotEntry(deps, user.id, request.params.id);
      noStore(reply);
      return body;
    },
  );

  app.get('/promotions', async (_request, reply): Promise<PromotionsResponse> => {
    const body = await listPromotions(deps);
    publicCache(reply);
    return body;
  });
}
