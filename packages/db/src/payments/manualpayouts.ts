import {
  assessManualPayout,
  bareSmsReference,
  latestClaimForSms,
  payoutDestination,
  type ManualPayoutAction,
} from '@vamos/core';
import { and, asc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import type { Database } from '../client';
import { amlHoldsWithdrawals } from '../compliance/aml';
import { DomainError, domainConflict, domainUnprocessable } from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { withTxRetry } from '../retry';
import { payouts } from '../schema/payments';
import { receivedSms } from '../schema/smsrail';
import { WITHDRAWAL_FAILED, WITHDRAWAL_PAID } from './events';
import { withdrawalPaidEntries, withdrawalPaidLedgerKey } from './postings';
import { comparableDestination, type Payout } from './types';
import {
  blockedSettlementCorrection,
  correctionPending,
  lockPayout,
  reverse,
  updatePayout,
} from './withdrawals';

/**
 * Manual payouts (SMS rail): an operator sends the money from a collection
 * account by hand and records it. Separation of duties (core
 * assessManualPayout, repeated by the payouts_manual_* constraints):
 *
 *     approved --claim--> processing --settle--> paid
 *                                    --release-> approved (nothing was sent)
 *                                    --fail----> failed   (the hold goes back)
 *
 * The approver never claims or settles; only the claimer settles, releases
 * or fails a claimed payout, so two operators never both send it.
 */

/** Staff acting on a manual payout (admin user id; audit and ledger actor). */
export interface ManualPayoutActor {
  staffId: string;
  ip?: string | null;
}

const MAX_TEXT_LENGTH = 500;

const DENIAL_MESSAGES = {
  wrong_status: 'This withdrawal is not in a state that allows this.',
  approver_cannot_pay: 'You approved this withdrawal, so someone else must pay it.',
  claimed_by_someone_else: 'Another operator is paying this withdrawal.',
} as const;

async function lockManualPayout(
  tx: DbTransaction,
  payoutId: string,
  action: ManualPayoutAction,
  staffId: string,
): Promise<Payout> {
  const payout = await lockPayout(tx, payoutId);
  if (!payout.manual) {
    throw domainConflict(
      'not_a_manual_payout',
      'This withdrawal is paid by a provider, not by hand.',
    );
  }
  const verdict = assessManualPayout({
    status: payout.status,
    action,
    actor: staffId,
    approvedBy: payout.approvedBy,
    payingBy: payout.payingBy,
  });
  if (!verdict.ok) {
    throw domainConflict(`manual_payout_${verdict.reason}`, DENIAL_MESSAGES[verdict.reason], {
      status: payout.status,
    });
  }
  return payout;
}

/** Approved and claimed manual payouts, oldest approval first (the operators' queue). */
export async function listManualPayoutQueue(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<Payout[]> {
  return exec
    .select()
    .from(payouts)
    .where(and(eq(payouts.manual, true), inArray(payouts.status, ['approved', 'processing'])))
    .orderBy(asc(payouts.approvedAt), asc(payouts.id))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

/** Claimed manual payouts still unpaid since before `claimedBefore`, oldest claim first (the idle-claim alarm). */
export async function listIdleManualClaims(
  exec: DbExecutor,
  options: { claimedBefore: Date; limit?: number },
): Promise<{ id: string; processingAt: Date; payingBy: string | null }[]> {
  const rows = await exec
    .select({ id: payouts.id, processingAt: payouts.processingAt, payingBy: payouts.payingBy })
    .from(payouts)
    .where(
      and(
        eq(payouts.manual, true),
        eq(payouts.status, 'processing'),
        lt(payouts.processingAt, options.claimedBefore),
      ),
    )
    .orderBy(asc(payouts.processingAt), asc(payouts.id))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
  return rows.flatMap((row) =>
    row.processingAt === null
      ? []
      : [{ id: row.id, processingAt: row.processingAt, payingBy: row.payingBy }],
  );
}

/**
 * An operator takes an approved manual payout to send it (`approved` →
 * `processing`, paying_by = the operator). Re-checked at the moment money
 * is about to leave: 409 `aml_review_pending` while the player's
 * withdrawals are held for AML, `settlement_correction_pending` while a
 * correction is blocked. 409 `manual_payout_*` for the approver or a
 * payout that is not approved.
 */
export async function claimManualPayout(
  tx: DbTransaction,
  input: ManualPayoutActor & { payoutId: string; now: Date },
): Promise<Payout> {
  const payout = await lockManualPayout(tx, input.payoutId, 'claim', input.staffId);
  if (await amlHoldsWithdrawals(tx, payout.userId)) {
    throw domainConflict(
      'aml_review_pending',
      'Compliance must review this player before the withdrawal can be paid.',
    );
  }
  const blocked = await blockedSettlementCorrection(tx, payout.userId);
  if (blocked) throw correctionPending(blocked.betId);
  const updated = await updatePayout(tx, payout.id, {
    status: 'processing',
    payingBy: input.staffId,
    processingAt: input.now,
    attempts: payout.attempts + 1,
    updatedAt: input.now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: 'payment.withdrawal_claimed',
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, destination: payout.destinationInstitution },
    ip: input.ip ?? null,
  });
  return updated;
}

/** The most payouts one batch claim takes (the API caps its request at the same number). */
export const MANUAL_PAYOUT_CLAIM_BATCH_MAX = 20;
/**
 * Without ids a batch looks at up to this many times `limit` candidates to find `limit` it can
 * claim: payouts under an AML hold or a blocked correction are refused one by one and must not
 * use up the batch, nor a payout another operator took a moment earlier.
 */
const CLAIM_SCAN_FACTOR = 5;

export interface ClaimManualPayoutBatchResult {
  payoutId: string;
  claimed: boolean;
  /** The refusal's code (`manual_payout_approver_cannot_pay`, `aml_review_pending`, ...) when not claimed. */
  reason?: string;
}

/**
 * Claims several approved manual payouts for one operator: exactly the given
 * `ids`, or else the oldest approved payouts nobody holds, skipping the ones this
 * operator approved themselves (they could never claim those), until `limit` are
 * claimed or CLAIM_SCAN_FACTOR times `limit` candidates have been tried. Every payout
 * goes through claimManualPayout in a transaction of its own, so each claim keeps its
 * row lock, its rules (the approver never claims, AML hold, status) and its audit
 * line, and a refused payout never blocks the others. Two operators racing for the
 * same rows each win a disjoint set: the loser of a row is told
 * `manual_payout_wrong_status` and goes on to the next one.
 */
export async function claimManualPayoutBatch(
  db: Database,
  input: ManualPayoutActor & { now: Date; limit?: number; ids?: readonly string[] },
): Promise<ClaimManualPayoutBatchResult[]> {
  let ids: string[];
  let want = Number.POSITIVE_INFINITY;
  if (input.ids !== undefined) {
    ids = [...new Set(input.ids)].slice(0, MANUAL_PAYOUT_CLAIM_BATCH_MAX);
  } else {
    want = Math.min(Math.max(input.limit ?? 10, 1), MANUAL_PAYOUT_CLAIM_BATCH_MAX);
    const rows = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.manual, true),
          eq(payouts.status, 'approved'),
          isNull(payouts.payingBy),
          // 'system:auto' and other staff approvals stay claimable; only the caller's own are not.
          or(isNull(payouts.approvedBy), ne(payouts.approvedBy, input.staffId)),
        ),
      )
      .orderBy(asc(payouts.approvedAt), asc(payouts.id))
      .limit(want * CLAIM_SCAN_FACTOR);
    ids = rows.map((row) => row.id);
  }
  const results: ClaimManualPayoutBatchResult[] = [];
  let claimed = 0;
  for (const payoutId of ids) {
    if (claimed >= want) break;
    try {
      await withTxRetry(db, (tx) =>
        claimManualPayout(tx, {
          payoutId,
          staffId: input.staffId,
          ip: input.ip ?? null,
          now: input.now,
        }),
      );
      results.push({ payoutId, claimed: true });
      claimed += 1;
    } catch (error) {
      // Only business refusals are reported; anything else is a fault and surfaces.
      if (!(error instanceof DomainError)) throw error;
      results.push({ payoutId, claimed: false, reason: error.code });
    }
  }
  return results;
}

