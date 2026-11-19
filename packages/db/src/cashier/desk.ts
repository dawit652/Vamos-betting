import {
  formatShopLabel,
  MAX_SHOP_NUMBER,
  normalizeEthiopianMsisdn,
  toWire,
  type PaymentRules,
} from '@vamos/core';
import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
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
import {
  cashOperations,
  cashShiftVariancePostings,
  cashierShifts,
  cashierShops,
  cashierStaffShops,
} from '../schema/cashier';
import { paymentIntents } from '../schema/payments';
import { agents } from '../schema/retail';

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
  shiftForceClosed: 'cashier.shift_force_closed',
  shiftVariancePosted: 'cashier.shift_variance_posted',
  deposit: 'cashier.deposit',
  withdrawal: 'cashier.withdrawal',
  withdrawalForReview: 'cashier.withdrawal_for_review',
  codeMade: 'cashier.code_made',
  receiptReprinted: 'cashier.receipt_reprinted',
  receiptPrinted: 'cashier.receipt_printed',
  shopUpdated: 'cashier.shop_updated',
  shopCreated: 'cashier.shop_created',
  staffShopAssigned: 'cashier.staff_shop_assigned',
} as const;

/** Roles that may work above a shop's approval threshold (the supervisors). */
const SUPERVISOR_ROLES: ReadonlySet<string> = new Set(['admin', 'finance']);

/** Whether a staff role may work above a shop's approval threshold. */
export function isSupervisorRole(role: string): boolean {
  return SUPERVISOR_ROLES.has(role);
}

/**
 * The next receipt number (taken before the receipt's row, so other rows can carry it). A number
 * taken by an operation that was then refused is not reused: a gap in the numbers is a refused
 * operation, never a missing receipt.
 */
export async function nextReceiptNo(tx: DbTransaction): Promise<number> {
  const [next] = await tx
    .execute<{ n: string }>(
      sql`SELECT nextval(pg_get_serial_sequence('cash_operations', 'receipt_no'))::text AS n`,
    )
    .then((result) => result.rows);
  if (!next) throw new Error('no receipt number');
  return Number(next.n);
}

/**
 * What the desk already took from (deposits) or paid to (withdrawals) one player in one shift. The
 * shop's approval threshold counts it too, so splitting an amount does not avoid the supervisor.
 */
export async function shiftPlayerTotal(
  exec: DbExecutor,
  input: { shiftId: string; userId: string; kind: 'deposit' | 'withdrawal' },
): Promise<bigint> {
  const [row] = await exec
    .select({ total: sql<string>`COALESCE(sum(${cashOperations.amount}), 0)::text` })
    .from(cashOperations)
    .where(
      and(
        eq(cashOperations.shiftId, input.shiftId),
        eq(cashOperations.userId, input.userId),
        eq(cashOperations.kind, input.kind),
      ),
    );
  return BigInt(row?.total ?? '0');
}

/** The operation a desk key made, if any. */
export async function findOperationByKey(
  exec: DbExecutor,
  idempotencyKey: string,
): Promise<CashOperation | null> {
  const [row] = await exec
    .select()
    .from(cashOperations)
    .where(eq(cashOperations.idempotencyKey, idempotencyKey.trim()))
    .limit(1);
  return row ?? null;
}

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

/**
 * A shop with its agent (docs/plans/agent-shops.md): agent 1000 is Nahubet HQ (`agentIsHouse`),
 * whose shops' cash is Nahubet's; `label` is the printed number, e.g. `1001-01`.
 */
export type ShopWithAgent = CashierShop & {
  agentNumber: number;
  agentName: string;
  agentStatus: 'active' | 'blocked';
  agentIsHouse: boolean;
  label: string;
};

const SHOP_WITH_AGENT = {
  ...getTableColumns(cashierShops),
  agentNumber: agents.number,
  agentName: agents.name,
  agentStatus: agents.status,
  agentIsHouse: agents.isHouse,
};

function withLabel(row: Omit<ShopWithAgent, 'label'>): ShopWithAgent {
  return { ...row, label: formatShopLabel(row.agentNumber, row.number) };
}

/** Every shop with its agent, by agent number then shop number. */
export async function listShops(exec: DbExecutor): Promise<ShopWithAgent[]> {
  const rows = await exec
    .select(SHOP_WITH_AGENT)
    .from(cashierShops)
    .innerJoin(agents, eq(agents.id, cashierShops.agentId))
    .orderBy(asc(agents.number), asc(cashierShops.number));
  return rows.map(withLabel);
}

