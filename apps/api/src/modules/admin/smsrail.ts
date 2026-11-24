import {
  ClaimManualPayoutBatchRequest,
  ClaimManualPayoutBatchResponse,
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
import { floatIsLow, parseSmsHeartbeat, smsHeartbeatKey, smsHeartbeatLate } from '@vamos/core';
import {
  acknowledgeReceiptAlarm,
  claimManualPayout,
  claimManualPayoutBatch,
  closeSmsByStaff,
  creditDepositClaim,
  creditSmsByStaff,
  reparseSmsByStaff,
  failManualPayout,
  getStaffWithdrawal,
  listReceivedSms,
  listSmsReviewQueue,
  loadFloatForecast,
  listStaffWithdrawals,
  releaseManualPayout,
  settleManualPayout,
  smsRailHealth,
  type DbTransaction,
  type ReceivedSms,
} from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../deps';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { smsProviderOf } from '../payments/smsrail';
import { inTx, parseUuid, wire } from './common';

type IdParams = { Params: { id: string } };

/** Redis key prefix of the worker's balance reconciliation (tasks/smsrail.ts in the worker). */
export const BALANCE_RESULT_KEY = 'sms-rail:balance:';

/** The worker's last balance reconciliation of `institution`, or null (none yet, or Redis down). */
async function readBalanceResult(deps: AppDeps, institution: string) {
  try {
    const raw = await deps.redis.get(`${BALANCE_RESULT_KEY}${institution}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as {
      checkedAt?: unknown;
      result?: { status?: unknown; drift?: unknown; observations?: unknown };
    };
    const status = parsed.result?.status;
    const observations = parsed.result?.observations;
    if (
      (status !== 'consistent' && status !== 'drift' && status !== 'insufficient_data') ||
      typeof observations !== 'number' ||
      typeof parsed.checkedAt !== 'string'
    ) {
      return null;
    }
    return {
      institution,
      checkedAt: parsed.checkedAt,
      status,
      drift: typeof parsed.result?.drift === 'string' ? parsed.result.drift : null,
      observations,
    };
  } catch {
    return null;
  }
}

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
    const institutions = [...new Set(provider?.collectionAccounts.map((a) => a.institution) ?? [])];
    const balance = [];
    for (const institution of institutions) {
      const stored = await readBalanceResult(deps, institution);
      if (stored !== null) balance.push(stored);
    }
    const now = deps.clock();
    const heartbeats = [];
    for (const account of provider?.collectionAccountIds ?? []) {
      const beat = parseSmsHeartbeat(await deps.redis.get(smsHeartbeatKey(account)));
      if (beat === null) continue;
      heartbeats.push({
        account,
        ...beat,
        late: smsHeartbeatLate(beat, now, deps.config.payments.sms.heartbeatAlarmMs),
      });
    }
    const rules = deps.config.payments.sms.floatForecast;
    const float = await loadFloatForecast(deps.db, { now: deps.clock(), rules });
    return wire(SmsRailHealthResponse, {
      ...health,
      payoutFloat: {
        horizonHours: Math.round(rules.horizonMs / 3_600_000),
        withdrawnPercent: Math.round(rules.withdrawnShareBps / 100),
        expectedWithdrawals: float.forecast.expectedWithdrawals,
        possiblePayouts: float.forecast.possiblePayouts,
        betsCounted: float.forecast.betsCounted,
        balances: float.balances
          .filter((b) => institutions.includes(b.institution))
          .map((b) => ({ ...b, low: floatIsLow(b.balance, float.forecast) })),
      },
      mode: provider?.mode ?? 'simulated',
      receiptVerify: deps.config.payments.sms.receiptVerify,
      receiptBreaker: deps.receipts?.state().breaker ?? null,
      heartbeats,
      balance,
    });
  });

  app.post<IdParams>(
    '/admin/sms/:id/credit',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const smsId = parseUuid(request.params.id, 'SMS');
      const input = parseInput(CreditSmsRequest, request.body);
      const actor = staffActor(request);
      const result = await inTx(deps, async (tx) => {
        const credited = await creditSmsByStaff(tx, {
          smsId,
          userId: input.userId,
          adminId: actor.adminId,
          note: input.note,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        // The player's claim this answers (G5.3), in the same transaction as the credit.
        if (input.claimId !== undefined) {
          await creditDepositClaim(tx, {
            claimId: input.claimId,
            userId: input.userId,
            intentId: credited.intent.id,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          });
        }
        return credited;
      });
      return smsBody(result.sms);
    },
  );

  // Reads a message again that no parser could read (after the parser was fixed): handled as when
  // it arrived. A credit is matched only against deposits that existed when the money moved.
  app.post<IdParams>(
    '/admin/sms/:id/reparse',
    { config: { staff: 'sms.review' } },
    async (request) => {
      const smsId = parseUuid(request.params.id, 'SMS');
      const actor = staffActor(request);
      const result = await inTx(deps, (tx) =>
        reparseSmsByStaff(tx, {
          smsId,
          adminId: actor.adminId,
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

  /**
   * Claims several payouts at once (the operator's pick list). Each claim
   * commits on its own through the single claim, so a refused row never
   * blocks the others and the four-eyes rule holds per payout.
   */
  app.post(
    '/admin/manual-payouts/claim-batch',
    { config: { staff: 'payouts.settle_manual' } },
    async (request) => {
      const input = parseInput(ClaimManualPayoutBatchRequest, request.body ?? {});
      const actor = staffActor(request);
      const results = await claimManualPayoutBatch(deps.db, {
        staffId: actor.adminId,
        ip: actor.ip ?? null,
        now: deps.clock(),
        limit: input.limit,
        ...(input.ids === undefined ? {} : { ids: input.ids }),
      });
      return wire(ClaimManualPayoutBatchResponse, { results });
    },
  );

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
