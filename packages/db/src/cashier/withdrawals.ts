import { timingSafeEqual } from 'node:crypto';
import { toWire, type AmlRules, type PaymentRules } from '@vamos/core';
import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../client';
import {
  domainBadRequest,
  domainConflict,
  domainForbidden,
  domainNotFound,
  domainUnprocessable,
} from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { amlHoldsWithdrawals } from '../compliance/aml';
import { markPayoutPaid, requestWithdrawal } from '../payments/withdrawals';
import { writeAudit } from '../platform/audit';
import { lockUser } from '../rg/limits';
import { adminUsers, users } from '../schema/accounts';
import { cashOperations, cashWithdrawalCodes } from '../schema/cashier';
import { payouts } from '../schema/payments';
import {
  CASH_PROVIDER,
  CASHIER_AUDIT,
  getShop,
  isSupervisorRole,
  lockOwnOpenShift,
  nextReceiptNo,
  shiftPlayerTotal,
  type CashOperation,
} from './desk';

/**
 * Cash withdrawals at a shop's desk (docs/plans/cashier-dashboard.md).
 *
 * The player proves the account with a one-time code made on their own phone (logged in): the
 * cashier never learns a PIN. The withdrawal is the ordinary one (requestWithdrawal with provider
 * `cash`: KYC, the deposit and settlement checks, limits, the daily cap, wagering, AML), so a cash
 * withdrawal is refused or held for review exactly when an online one would be. When the request
 * is approved at once it is paid at the desk in the same transaction (markPayoutPaid: the hold
 * moves to `house:psp:cash`); a request held for review stays in the back office's review queue,
 * and once approved it is paid at the desk on the player's next visit (with a new code). The
 * payout worker never takes a `cash` payout (claimDuePayouts).
 */

export const CASH_CODE_TTL_MS = 15 * 60_000;
export const CASH_CODE_MAX_ATTEMPTS = 5;

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * Stores a player's new shop code (the caller made the code and its keyed hash) and retires the
 * older live ones. 403 `account_disabled` for an account that is not active.
 */
export async function createCashCode(
  tx: DbTransaction,
  input: { userId: string; codeHash: string; now: Date },
): Promise<{ id: string; expiresAt: Date }> {
  await lockUser(tx, input.userId);
  const [user] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  if (user.status !== 'active') {
    throw domainForbidden('account_disabled', 'This account is disabled. Please contact support.', {
      status: user.status,
    });
  }
  await tx
    .update(cashWithdrawalCodes)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(cashWithdrawalCodes.userId, input.userId),
        isNull(cashWithdrawalCodes.usedAt),
        gt(cashWithdrawalCodes.expiresAt, input.now),
      ),
    );
  const expiresAt = new Date(input.now.getTime() + CASH_CODE_TTL_MS);
  const [row] = await tx
    .insert(cashWithdrawalCodes)
    .values({ userId: input.userId, codeHash: input.codeHash, expiresAt, createdAt: input.now })
    .returning({ id: cashWithdrawalCodes.id });
  if (!row) throw new Error('cash code insert returned no row');
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: CASHIER_AUDIT.codeMade,
    targetType: 'cash_withdrawal_code',
    targetId: row.id,
    metadata: { expiresAt },
  });
  return { id: row.id, expiresAt };
}

const invalidCode = (attemptsLeft: number) =>
  domainBadRequest(
    'cash_code_invalid',
    'This code is not valid. Ask the player to make a new code on their phone.',
    { attemptsLeft },
  );

/**
 * Checks the code a player gave at the desk, in its own transaction, so a wrong try is counted
 * even when the withdrawal then fails. Returns the code's id (for cashWithdrawal); 400
 * `cash_code_invalid` (details `{ attemptsLeft }`) when the player has no live code or it does not
 * match. After CASH_CODE_MAX_ATTEMPTS wrong tries the code is dead.
 */
export async function checkCashCode(
  db: Database,
  input: { userId: string; codeHash: string; now: Date },
): Promise<string> {
  const outcome = await db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(cashWithdrawalCodes)
      .where(
        and(
          eq(cashWithdrawalCodes.userId, input.userId),
          isNull(cashWithdrawalCodes.usedAt),
          gt(cashWithdrawalCodes.expiresAt, input.now),
          lt(cashWithdrawalCodes.attempts, CASH_CODE_MAX_ATTEMPTS),
        ),
      )
      .orderBy(desc(cashWithdrawalCodes.createdAt))
      .limit(1)
      .for('update');
    if (!code) return { id: null, attemptsLeft: 0 };
    if (!sameHash(code.codeHash, input.codeHash)) {
      const attempts = code.attempts + 1;
      await tx
        .update(cashWithdrawalCodes)
        .set({ attempts })
        .where(eq(cashWithdrawalCodes.id, code.id));
      return { id: null, attemptsLeft: CASH_CODE_MAX_ATTEMPTS - attempts };
    }
    return { id: code.id, attemptsLeft: CASH_CODE_MAX_ATTEMPTS - code.attempts };
  });
  if (outcome.id === null) throw invalidCode(outcome.attemptsLeft);
  return outcome.id;
}

