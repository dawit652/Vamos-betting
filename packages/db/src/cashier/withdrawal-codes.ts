import { businessDateOf, type AmlRules, type PaymentRules } from '@vamos/core';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { amlHoldsWithdrawals } from '../compliance/aml';
import { domainConflict, domainForbidden, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import {
  cancelWithdrawal,
  markPayoutFailed,
  markPayoutPaid,
  requestWithdrawal,
} from '../payments/withdrawals';
import { writeAudit } from '../platform/audit';
import { lockUser } from '../rg/limits';
import { kycProfiles, users } from '../schema/accounts';
import { cashOperations, cashierShops, cashWithdrawalCodes } from '../schema/cashier';
import { payouts } from '../schema/payments';
import {
  assertPlayerCashAllowed,
  assertShopOperates,
  CASHIER_AUDIT,
  type CashOperation,
  getShop,
  lockOwnOpenShift,
  nextReceiptNo,
  playerCashProvider,
} from './desk';

/**
 * Withdrawal codes (docs/plans/counter-codes-and-deposit-recovery.md, G4; decision O2: any shop
 * with player cash on). In the app a logged-in player asks for cash at a shop: the withdrawal is
 * requested at once (every online rule: winnings only, limits, the daily cap, AML, exclusions;
 * the cashier pays any amount alone, so its size never sends it to review) and its money held; the
 * player gets a 6-digit code valid WITHDRAWAL_CODE_TTL_MS. At any shop with player cash on the
 * cashier types the code alone: the desk shows the amount, the player's name and masked phone,
 * then pays it out of the drawer. One use; only a keyed hash of the code is stored (the API keeps
 * the key); WITHDRAWAL_CODE_SHOP_ATTEMPTS wrong codes in a day lock that shop's code entry until
 * the next day; a code not used in time returns the money to the player (expireWithdrawalCodes).
 * A newer code replaces the player's previous one (its withdrawal is cancelled, the money back).
 */

export const WITHDRAWAL_CODE_TTL_MS = 24 * 3_600_000;
export const WITHDRAWAL_CODE_SHOP_ATTEMPTS = 5;

export const WITHDRAWAL_CODE_AUDIT = {
  created: 'cashier.withdrawal_code_created',
  replaced: 'cashier.withdrawal_code_replaced',
  expired: 'cashier.withdrawal_code_expired',
  shopLocked: 'cashier.withdrawal_codes_locked',
} as const;

type CodeRow = typeof cashWithdrawalCodes.$inferSelect;
type PayoutRow = typeof payouts.$inferSelect;

const live = (now: Date) =>
  and(
    isNotNull(cashWithdrawalCodes.payoutId),
    isNull(cashWithdrawalCodes.usedAt),
    isNull(cashWithdrawalCodes.closedAt),
    gt(cashWithdrawalCodes.expiresAt, now),
  );

/** "+251911223344" → "+251 9•• ••3344": enough for the cashier to ask, not to copy. */
export function maskPhone(phone: string): string {
  return phone.length < 8 ? '••••' : `${phone.slice(0, 5)}•••${phone.slice(-4)}`;
}

/**
 * Requests a cash withdrawal for a code (the API made the code and its keyed hash), in the
 * caller's transaction. The player's previous live code, if any, is replaced: its withdrawal is
 * cancelled (the hold returned) and the code closed. Then requestWithdrawal (provider `cash`,
 * `counter`: no review for its size); the new code lives WITHDRAWAL_CODE_TTL_MS. A unique-hash
 * clash (another live code has the same digits) throws the database's unique violation: the
 * caller rolls back and tries again with new digits. Audited.
 */
export async function createWithdrawalCode(
  tx: DbTransaction,
  input: {
    userId: string;
    amount: bigint;
    codeHash: string;
    idempotencyKey: string;
    rules: PaymentRules;
    amlRules?: AmlRules;
    now: Date;
    ip?: string | null;
  },
): Promise<{ code: CodeRow; payout: PayoutRow; replaced: boolean }> {
  const { now } = input;
  if (input.amount <= 0n) throw new RangeError('amount must be positive');
  await lockUser(tx, input.userId);
  const previous = await tx
    .select()
    .from(cashWithdrawalCodes)
    .where(
      and(
        eq(cashWithdrawalCodes.userId, input.userId),
        isNotNull(cashWithdrawalCodes.payoutId),
        isNull(cashWithdrawalCodes.usedAt),
        isNull(cashWithdrawalCodes.closedAt),
      ),
    )
    .for('update');
  for (const old of previous) {
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, old.payoutId!));
    if (payout && (payout.status === 'requested' || payout.status === 'approved')) {
      await cancelWithdrawal(tx, {
        payoutId: payout.id,
        userId: input.userId,
        now,
        ip: input.ip ?? null,
      });
    }
    await tx
      .update(cashWithdrawalCodes)
      .set({ closedAt: now })
      .where(eq(cashWithdrawalCodes.id, old.id));
    await writeAudit(tx, {
      actorType: 'user',
      actorId: input.userId,
      action: WITHDRAWAL_CODE_AUDIT.replaced,
      targetType: 'payout',
      targetId: old.payoutId!,
      metadata: { codeId: old.id },
      ip: input.ip ?? null,
    });
  }

  const [player] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!player) throw domainNotFound('User');
  const requested = await requestWithdrawal(tx, {
    userId: input.userId,
    amount: input.amount,
    phone: player.phone,
    provider: 'cash',
    idempotencyKey: `cashcode:${input.idempotencyKey.trim()}`,
    now,
    rules: input.rules,
    ...(input.amlRules === undefined ? {} : { amlRules: input.amlRules }),
    ip: input.ip ?? null,
    counter: true,
  });
  if (requested.replayed) {
    // The same request again: its code was shown once and cannot be shown again.
    throw domainConflict('withdrawal_code_replayed', 'Ask for a new code.');
  }
  const [code] = await tx
    .insert(cashWithdrawalCodes)
    .values({
      userId: input.userId,
      codeHash: input.codeHash,
      payoutId: requested.payout.id,
      amount: requested.payout.amount,
      expiresAt: new Date(now.getTime() + WITHDRAWAL_CODE_TTL_MS),
      createdAt: now,
    })
    .returning();
  if (!code) throw new Error('withdrawal code insert returned no row');
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: WITHDRAWAL_CODE_AUDIT.created,
    targetType: 'payout',
    targetId: requested.payout.id,
    metadata: { codeId: code.id, amount: code.amount, status: requested.payout.status },
    ip: input.ip ?? null,
  });
  return { code, payout: requested.payout, replaced: previous.length > 0 };
}

