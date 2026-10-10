import { randomUUID } from 'node:crypto';
import { normalizeEthiopianMsisdn, toWire, type PaymentRules } from '@vamos/core';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
  WITHDRAWAL_FAILED,
  WITHDRAWAL_FLAGGED,
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

/**
 * Why a payout waits for staff (payouts.flag_reason):
 * - ambiguous_result: the provider's answer leaves open whether money left
 *   (e.g. it refused a resubmission that may be a duplicate);
 * - attempts_exhausted: rules.payoutMaxAttempts attempts got no answer;
 * - provider_conflict: the provider reports something that contradicts the
 *   payout (paid after the hold went back, failed after payment, another
 *   amount or reference). Later provider events are recorded but held.
 */
export type PayoutFlagReason = 'ambiguous_result' | 'attempts_exhausted' | 'provider_conflict';

/** Staff resolving a payout by hand (the audit and ledger actor). */
export interface AdminActor {
  adminId: string;
  ip?: string | null;
}

export interface RequestWithdrawalInput {
  userId: string;
  /** Santim. */
  amount: bigint;
  /** Must be the player's registered phone (payouts never go to anyone else). */
  phone: string;
  /** An enabled provider that can pay out (capabilities.payouts; the caller checks it). */
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

const wire = (amount: bigint): string => toWire(amount);
const isOpen = (payout: Payout) => payout.status === 'approved' || payout.status === 'processing';

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
 * Flags the payout for staff (the worker skips it from now on), with the
 * `payment.withdrawal_flagged` outbox event and an audit record. A payout
 * that is already flagged keeps its reason and time, except that a
 * provider conflict replaces a softer reason (later provider events are
 * then held for staff instead of applied).
 */
async function flagPayout(
  tx: DbTransaction,
  payout: Payout,
  reason: PayoutFlagReason,
  detail: Record<string, unknown>,
  now: Date,
  extra: Partial<typeof payouts.$inferInsert> = {},
): Promise<Payout> {
  const replace =
    payout.flaggedAt === null ||
    (reason === 'provider_conflict' && payout.flagReason !== 'provider_conflict');
  const updated = await updatePayout(tx, payout.id, {
    ...extra,
    ...(replace ? { flagReason: reason, flaggedAt: payout.flaggedAt ?? now } : {}),
    updatedAt: now,
  });
  const payload = {
    payoutId: payout.id,
    userId: payout.userId,
    provider: payout.provider,
    amount: payout.amount,
    status: payout.status,
    reason,
    ...detail,
  };
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_FLAGGED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload,
  });
  await writeAudit(tx, {
    actorType: 'system',
    action: WITHDRAWAL_FLAGGED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: payload,
  });
  return updated;
}

/**
 * Requests a withdrawal in the caller's transaction:
 * 1. lockUser (serialises the player's bets, deposits and withdrawals, so
 *    concurrent requests can never overdraw);
 * 2. a replayed idempotency key returns the existing payout (422
 *    `idempotency_key_reused` when amount, phone or provider differ);
 * 3. 403 `account_disabled` unless the account is active;
 * 4. 403 `kyc_required` unless kyc_profiles.status is `verified` (with a
 *    verified name: the payout goes out in the player's own name);
 * 5. 422 `payout_phone_mismatch` unless `phone` is the registered phone;
 * 6. 422 `withdrawal_amount_out_of_range` outside [minWithdrawal, maxWithdrawal];
 * 7. 422 `withdrawal_daily_cap_exceeded` when the open and paid withdrawals
 *    requested in the last 24 hours plus `amount` exceed dailyWithdrawalCap;
 * 8. 422 `wagering_requirement_not_met` (details `{ remaining }`) while the
 *    deposits are not wagered (see core `remainingWagering`), unless an
 *    exclusion is active (see below);
 * 9. the hold: player_cash -amount, house_withdrawals_pending +amount
 *    (422 `insufficient_funds`), so the money cannot be bet or withdrawn twice;
 * 10. the payout row: `approved` (by `system:auto`) when amount <
 *    autoApproveBelow and no exclusion is active, else `requested` for
 *    manual review; outbox `payment.withdrawal_requested` (and
 *    `payment.withdrawal_approved` when auto-approved) and the audit record.
 *
 * Exclusions do not block withdrawals: a player on a cool-off or
 * self-exclusion must always be able to take their money out (blocking it
 * would trap their funds). Since they cannot bet, the wagering rule is
 * waived for them, and every such withdrawal goes to manual review instead
 * (`active_exclusion`), so an exclusion cannot be used to cash out unplayed
 * deposits unseen. Deposits and bets stay blocked by the exclusion.
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
  const verifiedName = user.verifiedName?.trim() ?? '';
  if (user.kycStatus !== 'verified' || verifiedName.length === 0) {
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
        { balance: wire(error.available), amount: wire(amount) },
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
      recipientName: verifiedName,
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
 * Staff approve a payout waiting for review (`requested` → `approved`). A
 * payout that is already approved, being processed or paid returns
 * `changed: false`; 409 `payout_not_reviewable` once it was rejected,
 * cancelled or failed.
 */
