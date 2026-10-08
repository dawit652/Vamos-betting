import {
  DemoTopUpRequest,
  PageQuery,
  type WalletResponse,
  type WalletTransactionsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, parseInput } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { demoTopUp, getWallet, listWalletTransactions, parseEntryCursor } from './service';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to `true` on a response that replays an earlier request with the same key. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
/** 8–100 printable ASCII characters (a UUID is a good choice). */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{8,100}$/;

/** The request's Idempotency-Key header or a 400 `idempotency_key_required`. */
export function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw badRequest(
      'idempotency_key_required',
      'An Idempotency-Key header of 8 to 100 printable characters is required.',
    );
  }
  return value;
}

/**
 * Wallet balances and statement (ledger-backed), plus play-money top-ups.
 * POST /wallet/demo-topup only exists in demo mode; in licensed mode the route
 * is not registered at all (404), and the service refuses it as well.
 */
export default async function walletRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/wallet', { preHandler: app.requireAuth }, async (request): Promise<WalletResponse> =>
    getWallet(deps, requireUser(request).id),
  );

  app.get(
    '/wallet/transactions',
    { preHandler: app.requireAuth },
    async (request): Promise<WalletTransactionsResponse> => {
      const user = requireUser(request);
      const query = parseInput(PageQuery, request.query);
      const cursor = parseEntryCursor(query.cursor);
      return listWalletTransactions(deps, user.id, {
        limit: query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
  );

  if (deps.config.mode !== 'demo') return;

  app.post(
    '/wallet/demo-topup',
    {
      preHandler: app.requireAuth,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60_000,
          // After requireAuth, so the counter is per player.
          hook: 'preHandler' as const,
          keyGenerator: (request: FastifyRequest) =>
            `wallet-demo-topup|${request.user?.id ?? request.ip}`,
        },
      },
    },
    async (request, reply): Promise<WalletResponse> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(DemoTopUpRequest, request.body ?? {});
      const result = await demoTopUp(deps, {
        userId: user.id,
        idempotencyKey,
        ...(input.amount === undefined ? {} : { amount: BigInt(input.amount) }),
        ip: request.ip,
      });
      if (result.replayed) {
        void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      }
      return result.wallet;
    },
  );
}