/** The player's live withdrawal code (its amount, expiry and withdrawal's state), or null. */
export async function getLiveWithdrawalCode(
  exec: DbExecutor,
  input: { userId: string; now: Date },
): Promise<{ code: CodeRow; payout: PayoutRow } | null> {
  const [row] = await exec
    .select({ code: cashWithdrawalCodes, payout: payouts })
    .from(cashWithdrawalCodes)
    .innerJoin(payouts, eq(payouts.id, cashWithdrawalCodes.payoutId))
    .where(
      and(
        eq(cashWithdrawalCodes.userId, input.userId),
        live(input.now),
        inArray(payouts.status, ['requested', 'approved']),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What the desk shows for a typed code before paying. */
export interface WithdrawalCodeAtDesk {
  codeId: string;
  payoutId: string;
  amount: bigint;
  /** approved: payable now; requested: still in review (not payable yet). */
  status: 'approved' | 'requested';
  playerName: string | null;
  maskedPhone: string;
  expiresAt: Date;
}

/**
 * The live code with this hash for the shop of the caller's open shift, in its own transaction
 * (a wrong code is counted and committed): 409 `withdrawal_codes_locked` once the shop typed
 * WITHDRAWAL_CODE_SHOP_ATTEMPTS wrong codes today (Addis Ababa), 422 `withdrawal_code_wrong`
 * (details `{ attemptsLeft }`) for a code that is not live. A code of a withdrawal no longer
 * payable (cancelled, paid) is a wrong code.
 */
export async function findWithdrawalCodeAtShop(
  db: Database,
  input: { shopId: string; codeHash: string; now: Date },
): Promise<WithdrawalCodeAtDesk> {
  const today = businessDateOf(input.now);
  const outcome = await db.transaction(async (tx) => {
    const [shop] = await tx
      .select()
      .from(cashierShops)
      .where(eq(cashierShops.id, input.shopId))
      .for('update');
    if (!shop) throw domainNotFound('Shop');
    const failures = shop.withdrawalCodeFailureDay === today ? shop.withdrawalCodeFailures : 0;
    if (failures >= WITHDRAWAL_CODE_SHOP_ATTEMPTS) return { kind: 'locked' as const };
    const [row] = await tx
      .select({
        code: cashWithdrawalCodes,
        payout: payouts,
        phone: users.phone,
        fullName: users.fullName,
        verifiedName: kycProfiles.verifiedName,
      })
      .from(cashWithdrawalCodes)
      .innerJoin(payouts, eq(payouts.id, cashWithdrawalCodes.payoutId))
      .innerJoin(users, eq(users.id, cashWithdrawalCodes.userId))
      .leftJoin(kycProfiles, eq(kycProfiles.userId, cashWithdrawalCodes.userId))
      .where(
        and(
          eq(cashWithdrawalCodes.codeHash, input.codeHash),
          live(input.now),
          inArray(payouts.status, ['requested', 'approved']),
        ),
      )
      .limit(1);
    if (row) {
      return {
        kind: 'found' as const,
        found: {
          codeId: row.code.id,
          payoutId: row.payout.id,
          amount: row.payout.amount,
          status: row.payout.status as 'approved' | 'requested',
          playerName: row.verifiedName?.trim() || row.fullName?.trim() || null,
          maskedPhone: maskPhone(row.phone),
          expiresAt: row.code.expiresAt,
        },
      };
    }
    const count = failures + 1;
    await tx
      .update(cashierShops)
      .set({ withdrawalCodeFailures: count, withdrawalCodeFailureDay: today })
      .where(eq(cashierShops.id, shop.id));
    if (count >= WITHDRAWAL_CODE_SHOP_ATTEMPTS) {
      await writeAudit(tx, {
        actorType: 'system',
        action: WITHDRAWAL_CODE_AUDIT.shopLocked,
        targetType: 'cashier_shop',
        targetId: shop.id,
        metadata: { day: today, failures: count },
      });
    }
    return {
      kind: 'wrong' as const,
      attemptsLeft: Math.max(0, WITHDRAWAL_CODE_SHOP_ATTEMPTS - count),
    };
  });
  if (outcome.kind === 'found') return outcome.found;
  if (outcome.kind === 'locked') {
    throw domainConflict(
      'withdrawal_codes_locked',
      'Too many wrong withdrawal codes at this shop today: codes can be typed again tomorrow.',
    );
  }
  throw domainUnprocessable('withdrawal_code_wrong', 'No withdrawal waits for this code.', {
    attemptsLeft: outcome.attemptsLeft,
  });
}

/**
 * Pays a withdrawal code at the desk, in the caller's transaction (the code was found first with
 * findWithdrawalCodeAtShop): a replayed desk key returns its receipt; the cashier's open shift at a
 * shop with player cash on; the code still live (409 `withdrawal_code_not_live`); its withdrawal
 * approved (409 `withdrawal_in_review` while held for review), not flagged, not approved by this
 * cashier (409 `cashier_four_eyes`); the player active and not held by AML. The cash leaves the
 * drawer: markPayoutPaid (an agent's shop: the agent's balance grows by it), the receipt, the code
 * used, audited.
 */
export async function payWithdrawalCode(
  tx: DbTransaction,
  input: {
    staffId: string;
    shiftId: string;
    codeId: string;
    idempotencyKey: string;
    now: Date;
    ip?: string | null;
  },
): Promise<{ operation: CashOperation; replayed: boolean }> {
  const { now } = input;
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 100) throw new RangeError('idempotency key length');
  const replay = async () => {
    const [existing] = await tx
      .select()
      .from(cashOperations)
      .where(eq(cashOperations.idempotencyKey, key))
      .limit(1);
    if (!existing) return null;
    if (existing.kind !== 'withdrawal' || existing.staffId !== input.staffId) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This receipt key was already used for another operation.',
      );
    }
    return { operation: existing, replayed: true };
  };
  const early = await replay();
  if (early !== null) return early;
  const shift = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const late = await replay();
  if (late !== null) return late;
  const shop = await getShop(tx, shift.shopId);
  if (shop === null) throw domainNotFound('Shop');
  assertShopOperates(shop);
  assertPlayerCashAllowed(shop);

  const [code] = await tx
    .select()
    .from(cashWithdrawalCodes)
    .where(eq(cashWithdrawalCodes.id, input.codeId))
    .for('update');
  if (
    !code ||
    code.payoutId === null ||
    code.usedAt !== null ||
    code.closedAt !== null ||
    code.expiresAt <= now
  ) {
    throw domainConflict('withdrawal_code_not_live', 'This withdrawal code is no longer valid.');
  }
  await lockUser(tx, code.userId);
  const [payout] = await tx
    .select()
    .from(payouts)
    .where(eq(payouts.id, code.payoutId))
    .for('update');
  if (!payout) throw new Error(`payout ${code.payoutId} of withdrawal code ${code.id} is missing`);
  if (payout.status === 'requested') {
    throw domainConflict(
      'withdrawal_in_review',
      'This withdrawal is still being reviewed: it can be paid once approved.',
    );
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
  const [player] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, code.userId))
    .limit(1);
  if (player?.status !== 'active') {
    throw domainForbidden('account_disabled', 'This account is disabled. It cannot be paid.', {
      status: player?.status ?? null,
    });
  }
  if (await amlHoldsWithdrawals(tx, code.userId)) {
    throw domainConflict(
      'aml_review_pending',
      'Compliance must review this player before any cash is paid.',
    );
  }
  // Paid where it is collected: HQ's desks (`cash`) or an agent's (`agent_cash`).
  const provider = playerCashProvider(shop);
  if (payout.provider !== provider) {
    await tx.update(payouts).set({ provider }).where(eq(payouts.id, payout.id));
  }
  const receiptNo = await nextReceiptNo(tx);
  await markPayoutPaid(tx, {
    payoutId: payout.id,
    providerRef: `R${receiptNo}`,
    now,
    admin: { adminId: input.staffId, ip: input.ip ?? null },
    cashDesk: true,
    ...(shop.agentIsHouse ? {} : { paidTo: { kind: 'agent_balance', agentId: shop.agentId } }),
  });
  const [operation] = await tx
    .insert(cashOperations)
    .values({
      receiptNo,
      shiftId: shift.id,
      shopId: shop.id,
      staffId: input.staffId,
      userId: code.userId,
      kind: 'withdrawal',
      amount: payout.amount,
      payoutId: payout.id,
      idempotencyKey: key,
      createdAt: now,
    })
    .returning();
  if (!operation) throw new Error('cash operation insert returned no row');
  await tx
    .update(cashWithdrawalCodes)
    .set({ usedAt: now })
    .where(eq(cashWithdrawalCodes.id, code.id));
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
      userId: code.userId,
      amount: payout.amount,
      via: 'withdrawal_code',
    },
    ip: input.ip ?? null,
  });
  return { operation, replayed: false };
}

