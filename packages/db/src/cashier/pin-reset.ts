import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { isUniqueViolation } from '../catalog/errors';
import { domainConflict, domainForbidden, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { adminUsers, kycProfiles, users } from '../schema/accounts';
import { cashPinResets } from '../schema/cashier';

/**
 * Cashier phase "assisted PIN reset" (owner's default of 18 Nov 2026), for a player without SMS or
 * Telegram: the cashier checks the player's ID card against the verified KYC record (the ID number's
 * keyed hash), a supervisor approves (four eyes: not the cashier who asked), then the desk issues the
 * ORDINARY one-time reset code (the API creates it like the Telegram reset does) and prints it for the
 * player, who sets a new PIN on "Forgot PIN". The desk never sees or sets the PIN.
 */

export type DeskPinReset = typeof cashPinResets.$inferSelect;

export const PIN_RESET_AUDIT = {
  requested: 'cashier.pin_reset_requested',
  idMismatch: 'cashier.pin_reset_id_mismatch',
  approved: 'cashier.pin_reset_approved',
  rejected: 'cashier.pin_reset_rejected',
  issued: 'cashier.pin_reset_issued',
} as const;

/** An approved request is issued within this time, or asked again. */
export const PIN_RESET_ISSUE_WINDOW_MS = 30 * 60_000;
/** A request nobody decided within this time expires (a new one may be asked). */
export const PIN_RESET_REQUEST_TTL_MS = 24 * 3_600_000;

/**
 * The cashier asks a PIN reset for a player whose ID they checked: `idNumberHash` is the keyed hash of
 * the number on the card (the API computes it as KYC does). 422 `kyc_not_verified` without a verified
 * ID on file, 422 `id_mismatch` when the number differs (the API audits it in its own transaction:
 * this one rolls back), 409 `pin_reset_open` when one is waiting. A stale one (approved longer than
 * PIN_RESET_ISSUE_WINDOW_MS ago, or undecided after PIN_RESET_REQUEST_TTL_MS) expires first. Only an
 * active account. Audited.
 */
export async function requestDeskPinReset(
  tx: DbTransaction,
  input: {
    userId: string;
    staffId: string;
    shopId: string | null;
    idNumberHash: string;
    now: Date;
    ip?: string | null;
  },
): Promise<DeskPinReset> {
  const [player] = await tx
    .select({
      status: users.status,
      kycStatus: kycProfiles.status,
      idNumberHash: kycProfiles.idNumberHash,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.id, input.userId));
  if (!player) throw domainNotFound('Player');
  if (player.status !== 'active') {
    throw domainConflict('account_disabled', 'This account cannot be served.');
  }
  if (player.kycStatus !== 'verified' || player.idNumberHash === null) {
    throw domainUnprocessable(
      'kyc_not_verified',
      'The player has no verified ID on file: the desk cannot reset the PIN.',
    );
  }
  if (player.idNumberHash !== input.idNumberHash) {
    throw domainUnprocessable('id_mismatch', 'The ID number does not match the verified ID.');
  }
  await tx
    .update(cashPinResets)
    .set({ status: 'expired' })
    .where(
      and(
        eq(cashPinResets.userId, input.userId),
        or(
          and(
            eq(cashPinResets.status, 'approved'),
            lt(cashPinResets.approvedAt, new Date(input.now.getTime() - PIN_RESET_ISSUE_WINDOW_MS)),
          ),
          and(
            eq(cashPinResets.status, 'requested'),
            lt(cashPinResets.createdAt, new Date(input.now.getTime() - PIN_RESET_REQUEST_TTL_MS)),
          ),
        ),
      ),
    );
  let created: DeskPinReset | undefined;
  try {
    [created] = await tx.transaction((sp) =>
      sp
        .insert(cashPinResets)
        .values({
          userId: input.userId,
          shopId: input.shopId,
          requestedBy: input.staffId,
          status: 'requested',
          createdAt: input.now,
        })
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'cash_pin_resets_open_uq')) {
      throw domainConflict('pin_reset_open', 'A PIN reset is already waiting for this player.');
    }
    throw error;
  }
  if (!created) throw new Error('pin reset insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: PIN_RESET_AUDIT.requested,
    targetType: 'user',
    targetId: input.userId,
    metadata: { resetId: created.id, shopId: input.shopId },
    ip: input.ip ?? null,
  });
  return created;
}

async function lockReset(tx: DbTransaction, resetId: string): Promise<DeskPinReset> {
  const [row] = await tx
    .select()
    .from(cashPinResets)
    .where(eq(cashPinResets.id, resetId))
    .for('update');
  if (!row) throw domainNotFound('PIN reset');
  return row;
}

/**
 * A supervisor approves (`approve: true`) or rejects a waiting request; never the cashier who asked
 * (403 `cashier_four_eyes`); only a `requested` one (409 `pin_reset_not_waiting`). Audited.
 */
