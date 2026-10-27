import {
  CreditSmsRequest,
  FailManualPayoutRequest,
  ReleaseManualPayoutRequest,
  SettleManualPayoutRequest,
  SmsNoteRequest,
  SmsRailHealthResponse,
  StaffSmsChangeResponse,
  StaffSmsListResponse,
  StaffSmsQuery,
  StaffWithdrawalChangeResponse,
  StaffWithdrawalListResponse,
} from '@vamos/contracts';
import {
  acknowledgeReceiptAlarm,
  claimManualPayout,
  closeSmsByStaff,
  creditSmsByStaff,
  failManualPayout,
  getStaffWithdrawal,
  listReceivedSms,
  listSmsReviewQueue,
  listStaffWithdrawals,
  releaseManualPayout,
  settleManualPayout,
  smsRailHealth,
  type DbTransaction,
  type ReceivedSms,
} from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { smsProviderOf } from '../payments/smsrail';
import { inTx, parseUuid, wire } from './common';

type IdParams = { Params: { id: string } };

/**
 * The SMS rail in the back office:
 * - sms.review: the received messages, the review queue (unparsed,
 *   unmatched, ambiguous, flagged, receipt alarms) and its decisions
 *   (credit what arrived to a player, close, acknowledge a receipt alarm);
 * - payouts.settle_manual: the manual payout queue, where an operator
 *   claims an approved payout, sends the money by hand and settles it
 *   (never one they approved: the four-eyes rule, also in the database).
 * Every change is audited with the staff actor by the @vamos/db services.
 */
export default async function adminSmsRailRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  const smsBody = (sms: ReceivedSms) => wire(StaffSmsChangeResponse, { sms });

  app.get('/admin/sms', { config: { staff: 'sms.review' } }, async (request) => {
    const query = parseInput(StaffSmsQuery, request.query);
    const items =
      query.queue === 'review' && query.status === undefined
        ? await listSmsReviewQueue(deps.db, { limit: query.limit })
        : await listReceivedSms(deps.db, {
            ...(query.status === undefined ? {} : { status: query.status }),
            limit: query.limit,
          });
    return wire(StaffSmsListResponse, { items });
  });

  app.get('/admin/sms/health', { config: { staff: 'sms.review' } }, async () => {
    const provider = smsProviderOf(deps);
    const health = await smsRailHealth(deps.db);
    return wire(SmsRailHealthResponse, {
      ...health,
      mode: provider?.mode ?? 'simulated',
      receiptVerify: deps.config.payments.sms.receiptVerify,
      receiptBreaker: deps.receipts?.state().breaker ?? null,
    });
  });

  app.post<IdParams>(
    '/admin/sms/:id/credit',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const smsId = parseUuid(request.params.id, 'SMS');
      const input = parseInput(CreditSmsRequest, request.body);
      const actor = staffActor(request);
      const result = await inTx(deps, (tx) =>
        creditSmsByStaff(tx, {
          smsId,
          userId: input.userId,
          adminId: actor.adminId,
          note: input.note,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return smsBody(result.sms);
    },
  );

  app.post<IdParams>(
    '/admin/sms/:id/close',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const smsId = parseUuid(request.params.id, 'SMS');
      const input = parseInput(SmsNoteRequest, request.body);
      const actor = staffActor(request);
      const sms = await inTx(deps, (tx) =>
        closeSmsByStaff(tx, {
          smsId,
          adminId: actor.adminId,
          note: input.note,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return smsBody(sms);
    },
  );

  app.post<IdParams>(
    '/admin/sms/:id/acknowledge-receipt',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const smsId = parseUuid(request.params.id, 'SMS');
      const input = parseInput(SmsNoteRequest, request.body);
      const actor = staffActor(request);
      const sms = await inTx(deps, (tx) =>
        acknowledgeReceiptAlarm(tx, {
          smsId,
          adminId: actor.adminId,
          note: input.note,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return smsBody(sms);
    },
  );

  // ------------------------------------------------------------ manual payouts

  /** The operators' queue: approved and claimed manual payouts, oldest request first. */
  app.get('/admin/manual-payouts', { config: { staff: 'payouts.settle_manual' } }, async () => {
    const page = await listStaffWithdrawals(deps.db, {
      manual: true,
      statuses: ['approved', 'processing'],
      flagged: false,
      limit: 200,
    });
    return wire(StaffWithdrawalListResponse, page);
  });

  /** Runs a manual-payout change and answers with the payout after it. */
  const change = async (
    request: FastifyRequest<IdParams>,
    run: (
      tx: DbTransaction,
      context: { payoutId: string; staffId: string; ip: string | null; now: Date },
    ) => Promise<unknown>,
  ) => {
    const payoutId = parseUuid(request.params.id, 'Withdrawal');
    const actor = staffActor(request);
    const withdrawal = await inTx(deps, async (tx) => {
      await run(tx, { payoutId, staffId: actor.adminId, ip: actor.ip ?? null, now: deps.clock() });
      const after = await getStaffWithdrawal(tx, payoutId);
      if (after === null) throw notFound('Withdrawal');
      return after;
    });
    return wire(StaffWithdrawalChangeResponse, { changed: true, withdrawal });
  };

  app.post<IdParams>(
    '/admin/manual-payouts/:id/claim',
    { config: { staff: 'payouts.settle_manual' } },
    (request) => change(request, (tx, c) => claimManualPayout(tx, c)),
  );

  app.post<IdParams>(
    '/admin/manual-payouts/:id/release',
    { config: { staff: 'payouts.settle_manual' } },
    (request) => {
      const input = parseInput(ReleaseManualPayoutRequest, request.body);
      return change(request, (tx, c) => releaseManualPayout(tx, { ...c, note: input.note }));
    },
  );

  app.post<IdParams>(
    '/admin/manual-payouts/:id/settle',
    { config: { staff: 'payouts.settle_manual' } },
    (request) => {
      const input = parseInput(SettleManualPayoutRequest, request.body);
      return change(request, (tx, c) =>
        settleManualPayout(tx, {
          ...c,
          ...(input.smsId === undefined ? {} : { smsId: input.smsId }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          holderNameConfirmed: input.holderNameConfirmed,
          requireProof: deps.config.payments.sms.requirePayoutProof,
        }),
      );
    },
  );

  app.post<IdParams>(
    '/admin/manual-payouts/:id/fail',
    { config: { staff: 'payouts.settle_manual' } },
    (request) => {
      const input = parseInput(FailManualPayoutRequest, request.body);
      return change(request, (tx, c) => failManualPayout(tx, { ...c, reason: input.reason }));
    },
  );
}
