import { randomUUID } from 'node:crypto';
import { normalizeEthiopianMsisdn, toWire, type PaymentRules } from '@vamos/core';
import { and, asc, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  DomainError,
  domainConflict,
  domainForbidden,
  domainNotFound,
  domainUnprocessable,
} from '../errors';
import { InsufficientFundsError } from '../ledger/errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { toJsonSafe } from '../platform/json';
import { enqueueOutbox } from '../platform/outbox';
import { getActiveExclusion } from '../rg/exclusions';
import { lockUser } from '../rg/limits';
import { kycProfiles, users } from '../schema/accounts';
import { paymentEvents, payouts } from '../schema/payments';
import {
  WITHDRAWAL_APPROVED,
  WITHDRAWAL_CANCELLED,
  WITHDRAWAL_CONFLICT,
  WITHDRAWAL_FAILED,
  WITHDRAWAL_PAID,
  WITHDRAWAL_REJECTED,
  WITHDRAWAL_REQUESTED,
} from './events';
import {
  withdrawalHoldEntries,
  withdrawalHoldLedgerKey,
  withdrawalPaidEntries,
  withdrawalPaidLedgerKey,
  withdrawalReversalEntries,
  withdrawalReversalLedgerKey,
} from './postings';
import {
  assertAmount,
  assertProviderName,
  OPEN_PAYOUT_STATUSES,
  REVERSED_PAYOUT_STATUSES,
  type Payout,
  type ProviderEventInput,
} from './types';
import { getRemainingWagering } from './wagering';

const DAY_MS = 24 * 60 * 60_000;
const MAX_TEXT_LENGTH = 500;

/** `approved_by` of automatically approved payouts. */
export const AUTO_APPROVER = 'system:auto';

export type ReviewReason = 'above_auto_approve_threshold' | 'active_exclusion';

export interface RequestWithdrawalInput {
  userId: string;
  /** Santim. */
  amount: bigint;
  /** Must be the player's registered phone (payouts never go to anyone else). */
  phone: string;
  /** An enabled provider that can pay out (the caller checks its registry). */
  provider: string;
  /** The client's idempotency key (already validated: 8–100 printable characters). */
  idempotencyKey: string;
  now: Date;
  /** loadGameSettings().payments */
  rules: PaymentRules;
  ip?: string | null;
}

export interface RequestWithdrawalResult {
  payout: Payout;
  /** true when the idempotency key had been used already: nothing was written. */
  replayed: boolean;
}

/** A state change that may already have happened (idempotent calls). */
export interface PayoutChange {
  payout: Payout;
  /** false when the payout was already in the target state: nothing was written. */
  changed: boolean;
}

function wire(amount: bigint): string {
  return toWire(amount);
}

async function lockPayout(tx: DbTransaction, payoutId: string): Promise<Payout> {
  const [row] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for('update');
  if (!row) throw domainNotFound('Withdrawal');
  return row;
}

async function updatePayout(
  tx: DbTransaction,
  payoutId: string,
  values: Partial<typeof payouts.$inferInsert>,
): Promise<Payout> {
  const [row] = await tx.update(payouts).set(values).where(eq(payouts.id, payoutId)).returning();
  if (!row) throw new Error(`payout ${payoutId} vanished`);
  return row;
}

