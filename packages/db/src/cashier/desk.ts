import { normalizeEthiopianMsisdn, toWire, type PaymentRules } from '@vamos/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from '../catalog/errors';
import { domainConflict, domainForbidden, domainNotFound, domainUnprocessable } from '../errors';
import { postTransaction } from '../ledger/post';
import { getPlayerBalances } from '../ledger/queries';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { DEPOSIT_SUCCEEDED } from '../payments/events';
import { depositEntries, depositLedgerKey } from '../payments/postings';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { getActiveExclusion } from '../rg/exclusions';
import { assertDepositAllowed, lockUser } from '../rg/limits';
import { adminUsers, kycProfiles, users } from '../schema/accounts';
import { cashOperations, cashierShifts, cashierShops } from '../schema/cashier';
import { paymentIntents } from '../schema/payments';

/**
 * The cashier desk (docs/plans/cashier-dashboard.md). Cash is the payment provider `cash`: a desk
 * deposit is a `cash` payment intent credited at once with the ordinary deposit posting
 * (`house:psp:cash` -amount, player cash +amount) and the ordinary DEPOSIT_SUCCEEDED event, so
 * deposit limits, exclusions, AML, the player's history and notifications, and reconciliation
 * cover it like any other deposit. The desk adds the shop, the shift and the receipt.
 */

export const CASH_PROVIDER = 'cash';

/** Audit actions of the desk. */
export const CASHIER_AUDIT = {
  shiftOpened: 'cashier.shift_opened',
  shiftClosed: 'cashier.shift_closed',
  deposit: 'cashier.deposit',
  receiptReprinted: 'cashier.receipt_reprinted',
  shopUpdated: 'cashier.shop_updated',
} as const;

/** Roles that may work above a shop's approval threshold (the supervisors). */
const SUPERVISOR_ROLES: ReadonlySet<string> = new Set(['admin', 'finance']);

export type CashierShop = typeof cashierShops.$inferSelect;
export type CashierShift = typeof cashierShifts.$inferSelect;
export type CashOperation = typeof cashOperations.$inferSelect;

export interface ShiftTotals {
  deposits: { count: number; total: bigint };
  withdrawals: { count: number; total: bigint };
  /** Opening float + deposits − withdrawals. */
  expectedCash: bigint;
}

function assertSantim(amount: bigint, label: string, allowZero = false): void {
  if (typeof amount !== 'bigint' || amount < 0n || (!allowZero && amount === 0n)) {
    throw new RangeError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} bigint`);
  }
}

// ---------------------------------------------------------------------------------------- shops

export async function listShops(exec: DbExecutor): Promise<CashierShop[]> {
  return exec.select().from(cashierShops).orderBy(asc(cashierShops.code));
}

export async function getShop(exec: DbExecutor, shopId: string): Promise<CashierShop | null> {
  const [row] = await exec.select().from(cashierShops).where(eq(cashierShops.id, shopId)).limit(1);
  return row ?? null;
}

/** Changes a shop's receipt header and desk parameters (settings.edit); audited. */
export async function updateShop(
  tx: DbTransaction,
  input: {
    shopId: string;
    name: string;
    address: string;
    receiptWidthMm: 58 | 80;
    approvalThreshold: bigint;
    active: boolean;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<CashierShop> {
  assertSantim(input.approvalThreshold, 'approvalThreshold');
  const before = await getShop(tx, input.shopId);
  if (before === null) throw domainNotFound('Shop');
  const [after] = await tx
    .update(cashierShops)
    .set({
      name: input.name,
      address: input.address,
      receiptWidthMm: input.receiptWidthMm,
      approvalThreshold: input.approvalThreshold,
      active: input.active,
      updatedAt: input.now,
    })
    .where(eq(cashierShops.id, input.shopId))
    .returning();
  if (!after) throw domainNotFound('Shop');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: CASHIER_AUDIT.shopUpdated,
    targetType: 'cashier_shop',
    targetId: input.shopId,
    metadata: {
      before: {
        name: before.name,
        address: before.address,
        receiptWidthMm: before.receiptWidthMm,
        approvalThreshold: before.approvalThreshold,
        active: before.active,
      },
      after: {
        name: after.name,
        address: after.address,
        receiptWidthMm: after.receiptWidthMm,
        approvalThreshold: after.approvalThreshold,
        active: after.active,
      },
    },
    ip: input.ip ?? null,
  });
  return after;
}

// --------------------------------------------------------------------------------------- shifts

/** The deposits and withdrawals of a shift and the cash the drawer should hold. */
export async function shiftTotals(exec: DbExecutor, shift: CashierShift): Promise<ShiftTotals> {
  const rows = await exec
    .select({
      kind: cashOperations.kind,
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(sum(${cashOperations.amount}), 0)::text`,
    })
    .from(cashOperations)
    .where(eq(cashOperations.shiftId, shift.id))
    .groupBy(cashOperations.kind);
  const of = (kind: 'deposit' | 'withdrawal') => {
    const row = rows.find((r) => r.kind === kind);
    return { count: row?.count ?? 0, total: BigInt(row?.total ?? '0') };
  };
  const deposits = of('deposit');
  const withdrawals = of('withdrawal');
  return {
    deposits,
    withdrawals,
    expectedCash: shift.openingFloat + deposits.total - withdrawals.total,
  };
}

