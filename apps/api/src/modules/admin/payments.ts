import {
  PayoutNoteRequest,
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
  getStaffWithdrawal,
  listFlaggedDeposits,
  listStaffWithdrawals,
  staffApproveWithdrawal,
  staffClearPayoutFlag,
  staffFlagPayout,
  staffRejectWithdrawal,
  staffResolveDeposit,
  staffSettlePayout,
  type DbTransaction,
  type StaffActor,
} from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
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
    (request) => changePayout(request, (tx, context) => staffApproveWithdrawal(tx, context)),
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
}
