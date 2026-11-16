import {
  AddPayoutAccountRequest,
  ConfirmPayoutAccountRequest,
  CreateDepositRequest,
  CreateWithdrawalRequest,
  DepositCheckRequest,
  type AddPayoutAccountResponse,
  type DepositCheckResponse,
  type PayoutAccountView,
  type PayoutAccountsResponse,
  type DepositView,
  type DepositsResponse,
  type PaymentOptionsResponse,
  type PaymentWebhookAck,
  type WithdrawalView,
  type WithdrawalsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput } from '../../lib/errors';
import { IDEMPOTENT_REPLAYED_HEADER, readIdempotencyKey } from '../../lib/idempotency';
import { requireUser } from '../../plugins/session';
import {
  cancelPlayerWithdrawal,
  createPlayerDeposit,
  getPlayerDeposit,
  getPlayerWithdrawal,
  listPlayerDeposits,
  listPlayerWithdrawals,
  paymentOptions,
  receiveWebhook,
  requestPlayerWithdrawal,
} from './service';
import {
  addPlayerPayoutAccount,
  checkPlayerSmsDeposit,
  confirmPlayerPayoutAccount,
  listPlayerPayoutAccounts,
  receiveGatewayHeartbeat,
  receiveGatewaySms,
  removePlayerPayoutAccount,
  resendPayoutAccountCode,
} from './smsrail';

const MINUTE_MS = 60_000;

/** Largest webhook body accepted (provider notifications are a few hundred bytes). */
export const WEBHOOK_BODY_LIMIT = 16 * 1024;

/** Largest SMS gateway body (one SMS of at most 2000 characters, JSON-encoded). */
export const SMS_GATEWAY_BODY_LIMIT = 4 * 1024;

/** Per-route limits (requests per minute). */
export const PAYMENT_RATE_LIMITS = {
  /** Per player. */
  createDeposit: 20,
  /** Per player. */
  createWithdrawal: 10,
  /** Per player. */
  cancelWithdrawal: 20,
  /** Per (provider, client address): providers call from a few addresses. */
  webhook: 600,
  /** Per player: each check may ask the institution's receipt page. */
  depositCheck: 5,
  /** Per player: adding, confirming and resending payout-account codes. */
  payoutAccounts: 10,
} as const;

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** After the session hook, so the counter is per player. */
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
 * Provider webhooks, in their own encapsulated context: every content type is
 * read as a raw Buffer (no JSON parsing) so the signature is checked over the
 * exact bytes received, with a small body limit. No session or CSRF: the
 * signature is the authentication.
 */
async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  // The SMS rail's gateway (the collection handset): a shared secret, not a signature.
  app.post(
    '/payments/webhooks/sms',
    {
      bodyLimit: SMS_GATEWAY_BODY_LIMIT,
      config: {
        rateLimit: {
          max: PAYMENT_RATE_LIMITS.webhook,
          timeWindow: MINUTE_MS,
          keyGenerator: (request: FastifyRequest) =>
            `payment-webhook|sms|${clientAddressKey(request.ip)}`,
        },
      },
    },
    async (request, reply): Promise<PaymentWebhookAck> => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const ack = await receiveGatewaySms(
        deps,
        { headers: request.headers, rawBody, ip: request.ip },
        request.log,
      );
      noStore(reply);
      return ack;
    },
  );

  // The forwarder's heartbeat: the same guards, its own rate-limit bucket.
  app.post(
    '/payments/webhooks/sms/heartbeat',
    {
      bodyLimit: SMS_GATEWAY_BODY_LIMIT,
      config: {
        rateLimit: {
          max: PAYMENT_RATE_LIMITS.webhook,
          timeWindow: MINUTE_MS,
          keyGenerator: (request: FastifyRequest) =>
            `payment-webhook|sms-heartbeat|${clientAddressKey(request.ip)}`,
        },
      },
    },
    async (request, reply): Promise<{ ok: true }> => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const ack = await receiveGatewayHeartbeat(
        deps,
        { headers: request.headers, rawBody, ip: request.ip },
        request.log,
      );
      noStore(reply);
      return ack;
    },
  );

  app.post<{ Params: { provider: string } }>(
    '/payments/webhooks/:provider',
    {
      bodyLimit: WEBHOOK_BODY_LIMIT,
      config: {
        rateLimit: {
          max: PAYMENT_RATE_LIMITS.webhook,
          timeWindow: MINUTE_MS,
          keyGenerator: (request: FastifyRequest) =>
            `payment-webhook|${(request.params as { provider?: string }).provider ?? ''}|${clientAddressKey(request.ip)}`,
        },
      },
    },
    async (request, reply): Promise<PaymentWebhookAck> => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const ack = await receiveWebhook(
        deps,
        request.params.provider,
        { headers: request.headers, rawBody },
        (rejection, error) =>
          request.log.warn({ ...rejection, err: error }, 'payment webhook rejected'),
      );
      noStore(reply);
      return ack;
    },
  );
}