/** The staff member's open shift, if any. */
export async function getOpenShift(
  exec: DbExecutor,
  staffId: string,
): Promise<CashierShift | null> {
  const [row] = await exec
    .select()
    .from(cashierShifts)
    .where(and(eq(cashierShifts.staffId, staffId), eq(cashierShifts.status, 'open')))
    .limit(1);
  return row ?? null;
}

export async function getShift(exec: DbExecutor, shiftId: string): Promise<CashierShift | null> {
  const [row] = await exec
    .select()
    .from(cashierShifts)
    .where(eq(cashierShifts.id, shiftId))
    .limit(1);
  return row ?? null;
}

/**
 * Opens a shift at an active shop with the counted float. 409 `shift_already_open` when the
 * staff member has one open (one desk at a time), 409 `shop_inactive` for a closed shop.
 */
export async function openShift(
  tx: DbTransaction,
  input: { staffId: string; shopId: string; openingFloat: bigint; now: Date; ip?: string | null },
): Promise<CashierShift> {
  assertSantim(input.openingFloat, 'openingFloat', true);
  const shop = await getShop(tx, input.shopId);
  if (shop === null) throw domainNotFound('Shop');
  if (!shop.active) throw domainConflict('shop_inactive', 'This shop is closed.');
  if ((await getOpenShift(tx, input.staffId)) !== null) {
    throw domainConflict('shift_already_open', 'You already have an open shift. Close it first.');
  }
  let shift: CashierShift | undefined;
  try {
    // A savepoint: a concurrent open (unique index) must not abort the caller's transaction.
    [shift] = await tx.transaction((sp) =>
      sp
        .insert(cashierShifts)
        .values({
          shopId: shop.id,
          staffId: input.staffId,
          openingFloat: input.openingFloat,
          openedAt: input.now,
        })
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'cashier_shifts_open_staff_uq')) {
      throw domainConflict('shift_already_open', 'You already have an open shift. Close it first.');
    }
    throw error;
  }
  if (!shift) throw new Error('shift insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.shiftOpened,
    targetType: 'cashier_shift',
    targetId: shift.id,
    metadata: { shopId: shop.id, openingFloat: input.openingFloat },
    ip: input.ip ?? null,
  });
  return shift;
}

/** Locks the staff member's shift (FOR UPDATE): 404 unless it is theirs, 409 unless open. */
async function lockOwnOpenShift(
  tx: DbTransaction,
  shiftId: string,
  staffId: string,
): Promise<CashierShift> {
  const [shift] = await tx
    .select()
    .from(cashierShifts)
    .where(eq(cashierShifts.id, shiftId))
    .for('update');
  if (!shift || shift.staffId !== staffId) throw domainNotFound('Shift');
  if (shift.status !== 'open') {
    throw domainConflict('shift_not_open', 'This shift is closed. Open a new shift.');
  }
  return shift;
}

/**
 * Closes the staff member's shift with the cash counted: the expected cash is fixed from the
 * shift's operations (taken under the shift's lock, so no operation can land in it afterwards)
 * and the variance (counted − expected) is audited for finance to review.
 */