/** Marks a checked code used, in the withdrawal's transaction (400 if it died meanwhile). */
async function useCashCode(
  tx: DbTransaction,
  input: { codeId: string; userId: string; codeHash: string; now: Date },
): Promise<void> {
  const [code] = await tx
    .select()
    .from(cashWithdrawalCodes)
    .where(eq(cashWithdrawalCodes.id, input.codeId))
    .for('update');
  if (
    !code ||
    code.userId !== input.userId ||
    code.usedAt !== null ||
    code.expiresAt <= input.now ||
    code.attempts >= CASH_CODE_MAX_ATTEMPTS ||
    !sameHash(code.codeHash, input.codeHash)
  ) {
    throw invalidCode(0);
  }
  await tx
    .update(cashWithdrawalCodes)
    .set({ usedAt: input.now })
    .where(eq(cashWithdrawalCodes.id, code.id));
}

export type CashWithdrawalResult =
  | { outcome: 'paid'; operation: CashOperation; replayed: boolean }
  | {
      outcome: 'review';
      payoutId: string;
      amount: bigint;
      /** Why it waits (requestWithdrawal's review reason: above the auto-approval, AML, exclusion). */
      reviewReason: string | null;
      replayed: boolean;
    };

/**
 * Pays a player cash at the desk, in the caller's transaction (the code was checked first with
 * checkCashCode, in its own transaction):
 * 1. a replayed desk key returns its receipt (422 `idempotency_key_reused` if it differs);
 * 2. the shift is locked (404 unless the caller's, 409 `shift_not_open`); 403
 *    `cashier_approval_required` when this amount plus what the desk already paid the player in
 *    this shift is above the shop's threshold, unless a supervisor;
 * 3. the player's approved `cash` payout waiting at the desk, if any, is paid first (409
 *    `cash_payout_waiting`, details `{ amount }`, for another amount); else a new withdrawal is
 *    requested with provider `cash` and every online rule;
 * 4. the code is used (in this transaction: a refusal above leaves it live);
 * 5. a request held for review is answered `review` (the hold stays; the back office reviews it);
 * 6. an approved one is paid: 409 `cashier_four_eyes` when the caller approved it; the player is
 *    checked again (403 `account_disabled`, 409 `aml_review_pending`: it may have waited since its
 *    approval); then markPayoutPaid (provider reference R<receipt number>), the receipt and the
 *    audit record.
 */