export async function getShop(exec: DbExecutor, shopId: string): Promise<ShopWithAgent | null> {
  const [row] = await exec
    .select(SHOP_WITH_AGENT)
    .from(cashierShops)
    .innerJoin(agents, eq(agents.id, cashierShops.agentId))
    .where(eq(cashierShops.id, shopId))
    .limit(1);
  return row === undefined ? null : withLabel(row);
}

/**
 * A shop works only while it is open and its agent is not blocked (the admin blocks an agent at
 * any time; owner, 19 Nov 2026): 409 `shop_inactive` / `agent_blocked`.
 */
export function assertShopOperates(shop: ShopWithAgent): void {
  if (!shop.active) throw domainConflict('shop_inactive', 'This shop is closed.');
  if (shop.agentStatus === 'blocked') {
    throw domainConflict(
      'agent_blocked',
      "This shop's agent is blocked: it cannot work until an admin unblocks it.",
    );
  }
}

/**
 * Player cash (deposits and withdrawals for online players) moves the agent's prepaid balance at an
 * independent agent's shop, which arrives with phase 2 of docs/plans/agent-shops.md. Until then
 * only Nahubet HQ's shops, whose cash is Nahubet's, take player cash: 409 `agent_player_cash_off`.
 */
export function assertPlayerCashAllowed(shop: ShopWithAgent): void {
  if (!shop.agentIsHouse) {
    throw domainConflict(
      'agent_player_cash_off',
      "Player cash is not available at this agent's shops yet.",
    );
  }
}

/**
 * Adds a shop (settings.edit; the owner runs more than 40): its `code` (2 to 32 of a-z, 0-9 and -,
 * unique, shown on receipts and reports), name, address, receipt width and approval threshold.
 * A code already in use is a 409. Audited.
 */
export async function createShop(
  tx: DbTransaction,
  input: {
    /** The agent that runs it; omitted or null for Nahubet HQ. */
    agentId?: string | null;
    /** Omitted: the shop's printed number (`1001-01`). */
    code?: string;
    name: string;
    address: string;
    receiptWidthMm: 58 | 80;
    approvalThreshold: bigint;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<CashierShop> {
  assertSantim(input.approvalThreshold, 'approvalThreshold');
  // The agent row is locked: two shops added at once for one agent get different numbers.
  const [agent] = await tx
    .select({ id: agents.id, number: agents.number })
    .from(agents)
    .where(
      input.agentId === undefined || input.agentId === null
        ? eq(agents.isHouse, true)
        : eq(agents.id, input.agentId),
    )
    .for('update');
  if (agent === undefined) throw domainNotFound('Agent');
  const [highest] = await tx
    .select({ number: sql<number | null>`max(${cashierShops.number})` })
    .from(cashierShops)
    .where(eq(cashierShops.agentId, agent.id));
  const number = Number(highest?.number ?? 0) + 1;
  if (number > MAX_SHOP_NUMBER) {
    throw domainConflict('agent_shop_limit', `An agent can have at most ${MAX_SHOP_NUMBER} shops.`);
  }
  const code = input.code ?? formatShopLabel(agent.number, number);
  let created: CashierShop | undefined;
  try {
    [created] = await tx
      .insert(cashierShops)
      .values({
        agentId: agent.id,
        number,
        code,
        name: input.name,
        address: input.address,
        receiptWidthMm: input.receiptWidthMm,
        approvalThreshold: input.approvalThreshold,
        active: true,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw domainConflict('shop_code_taken', `A shop with the code "${code}" exists.`);
    }
    throw error;
  }
  if (!created) throw new Error('cashier_shops insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: CASHIER_AUDIT.shopCreated,
    targetType: 'cashier_shop',
    targetId: created.id,
    metadata: {
      code: created.code,
      agentId: agent.id,
      label: formatShopLabel(agent.number, number),
      name: created.name,
      receiptWidthMm: created.receiptWidthMm,
      approvalThreshold: created.approvalThreshold,
    },
    ip: input.ip ?? null,
  });
  return created;
}

/**
 * A cashier opens shifts only at their own shop (cashier_staff_shops); one without a shop may work
 * while only one shop is active (a single-shop setup). Supervisors (finance, admin) work anywhere.
 */
async function assertMayWorkAt(tx: DbTransaction, staffId: string, shopId: string): Promise<void> {
  const [staff] = await tx
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, staffId));
  if (staff?.role !== 'cashier') return;
  const assigned = await getStaffShop(tx, staffId);
  if (assigned !== null) {
    if (assigned !== shopId) {
      throw domainForbidden(
        'shop_not_assigned',
        'You work at another shop: open your shift there.',
      );
    }
    return;
  }
  const active = await tx
    .select({ id: cashierShops.id })
    .from(cashierShops)
    .where(eq(cashierShops.active, true))
    .limit(2);
  if (active.length > 1) {
    throw domainForbidden(
      'shop_assignment_required',
      'An admin must first assign you to your shop (Cashier, Shifts, Cashiers).',
    );
  }
}