export async function closeShift(
  tx: DbTransaction,
  input: {
    staffId: string;
    shiftId: string;
    countedCash: bigint;
    note?: string | null;
    now: Date;
    ip?: string | null;
  },
): Promise<{ shift: CashierShift; totals: ShiftTotals }> {
  assertSantim(input.countedCash, 'countedCash', true);
  const open = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const totals = await shiftTotals(tx, open);
  const [shift] = await tx
    .update(cashierShifts)
    .set({
      status: 'closed',
      closedAt: input.now,
      countedCash: input.countedCash,
      expectedCash: totals.expectedCash,
      closeNote: input.note?.trim() || null,
    })
    .where(eq(cashierShifts.id, open.id))
    .returning();
  if (!shift) throw new Error('shift update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.shiftClosed,
    targetType: 'cashier_shift',
    targetId: shift.id,
    metadata: {
      shopId: shift.shopId,
      openingFloat: shift.openingFloat,
      deposits: totals.deposits.total,
      withdrawals: totals.withdrawals.total,
      expectedCash: totals.expectedCash,
      countedCash: input.countedCash,
      variance: input.countedCash - totals.expectedCash,
    },
    ip: input.ip ?? null,
  });
  return { shift, totals };
}

/** Shifts, newest first (cashier.reports); optionally one shop's or one staff member's. */
export async function listShifts(
  exec: DbExecutor,
  options: { shopId?: string; staffId?: string; shiftId?: string; limit: number },
): Promise<Array<CashierShift & { staffName: string; shopName: string }>> {
  return exec
    .select({
      id: cashierShifts.id,
      shopId: cashierShifts.shopId,
      staffId: cashierShifts.staffId,
      status: cashierShifts.status,
      openingFloat: cashierShifts.openingFloat,
      openedAt: cashierShifts.openedAt,
      closedAt: cashierShifts.closedAt,
      countedCash: cashierShifts.countedCash,
      expectedCash: cashierShifts.expectedCash,
      closeNote: cashierShifts.closeNote,
      staffName: adminUsers.displayName,
      shopName: cashierShops.name,
    })
    .from(cashierShifts)
    .innerJoin(adminUsers, eq(adminUsers.id, cashierShifts.staffId))
    .innerJoin(cashierShops, eq(cashierShops.id, cashierShifts.shopId))
    .where(
      and(
        options.shopId === undefined ? undefined : eq(cashierShifts.shopId, options.shopId),
        options.staffId === undefined ? undefined : eq(cashierShifts.staffId, options.staffId),
        options.shiftId === undefined ? undefined : eq(cashierShifts.id, options.shiftId),
      ),
    )
    .orderBy(desc(cashierShifts.openedAt), desc(cashierShifts.id))
    .limit(options.limit);
}

// -------------------------------------------------------------------------------------- players

export interface DeskPlayer {
  id: string;
  phone: string;
  /** The KYC-verified name, else the name the player gave. */
  name: string | null;
  status: string;
  kycStatus: string;
  cash: bigint;
  bonus: bigint;
  exclusion: { kind: string; endsAt: Date | null } | null;
}

/** Finds a player by phone for the desk (only what the desk needs); null when there is none. */
export async function findDeskPlayer(
  exec: DbExecutor,
  phone: string,
  now: Date,
): Promise<DeskPlayer | null> {
  const normalized = normalizeEthiopianMsisdn(phone);
  if (normalized === null) return null;
  const [user] = await exec
    .select({
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      status: users.status,
      kycStatus: kycProfiles.status,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.phone, normalized))
    .limit(1);
  if (!user) return null;
  const balances = await getPlayerBalances(exec, user.id);
  const exclusion = await getActiveExclusion(exec, user.id, now);
  return {
    id: user.id,
    phone: user.phone,
    name: user.verifiedName?.trim() || user.fullName?.trim() || null,
    status: user.status,
    kycStatus: user.kycStatus ?? 'unverified',
    cash: balances.cash,
    bonus: balances.bonus,
    exclusion: exclusion === null ? null : { kind: exclusion.kind, endsAt: exclusion.endsAt },
  };
}

// ------------------------------------------------------------------------------------- deposits

export interface CashDepositResult {
  operation: CashOperation;
  /** true when the desk's key had been used already: nothing was written. */
  replayed: boolean;
}