/**
 * Withdrawal codes not used in time: each one's withdrawal goes back to the player
 * (markPayoutFailed `withdrawal_code_expired`, the hold returned and the player told) and the code
 * is closed. One transaction per code, with the payout's lock, so a desk paying it at the same
 * moment wins or loses cleanly. At most `limit` per call; returns how many were closed.
 */
export async function expireWithdrawalCodes(
  db: Database,
  input: { now: Date; limit?: number },
): Promise<number> {
  const due = await db
    .select({ id: cashWithdrawalCodes.id })
    .from(cashWithdrawalCodes)
    .where(
      and(
        isNotNull(cashWithdrawalCodes.payoutId),
        isNull(cashWithdrawalCodes.usedAt),
        isNull(cashWithdrawalCodes.closedAt),
        lte(cashWithdrawalCodes.expiresAt, input.now),
      ),
    )
    .orderBy(asc(cashWithdrawalCodes.expiresAt))
    .limit(input.limit ?? 200);
  let closed = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [code] = await tx
        .select()
        .from(cashWithdrawalCodes)
        .where(eq(cashWithdrawalCodes.id, id))
        .for('update');
      if (!code || code.usedAt !== null || code.closedAt !== null || code.payoutId === null) {
        return false;
      }
      const [payout] = await tx
        .select()
        .from(payouts)
        .where(eq(payouts.id, code.payoutId))
        .for('update');
      if (payout && (payout.status === 'requested' || payout.status === 'approved')) {
        await markPayoutFailed(tx, {
          payoutId: payout.id,
          reason: 'withdrawal_code_expired',
          now: input.now,
        });
      }
      await tx
        .update(cashWithdrawalCodes)
        .set({ closedAt: input.now })
        .where(eq(cashWithdrawalCodes.id, code.id));
      await writeAudit(tx, {
        actorType: 'system',
        action: WITHDRAWAL_CODE_AUDIT.expired,
        targetType: 'payout',
        targetId: code.payoutId,
        metadata: { codeId: code.id, amount: code.amount },
      });
      return true;
    });
    if (done) closed += 1;
  }
  return closed;
}