export async function cashWithdrawal(
  tx: DbTransaction,
  input: {
    staffId: string;
    shiftId: string;
    userId: string;
    amount: bigint;
    idempotencyKey: string;
    code: { id: string; hash: string };
    rules: PaymentRules;
    amlRules?: AmlRules;
    now: Date;
    ip?: string | null;
  },
): Promise<CashWithdrawalResult> {
  const { amount, now } = input;
  if (typeof amount !== 'bigint' || amount <= 0n) throw new RangeError('amount must be positive');
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 100) throw new RangeError('idempotency key length');

  const replay = async (): Promise<CashWithdrawalResult | null> => {
    const [existing] = await tx
      .select()
      .from(cashOperations)
      .where(eq(cashOperations.idempotencyKey, key))
      .limit(1);
    if (!existing) return null;
    if (
      existing.kind !== 'withdrawal' ||
      existing.userId !== input.userId ||
      existing.amount !== amount ||
      existing.staffId !== input.staffId
    ) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This receipt key was already used for another operation.',
      );
    }
    return { outcome: 'paid', operation: existing, replayed: true };
  };
  const early = await replay();
  if (early !== null) return early;
  const shift = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const late = await replay();
  if (late !== null) return late;

  const shop = await getShop(tx, shift.shopId);
  if (shop === null) throw domainNotFound('Shop');
  if (!shop.active) throw domainConflict('shop_inactive', 'This shop is closed.');
  const [staff] = await tx
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.staffId))
    .limit(1);
  if (!staff) throw domainNotFound('Staff member');
  if (!isSupervisorRole(staff.role)) {
    const already = await shiftPlayerTotal(tx, {
      shiftId: shift.id,
      userId: input.userId,
      kind: 'withdrawal',
    });
    if (already + amount > shop.approvalThreshold) {
      throw domainForbidden(
        'cashier_approval_required',
        'This amount is above what a cashier may pay alone. A supervisor must pay it.',
        {
          threshold: toWire(shop.approvalThreshold),
          amount: toWire(amount),
          alreadyThisShift: toWire(already),
        },
      );
    }
  }

  await lockUser(tx, input.userId);
  const [player] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!player) throw domainNotFound('User');

  const [waiting] = await tx
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.userId, input.userId),
        eq(payouts.provider, CASH_PROVIDER),
        eq(payouts.status, 'approved'),
        isNull(payouts.flaggedAt),
      ),
    )
    .orderBy(asc(payouts.approvedAt), asc(payouts.id))
    .limit(1)
    .for('update');
  let payout;
  let replayed = false;
  if (waiting) {
    if (waiting.amount !== amount) {
      throw domainConflict(
        'cash_payout_waiting',
        'An approved cash withdrawal is waiting for this player: pay that amount first.',
        { amount: toWire(waiting.amount) },
      );
    }
    await useCashCode(tx, {
      codeId: input.code.id,
      userId: input.userId,
      codeHash: input.code.hash,
      now,
    });
    payout = waiting;
  } else {
    await useCashCode(tx, {
      codeId: input.code.id,
      userId: input.userId,
      codeHash: input.code.hash,
      now,
    });
    const requested = await requestWithdrawal(tx, {
      userId: input.userId,
      amount,
      phone: player.phone,
      provider: CASH_PROVIDER,
      idempotencyKey: `cashier:${key}`,
      now,
      rules: input.rules,
      ...(input.amlRules === undefined ? {} : { amlRules: input.amlRules }),
      ip: input.ip ?? null,
    });
    payout = requested.payout;
    replayed = requested.replayed;
  }

  if (payout.status === 'requested') {
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: input.staffId,
      action: CASHIER_AUDIT.withdrawalForReview,
      targetType: 'payout',
      targetId: payout.id,
      metadata: {
        shiftId: shift.id,
        shopId: shop.id,
        userId: input.userId,
        amount,
        reviewReason: payout.reviewReason,
      },
      ip: input.ip ?? null,
    });
    return {
      outcome: 'review',
      payoutId: payout.id,
      amount: payout.amount,
      reviewReason: payout.reviewReason,
      replayed,
    };
  }
  if (payout.status !== 'approved') {
    throw domainConflict('payout_already_closed', 'This withdrawal was already closed.', {
      status: payout.status,
    });
  }
  if (payout.flaggedAt !== null) {
    throw domainConflict('payout_flagged', 'This withdrawal is waiting for staff.');
  }
  if (payout.approvedBy === input.staffId) {
    throw domainConflict(
      'cashier_four_eyes',
      'You approved this withdrawal: another staff member must pay it.',
    );
  }
  // An approved withdrawal may have waited: the player is checked again before cash leaves.
  const [current] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (current?.status !== 'active') {
    throw domainForbidden('account_disabled', 'This account is disabled. It cannot be paid.', {
      status: current?.status ?? null,
    });
  }
  if (await amlHoldsWithdrawals(tx, input.userId)) {
    throw domainConflict(
      'aml_review_pending',
      'Compliance must review this player before any cash is paid.',
    );
  }

  const receiptNo = await nextReceiptNo(tx);
  await markPayoutPaid(tx, {
    payoutId: payout.id,
    providerRef: `R${receiptNo}`,
    now,
    admin: { adminId: input.staffId, ip: input.ip ?? null },
    cashDesk: true,
  });
  const [operation] = await tx
    .insert(cashOperations)
    .values({
      receiptNo,
      shiftId: shift.id,
      shopId: shop.id,
      staffId: input.staffId,
      userId: input.userId,
      kind: 'withdrawal',
      amount: payout.amount,
      payoutId: payout.id,
      idempotencyKey: key,
      createdAt: now,
    })
    .returning();
  if (!operation) throw new Error('cash operation insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.withdrawal,
    targetType: 'payout',
    targetId: payout.id,
    metadata: {
      receiptNo,
      shiftId: shift.id,
      shopId: shop.id,
      userId: input.userId,
      amount: payout.amount,
    },
    ip: input.ip ?? null,
  });
  return { outcome: 'paid', operation, replayed: false };
}

/** The payout a desk key requested, if any (a retry after a `review` answer finds it). */
export async function findDeskPayout(
  exec: DbExecutor,
  input: { userId: string; idempotencyKey: string },
): Promise<typeof payouts.$inferSelect | null> {
  const [row] = await exec
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.userId, input.userId),
        eq(payouts.idempotencyKey, `cashier:${input.idempotencyKey.trim()}`),
      ),
    )
    .limit(1);
  return row ?? null;
}