/** The shop a cashier is assigned to, or null. */
export async function getStaffShop(exec: DbExecutor, staffId: string): Promise<string | null> {
  const [row] = await exec
    .select({ shopId: cashierStaffShops.shopId })
    .from(cashierStaffShops)
    .where(eq(cashierStaffShops.staffId, staffId));
  return row?.shopId ?? null;
}

/** The cashier accounts with their shop (null: not assigned), by name. */
export async function listCashierStaff(
  exec: DbExecutor,
): Promise<Array<{ id: string; email: string; name: string; shopId: string | null }>> {
  return exec
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.displayName,
      shopId: cashierStaffShops.shopId,
    })
    .from(adminUsers)
    .leftJoin(cashierStaffShops, eq(cashierStaffShops.staffId, adminUsers.id))
    .where(eq(adminUsers.role, 'cashier'))
    .orderBy(asc(adminUsers.displayName));
}

/**
 * Assigns a cashier to a shop, or removes the assignment (`shopId` null), settings.edit; audited.
 * Only cashier accounts are assigned (404 otherwise); the shop must exist and be active.
 */
export async function assignStaffShop(
  tx: DbTransaction,
  input: { staffId: string; shopId: string | null; adminId: string; now: Date; ip?: string | null },
): Promise<void> {
  const [staff] = await tx
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.staffId));
  if (staff?.role !== 'cashier') throw domainNotFound('Cashier');
  const before = await getStaffShop(tx, input.staffId);
  if (input.shopId === null) {
    await tx.delete(cashierStaffShops).where(eq(cashierStaffShops.staffId, input.staffId));
  } else {
    const shop = await getShop(tx, input.shopId);
    if (shop === null) throw domainNotFound('Shop');
    if (!shop.active) throw domainConflict('shop_inactive', 'This shop is closed.');
    await tx
      .insert(cashierStaffShops)
      .values({
        staffId: input.staffId,
        shopId: input.shopId,
        assignedBy: input.adminId,
        assignedAt: input.now,
      })
      .onConflictDoUpdate({
        target: cashierStaffShops.staffId,
        set: { shopId: input.shopId, assignedBy: input.adminId, assignedAt: input.now },
      });
  }
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: CASHIER_AUDIT.staffShopAssigned,
    targetType: 'admin_user',
    targetId: input.staffId,
    metadata: { before, after: input.shopId },
    ip: input.ip ?? null,
  });
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
  return (await shiftTotalsMany(exec, [shift])).get(shift.id)!;
}

/**
 * shiftTotals for many shifts in ONE grouped query (the shift list; review finding 8 of the
 * cashier dashboard: it read one query per shift). Every shift given has an entry.
 */
