import {
  CloseDepositClaimRequest,
  MoneyNotCreditedResponse,
  hasPermission,
  ManualDepositRequest,
  ManualDepositResponse,
  PayoutNoteRequest,
  RecheckDepositResponse,
  RejectWithdrawalRequest,
  ResolveDepositRequest,
  SettlePayoutRequest,
  StaffDepositListResponse,
  StaffWithdrawalChangeResponse,
  StaffWithdrawalListResponse,
  StaffWithdrawalQuery,
  StaffWithdrawalView,
} from '@vamos/contracts';
import {
  applyDepositEvent,
  closeDepositClaim,
  creditDepositByAdmin,
  creditDepositClaim,
  listMoneyNotCredited,
  getStaffWithdrawal,
  listFlaggedDeposits,
  listStaffWithdrawals,
  staffApproveWithdrawal,
  staffClearPayoutFlag,
  staffFlagPayout,
  staffRejectWithdrawal,
  staffResolveDeposit,
  staffSettlePayout,
  schema,
  type DbTransaction,
  type StaffActor,
} from '@vamos/db';
import { eventFromStatusQuery, PaymentProviderError } from '@vamos/payments';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { conflict, notFound, parseInput, serviceUnavailable } from '../../lib/errors';
import { requireStaff, staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

type IdParams = { Params: { id: string } };

interface PayoutChangeContext {
  payoutId: string;
  actor: StaffActor;
  now: Date;
}

/**
 * Withdrawals and flagged payments (withdrawals.view / withdrawals.approve)
 * over the Phase 6 staff services; every change is audited with the staff
 * actor. The approved payout is then sent by the worker's payout task.
 */
export default async function adminPaymentRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  /** Runs a withdrawal change and answers with the payout as finance sees it after it. */
  const changePayout = async (
    request: FastifyRequest<IdParams>,
    run: (tx: DbTransaction, context: PayoutChangeContext) => Promise<{ changed: boolean }>,
  ) => {
    const context: PayoutChangeContext = {
      payoutId: parseUuid(request.params.id, 'Withdrawal'),
      actor: staffActor(request),
      now: deps.clock(),
    };
    const result = await inTx(deps, async (tx) => {
      const { changed } = await run(tx, context);
      const withdrawal = await getStaffWithdrawal(tx, context.payoutId);
      if (withdrawal === null) throw notFound('Withdrawal');
      return { changed, withdrawal };
    });
    return wire(StaffWithdrawalChangeResponse, result);
  };

  app.get('/admin/withdrawals', { config: { staff: 'withdrawals.view' } }, async (request) => {
    const query = parseInput(StaffWithdrawalQuery, request.query);
    const page = await listStaffWithdrawals(deps.db, {
      ...(query.status === undefined || query.status.length === 0
        ? {}
        : { statuses: query.status }),
      ...(query.flagged === undefined ? {} : { flagged: query.flagged }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      order: query.order,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(StaffWithdrawalListResponse, page);
  });

  app.get<IdParams>(
    '/admin/withdrawals/:id',
    { config: { staff: 'withdrawals.view' } },
    async (request) => {
      const withdrawal = await getStaffWithdrawal(
        deps.db,
        parseUuid(request.params.id, 'Withdrawal'),
      );
      if (withdrawal === null) throw notFound('Withdrawal');
      return wire(StaffWithdrawalView, withdrawal);
    },
  );

  app.post<IdParams>(
    '/admin/withdrawals/:id/approve',
    { config: { staff: 'withdrawals.approve' } },
    (request) => {
      // Only aml.review (compliance, admin) releases a withdrawal held for an unresolved AML flag.
      const amlReviewer = hasPermission(requireStaff(request).role, 'aml.review');
      return changePayout(request, (tx, context) =>
        staffApproveWithdrawal(tx, { ...context, amlReviewer }),
      );
    },
  );

  app.post<IdParams>(
    '/admin/withdrawals/:id/reject',
    { config: { staff: 'withdrawals.approve' } },
    (request) => {
      const input = parseInput(RejectWithdrawalRequest, request.body);
      return changePayout(request, (tx, context) =>
        staffRejectWithdrawal(tx, { ...context, reason: input.reason }),
      );
    },
  );

  app.post<IdParams>(
    '/admin/withdrawals/:id/flag',
    { config: { staff: 'withdrawals.approve' } },
    (request) => {
      const input = parseInput(PayoutNoteRequest, request.body);
      return changePayout(request, (tx, context) =>
        staffFlagPayout(tx, { ...context, note: input.note }),
      );
    },
  );

  app.post<IdParams>(
    '/admin/withdrawals/:id/clear-flag',
    { config: { staff: 'withdrawals.approve' } },
    (request) => {
      const input = parseInput(PayoutNoteRequest, request.body);
      return changePayout(request, (tx, context) =>
        staffClearPayoutFlag(tx, { ...context, note: input.note }),
      );
    },
  );

  app.post<IdParams>(
    '/admin/withdrawals/:id/settle',
    { config: { staff: 'withdrawals.approve' } },
    (request) => {
      const input = parseInput(SettlePayoutRequest, request.body);
      return changePayout(request, (tx, context) =>
        staffSettlePayout(
          tx,
          input.outcome === 'paid'
            ? {
                ...context,
                outcome: 'paid',
                ...(input.providerRef === undefined ? {} : { providerRef: input.providerRef }),
              }
            : { ...context, outcome: 'failed', reason: input.reason },
        ),
      );
    },
  );

  app.get('/admin/deposits/flagged', { config: { staff: 'withdrawals.view' } }, async () =>
    wire(StaffDepositListResponse, { items: await listFlaggedDeposits(deps.db) }),
  );

  /** Answers `{ id, status }`: the deposit after the decision (its flag is cleared). */
  app.post<IdParams>(
    '/admin/deposits/:id/resolve',
    { config: { staff: 'withdrawals.approve' } },
    async (request) => {
      const intentId = parseUuid(request.params.id, 'Deposit');
      const input = parseInput(ResolveDepositRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const intent = await inTx(deps, (tx) =>
        staffResolveDeposit(tx, {
          intentId,
          resolution: input.resolution,
          note: input.note,
          actor,
          now,
        }),
      );
      return { id: intent.id, status: intent.status };
    },
  );

  /**
   * A deposit that reached Nahubet but was not credited, credited by one admin (owner's decision
   * O5; docs/plans/counter-codes-and-deposit-recovery.md, G5.2): once per provider transaction id,
   * the player's own deposit as itself, audited, the owner told above ETB 5,000.
   */
  app.post<IdParams>(
    '/admin/users/:id/manual-deposits',
    { config: { staff: 'deposits.credit' } },
    async (request) => {
      const userId = parseUuid(request.params.id, 'User');
      const input = parseInput(ManualDepositRequest, request.body);
      const actor = staffActor(request);
      const { intent, created } = await inTx(deps, async (tx) => {
        const credited = await creditDepositByAdmin(tx, {
          userId,
          intentId: input.intentId ?? null,
          provider: input.provider,
          providerTransactionId: input.providerTransactionId,
          amount: input.amount === undefined ? null : BigInt(input.amount),
          reason: input.reason,
          adminId: actor.adminId,
          ownerAlerts: deps.config.ownerAlerts,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        // The player's claim this answers (G5.3), in the same transaction as the credit.
        if (input.claimId !== undefined) {
          await creditDepositClaim(tx, {
            claimId: input.claimId,
            userId,
            intentId: credited.intent.id,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          });
        }
        return credited;
      });
      return wire(ManualDepositResponse, {
        deposit: {
          id: intent.id,
          provider: intent.provider,
          amount: intent.amount,
          status: intent.status,
        },
        created,
      });
    },
  );

  /**
   * "Money not credited" (G6): money that arrived but was not credited, and the players' open
   * claims, each with the players it may belong to. Never credited automatically.
   */
  app.get('/admin/money-not-credited', { config: { staff: 'sms.review' } }, async () => {
    const list = await listMoneyNotCredited(deps.db);
    return wire(MoneyNotCreditedResponse, {
      items: list.items,
      claims: list.claims.map(({ claim, phone, name, pairs }) => ({
        id: claim.id,
        userId: claim.userId,
        phone,
        name,
        method: claim.method,
        amount: claim.amount,
        paidAt: claim.paidAt,
        reference: claim.reference,
        payerPhone: claim.payerPhone,
        note: claim.note,
        createdAt: claim.createdAt,
        pairs,
      })),
      waiting: list.waiting,
    });
  });

  app.post<IdParams>(
    '/admin/deposit-claims/:id/close',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const claimId = parseUuid(request.params.id, 'Claim');
      const input = parseInput(CloseDepositClaimRequest, request.body);
      const actor = staffActor(request);
      const claim = await inTx(deps, (tx) =>
        closeDepositClaim(tx, {
          claimId,
          note: input.note,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return { id: claim.id, status: claim.status };
    },
  );

  /**
   * Asks the provider now about a deposit not yet credited (the worker also does it on its own
   * schedule): a payment the provider confirms is credited the normal way, exactly once.
   */
  app.post<IdParams>(
    '/admin/deposits/:id/recheck',
    { config: { staff: 'withdrawals.approve' } },
    async (request) => {
      const intentId = parseUuid(request.params.id, 'Deposit');
      const [intent] = await deps.db
        .select()
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.id, intentId))
        .limit(1);
      if (!intent) throw notFound('Deposit');
      if (intent.status === 'succeeded') {
        return wire(RecheckDepositResponse, { outcome: 'already_credited', status: intent.status });
      }
      const provider = deps.payments.get(intent.provider);
      if (provider === undefined || intent.providerRef === null) {
        throw conflict(
          'recheck_unavailable',
          'This deposit cannot be checked with its provider (no reference or no provider).',
        );
      }
      let result;
      try {
        result = await provider.queryDeposit(intent.providerRef);
      } catch (error) {
        if (!(error instanceof PaymentProviderError)) throw error;
        throw serviceUnavailable(
          'payment_provider_unavailable',
          'The payment service is not answering. Try again in a moment.',
        );
      }
      if (result.status === 'pending') {
        return wire(RecheckDepositResponse, { outcome: 'pending', status: intent.status });
      }
      if (result.providerRef !== intent.providerRef) {
        throw conflict('recheck_mismatch', 'The provider answered for another reference.');
      }
      const event = eventFromStatusQuery('deposit', result);
      const applied = await inTx(deps, (tx) =>
        applyDepositEvent(tx, { provider: intent.provider, event, now: deps.clock() }),
      );
      return wire(RecheckDepositResponse, {
        outcome: applied.outcome,
        status: applied.intent.status,
      });
    },
  );
}