/** Withdrawals of the player in the 24 hours before `now` that are open or paid. */
async function withdrawnLastDay(tx: DbTransaction, userId: string, now: Date): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${payouts.amount}), 0)::text` })
    .from(payouts)
    .where(
      and(
        eq(payouts.userId, userId),
        gt(payouts.requestedAt, new Date(now.getTime() - DAY_MS)),
        notInArray(payouts.status, [...REVERSED_PAYOUT_STATUSES]),
      ),
    );
  return BigInt(row?.total ?? '0');
}

/**
 * Requests a withdrawal in the caller's transaction:
 * 1. lockUser (serialises the player's bets, deposits and withdrawals, so
 *    concurrent requests can never overdraw);
 * 2. a replayed idempotency key returns the existing payout (422
 *    `idempotency_key_reused` when amount, phone or provider differ);
 * 3. 403 `account_disabled` unless the account is active;
 * 4. 403 `kyc_required` unless kyc_profiles.status is `verified`;
 * 5. 422 `payout_phone_mismatch` unless `phone` is the registered phone;
 * 6. 422 `withdrawal_amount_out_of_range` outside [minWithdrawal, maxWithdrawal];
 * 7. 422 `withdrawal_daily_cap_exceeded` when the open and paid withdrawals
 *    of the last 24 hours plus `amount` exceed dailyWithdrawalCap;
 * 8. 422 `wagering_requirement_not_met` (details `{ remaining }`) while the
 *    deposits are not wagered (see core `remainingWagering`) – waived during
 *    a cool-off or self-exclusion, see below;
 * 9. the hold: player_cash -amount, house_withdrawals_pending +amount
 *    (422 `insufficient_funds`);
 * 10. the payout row: `approved` (by `system:auto`) when amount <
 *    autoApproveBelow and no exclusion is active, else `requested` for
 *    manual review; outbox `payment.withdrawal_requested` (and
 *    `payment.withdrawal_approved` when auto-approved) and the audit record.
 *
 * Exclusions do not block withdrawals: a player on a cool-off or
 * self-exclusion must always be able to take their money out. Since they
 * cannot bet, the wagering rule is waived for them, and every such
 * withdrawal goes to manual review instead (so a cool-off cannot be used to
 * cash out unplayed deposits unseen).
 */
export async function requestWithdrawal(
  tx: DbTransaction,
  input: RequestWithdrawalInput,
): Promise<RequestWithdrawalResult> {
  const { userId, amount, now, rules } = input;
  assertAmount(amount, 'withdrawal amount');
  assertProviderName(input.provider);
  const phone = normalizeEthiopianMsisdn(input.phone);

  await lockUser(tx, userId);

  const [existing] = await tx
    .select()
    .from(payouts)
    .where(and(eq(payouts.userId, userId), eq(payouts.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing) {
    if (
      existing.amount !== amount ||
      existing.provider !== input.provider ||
      existing.phone !== phone
    ) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different withdrawal.',
      );
    }
    return { payout: existing, replayed: true };
  }

  const [user] = await tx
    .select({
      phone: users.phone,
      status: users.status,
      kycStatus: kycProfiles.status,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  if (user.status !== 'active') {
    throw domainForbidden('account_disabled', 'This account is disabled. Please contact support.', {
      status: user.status,
    });
  }
  if (user.kycStatus !== 'verified' || !user.verifiedName) {
    throw domainForbidden('kyc_required', 'Verify your identity before withdrawing.', {
      kycStatus: user.kycStatus ?? 'unverified',
    });
  }
  if (phone !== user.phone) {
    throw domainUnprocessable(
      'payout_phone_mismatch',
      'Withdrawals can only be paid to your registered phone number.',
    );
  }
  if (amount < rules.minWithdrawal || amount > rules.maxWithdrawal) {
    throw domainUnprocessable(
      'withdrawal_amount_out_of_range',
      amount < rules.minWithdrawal
        ? 'This withdrawal is below the minimum withdrawal.'
        : 'This withdrawal is above the maximum withdrawal.',
      { min: wire(rules.minWithdrawal), max: wire(rules.maxWithdrawal), amount: wire(amount) },
    );
  }
  const used = await withdrawnLastDay(tx, userId, now);
  if (used + amount > rules.dailyWithdrawalCap) {
    throw domainUnprocessable(
      'withdrawal_daily_cap_exceeded',
      'This withdrawal would exceed the 24-hour withdrawal limit.',
      { cap: wire(rules.dailyWithdrawalCap), used: wire(used), amount: wire(amount) },
    );
  }
  const exclusion = await getActiveExclusion(tx, userId, now);
  if (exclusion === null) {
    const remaining = await getRemainingWagering(tx, userId, rules.wageringMultiplierBps);
    if (remaining > 0n) {
      throw domainUnprocessable(
        'wagering_requirement_not_met',
        'Your deposits must be played through before you can withdraw.',
        { remaining: wire(remaining) },
      );
    }
  }

  const payoutId = randomUUID();
  let holdId: string;
  try {
    const hold = await postTransaction(tx, {
      type: 'withdrawal',
      idempotencyKey: withdrawalHoldLedgerKey(payoutId),
      refType: 'payout',
      refId: payoutId,
      description: `Withdrawal via ${input.provider}`,
      actor: { type: 'user', id: userId },
      entries: withdrawalHoldEntries(userId, amount),
    });
    holdId = hold.transactionId;
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw domainUnprocessable(
        'insufficient_funds',
        'Your balance is too low for this withdrawal.',
        {
          balance: wire(error.available),
          amount: wire(amount),
        },
      );
    }
    throw error;
  }

  const reviewReason: ReviewReason | null =
    exclusion !== null
      ? 'active_exclusion'
      : amount >= rules.autoApproveBelow
        ? 'above_auto_approve_threshold'
        : null;
  const autoApproved = reviewReason === null;
  const [payout] = await tx
    .insert(payouts)
    .values({
      id: payoutId,
      userId,
      provider: input.provider,
      amount,
      phone: user.phone,
      recipientName: user.verifiedName,
      status: autoApproved ? 'approved' : 'requested',
      reviewReason,
      approvedBy: autoApproved ? AUTO_APPROVER : null,
      approvedAt: autoApproved ? now : null,
      idempotencyKey: input.idempotencyKey,
      holdLedgerTransactionId: holdId,
      requestedAt: now,
      updatedAt: now,
    })
    .returning();
  if (!payout) throw new Error('payout insert returned no row');

  const summary = {
    payoutId,
    userId,
    provider: payout.provider,
    amount,
    status: payout.status,
    reviewReason,
  };
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_REQUESTED,
    aggregateType: 'payout',
    aggregateId: payoutId,
    payload: summary,
  });
  if (autoApproved) {
    await enqueueOutbox(tx, {
      type: WITHDRAWAL_APPROVED,
      aggregateType: 'payout',
      aggregateId: payoutId,
      payload: { payoutId, userId, provider: payout.provider, amount, approvedBy: AUTO_APPROVER },
    });
  }
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: WITHDRAWAL_REQUESTED,
    targetType: 'payout',
    targetId: payoutId,
    metadata: summary,
    ip: input.ip ?? null,
  });
  return { payout, replayed: false };
}

/**
 * Staff approve a payout waiting for review (`requested` → `approved`);
 * repeating it is a no-op. 409 `payout_not_reviewable` in any other state.
 */
export async function approveWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; adminId: string; now: Date; ip?: string | null },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'approved') return { payout, changed: false };
  if (payout.status !== 'requested') {
    throw domainConflict('payout_not_reviewable', 'This withdrawal is not waiting for review.', {
      status: payout.status,
    });
  }
  const updated = await updatePayout(tx, payout.id, {
    status: 'approved',
    approvedBy: input.adminId,
    approvedAt: input.now,
    nextAttemptAt: null,
    updatedAt: input.now,
  });
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_APPROVED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: {
      payoutId: payout.id,
      userId: payout.userId,
      provider: payout.provider,
      amount: payout.amount,
      approvedBy: input.adminId,
    },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: WITHDRAWAL_APPROVED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, userId: payout.userId },
    ip: input.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/** Returns the hold to the player and closes the payout with `status`. */
async function reverse(
  tx: DbTransaction,
  payout: Payout,
  status: 'failed' | 'rejected' | 'cancelled',
  values: Partial<typeof payouts.$inferInsert>,
  now: Date,
): Promise<Payout> {
  const reversal = await postTransaction(tx, {
    type: 'withdrawal_reversal',
    idempotencyKey: withdrawalReversalLedgerKey(payout.id),
    refType: 'payout',
    refId: payout.id,
    description: `Withdrawal ${status}`,
    entries: withdrawalReversalEntries(payout.userId, payout.amount),
  });
  return updatePayout(tx, payout.id, {
    ...values,
    status,
    reversalLedgerTransactionId: reversal.transactionId,
    nextAttemptAt: null,
    completedAt: now,
    updatedAt: now,
  });
}

/**
 * Staff reject a payout that has not been sent to the provider (`requested`
 * or `approved`): the hold goes back to the player (`withdrawal_reversal`).
 * Repeating it is a no-op; 409 `payout_not_reviewable` once processing.
 */
export async function rejectWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; adminId: string; reason: string; now: Date; ip?: string | null },
): Promise<PayoutChange> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new RangeError('rejectWithdrawal: a reason is required');
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'rejected') return { payout, changed: false };
  if (payout.status !== 'requested' && payout.status !== 'approved') {
    throw domainConflict('payout_not_reviewable', 'This withdrawal can no longer be rejected.', {
      status: payout.status,
    });
  }
  const updated = await reverse(
    tx,
    payout,
    'rejected',
    { reviewReason: reason.slice(0, MAX_TEXT_LENGTH), closedBy: input.adminId },
    input.now,
  );
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_REJECTED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, userId: payout.userId, amount: payout.amount, reason },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: WITHDRAWAL_REJECTED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, userId: payout.userId, reason },
    ip: input.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/**
 * The player cancels their own payout before it is sent to the provider
 * (`requested` or `approved`); the hold goes back. 404 for another player's
 * payout, 409 `payout_not_cancellable` once processing; repeating is a no-op.
 */
export async function cancelWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; userId: string; now: Date; ip?: string | null },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.userId !== input.userId) throw domainNotFound('Withdrawal');
  if (payout.status === 'cancelled') return { payout, changed: false };
  if (payout.status !== 'requested' && payout.status !== 'approved') {
    throw domainConflict('payout_not_cancellable', 'This withdrawal can no longer be cancelled.', {
      status: payout.status,
    });
  }
  const updated = await reverse(tx, payout, 'cancelled', { closedBy: input.userId }, input.now);
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_CANCELLED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, userId: payout.userId, amount: payout.amount },
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: WITHDRAWAL_CANCELLED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount },
    ip: input.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/**
 * Locks up to `limit` payouts the payout worker should look at now:
 * `approved` ones (to submit) and `processing` ones whose next check is
 * due, oldest first, skipping rows another worker holds (FOR UPDATE SKIP
 * LOCKED). Call markPayoutProcessing on each before committing, then talk
 * to the provider outside the transaction.
 */
export async function claimDuePayouts(
  tx: DbTransaction,
  options: { now: Date; limit?: number },
): Promise<Payout[]> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('claimDuePayouts: limit must be a positive integer');
  }
  return tx
    .select()
    .from(payouts)
    .where(
      and(
        inArray(payouts.status, ['approved', 'processing']),
        or(isNull(payouts.nextAttemptAt), lte(payouts.nextAttemptAt, options.now)),
      ),
    )
    .orderBy(asc(sql`COALESCE(${payouts.nextAttemptAt}, ${payouts.approvedAt})`), asc(payouts.id))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/**
 * The payout worker is about to submit (or resubmit) the payout to the
 * provider: `approved` → `processing`, attempts + 1, and the next look at
 * it no earlier than `checkAt` (when no webhook has settled it by then).
 * Submissions reuse the payout id as the provider's reference, so a
 * resubmission after a timeout cannot pay twice. 409
 * `payout_not_processable` unless approved or processing.
 */
export async function markPayoutProcessing(
  tx: DbTransaction,
  input: { payoutId: string; now: Date; checkAt: Date },
): Promise<Payout> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status !== 'approved' && payout.status !== 'processing') {
    throw domainConflict('payout_not_processable', 'This withdrawal cannot be processed.', {
      status: payout.status,
    });
  }
  return updatePayout(tx, payout.id, {
    status: 'processing',
    attempts: sql`${payouts.attempts} + 1`,
    processingAt: payout.processingAt ?? input.now,
    nextAttemptAt: input.checkAt,
    updatedAt: input.now,
  });
}

/**
 * The provider accepted the payout but has not settled it: store its
 * reference (webhooks and queryPayout name the payout by it) and when to
 * check again. 409 `provider_ref_conflict` if a different reference is
 * already stored.
 */
export async function recordPayoutSubmission(
  tx: DbTransaction,
  input: { payoutId: string; providerRef: string; now: Date; checkAt: Date },
): Promise<Payout> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.providerRef !== null && payout.providerRef !== input.providerRef) {
    throw domainConflict(
      'provider_ref_conflict',
      'This withdrawal already has a provider reference.',
    );
  }
  if (payout.status !== 'processing') return payout;
  return updatePayout(tx, payout.id, {
    providerRef: input.providerRef,
    lastError: null,
    nextAttemptAt: input.checkAt,
    updatedAt: input.now,
  });
}

/**
 * A submission or status check failed in a way that may be retried
 * (timeout, network error, provider 5xx): keep the status, record the
 * error and look again at `retryAt`. Use `attempts` against
 * rules.payoutMaxAttempts to stop retrying; when the provider cannot
 * confirm a failure, leave the payout for staff rather than failing it
 * (it may have been paid).
 */
export async function schedulePayoutRetry(
  tx: DbTransaction,
  input: { payoutId: string; error: string; retryAt: Date; now: Date },
): Promise<Payout> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status !== 'approved' && payout.status !== 'processing') return payout;
  return updatePayout(tx, payout.id, {
    lastError: input.error.slice(0, MAX_TEXT_LENGTH),
    nextAttemptAt: input.retryAt,
    updatedAt: input.now,
  });
}

/**
 * The provider confirmed the payout: the hold moves to the provider's
 * clearing account (house_withdrawals_pending -amount,
 * house_psp_clearing:<provider> +amount) and the payout is `paid`, with
 * `payment.withdrawal_paid`. Repeating it is a no-op. 409
 * `payout_already_closed` when the payout was rejected, cancelled or
 * failed (its hold went back to the player; staff must resolve it).
 */
export async function markPayoutPaid(
  tx: DbTransaction,
  input: { payoutId: string; providerRef?: string; now: Date },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'paid') return { payout, changed: false };
  if (payout.status !== 'approved' && payout.status !== 'processing') {
    throw domainConflict('payout_already_closed', 'This withdrawal was already closed.', {
      status: payout.status,
    });
  }
  if (
    input.providerRef !== undefined &&
    payout.providerRef !== null &&
    payout.providerRef !== input.providerRef
  ) {
    throw domainConflict(
      'provider_ref_conflict',
      'This withdrawal has another provider reference.',
    );
  }
  const posting = await postTransaction(tx, {
    type: 'withdrawal',
    idempotencyKey: withdrawalPaidLedgerKey(payout.id),
    refType: 'payout',
    refId: payout.id,
    description: `Withdrawal paid via ${payout.provider}`,
    entries: withdrawalPaidEntries(payout.provider, payout.amount),
  });
  const updated = await updatePayout(tx, payout.id, {
    status: 'paid',
    providerRef: payout.providerRef ?? input.providerRef ?? null,
    paidLedgerTransactionId: posting.transactionId,
    lastError: null,
    nextAttemptAt: null,
    completedAt: input.now,
    updatedAt: input.now,
  });
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_PAID,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: {
      payoutId: payout.id,
      userId: payout.userId,
      provider: payout.provider,
      amount: payout.amount,
      providerRef: updated.providerRef,
    },
  });
  await writeAudit(tx, {
    actorType: 'system',
    action: WITHDRAWAL_PAID,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, provider: payout.provider },
  });
  return { payout: updated, changed: true };
}

/**
 * The payout failed for good (the provider refused it, or confirmed it
 * failed): the hold goes back to the player (`withdrawal_reversal`) and the
 * payout is `failed`, with `payment.withdrawal_failed`. Repeating it is a
 * no-op. 409 `payout_already_paid` after a payment, `payout_already_closed`
 * after a rejection or cancellation.
 */
export async function markPayoutFailed(
  tx: DbTransaction,
  input: { payoutId: string; reason: string; now: Date },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'failed') return { payout, changed: false };
  if (payout.status === 'paid') {
    throw domainConflict('payout_already_paid', 'This withdrawal was already paid.');
  }
  if (payout.status !== 'approved' && payout.status !== 'processing') {
    throw domainConflict('payout_already_closed', 'This withdrawal was already closed.', {
      status: payout.status,
    });
  }
  const reason = input.reason.slice(0, MAX_TEXT_LENGTH);
  const updated = await reverse(tx, payout, 'failed', { failureReason: reason }, input.now);
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_FAILED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, userId: payout.userId, amount: payout.amount, reason },
  });
  await writeAudit(tx, {
    actorType: 'system',
    action: WITHDRAWAL_FAILED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, reason },
  });
  return { payout: updated, changed: true };
}

/**
 * - paid / failed: the event settled the payout;
 * - pending: the provider reports it in progress (nothing changes);
 * - ignored: the payout is already in that state;
 * - conflict: the event contradicts the payout (paid after a reversal,
 *   failed after payment, another amount): nothing changes, and
 *   `payment.withdrawal_conflict` asks staff to resolve it;
 * - duplicate: this provider event id was already applied.
 */
export type PayoutEventOutcome =
  'paid' | 'failed' | 'pending' | 'ignored' | 'conflict' | 'duplicate';

/**
 * Applies a verified payout notification (or status-query result) in the
 * caller's transaction. The payout is found by (provider, providerRef);
 * an unknown reference is a 404 `unknown_payment_reference` that records
 * nothing (the provider retries). Recorded once per (provider,
 * providerEventId) in payment_events.
 */
export async function applyPayoutEvent(
  tx: DbTransaction,
  input: { provider: string; event: ProviderEventInput; now: Date },
): Promise<{ outcome: PayoutEventOutcome; payout: Payout }> {
  const { provider, event, now } = input;
  assertProviderName(provider);
  if (event.kind !== undefined && event.kind !== 'payout') {
    throw new RangeError('applyPayoutEvent: not a payout event');
  }
  const [found] = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.provider, provider), eq(payouts.providerRef, event.providerRef)))
    .limit(1);
  if (!found) {
    throw new DomainError(
      404,
      'unknown_payment_reference',
      `No ${provider} payout has this reference (yet).`,
    );
  }
  const payout = await lockPayout(tx, found.id);

  let outcome: Exclude<PayoutEventOutcome, 'duplicate'>;
  const closed = (REVERSED_PAYOUT_STATUSES as readonly string[]).includes(payout.status);
  if (event.amount !== null && event.amount !== payout.amount && event.status !== 'pending') {
    outcome = 'conflict';
  } else if (event.status === 'pending') {
    outcome = 'pending';
  } else if (event.status === 'succeeded') {
    outcome = payout.status === 'paid' ? 'ignored' : closed ? 'conflict' : 'paid';
  } else {
    outcome =
      payout.status === 'failed'
        ? 'ignored'
        : payout.status === 'paid'
          ? 'conflict'
          : closed
            ? 'ignored'
            : 'failed';
  }

  const [recorded] = await tx
    .insert(paymentEvents)
    .values({
      provider,
      providerEventId: event.providerEventId,
      kind: 'payout',
      providerRef: event.providerRef,
      status: event.status,
      amount: event.amount,
      currency: event.currency,
      payoutId: payout.id,
      outcome,
      payload: toJsonSafe(event.raw ?? null) ?? null,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.providerEventId] })
    .returning({ id: paymentEvents.id });
  if (!recorded) return { outcome: 'duplicate', payout };

  switch (outcome) {
    case 'paid':
      return { outcome, payout: (await markPayoutPaid(tx, { payoutId: payout.id, now })).payout };
    case 'failed':
      return {
        outcome,
        payout: (
          await markPayoutFailed(tx, { payoutId: payout.id, reason: 'failed_at_provider', now })
        ).payout,
      };
    case 'conflict': {
      await enqueueOutbox(tx, {
        type: WITHDRAWAL_CONFLICT,
        aggregateType: 'payout',
        aggregateId: payout.id,
        payload: {
          payoutId: payout.id,
          userId: payout.userId,
          status: payout.status,
          amount: payout.amount,
          reportedStatus: event.status,
          reportedAmount: event.amount,
          providerEventId: event.providerEventId,
        },
      });
      await writeAudit(tx, {
        actorType: 'system',
        action: WITHDRAWAL_CONFLICT,
        targetType: 'payout',
        targetId: payout.id,
        metadata: {
          status: payout.status,
          reportedStatus: event.status,
          reportedAmount: event.amount,
        },
      });
      return { outcome, payout };
    }
    default:
      return { outcome, payout };
  }
}

/** One payout of the player, or null (also for another player's payout). */
export async function getUserPayout(
  exec: DbExecutor,
  userId: string,
  payoutId: string,
): Promise<Payout | null> {
  const [row] = await exec
    .select()
    .from(payouts)
    .where(and(eq(payouts.id, payoutId), eq(payouts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** The player's payouts, newest first. */
export async function listUserPayouts(
  exec: DbExecutor,
  userId: string,
  options: { limit?: number } = {},
): Promise<Payout[]> {
  return exec
    .select()
    .from(payouts)
    .where(eq(payouts.userId, userId))
    .orderBy(desc(payouts.requestedAt), desc(payouts.id))
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));
}

/** Payouts waiting for manual review, oldest first (the back-office queue). */
export async function listPayoutsForReview(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<Payout[]> {
  return exec
    .select()
    .from(payouts)
    .where(eq(payouts.status, 'requested'))
    .orderBy(asc(payouts.requestedAt), asc(payouts.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
}

/** Total held for open payouts (equals the house_withdrawals_pending balance). */
export async function openPayoutTotal(exec: DbExecutor): Promise<bigint> {
  const [row] = await exec
    .select({ total: sql<string>`COALESCE(SUM(${payouts.amount}), 0)::text` })
    .from(payouts)
    .where(inArray(payouts.status, [...OPEN_PAYOUT_STATUSES]));
  return BigInt(row?.total ?? '0');
}