export async function decideDeskPinReset(
  tx: DbTransaction,
  input: { resetId: string; supervisorId: string; approve: boolean; now: Date; ip?: string | null },
): Promise<DeskPinReset> {
  const reset = await lockReset(tx, input.resetId);
  if (reset.status !== 'requested') {
    throw domainConflict('pin_reset_not_waiting', 'This PIN reset is not waiting for a decision.');
  }
  if (reset.requestedBy === input.supervisorId) {
    throw domainForbidden('cashier_four_eyes', 'Another supervisor must decide your own request.');
  }
  const [updated] = await tx
    .update(cashPinResets)
    .set(
      input.approve
        ? { status: 'approved', approvedBy: input.supervisorId, approvedAt: input.now }
        : { status: 'rejected', approvedBy: input.supervisorId, approvedAt: input.now },
    )
    .where(eq(cashPinResets.id, reset.id))
    .returning();
  if (!updated) throw new Error('pin reset update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.supervisorId,
    action: input.approve ? PIN_RESET_AUDIT.approved : PIN_RESET_AUDIT.rejected,
    targetType: 'user',
    targetId: reset.userId,
    metadata: { resetId: reset.id },
    ip: input.ip ?? null,
  });
  return updated;
}

/**
 * The desk issues an approved request: the cashier who asked, or a supervisor; within
 * PIN_RESET_ISSUE_WINDOW_MS of the approval, else the request is marked expired and `expired` is
 * returned (a result, not an error, so the mark commits; the caller answers 409 after). Issued: marks
 * it and returns the player's phone; the caller creates the ordinary reset code for it in the same
 * transaction. Audited.
 */
export async function issueDeskPinReset(
  tx: DbTransaction,
  input: { resetId: string; staffId: string; supervisor: boolean; now: Date; ip?: string | null },
): Promise<{ outcome: 'issued'; reset: DeskPinReset; phone: string } | { outcome: 'expired' }> {
  const reset = await lockReset(tx, input.resetId);
  if (!input.supervisor && reset.requestedBy !== input.staffId) throw domainNotFound('PIN reset');
  if (reset.status !== 'approved' || reset.approvedAt === null) {
    throw domainConflict('pin_reset_not_approved', 'This PIN reset is not approved.');
  }
  if (input.now.getTime() - reset.approvedAt.getTime() > PIN_RESET_ISSUE_WINDOW_MS) {
    await tx.update(cashPinResets).set({ status: 'expired' }).where(eq(cashPinResets.id, reset.id));
    return { outcome: 'expired' };
  }
  const [player] = await tx
    .select({ phone: users.phone, status: users.status })
    .from(users)
    .where(eq(users.id, reset.userId));
  if (!player || player.status !== 'active') {
    throw domainConflict('account_disabled', 'This account cannot be served.');
  }
  const [updated] = await tx
    .update(cashPinResets)
    .set({ status: 'issued', issuedAt: input.now })
    .where(eq(cashPinResets.id, reset.id))
    .returning();
  if (!updated) throw new Error('pin reset update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: PIN_RESET_AUDIT.issued,
    targetType: 'user',
    targetId: reset.userId,
    metadata: { resetId: reset.id },
    ip: input.ip ?? null,
  });
  return { outcome: 'issued', reset: updated, phone: player.phone };
}

/** Requests waiting for a decision, or approved and not yet issued, oldest first, with names. */
export async function listOpenDeskPinResets(
  exec: DbExecutor,
): Promise<Array<DeskPinReset & { playerPhone: string; requestedByName: string }>> {
  return exec
    .select({
      id: cashPinResets.id,
      userId: cashPinResets.userId,
      shopId: cashPinResets.shopId,
      requestedBy: cashPinResets.requestedBy,
      status: cashPinResets.status,
      approvedBy: cashPinResets.approvedBy,
      approvedAt: cashPinResets.approvedAt,
      issuedAt: cashPinResets.issuedAt,
      createdAt: cashPinResets.createdAt,
      playerPhone: users.phone,
      requestedByName: adminUsers.displayName,
    })
    .from(cashPinResets)
    .innerJoin(users, eq(users.id, cashPinResets.userId))
    .innerJoin(adminUsers, eq(adminUsers.id, cashPinResets.requestedBy))
    .where(inArray(cashPinResets.status, ['requested', 'approved']))
    .orderBy(asc(cashPinResets.createdAt), asc(cashPinResets.id));
}

/** The player's open request at the desk (requested or approved), if any. */
export async function findOpenDeskPinReset(
  exec: DbExecutor,
  userId: string,
): Promise<DeskPinReset | null> {
  const [row] = await exec
    .select()
    .from(cashPinResets)
    .where(
      and(
        eq(cashPinResets.userId, userId),
        inArray(cashPinResets.status, ['requested', 'approved']),
      ),
    );
  return row ?? null;
}