export async function shiftTotalsMany(
  exec: DbExecutor,
  shifts: readonly CashierShift[],
): Promise<Map<string, ShiftTotals>> {
  const out = new Map<string, ShiftTotals>();
  if (shifts.length === 0) return out;
  const rows = await exec
    .select({
      shiftId: cashOperations.shiftId,
      kind: cashOperations.kind,
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(sum(${cashOperations.amount}), 0)::text`,
    })
    .from(cashOperations)
    .where(
      inArray(
        cashOperations.shiftId,
        shifts.map((shift) => shift.id),
      ),
    )
    .groupBy(cashOperations.shiftId, cashOperations.kind);
  for (const shift of shifts) out.set(shift.id, totalsOf(shift, rows));
  return out;
}

function totalsOf(
  shift: CashierShift,
  rows: ReadonlyArray<{ shiftId: string; kind: string; count: number; total: string }>,
): ShiftTotals {
  const of = (kind: 'deposit' | 'withdrawal') => {
    const row = rows.find((r) => r.shiftId === shift.id && r.kind === kind);
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

/** One shop's day (shopDaySummary). */
export interface ShopDaySummary {
  shopId: string;
  code: string;
  name: string;
  active: boolean;
  /** Shifts open now (whatever day they opened). */
  openShifts: number;
  deposits: { count: number; total: bigint };
  withdrawals: { count: number; total: bigint };
  /** Deposits − withdrawals of the period: the cash the shop took in. */
  net: bigint;
}

/**
 * Every shop's cash in [from, to) and its open shifts, in two grouped queries, by shop code (the
 * owner runs more than 40 shops: one table instead of opening each shift).
 */
export async function shopDaySummary(
  exec: DbExecutor,
  period: { from: Date; to: Date },
): Promise<ShopDaySummary[]> {
  const [shops, sums, open] = await Promise.all([
    listShops(exec),
    exec
      .select({
        shopId: cashOperations.shopId,
        kind: cashOperations.kind,
        count: sql<number>`count(*)::int`,
        total: sql<string>`COALESCE(sum(${cashOperations.amount}), 0)::text`,
      })
      .from(cashOperations)
      .where(
        and(
          sql`${cashOperations.createdAt} >= ${period.from.toISOString()}::timestamptz`,
          sql`${cashOperations.createdAt} < ${period.to.toISOString()}::timestamptz`,
        ),
      )
      .groupBy(cashOperations.shopId, cashOperations.kind),
    exec
      .select({ shopId: cashierShifts.shopId, count: sql<number>`count(*)::int` })
      .from(cashierShifts)
      .where(eq(cashierShifts.status, 'open'))
      .groupBy(cashierShifts.shopId),
  ]);
  return shops.map((shop) => {
    const of = (kind: 'deposit' | 'withdrawal') => {
      const row = sums.find((r) => r.shopId === shop.id && r.kind === kind);
      return { count: row?.count ?? 0, total: BigInt(row?.total ?? '0') };
    };
    const deposits = of('deposit');
    const withdrawals = of('withdrawal');
    return {
      shopId: shop.id,
      code: shop.code,
      name: shop.name,
      active: shop.active,
      openShifts: open.find((r) => r.shopId === shop.id)?.count ?? 0,
      deposits,
      withdrawals,
      net: deposits.total - withdrawals.total,
    };
  });
}

/** One of a player's deposits as the desk shows it (recentDeposits). */
export interface DeskDeposit {
  id: string;
  provider: string;
  amount: bigint;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired';
  /** Waiting for staff (an SMS that did not match, another payer's phone...). */
  flagged: boolean;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * A player's latest deposits, newest first (cashier phase "failed automatic deposit"): a player
 * who says an online payment did not arrive is shown its state at the desk; the desk never credits
 * it (a flagged one is for staff on the SMS rail review queue, through the existing tools).
 */
export async function recentDeposits(
  exec: DbExecutor,
  userId: string,
  limit = 10,
): Promise<DeskDeposit[]> {
  const rows = await exec
    .select({
      id: paymentIntents.id,
      provider: paymentIntents.provider,
      amount: paymentIntents.amount,
      status: paymentIntents.status,
      flaggedAt: paymentIntents.flaggedAt,
      createdAt: paymentIntents.createdAt,
      completedAt: paymentIntents.completedAt,
    })
    .from(paymentIntents)
    .where(eq(paymentIntents.userId, userId))
    .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    amount: row.amount,
    status: row.status,
    flagged: row.flaggedAt !== null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  }));
}

/** A closed shift's booked cash difference, or null (postShiftVariance). */
export type ShiftVariancePosting = typeof cashShiftVariancePostings.$inferSelect;

export async function getShiftVariancePosting(
  exec: DbExecutor,
  shiftId: string,
): Promise<ShiftVariancePosting | null> {
  const [row] = await exec
    .select()
    .from(cashShiftVariancePostings)
    .where(eq(cashShiftVariancePostings.shiftId, shiftId));
  return row ?? null;
}

/**
 * Books a closed shift's cash difference (cashier phase "variance posting"; the owner's default of
 * 18 Nov: a shop loss or gain approved by a supervisor). variance = counted − expected (fixed at
 * the close); one `adjustment` posting: the cash the shops hold (`house:psp:cash`) moves by the
 * difference, against `house:cash_variance` (never GGR). Once per shift (409
 * `variance_already_posted`); the shift must be closed with a count (409 `shift_not_closed`) and
 * have a difference (409 `no_variance`); four eyes: the shift's own cashier may not book it (403
 * `cashier_four_eyes`). Audited.
 */
export async function postShiftVariance(
  tx: DbTransaction,
  input: { shiftId: string; supervisorId: string; now: Date; ip?: string | null },
): Promise<ShiftVariancePosting> {
  const [shift] = await tx
    .select()
    .from(cashierShifts)
    .where(eq(cashierShifts.id, input.shiftId))
    .for('update');
  if (!shift) throw domainNotFound('Shift');
  if (shift.status !== 'closed' || shift.countedCash === null || shift.expectedCash === null) {
    throw domainConflict('shift_not_closed', 'Close the shift with a cash count first.');
  }
  if (shift.staffId === input.supervisorId) {
    throw domainForbidden('cashier_four_eyes', 'Another supervisor must book your own shift.');
  }
  if ((await getShiftVariancePosting(tx, shift.id)) !== null) {
    throw domainConflict('variance_already_posted', 'This difference is already booked.');
  }
  const variance = shift.countedCash - shift.expectedCash;
  if (variance === 0n) throw domainConflict('no_variance', 'The count matched: nothing to book.');
  const posting = await postTransaction(tx, {
    type: 'adjustment',
    idempotencyKey: `cash_shift_variance:${shift.id}`,
    refType: 'cashier_shift',
    refId: shift.id,
    description: variance < 0n ? 'cash shift short' : 'cash shift over',
    actor: { type: 'admin', id: input.supervisorId },
    createdAt: input.now,
    entries: [
      { account: { kind: 'house_psp_clearing', provider: CASH_PROVIDER }, amount: -variance },
      { account: { kind: 'house_cash_variance' }, amount: variance },
    ],
  });
  const [row] = await tx
    .insert(cashShiftVariancePostings)
    .values({
      shiftId: shift.id,
      amount: variance,
      ledgerTransactionId: posting.transactionId,
      postedBy: input.supervisorId,
      postedAt: input.now,
    })
    .returning();
  if (!row) throw new Error('variance posting insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.supervisorId,
    action: CASHIER_AUDIT.shiftVariancePosted,
    targetType: 'cashier_shift',
    targetId: shift.id,
    metadata: { variance, ledgerTransactionId: posting.transactionId, shopId: shift.shopId },
    ip: input.ip ?? null,
  });
  return row;
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
  assertShopOperates(shop);
  await assertMayWorkAt(tx, input.staffId, shop.id);
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
export async function lockOwnOpenShift(
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

/**
 * A supervisor (finance, admin) closes a shift its cashier left open (gone home, ill), with the cash
 * the supervisor counted in that drawer; audited with both staff members. 403
 * `supervisor_required` for anyone else, 409 `use_own_close` for the supervisor's own shift (the
 * ordinary close), 409 `shift_not_open` when it is closed already.
 */
export async function forceCloseShift(
  tx: DbTransaction,
  input: {
    supervisorId: string;
    shiftId: string;
    countedCash: bigint;
    note?: string | null;
    now: Date;
    ip?: string | null;
  },
): Promise<{ shift: CashierShift; totals: ShiftTotals }> {
  assertSantim(input.countedCash, 'countedCash', true);
  const [staff] = await tx
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.supervisorId))
    .limit(1);
  if (!staff || !SUPERVISOR_ROLES.has(staff.role)) {
    throw domainForbidden(
      'supervisor_required',
      "Only a supervisor (finance or admin) can close another person's shift.",
    );
  }
  const [open] = await tx
    .select()
    .from(cashierShifts)
    .where(eq(cashierShifts.id, input.shiftId))
    .for('update');
  if (!open) throw domainNotFound('Shift');
  if (open.staffId === input.supervisorId) {
    throw domainConflict('use_own_close', 'Close your own shift from your desk.');
  }
  if (open.status !== 'open') {
    throw domainConflict('shift_not_open', 'This shift is closed already.');
  }
  const totals = await shiftTotals(tx, open);
  const note = input.note?.trim();
  const [shift] = await tx
    .update(cashierShifts)
    .set({
      status: 'closed',
      closedAt: input.now,
      countedCash: input.countedCash,
      expectedCash: totals.expectedCash,
      closeNote: note ? `Closed by a supervisor: ${note}` : 'Closed by a supervisor',
    })
    .where(eq(cashierShifts.id, open.id))
    .returning();
  if (!shift) throw new Error('shift update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.supervisorId,
    action: CASHIER_AUDIT.shiftForceClosed,
    targetType: 'cashier_shift',
    targetId: shift.id,
    metadata: {
      cashierId: open.staffId,
      shopId: shift.shopId,
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
 * 4. 403 `cashier_approval_required` when this amount plus what the desk already took from the
 *    player in this shift is above the shop's approval threshold, unless the staff member is a
 *    supervisor (finance, admin);
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
  assertShopOperates(shop);
  assertPlayerCashAllowed(shop);

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
  if (!SUPERVISOR_ROLES.has(staff.role)) {
    const already = await shiftPlayerTotal(tx, {
      shiftId: shift.id,
      userId: input.userId,
      kind: 'deposit',
    });
    if (already + amount > shop.approvalThreshold) {
      throw domainForbidden(
        'cashier_approval_required',
        'This amount is above what a cashier may take alone. A supervisor must take it.',
        {
          threshold: toWire(shop.approvalThreshold),
          amount: toWire(amount),
          alreadyThisShift: toWire(already),
        },
      );
    }
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
  const receiptNo = await nextReceiptNo(tx);
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
  shop: ShopWithAgent;
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
      agentNumber: agents.number,
      agentName: agents.name,
      agentStatus: agents.status,
      agentIsHouse: agents.isHouse,
      staffName: adminUsers.displayName,
      phone: users.phone,
      fullName: users.fullName,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(cashOperations)
    .innerJoin(cashierShops, eq(cashierShops.id, cashOperations.shopId))
    .innerJoin(agents, eq(agents.id, cashierShops.agentId))
    .innerJoin(adminUsers, eq(adminUsers.id, cashOperations.staffId))
    .innerJoin(users, eq(users.id, cashOperations.userId))
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(cashOperations.id, operationId))
    .limit(1);
  if (!row) return null;
  return {
    operation: row.operation,
    shop: withLabel({
      ...row.shop,
      agentNumber: row.agentNumber,
      agentName: row.agentName,
      agentStatus: row.agentStatus,
      agentIsHouse: row.agentIsHouse,
    }),
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
      originalPrintedAt: cashOperations.originalPrintedAt,
      createdAt: cashOperations.createdAt,
      playerPhone: users.phone,
    })
    .from(cashOperations)
    .innerJoin(users, eq(users.id, cashOperations.userId))
    .where(eq(cashOperations.shiftId, shiftId))
    .orderBy(desc(cashOperations.createdAt), desc(cashOperations.receiptNo));
}

/**
 * Prints a receipt (cashier phase "original receipt once"): the first print is the ORIGINAL
 * (original_printed_at set, audited `cashier.receipt_printed`); every later one is a copy, counted
 * and audited like a reprint. Only the staff member who made it, or a supervisor, prints it.
 */
export async function printReceipt(
  tx: DbTransaction,
  input: {
    operationId: string;
    staffId: string;
    supervisor: boolean;
    now: Date;
    ip?: string | null;
  },
): Promise<{ operation: CashOperation; copy: boolean }> {
  const [current] = await tx
    .select()
    .from(cashOperations)
    .where(eq(cashOperations.id, input.operationId))
    .for('update');
  if (!current || (!input.supervisor && current.staffId !== input.staffId)) {
    throw domainNotFound('Receipt');
  }
  if (current.originalPrintedAt !== null) {
    const operation = await recordReprint(tx, input);
    return { operation, copy: true };
  }
  const [updated] = await tx
    .update(cashOperations)
    .set({ originalPrintedAt: input.now })
    .where(eq(cashOperations.id, current.id))
    .returning();
  if (!updated) throw new Error('print update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: CASHIER_AUDIT.receiptPrinted,
    targetType: 'cash_operation',
    targetId: current.id,
    metadata: { receiptNo: current.receiptNo },
    ip: input.ip ?? null,
  });
  return { operation: updated, copy: false };
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
