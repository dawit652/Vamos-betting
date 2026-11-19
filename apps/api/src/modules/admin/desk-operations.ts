import {
  CashDepositResponse,
  CashierPlayerResponse,
  CashWithdrawalResponse,
  type CashDepositRequest,
  type CashWithdrawalRequest,
} from '@vamos/contracts';
import {
  cashDeposit,
  cashWithdrawal,
  checkCashCode,
  findDeskPayout,
  findDeskPlayer,
  findOperationByKey,
  getReceipt,
  loadComplianceSettings,
  loadGameSettings,
  printReceipt,
  recordReprint,
  writeAudit,
  type DbExecutor,
  type Receipt,
} from '@vamos/db';
import type { AppDeps } from '../../deps';
import { cashCodeHash } from '../../lib/cash-code';
import { notFound } from '../../lib/errors';
import { inTx, wire } from './common';

/**
 * Player cash at a desk, shared by the back office's desk (`/admin/cashier/*`) and the shop app's
 * (`/shop/desk/*`): one code path for the lookups, deposits, withdrawals and receipts, so both
 * sides keep the same rules. The money moves in @vamos/db (cashDeposit, cashWithdrawal); these
 * functions only order the checks and shape the answers.
 */

/** Who works the desk: the staff member, their address, and whether they are a supervisor. */
export interface DeskActor {
  staffId: string;
  ip: string | null;
  /** Finance or admin: above a shop's threshold, and any receipt. Never in the shop app. */
  supervisor: boolean;
}

type ReceiptViewOf = (receipt: Receipt) => unknown;

/** Finds a player by phone; every lookup is audited (who looked whom up), found or not. */
export async function deskLookup(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  actor: DeskActor,
  phone: string,
) {
  const player = await findDeskPlayer(deps.db, phone, deps.clock());
  await writeAudit(deps.db, {
    actorType: 'admin',
    actorId: actor.staffId,
    action: 'cashier.player_lookup',
    ...(player === null ? {} : { targetType: 'user', targetId: player.id }),
    metadata: { found: player !== null },
    ip: actor.ip,
  });
  if (player === null) throw notFound('Player');
  return wire(CashierPlayerResponse, { player });
}

/** A cash deposit in the actor's open shift, answered with its receipt. */
export async function deskDeposit(
  deps: AppDeps,
  actor: DeskActor,
  input: CashDepositRequest,
  receiptView: ReceiptViewOf,
) {
  const result = await inTx(deps, async (tx) => {
    const { payments } = await loadGameSettings(tx);
    const { operation, replayed } = await cashDeposit(tx, {
      staffId: actor.staffId,
      shiftId: input.shiftId,
      userId: input.userId,
      amount: BigInt(input.amount),
      idempotencyKey: input.idempotencyKey,
      rules: payments,
      now: deps.clock(),
      ip: actor.ip,
    });
    const receipt = await getReceipt(tx, operation.id);
    if (receipt === null) throw new Error('receipt missing after a deposit');
    return { receipt: receiptView(receipt), replayed };
  });
  return wire(CashDepositResponse, result);
}

/**
 * A cash withdrawal with the player's shop code: a replay answers with its receipt first (the code
 * is spent by then), a retry after a `review` answer gets that answer again, then the code is
 * checked in its own transaction (a wrong try counts even when nothing else happens), then the
 * ordinary withdrawal rules run.
 */
export async function deskWithdrawal(
  deps: AppDeps,
  actor: DeskActor,
  input: CashWithdrawalRequest,
  receiptView: ReceiptViewOf,
) {
  const now = deps.clock();
  const done = await findOperationByKey(deps.db, input.idempotencyKey);
  if (
    done !== null &&
    done.kind === 'withdrawal' &&
    done.userId === input.userId &&
    done.amount === BigInt(input.amount) &&
    done.staffId === actor.staffId
  ) {
    const receipt = await getReceipt(deps.db, done.id);
    if (receipt === null) throw notFound('Receipt');
    return wire(CashWithdrawalResponse, {
      outcome: 'paid',
      receipt: receiptView(receipt),
      replayed: true,
    });
  }
  const requested = await findDeskPayout(deps.db, {
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
  });
  if (requested !== null && requested.status === 'requested') {
    return wire(CashWithdrawalResponse, {
      outcome: 'review',
      payoutId: requested.id,
      amount: requested.amount,
      reviewReason: requested.reviewReason,
      replayed: true,
    });
  }
  const codeHash = cashCodeHash(deps.config.sessionSecret, input.userId, input.code);
  const codeId = await checkCashCode(deps.db, { userId: input.userId, codeHash, now });
  const result = await inTx(deps, async (tx) => {
    const { payments } = await loadGameSettings(tx);
    const { amlRules } = await loadComplianceSettings(tx);
    const outcome = await cashWithdrawal(tx, {
      staffId: actor.staffId,
      shiftId: input.shiftId,
      userId: input.userId,
      amount: BigInt(input.amount),
      idempotencyKey: input.idempotencyKey,
      code: { id: codeId, hash: codeHash },
      rules: payments,
      amlRules,
      now,
      ip: actor.ip,
    });
    if (outcome.outcome === 'review') return outcome;
    const receipt = await getReceipt(tx, outcome.operation.id);
    if (receipt === null) throw new Error('receipt missing after a withdrawal');
    return { outcome: 'paid' as const, receipt: receiptView(receipt), replayed: outcome.replayed };
  });
  return wire(CashWithdrawalResponse, result);
}

/** A receipt the actor may see: their own, or any for a supervisor; 404 otherwise. */
export async function deskReceipt(
  exec: DbExecutor,
  actor: DeskActor,
  operationId: string,
): Promise<Receipt> {
  const receipt = await getReceipt(exec, operationId);
  if (receipt === null || (!actor.supervisor && receipt.operation.staffId !== actor.staffId)) {
    throw notFound('Receipt');
  }
  return receipt;
}

/** The first print is the original, every later one a counted copy. */
export async function deskPrint(deps: AppDeps, actor: DeskActor, operationId: string) {
  return inTx(deps, async (tx) => {
    const current = await deskReceipt(tx, actor, operationId);
    const printed = await printReceipt(tx, {
      operationId: current.operation.id,
      staffId: actor.staffId,
      supervisor: actor.supervisor,
      now: deps.clock(),
      ip: actor.ip,
    });
    const after = await getReceipt(tx, current.operation.id);
    if (after === null) throw notFound('Receipt');
    return { receipt: after, copy: printed.copy };
  });
}

/** A counted copy of a receipt. */
export async function deskReprint(deps: AppDeps, actor: DeskActor, operationId: string) {
  return inTx(deps, async (tx) => {
    const current = await deskReceipt(tx, actor, operationId);
    await recordReprint(tx, {
      operationId: current.operation.id,
      staffId: actor.staffId,
      supervisor: actor.supervisor,
      ip: actor.ip,
    });
    const after = await getReceipt(tx, current.operation.id);
    if (after === null) throw notFound('Receipt');
    return after;
  });
}