export async function approveWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; adminId: string; now: Date; ip?: string | null },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'approved' || payout.status === 'processing' || payout.status === 'paid') {
    return { payout, changed: false };
  }
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

/** Returns the hold to the player (`withdrawal_reversal`) and closes the payout with `status`. */
async function reverse(
  tx: DbTransaction,
  payout: Payout,
  status: 'failed' | 'rejected' | 'cancelled',
  values: Partial<typeof payouts.$inferInsert>,
  now: Date,
  actor: { type: 'user' | 'admin' | 'system'; id?: string },
): Promise<Payout> {
  const reversal = await postTransaction(tx, {
    type: 'withdrawal_reversal',
    idempotencyKey: withdrawalReversalLedgerKey(payout.id),
    refType: 'payout',
    refId: payout.id,
    description: `Withdrawal ${status}`,
    actor,
    entries: withdrawalReversalEntries(payout.userId, payout.amount),
  });
  return updatePayout(tx, payout.id, {
    ...values,
    status,
    reversalLedgerTransactionId: reversal.transactionId,
    nextAttemptAt: null,
    flagReason: null,
    flaggedAt: null,
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
    { type: 'admin', id: input.adminId },
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
  const updated = await reverse(tx, payout, 'cancelled', { closedBy: input.userId }, input.now, {
    type: 'user',
    id: input.userId,
  });
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
 * Locks up to `limit` unflagged payouts the payout worker should handle
 * now: `approved` ones (to send) and `processing` ones whose next look is
 * due, oldest first, skipping rows another worker holds (FOR UPDATE SKIP
 * LOCKED). Call markPayoutProcessing on each before committing (its
 * `checkAt` is the lease: a worker that dies mid-attempt leaves the payout
 * to be picked up again then), talk to the provider outside the
 * transaction (attemptPayout in @vamos/payments), then record the result
 * with applyPayoutAttempt.
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
        isNull(payouts.flaggedAt),
        or(isNull(payouts.nextAttemptAt), lte(payouts.nextAttemptAt, options.now)),
      ),
    )
    .orderBy(asc(sql`COALESCE(${payouts.nextAttemptAt}, ${payouts.approvedAt})`), asc(payouts.id))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/**
 * The payout worker is about to send the payout (or ask about it):
 * `approved` → `processing`, attempts + 1, and no other worker looks at it
 * before `checkAt`. Returns the payout with the attempt counted (pass its
 * `attempts` and `providerRef` to attemptPayout). 409
 * `payout_not_processable` unless approved or processing, 409
 * `payout_flagged` when it waits for staff.
 */
export async function markPayoutProcessing(
  tx: DbTransaction,
  input: { payoutId: string; now: Date; checkAt: Date },
): Promise<Payout> {
  const payout = await lockPayout(tx, input.payoutId);
  if (!isOpen(payout)) {
    throw domainConflict('payout_not_processable', 'This withdrawal cannot be processed.', {
      status: payout.status,
    });
  }
  if (payout.flaggedAt !== null) {
    throw domainConflict('payout_flagged', 'This withdrawal is waiting for staff.', {
      flagReason: payout.flagReason,
    });
  }
  return updatePayout(tx, payout.id, {
    status: 'processing',
    // The row is locked FOR UPDATE above, so this cannot lose an increment.
    attempts: payout.attempts + 1,
    processingAt: payout.processingAt ?? input.now,
    nextAttemptAt: input.checkAt,
    updatedAt: input.now,
  });
}

/**
 * Staff may settle a payout by hand only while no worker can be sending it:
 * before it was sent (`approved`) or once it is flagged.
 */
function assertStaffMaySettle(payout: Payout): void {
  if (payout.status === 'processing' && payout.flaggedAt === null) {
    throw domainConflict(
      'payout_in_progress',
      'This withdrawal is being processed; wait until it is flagged for staff.',
      { status: payout.status },
    );
  }
}

/** 409 for settling a payout that is not open. */
function notOpenError(payout: Payout): DomainError {
  return payout.status === 'requested'
    ? domainConflict('payout_not_approved', 'This withdrawal has not been approved.')
    : domainConflict('payout_already_closed', 'This withdrawal was already closed.', {
        status: payout.status,
      });
}

/**
 * The payout went out: the hold moves to the provider's clearing account
 * (house_withdrawals_pending -amount, house_psp_clearing:<provider>
 * +amount), the payout is `paid` (flag cleared) with
 * `payment.withdrawal_paid`. Repeating it is a no-op. 409
 * `payout_not_approved` / `payout_already_closed` unless approved or
 * processing, `provider_ref_conflict` for another reference. With `admin`
 * (staff confirmed it with the provider) a processing payout must be
 * flagged first (409 `payout_in_progress`).
 */
export async function markPayoutPaid(
  tx: DbTransaction,
  input: { payoutId: string; providerRef?: string; now: Date; admin?: AdminActor },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'paid') return { payout, changed: false };
  if (!isOpen(payout)) throw notOpenError(payout);
  if (input.admin !== undefined) assertStaffMaySettle(payout);
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
    actor: input.admin ? { type: 'admin', id: input.admin.adminId } : { type: 'system' },
    entries: withdrawalPaidEntries(payout.provider, payout.amount),
  });
  const updated = await updatePayout(tx, payout.id, {
    status: 'paid',
    providerRef: payout.providerRef ?? input.providerRef ?? null,
    paidLedgerTransactionId: posting.transactionId,
    lastError: null,
    nextAttemptAt: null,
    flagReason: null,
    flaggedAt: null,
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
    actorType: input.admin ? 'admin' : 'system',
    actorId: input.admin?.adminId ?? null,
    action: WITHDRAWAL_PAID,
    targetType: 'payout',
    targetId: payout.id,
    metadata: {
      amount: payout.amount,
      provider: payout.provider,
      providerRef: updated.providerRef,
      flagReason: payout.flagReason,
    },
    ip: input.admin?.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/**
 * The payout failed and no money left: the hold goes back to the player
 * (`withdrawal_reversal`), the payout is `failed` (flag cleared) with
 * `payment.withdrawal_failed`. Repeating it is a no-op. 409
 * `payout_already_paid` after a payment, `payout_not_approved` /
 * `payout_already_closed` otherwise. With `admin` a processing payout must
 * be flagged first (409 `payout_in_progress`).
 */
export async function markPayoutFailed(
  tx: DbTransaction,
  input: { payoutId: string; reason: string; now: Date; admin?: AdminActor },
): Promise<PayoutChange> {
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.status === 'failed') return { payout, changed: false };
  if (payout.status === 'paid') {
    throw domainConflict('payout_already_paid', 'This withdrawal was already paid.');
  }
  if (!isOpen(payout)) throw notOpenError(payout);
  if (input.admin !== undefined) assertStaffMaySettle(payout);
  const reason = input.reason.trim().slice(0, MAX_TEXT_LENGTH) || 'failed';
  const updated = await reverse(
    tx,
    payout,
    'failed',
    { failureReason: reason, ...(input.admin ? { closedBy: input.admin.adminId } : {}) },
    input.now,
    input.admin ? { type: 'admin', id: input.admin.adminId } : { type: 'system' },
  );
  await enqueueOutbox(tx, {
    type: WITHDRAWAL_FAILED,
    aggregateType: 'payout',
    aggregateId: payout.id,
    payload: { payoutId: payout.id, userId: payout.userId, amount: payout.amount, reason },
  });
  await writeAudit(tx, {
    actorType: input.admin ? 'admin' : 'system',
    actorId: input.admin?.adminId ?? null,
    action: WITHDRAWAL_FAILED,
    targetType: 'payout',
    targetId: payout.id,
    metadata: { amount: payout.amount, reason, flagReason: payout.flagReason },
    ip: input.admin?.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/**
 * The result of one payout attempt (attemptPayout in @vamos/payments; this
 * is the same shape without `raw`).
 */
export type PayoutAttemptOutcome =
  | { outcome: 'paid'; providerRef: string }
  | { outcome: 'failed'; providerRef: string | null; reason: string }
  | { outcome: 'pending'; providerRef: string }
  | { outcome: 'retry'; providerRef: string | null; error: string }
  | { outcome: 'unknown'; providerRef: string | null; error: string };

/**
 * - paid / failed: the payout was settled (markPayoutPaid / markPayoutFailed);
 * - pending: the provider has it; looked at again at `retryAt`;
 * - retry_scheduled: nothing learned; tried again at `retryAt`;
 * - flagged: it now waits for staff (see PayoutFlagReason);
 * - unchanged: the payout was settled or flagged meanwhile and the result
 *   agrees with that (or is moot).
 */
export type AppliedPayoutAttempt =
  'paid' | 'failed' | 'pending' | 'retry_scheduled' | 'flagged' | 'unchanged';

/**
 * Records what a payout attempt established, in its own transaction after
 * the provider call. A result that contradicts the payout's state (paid
 * after the hold went back, failed after payment, another provider
 * reference) flags it `provider_conflict`; `unknown` flags it
 * `ambiguous_result`; a `retry` at `maxAttempts` (rules.payoutMaxAttempts)
 * or more attempts flags it `attempts_exhausted`. A `pending` result never
 * runs out: the payout is looked at again at `retryAt` (use
 * payoutRetryDelayMs).
 */
export async function applyPayoutAttempt(
  tx: DbTransaction,
  input: {
    payoutId: string;
    result: PayoutAttemptOutcome;
    now: Date;
    retryAt: Date;
    maxAttempts: number;
  },
): Promise<{ applied: AppliedPayoutAttempt; payout: Payout }> {
  const { result, now } = input;
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError('applyPayoutAttempt: maxAttempts must be a positive integer');
  }
  const payout = await lockPayout(tx, input.payoutId);
  const reported = { reportedOutcome: result.outcome, reportedProviderRef: result.providerRef };

  if (!isOpen(payout)) {
    const contradicts =
      (result.outcome === 'paid' && payout.status !== 'paid') ||
      (result.outcome === 'failed' && payout.status === 'paid');
    if (!contradicts) return { applied: 'unchanged', payout };
    const flagged = await flagPayout(tx, payout, 'provider_conflict', reported, now);
    return { applied: 'flagged', payout: flagged };
  }
  if (payout.flaggedAt !== null) return { applied: 'unchanged', payout };

  if (
    result.providerRef !== null &&
    payout.providerRef !== null &&
    result.providerRef !== payout.providerRef
  ) {
    const flagged = await flagPayout(tx, payout, 'provider_conflict', reported, now);
    return { applied: 'flagged', payout: flagged };
  }
  const providerRef = payout.providerRef ?? result.providerRef;

  switch (result.outcome) {
    case 'paid': {
      const change = await markPayoutPaid(tx, {
        payoutId: payout.id,
        providerRef: result.providerRef,
        now,
      });
      return { applied: 'paid', payout: change.payout };
    }
    case 'failed': {
      if (providerRef !== payout.providerRef) {
        await updatePayout(tx, payout.id, { providerRef, updatedAt: now });
      }
      const change = await markPayoutFailed(tx, {
        payoutId: payout.id,
        reason: result.reason,
        now,
      });
      return { applied: 'failed', payout: change.payout };
    }
    case 'pending': {
      const updated = await updatePayout(tx, payout.id, {
        providerRef,
        lastError: null,
        nextAttemptAt: input.retryAt,
        updatedAt: now,
      });
      return { applied: 'pending', payout: updated };
    }
    case 'retry': {
      const error = result.error.slice(0, MAX_TEXT_LENGTH);
      if (payout.attempts >= input.maxAttempts) {
        const flagged = await flagPayout(
          tx,
          payout,
          'attempts_exhausted',
          { attempts: payout.attempts, error },
          now,
          { providerRef, lastError: error },
        );
        return { applied: 'flagged', payout: flagged };
      }
      const updated = await updatePayout(tx, payout.id, {
        providerRef,
        lastError: error,
        nextAttemptAt: input.retryAt,
        updatedAt: now,
      });
      return { applied: 'retry_scheduled', payout: updated };
    }
    case 'unknown': {
      const error = result.error.slice(0, MAX_TEXT_LENGTH);
      const flagged = await flagPayout(
        tx,
        payout,
        'ambiguous_result',
        { attempts: payout.attempts, error },
        now,
        { providerRef, lastError: error },
      );
      return { applied: 'flagged', payout: flagged };
    }
  }
}

/**
 * - paid / failed: the event settled the payout;
 * - pending: the provider reports it in progress (nothing changes);
 * - ignored: the payout is already in that state;
 * - conflict: the event contradicts the payout; nothing changes and the
 *   payout is flagged `provider_conflict`;
 * - held: the payout is flagged `provider_conflict`; staff decide, so the
 *   event is only recorded;
 * - duplicate: this provider event id was already applied.
 */
export type PayoutEventOutcome =
  'paid' | 'failed' | 'pending' | 'ignored' | 'conflict' | 'held' | 'duplicate';

function decidePayoutEvent(
  payout: Payout,
  event: ProviderEventInput,
): Exclude<PayoutEventOutcome, 'duplicate'> {
  if (payout.flagReason === 'provider_conflict') return 'held';
  if (event.status === 'pending') return 'pending';
  if (
    (event.amount !== null && event.amount !== payout.amount) ||
    (event.currency !== null && event.currency.toUpperCase() !== payout.currency)
  ) {
    return 'conflict';
  }
  switch (payout.status) {
    case 'approved':
    case 'processing':
      return event.status === 'succeeded' ? 'paid' : 'failed';
    case 'paid':
      return event.status === 'succeeded' ? 'ignored' : 'conflict';
    case 'failed':
    case 'rejected':
    case 'cancelled':
      // The hold went back to the player: a payment now is money paid twice.
      return event.status === 'failed' ? 'ignored' : 'conflict';
    case 'requested':
      return 'conflict';
  }
}

/**
 * Applies a verified payout notification (or eventFromStatusQuery) in the
 * caller's transaction. The payout is found by (provider, providerRef); an
 * unknown reference is a 404 `unknown_payment_reference` that records
 * nothing (the provider retries, and will match once the worker has stored
 * the reference). Recorded once per (provider, providerEventId) in
 * payment_events; a redelivery returns `duplicate` and changes nothing.
 * A success settles an open payout as paid, a failure returns its hold;
 * this also resolves a payout flagged `ambiguous_result` or
 * `attempts_exhausted` (the provider answered).
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
  const outcome = decidePayoutEvent(payout, event);

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
      const flagged = await flagPayout(
        tx,
        payout,
        'provider_conflict',
        {
          reportedStatus: event.status,
          reportedAmount: event.amount,
          reportedCurrency: event.currency,
          providerEventId: event.providerEventId,
        },
        now,
      );
      return { outcome, payout: flagged };
    }
    default:
      return { outcome, payout };
  }
}

/**
 * Staff clear a payout's flag after looking into it. An open payout is
 * handed back to the payout worker at once (it is asked about, or sent
 * again under the same payout id, which the provider deduplicates); a
 * closed one just leaves the queue. Use markPayoutPaid / markPayoutFailed
 * with `admin` instead when the provider confirmed the outcome. Clearing a
 * payout that is not flagged is a no-op.
 */
export async function clearPayoutFlag(
  tx: DbTransaction,
  input: { payoutId: string; adminId: string; note: string; now: Date; ip?: string | null },
): Promise<PayoutChange> {
  const note = input.note.trim();
  if (note.length === 0) throw new RangeError('clearPayoutFlag: a note is required');
  const payout = await lockPayout(tx, input.payoutId);
  if (payout.flaggedAt === null) return { payout, changed: false };
  const updated = await updatePayout(tx, payout.id, {
    flagReason: null,
    flaggedAt: null,
    ...(isOpen(payout) ? { nextAttemptAt: null } : {}),
    updatedAt: input.now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'payment.withdrawal_flag_cleared',
    targetType: 'payout',
    targetId: payout.id,
    metadata: {
      flagReason: payout.flagReason,
      status: payout.status,
      note: note.slice(0, MAX_TEXT_LENGTH),
    },
    ip: input.ip ?? null,
  });
  return { payout: updated, changed: true };
}

/** One payout by id (back office), or null. */
export async function getPayout(exec: DbExecutor, payoutId: string): Promise<Payout | null> {
  const [row] = await exec.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1);
  return row ?? null;
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

/** The player's payouts, newest first (at most 100). */
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

/** Flagged payouts, oldest flag first (the back office's "needs attention" queue). */
export async function listFlaggedPayouts(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<Payout[]> {
  return exec
    .select()
    .from(payouts)
    .where(isNotNull(payouts.flaggedAt))
    .orderBy(asc(payouts.flaggedAt), asc(payouts.id))
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
