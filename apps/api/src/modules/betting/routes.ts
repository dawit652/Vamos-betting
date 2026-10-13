import {
  CashOutOffersQuery,
  CashOutRequest,
  CreateBookingCodeRequest,
  MyBetsQuery,
  PlaceBetRequest,
  QuoteRequest,
  type BetView,
  type BookingCodeResponse,
  type CashOutOffersResponse,
  type CashOutOfferView,
  type CashOutResponse,
  type MyBetsResponse,
  type QuoteResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput } from '../../lib/errors';
import { IDEMPOTENT_REPLAYED_HEADER, readIdempotencyKey } from '../../lib/idempotency';
import { requireUser } from '../../plugins/session';
import {
  cashOutPlayerBet,
  createSlipBookingCode,
  getBookingCode,
  getMyBet,
  getMyCashOutOffer,
  getMyCashOutOffers,
  listMyBets,
  placePlayerBet,
  quoteBetslip,
} from './service';

const MINUTE_MS = 60_000;

/** Per-route limits (requests per minute). */
export const BETTING_RATE_LIMITS = {
  /** Per client address: the betslip re-quotes on every change. */
  quote: 120,
  /** Per player. */
  placeBet: 30,
  /** Per player when logged in, else per client address. */
  createBookingCode: 30,
  /** Per client address (codes are short, so lookups are capped against guessing). */
  loadBookingCode: 60,
  /** Per player: executing a cash-out. */
  cashOut: 30,
  /**
   * Per player: one bet's offer and the batch of offers (clients re-fetch at
   * most every 2 s per open tab when live deltas arrive).
   */
  cashOutOffers: 120,
} as const;

function perClient(name: string, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: MINUTE_MS,
      keyGenerator: (request: FastifyRequest) => `${name}|${clientAddressKey(request.ip)}`,
    },
  };
}

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

/**
 * Betslip quotes, bet placement, My Bets and booking codes. Placement runs
 * placeBet (@vamos/db) in one transaction; its DomainErrors (409 odds
 * changed / selection unavailable, 422 slip invalid / insufficient funds /
 * limits, 403 exclusions) are rendered by the app's error handler.
 */
export default async function bettingRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.post(
    '/betslip/quote',
    { config: perClient('betslip-quote', BETTING_RATE_LIMITS.quote) },
    async (request, reply): Promise<QuoteResponse> => {
      const input = parseInput(QuoteRequest, request.body);
      const body = await quoteBetslip(deps, input);
      noStore(reply);
      return body;
    },
  );

  app.post(
    '/bets',
    {
      preHandler: app.requireAuth,
      config: perPlayer('bets-place', BETTING_RATE_LIMITS.placeBet),
    },
    async (request, reply): Promise<BetView> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(PlaceBetRequest, request.body);
      const result = await placePlayerBet(deps, {
        userId: user.id,
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
      return result.bet;
    },
  );

  app.get(
    '/me/bets',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<MyBetsResponse> => {
      const user = requireUser(request);
      const query = parseInput(MyBetsQuery, request.query);
      const body = await listMyBets(deps, user.id, query);
      noStore(reply);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/me/bets/:id',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<BetView> => {
      const user = requireUser(request);
      const body = await getMyBet(deps, user.id, request.params.id);
      noStore(reply);
      return body;
    },
  );

  // Cash-out (Phase 7; see CashOut* in @vamos/contracts). Only the player's own
  // bets: someone else's bet is a 404, like an unknown id.
  app.get<{ Params: { id: string } }>(
    '/me/bets/:id/cash-out',
    {
      preHandler: app.requireAuth,
      config: perPlayer('cash-out-offer', BETTING_RATE_LIMITS.cashOutOffers),
    },
    async (request, reply): Promise<CashOutOfferView> => {
      const user = requireUser(request);
      const body = await getMyCashOutOffer(deps, user.id, request.params.id);
      noStore(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/me/bets/:id/cash-out',
    {
      preHandler: app.requireAuth,
      config: perPlayer('cash-out', BETTING_RATE_LIMITS.cashOut),
    },
    async (request, reply): Promise<CashOutResponse> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(CashOutRequest, request.body);
      const result = await cashOutPlayerBet(deps, {
        userId: user.id,
        betId: request.params.id,
        quotedGross: BigInt(input.gross),
        idempotencyKey,
        ip: request.ip,
      });
      if (result.replayed) void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      noStore(reply);
      return result.body;
    },
  );

  app.get(
    '/me/cash-out-offers',
    {
      preHandler: app.requireAuth,
      config: perPlayer('cash-out-offers', BETTING_RATE_LIMITS.cashOutOffers),
    },
    async (request, reply): Promise<CashOutOffersResponse> => {
      const user = requireUser(request);
      const query = parseInput(CashOutOffersQuery, request.query);
      const body = await getMyCashOutOffers(deps, user.id, query.betIds);
      noStore(reply);
      return body;
    },
  );

  app.post(
    '/booking-codes',
    { config: perPlayer('booking-code-create', BETTING_RATE_LIMITS.createBookingCode) },
    async (request, reply): Promise<BookingCodeResponse> => {
      const input = parseInput(CreateBookingCodeRequest, request.body);
      const body = await createSlipBookingCode(deps, input, request.user?.id ?? null);
      void reply.status(201);
      return body;
    },
  );

  app.get<{ Params: { code: string } }>(
    '/booking-codes/:code',
    { config: perClient('booking-code-load', BETTING_RATE_LIMITS.loadBookingCode) },
    async (request, reply): Promise<BookingCodeResponse> => {
      const body = await getBookingCode(deps, request.params.code);
      noStore(reply);
      return body;
    },
  );
}
