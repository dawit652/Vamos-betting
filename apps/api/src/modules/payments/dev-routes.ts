import {
  DevPhoneDecisionRequest,
  DevPhoneQuery,
  DevRejectWithdrawalRequest,
  type DevPhoneDecisionResponse,
  type DevPhonePushesResponse,
  type DevWithdrawalQueueResponse,
  type WithdrawalView,
} from '@vamos/contracts';
import { normalizeEthiopianMsisdn } from '@vamos/core';
import {
  approveWithdrawal,
  getDepositIntent,
  listOpenDepositIntentsForPhone,
  listPayoutsForReview,
  rejectWithdrawal,
  withTxRetry,
} from '@vamos/db';
import { MockPaymentProvider, MockPinError } from '@vamos/payments';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../deps';
import { clientAddressKey } from '../../lib/client-address';
import { badRequest, notFound, parseInput, unprocessable } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { parseId, receiveWebhook } from './service';
import { depositView, withdrawalView } from './views';

/**
 * DEV ONLY. The actor recorded (audit log, ledger, approved_by / closed_by)
 * for withdrawals approved or rejected through the stand-in back office.
 */
export const DEV_BACK_OFFICE_ACTOR = 'dev:back-office-stand-in';

/**
 * The phone simulator: demo mode with the mock (play-money) payment provider,
 * whatever NODE_ENV is, so a public demo deployment (NODE_ENV=production) can
 * take deposits too. It is the only way to complete a mock deposit, and it
 * gives a player nothing the demo top-up (POST /wallet/demo-topup) does not:
 * play money, for their own session and their own deposits only. Licensed mode
 * never has it (the mock provider is refused there).
 */
export function demoPhoneEnabled(deps: Pick<AppDeps, 'config' | 'payments'>): boolean {
  return deps.config.mode === 'demo' && deps.payments.get('mock') instanceof MockPaymentProvider;
}

/**
 * The stand-in back office (no staff session) exists only for local
 * development, tests and e2e: the phone simulator's conditions plus NODE_ENV
 * other than production, like the dev SMS inbox. A public deployment approves
 * withdrawals in the real back office (apps/admin).
 */
export function devPaymentsEnabled(deps: Pick<AppDeps, 'config' | 'payments'>): boolean {
  return demoPhoneEnabled(deps) && deps.config.nodeEnv !== 'production';
}

function mockProvider(deps: Pick<AppDeps, 'payments'>): MockPaymentProvider {
  const provider = deps.payments.get('mock');
  if (!(provider instanceof MockPaymentProvider)) throw notFound('Mock payment provider');
  return provider;
}

/**
 * The signed-in player's phone. A `phone` the client names must be that
 * number: the simulator never shows or decides pushes to anyone else's
 * phone (404, like another player's deposit).
 */
function sessionPhone(request: FastifyRequest, named: string | undefined): string {
  const own = requireUser(request).phone;
  if (named === undefined) return own;
  const phone = normalizeEthiopianMsisdn(named);
  if (phone === null) throw badRequest('invalid_phone', 'Not an Ethiopian mobile number.');
  if (phone !== own) throw notFound('Phone');
  return own;
}

/**
 * DEMO ONLY – not part of the licensed product.
 *
 * The phone simulator for the mock provider, for the signed-in
 * player's own registered phone only (session required, CSRF for cookies):
 * - GET /dev/payments/phone lists the deposit pushes waiting on it;
 * - POST /dev/payments/phone approves (PIN 1234) or declines one. It builds
 *   the signed mock webhook and feeds it through the same verification and
 *   apply path as POST /payments/webhooks/mock.
 *
 * DEV ONLY (not in production): a STAND-IN for the back office, so e2e can
 * walk a withdrawal through review (no session: it plays the staff side):
 * - GET /dev/payments/withdrawals lists withdrawals waiting for review;
 * - POST /dev/payments/withdrawals/:id/approve and …/reject.
 */
export default async function devPaymentRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!demoPhoneEnabled(deps)) return;

  app.get(
    '/dev/payments/phone',
    { preHandler: app.requireAuth },
    async (request): Promise<DevPhonePushesResponse> => {
      const query = parseInput(DevPhoneQuery, request.query);
      const rows = await listOpenDepositIntentsForPhone(deps.db, {
        provider: 'mock',
        phone: sessionPhone(request, query.phone),
        now: deps.clock(),
      });
      return {
        items: rows.map((row) => ({
          depositId: row.id,
          amount: row.amount.toString(),
          instructions: row.instructions,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/dev/payments/phone',
    {
      preHandler: app.requireAuth,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
          keyGenerator: (request: FastifyRequest) =>
            `dev-payments-phone|${clientAddressKey(request.ip)}`,
        },
      },
    },
    async (request): Promise<DevPhoneDecisionResponse> => {
      const input = parseInput(DevPhoneDecisionRequest, request.body);
      const user = requireUser(request);
      const phone = sessionPhone(request, input.phone);
      const intent = await getDepositIntent(deps.db, parseId(input.depositId, 'Payment request'));
      if (
        intent === null ||
        intent.provider !== 'mock' ||
        intent.userId !== user.id ||
        intent.phone !== phone ||
        intent.providerRef === null
      ) {
        throw notFound('Payment request');
      }
      const provider = mockProvider(deps);
      let webhook;
      try {
        webhook = provider.simulateDepositDecision({
          providerRef: intent.providerRef,
          amount: intent.amount,
          decision: input.decision,
          ...(input.pin === undefined ? {} : { pin: input.pin }),
        });
      } catch (error) {
        if (error instanceof MockPinError) {
          throw unprocessable('wrong_pin', 'Wrong PIN. The demo PIN is 1234.');
        }
        throw error;
      }
      const ack = await receiveWebhook(deps, 'mock', webhook);
      const updated = await getDepositIntent(deps.db, intent.id);
      if (updated === null) throw notFound('Payment request');
      return { outcome: ack.outcome, deposit: depositView(updated) };
    },
  );

  // Unauthenticated staff actions: never on a public deployment.
  if (!devPaymentsEnabled(deps)) return;

  app.get('/dev/payments/withdrawals', async (): Promise<DevWithdrawalQueueResponse> => {
    const rows = await listPayoutsForReview(deps.db);
    return { items: rows.map((row) => ({ ...withdrawalView(row), userId: row.userId })) };
  });

  app.post<{ Params: { id: string } }>(
    '/dev/payments/withdrawals/:id/approve',
    async (request): Promise<WithdrawalView> => {
      const payoutId = parseId(request.params.id, 'Withdrawal');
      const now = deps.clock();
      const change = await withTxRetry(deps.db, (tx) =>
        approveWithdrawal(tx, { payoutId, adminId: DEV_BACK_OFFICE_ACTOR, now, ip: request.ip }),
      );
      return withdrawalView(change.payout);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/dev/payments/withdrawals/:id/reject',
    async (request): Promise<WithdrawalView> => {
      const payoutId = parseId(request.params.id, 'Withdrawal');
      const input = parseInput(DevRejectWithdrawalRequest, request.body ?? {});
      const now = deps.clock();
      const change = await withTxRetry(deps.db, (tx) =>
        rejectWithdrawal(tx, {
          payoutId,
          adminId: DEV_BACK_OFFICE_ACTOR,
          reason: input.reason ?? 'Rejected in the dev back office',
          now,
          ip: request.ip,
        }),
      );
      return withdrawalView(change.payout);
    },
  );
}