/**
 * Takes a cash deposit for a player in the staff member's open shift, in the caller's transaction:
 * 1. a replayed desk key returns the operation it made (422 `idempotency_key_reused` when the
 *    player or amount differ);
 * 2. the shift is locked (409 `shift_not_open`; 404 unless it is the caller's);
 * 3. 422 `deposit_amount_out_of_range` outside the payment rules' [minDeposit, maxDeposit];
 * 4. 403 `cashier_approval_required` above the shop's approval threshold unless the staff member
 *    is a supervisor (finance, admin);
 * 5. lockUser, then assertDepositAllowed: 403 for a disabled or excluded player, 422
 *    `deposit_limit_exceeded` over a deposit limit (cash counts like any deposit);
 * 6. the `cash` payment intent, succeeded, with the ordinary deposit posting; the receipt
 *    (cash_operations); DEPOSIT_SUCCEEDED; the audit record.
 */
export async function cashDeposit(
  tx: DbTransaction,
  input: {
    staffId: string;
    shiftId: string;
    userId: string;
    amount: bigint;
    idempotencyKey: string;
    rules: Pick<PaymentRules, 'minDeposit' | 'maxDeposit'>;
    now: Date;
    ip?: string | null;
  },
): Promise<CashDepositResult> {
  const { amount, now } = input;
  assertSantim(amount, 'deposit amount');
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 100) throw new RangeError('idempotency key length');

  const replay = async (): Promise<CashDepositResult | null> => {
    const [existing] = await tx
      .select()
      .from(cashOperations)
      .where(eq(cashOperations.idempotencyKey, key))
      .limit(1);
    if (!existing) return null;
    if (
      existing.kind !== 'deposit' ||
      existing.userId !== input.userId ||
      existing.amount !== amount ||
      existing.staffId !== input.staffId
    ) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This receipt key was already used for another operation.',
      );
    }
    return { operation: existing, replayed: true };
  };
  // Before the shift lock (a replay still answers once the shift is closed), and again under it:
  // the same key comes from the same desk, so a concurrent duplicate waits for the lock.
  const early = await replay();
  if (early !== null) return early;
  const shift = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const late = await replay();
  if (late !== null) return late;
  const shop = await getShop(tx, shift.shopId);
  if (shop === null) throw domainNotFound('Shop');
  if (!shop.active) throw domainConflict('shop_inactive', 'This shop is closed.');

  if (amount < input.rules.minDeposit || amount > input.rules.maxDeposit) {
    throw domainUnprocessable(
      'deposit_amount_out_of_range',
      amount < input.rules.minDeposit
        ? 'This deposit is below the minimum deposit.'
        : 'This deposit is above the maximum deposit.',
      {
        min: toWire(input.rules.minDeposit),
        max: toWire(input.rules.maxDeposit),
        amount: toWire(amount),
      },
    );
  }
  const [staff] = await tx
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.staffId))
    .limit(1);
  if (!staff) throw domainNotFound('Staff member');
  if (amount > shop.approvalThreshold && !SUPERVISOR_ROLES.has(staff.role)) {
    throw domainForbidden(
      'cashier_approval_required',
      'This amount is above what a cashier may take alone. A supervisor must take it.',
      { threshold: toWire(shop.approvalThreshold), amount: toWire(amount) },
    );
  }

  await lockUser(tx, input.userId);
  await assertDepositAllowed(tx, input.userId, amount, now);
  const [player] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!player) throw domainNotFound('User');

  const intentId = randomUUID();
  const operationId = randomUUID();
  const [next] = await tx
    .execute<{ n: string }>(
      sql`SELECT nextval(pg_get_serial_sequence('cash_operations', 'receipt_no'))::text AS n`,
    )
    .then((result) => result.rows);
  if (!next) throw new Error('no receipt number');
  const receiptNo = Number(next.n);
  const reference = `R${receiptNo}`;

  const posting = await postTransaction(tx, {
    type: 'deposit',
    idempotencyKey: depositLedgerKey(intentId),
    refType: 'payment_intent',
    refId: intentId,
    description: `Cash deposit, receipt ${reference}`,
    actor: { type: 'admin', id: input.staffId },
    createdAt: now,
    entries: depositEntries(CASH_PROVIDER, input.userId, amount),
  });
  await tx.insert(paymentIntents).values({
    id: intentId,
    userId: input.userId,
    provider: CASH_PROVIDER,
    amount,
    phone: player.phone,
    status: 'succeeded',
    providerRef: reference,
    idempotencyKey: `cashier:${operationId}`,
    ledgerTransactionId: posting.transactionId,
    expiresAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const [operation] = await tx
    .insert(cashOperations)
    .values({
      id: operationId,
      receiptNo,
      shiftId: shift.id,
      shopId: shop.id,
      staffId: input.staffId,
      userId: input.userId,
      kind: 'deposit',
      amount,
      paymentIntentId: intentId,
      idempotencyKey: key,
      createdAt: now,
    })
    .returning();
  if (!operation) throw new Error('cash operation insert returned no row');

  await enqueueOutbox(tx, {
    type: DEPOSIT_SUCCEEDED,
    aggregateType: 'payment_intent',
    aggregateId: intentId,
    payload: {
      intentId,
      userId: input.userId,
      provider: CASH_PROVIDER,
      amount,
      providerRef: reference,
    },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.deposit,
    targetType: 'payment_intent',
    targetId: intentId,
    metadata: { receiptNo, shiftId: shift.id, shopId: shop.id, userId: input.userId, amount },
    ip: input.ip ?? null,
  });
  return { operation, replayed: false };
}

// ------------------------------------------------------------------------------------- receipts

export interface Receipt {
  operation: CashOperation;
  shop: CashierShop;
  staffName: string;
  player: { phone: string; name: string | null };
  /** The provider reference the player sees in their history (R<receipt number>). */
  reference: string;
}

/** A receipt to print; null when there is none. */
export async function getReceipt(exec: DbExecutor, operationId: string): Promise<Receipt | null> {
  const [row] = await exec
    .select({
      operation: cashOperations,
      shop: cashierShops,
      staffName: adminUsers.displayName,
      phone: users.phone,
      fullName: users.fullName,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(cashOperations)
    .innerJoin(cashierShops, eq(cashierShops.id, cashOperations.shopId))
    .innerJoin(adminUsers, eq(adminUsers.id, cashOperations.staffId))
    .innerJoin(users, eq(users.id, cashOperations.userId))
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(cashOperations.id, operationId))
    .limit(1);
  if (!row) return null;
  return {
    operation: row.operation,
    shop: row.shop,
    staffName: row.staffName,
    player: {
      phone: row.phone,
      name: row.verifiedName?.trim() || row.fullName?.trim() || null,
    },
    reference: `R${row.operation.receiptNo}`,
  };
}

/** The operations of a shift, newest first. */
export async function listShiftOperations(
  exec: DbExecutor,
  shiftId: string,
): Promise<Array<CashOperation & { playerPhone: string }>> {
  return exec
    .select({
      id: cashOperations.id,
      receiptNo: cashOperations.receiptNo,
      shiftId: cashOperations.shiftId,
      shopId: cashOperations.shopId,
      staffId: cashOperations.staffId,
      userId: cashOperations.userId,
      kind: cashOperations.kind,
      amount: cashOperations.amount,
      paymentIntentId: cashOperations.paymentIntentId,
      payoutId: cashOperations.payoutId,
      idempotencyKey: cashOperations.idempotencyKey,
      reprints: cashOperations.reprints,
      createdAt: cashOperations.createdAt,
      playerPhone: users.phone,
    })
    .from(cashOperations)
    .innerJoin(users, eq(users.id, cashOperations.userId))
    .where(eq(cashOperations.shiftId, shiftId))
    .orderBy(desc(cashOperations.createdAt), desc(cashOperations.receiptNo));
}

/**
 * Counts a reprint of a receipt (the copy says COPY) and audits it. Only the staff member who
 * made the operation, or a supervisor, may reprint (404 otherwise).
 */
export async function recordReprint(
  tx: DbTransaction,
  input: { operationId: string; staffId: string; supervisor: boolean; ip?: string | null },
): Promise<CashOperation> {
  const [current] = await tx
    .select()
    .from(cashOperations)
    .where(eq(cashOperations.id, input.operationId))
    .for('update');
  if (!current || (!input.supervisor && current.staffId !== input.staffId)) {
    throw domainNotFound('Receipt');
  }
  const [updated] = await tx
    .update(cashOperations)
    .set({ reprints: current.reprints + 1 })
    .where(eq(cashOperations.id, current.id))
    .returning();
  if (!updated) throw new Error('reprint update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.receiptReprinted,
    targetType: 'cash_operation',
    targetId: current.id,
    metadata: { receiptNo: current.receiptNo, copy: updated.reprints },
    ip: input.ip ?? null,
  });
  return updated;
}