/**
 * Deposits, withdrawals (with the status tracker) and provider webhooks.
 * The services in @vamos/db do the money work (ledger, outbox, idempotency);
 * their DomainErrors (403 KYC / exclusions, 422 limits / amounts / wagering /
 * insufficient funds, 409 states) are rendered by the app's error handler.
 */
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/payments/options', async (_request, reply): Promise<PaymentOptionsResponse> => {
    const body = await paymentOptions(deps);
    noStore(reply);
    return body;
  });

  app.post(
    '/payments/deposits',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-deposit', PAYMENT_RATE_LIMITS.createDeposit),
    },
    async (request, reply): Promise<DepositView> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(CreateDepositRequest, request.body);
      const result = await createPlayerDeposit(
        { ...deps, log: request.log },
        { userId: user.id, idempotencyKey, request: input, ip: request.ip },
      );
      if (result.replayed) {
        void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
        void reply.status(200);
      } else {
        void reply.status(201);
      }
      noStore(reply);
      return result.deposit;
    },
  );

  app.get(
    '/payments/deposits',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<DepositsResponse> => {
      const user = requireUser(request);
      const query = parseInput(ListQuery, request.query);
      const body = await listPlayerDeposits(deps, user.id, query.limit);
      noStore(reply);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/payments/deposits/:id',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<DepositView> => {
      const user = requireUser(request);
      const body = await getPlayerDeposit(deps, user.id, request.params.id);
      noStore(reply);
      return body;
    },
  );

  app.post(
    '/payments/deposits/check',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-deposit-check', PAYMENT_RATE_LIMITS.depositCheck),
    },
    async (request, reply): Promise<DepositCheckResponse> => {
      const user = requireUser(request);
      const input = parseInput(DepositCheckRequest, request.body);
      const body = await checkPlayerSmsDeposit(deps, { userId: user.id, text: input.text });
      noStore(reply);
      return body;
    },
  );

  app.get(
    '/payments/payout-accounts',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<PayoutAccountsResponse> => {
      const user = requireUser(request);
      const body = await listPlayerPayoutAccounts(deps, user.id);
      noStore(reply);
      return body;
    },
  );

  app.post(
    '/payments/payout-accounts',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-payout-accounts', PAYMENT_RATE_LIMITS.payoutAccounts),
    },
    async (request, reply): Promise<AddPayoutAccountResponse> => {
      const user = requireUser(request);
      const input = parseInput(AddPayoutAccountRequest, request.body);
      const body = await addPlayerPayoutAccount(
        deps,
        { userId: user.id, ...input, locale: user.locale, ip: request.ip },
        request.log,
      );
      void reply.status(201);
      noStore(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/payments/payout-accounts/:id/confirm',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-payout-accounts', PAYMENT_RATE_LIMITS.payoutAccounts),
    },
    async (request, reply): Promise<PayoutAccountView> => {
      const user = requireUser(request);
      const input = parseInput(ConfirmPayoutAccountRequest, request.body);
      const body = await confirmPlayerPayoutAccount(deps, {
        userId: user.id,
        phone: user.phone,
        accountId: request.params.id,
        code: input.code,
        ip: request.ip,
      });
      noStore(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/payments/payout-accounts/:id/resend',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-payout-accounts', PAYMENT_RATE_LIMITS.payoutAccounts),
    },
    async (request, reply): Promise<AddPayoutAccountResponse> => {
      const user = requireUser(request);
      const body = await resendPayoutAccountCode(
        deps,
        { userId: user.id, accountId: request.params.id, locale: user.locale, ip: request.ip },
        request.log,
      );
      noStore(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/payments/payout-accounts/:id/remove',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const user = requireUser(request);
      await removePlayerPayoutAccount(deps, {
        userId: user.id,
        accountId: request.params.id,
        ip: request.ip,
      });
      void reply.status(204);
      noStore(reply);
    },
  );

  app.post(
    '/payments/withdrawals',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-withdrawal', PAYMENT_RATE_LIMITS.createWithdrawal),
    },
    async (request, reply): Promise<WithdrawalView> => {
      const user = requireUser(request);
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(CreateWithdrawalRequest, request.body);
      const result = await requestPlayerWithdrawal(deps, {
        userId: user.id,
        phone: user.phone,
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
      return result.withdrawal;
    },
  );

  app.get(
    '/payments/withdrawals',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<WithdrawalsResponse> => {
      const user = requireUser(request);
      const query = parseInput(ListQuery, request.query);
      const body = await listPlayerWithdrawals(deps, user.id, query.limit);
      noStore(reply);
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/payments/withdrawals/:id',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<WithdrawalView> => {
      const user = requireUser(request);
      const body = await getPlayerWithdrawal(deps, user.id, request.params.id);
      noStore(reply);
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/payments/withdrawals/:id/cancel',
    {
      preHandler: app.requireAuth,
      config: perPlayer('payments-withdrawal-cancel', PAYMENT_RATE_LIMITS.cancelWithdrawal),
    },
    async (request, reply): Promise<WithdrawalView> => {
      const user = requireUser(request);
      const body = await cancelPlayerWithdrawal(deps, {
        userId: user.id,
        payoutId: request.params.id,
        ip: request.ip,
      });
      noStore(reply);
      return body;
    },
  );

  await app.register(webhookRoutes);
}