/** The claimer hands a payout back unpaid (`processing` → `approved`), with a note. */
export async function releaseManualPayout(
  tx: DbTransaction,
  input: ManualPayoutActor & { payoutId: string; note: string; now: Date },
): Promise<Payout> {
  const note = input.note.trim().slice(0, MAX_TEXT_LENGTH);
  if (note.length === 0) throw new RangeError('releaseManualPayout: a note is required');
  const payout = await lockManualPayout(tx, input.payoutId, 'release', input.staffId);
  const updated = await updatePayout(tx, payout.id, {
    status: 'approved',
    payingBy: null,
    updatedAt: input.now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: 'payment.withdrawal_released',
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, note },
    ip: input.ip ?? null,
  });
  return updated;
}

export interface SettleManualPayoutInput extends ManualPayoutActor {
  payoutId: string;
  /** The transfer's reference as the operator's banking app shows it. */
  reference?: string;
  /** The outgoing confirmation SMS proposed for this payout (its reference is used). */
  smsId?: string;
  /** Bank payouts: the bank showed the player's own name as the account holder. */
  holderNameConfirmed: boolean;
  /** PAYOUT_REQUIRE_PROOF: settle only against an outgoing SMS. */
  requireProof: boolean;
  now: Date;
}

/**
 * The claimer records the payout as sent (`processing` → `paid`): the hold
 * moves to the SMS rail's clearing account (`withdrawal`,
 * house_withdrawals_pending -amount, house_psp_clearing:<provider> +amount)
 * with `payment.withdrawal_paid`, exactly once.
 * - 422 `holder_name_not_confirmed` for a bank payout without the holder
 *   confirmation;
 * - proof: `smsId` must be the debit SMS proposed for this payout; a typed
 *   reference that matches a debit SMS we hold must be of this amount and
 *   not proposed for another payout (409 `settlement_reference_mismatch`),
 *   and is then linked as the proof; 409 `settlement_proof_required` with
 *   `requireProof` and no SMS; 422 `invalid_settlement_reference`;
 * - a typed reference for a wallet payout: the SMS must name the payout's
 *   number (409 `settlement_destination_mismatch`); one that names no number
 *   counts only as the matcher's own proposal for this payout, never as an
 *   `ignored_debit` (409 `settlement_proof_mismatch`). Bank payouts rest on
 *   the holder-name confirmation, as before;
 * - either way, the SMS must be of a transfer made after this claim (core
 *   latestClaimForSms: claim minus the clock skew), else 409
 *   `settlement_proof_too_old`. Otherwise the claimer could pay themselves
 *   the same amount and point at that debit as the player's payment;
 * - 409 `settlement_reference_used` when the reference settled another payout.
 */
export async function settleManualPayout(
  tx: DbTransaction,
  input: SettleManualPayoutInput,
): Promise<Payout> {
  const payout = await lockManualPayout(tx, input.payoutId, 'settle', input.staffId);
  const destination = payout.destinationInstitution
    ? payoutDestination(payout.destinationInstitution)
    : null;
  if (destination?.kind === 'bank' && !input.holderNameConfirmed) {
    throw domainUnprocessable(
      'holder_name_not_confirmed',
      "Confirm that the bank showed the player's own name as the account holder.",
    );
  }

  let proof: { id: string; reference: string };
  if (input.smsId !== undefined) {
    const [sms] = await tx
      .select()
      .from(receivedSms)
      .where(eq(receivedSms.id, input.smsId))
      .for('update')
      .limit(1);
    if (
      !sms ||
      sms.direction !== 'debit' ||
      sms.proposedPayoutId !== payout.id ||
      sms.status !== 'settlement_proposed' ||
      sms.reference === null
    ) {
      throw domainConflict(
        'settlement_proof_mismatch',
        'That SMS is not the proposed proof of this withdrawal.',
      );
    }
    assertSentAfterClaim(payout, sms);
    proof = { id: sms.id, reference: sms.reference };
  } else {
    const typed = input.reference === undefined ? null : bareSmsReference(input.reference);
    if (typed === null) {
      throw domainUnprocessable(
        'invalid_settlement_reference',
        'Enter the transfer reference (6–25 letters and digits).',
      );
    }
    const [sms] = await tx
      .select()
      .from(receivedSms)
      .where(eq(receivedSms.reference, typed))
      .for('update')
      .limit(1);
    if (sms) {
      if (
        sms.direction !== 'debit' ||
        sms.amount !== payout.amount ||
        (sms.proposedPayoutId !== null && sms.proposedPayoutId !== payout.id) ||
        !['ignored_debit', 'settlement_proposed'].includes(sms.status)
      ) {
        throw domainConflict(
          'settlement_reference_mismatch',
          'We hold an SMS with that reference that is not this payment. Check the reference.',
        );
      }
      if (destination?.kind === 'wallet') assertSentToWallet(payout, sms);
      assertSentAfterClaim(payout, sms);
      proof = { id: sms.id, reference: typed };
    } else if (input.requireProof) {
      throw domainConflict(
        'settlement_proof_required',
        'Wait for the outgoing confirmation SMS from the collection account before settling.',
      );
    } else {
      return pay(tx, payout, input, { reference: typed, smsId: null });
    }
  }
  return pay(tx, payout, input, { reference: proof.reference, smsId: proof.id });
}

type ReceivedSmsRow = typeof receivedSms.$inferSelect;

/**
 * A typed reference for a wallet payout: the debit SMS must show the money
 * going to the payout's own number (both compared in E.164). An SMS without a
 * number proves nothing about where the money went, unless the matcher already
 * proposed it for this payout as its only same-amount candidate (`amount_only`).
 */
function assertSentToWallet(payout: Payout, sms: ReceivedSmsRow): void {
  if (sms.counterpartyPhone === null) {
    if (sms.status === 'settlement_proposed' && sms.proposedPayoutId === payout.id) return;
    throw domainConflict(
      'settlement_proof_mismatch',
      "That SMS does not show the number the money went to, so it cannot prove this withdrawal. Ask a supervisor to check the transfer in the collection account's history.",
    );
  }
  const sentTo = comparableDestination(payout.destinationInstitution, sms.counterpartyPhone);
  const owed = comparableDestination(payout.destinationInstitution, payout.destinationAccount);
  if (sentTo !== owed) {
    throw domainConflict(
      'settlement_destination_mismatch',
      'That SMS shows money sent to another number: check the reference and the number you paid.',
    );
  }
}

/**
 * The SMS must be of a transfer made after this payout was claimed (minus the
 * clock skew; core latestClaimForSms): an older debit of the same amount, or one
 * made under an earlier claim, did not pay this claim.
 */
function assertSentAfterClaim(payout: Payout, sms: ReceivedSmsRow): void {
  const latest = latestClaimForSms({
    occurredAt: sms.occurredAt,
    deviceReceivedAt: sms.deviceReceivedAt,
    receivedAt: sms.receivedAt,
  });
  if (payout.processingAt === null || payout.processingAt.getTime() > latest.getTime()) {
    throw domainConflict(
      'settlement_proof_too_old',
      'That SMS is of a transfer made before you claimed this withdrawal, so it is not this payment. Check the reference of the transfer you sent after claiming.',
    );
  }
}

async function pay(
  tx: DbTransaction,
  payout: Payout,
  input: SettleManualPayoutInput,
  settlement: { reference: string; smsId: string | null },
): Promise<Payout> {
  const { now } = input;
  const [used] = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.settlementReference, settlement.reference), ne(payouts.id, payout.id)))
    .limit(1);
  if (used) {
    throw domainConflict(
      'settlement_reference_used',
      'That reference already settled another withdrawal.',
    );
  }
  const posting = await postTransaction(tx, {
    type: 'withdrawal',
    idempotencyKey: withdrawalPaidLedgerKey(payout.id),
    refType: 'payout',
    refId: payout.id,
    description: `Withdrawal paid by hand via ${payout.provider}`,
    actor: { type: 'admin', id: input.staffId },
    entries: withdrawalPaidEntries(payout.provider, payout.amount),
  });
  const updated = await updatePayout(tx, payout.id, {
    status: 'paid',
    payingBy: null,
    settledBy: input.staffId,
    settlementReference: settlement.reference,
    settlementSmsId: settlement.smsId,
    holderNameConfirmed: input.holderNameConfirmed,
    paidLedgerTransactionId: posting.transactionId,
    lastError: null,
    nextAttemptAt: null,
    completedAt: now,
    updatedAt: now,
  });
  if (settlement.smsId !== null) {
    await tx
      .update(receivedSms)
      .set({ status: 'settled', proposedPayoutId: payout.id, updatedAt: now })
      .where(eq(receivedSms.id, settlement.smsId));
  }
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_PAID,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: {
      payoutId: payout.id,
      userId: payout.userId,
      provider: payout.provider,
      amount: payout.amount,
      providerRef: settlement.reference,
    },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: WITHDRAWAL_PAID,
    targetType: 'payout',
    targetId: payout.id,
    metadata: {
      amount: payout.amount,
      provider: payout.provider,
      manual: true,
      reference: settlement.reference,
      evidencedBySms: settlement.smsId,
      approvedBy: payout.approvedBy,
      holderNameConfirmed: input.holderNameConfirmed,
    },
    ip: input.ip ?? null,
  });
  return updated;
}

/**
 * The claimer reports that the transfer did not go out (refused, bounced):
 * the hold goes back to the player (`failed`, `payment.withdrawal_failed`).
 * Only when no money left the collection account.
 */
export async function failManualPayout(
  tx: DbTransaction,
  input: ManualPayoutActor & { payoutId: string; reason: string; now: Date },
): Promise<Payout> {
  const reason = input.reason.trim().slice(0, MAX_TEXT_LENGTH);
  if (reason.length === 0) throw new RangeError('failManualPayout: a reason is required');
  const payout = await lockManualPayout(tx, input.payoutId, 'fail', input.staffId);
  const updated = await reverse(
    tx,
    payout,
    'failed',
    { failureReason: reason, closedBy: input.staffId, payingBy: null },
    input.now,
    { type: 'admin', id: input.staffId },
  );
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_FAILED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, userId: payout.userId, amount: payout.amount, reason },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: WITHDRAWAL_FAILED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, reason, manual: true },
    ip: input.ip ?? null,
  });
  return updated;
}
