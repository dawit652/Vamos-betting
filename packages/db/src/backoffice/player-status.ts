import { eq } from 'drizzle-orm';
import { domainConflict, domainNotFound } from '../errors';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { lockUser } from '../rg/limits';
import { users } from '../schema/accounts';

/** Audit actions of blocking and unblocking a player. */
export const PLAYER_SUSPENDED = 'player.suspended';
export const PLAYER_REACTIVATED = 'player.reactivated';

export type PlayerStatusChange = 'active' | 'suspended';

/**
 * Blocks (`suspended`) or unblocks (`active`) a player, audited with the staff member, the reason
 * and where it was done. A blocked player cannot sign in (their sessions stop at once), deposit,
 * bet or withdraw, online or at a desk. Only active ↔ suspended: an account still being verified
 * or closed is refused (409 `player_status_unchangeable`). Asking for the status it already has
 * changes nothing (`changed: false`).
 */
export async function setPlayerStatus(
  tx: DbTransaction,
  input: {
    userId: string;
    status: PlayerStatusChange;
    reason: string;
    adminId: string;
    via: 'back_office' | 'cashier_desk';
    ip?: string | null;
  },
): Promise<{ status: PlayerStatusChange; changed: boolean }> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new RangeError('a reason is required');
  await lockUser(tx, input.userId);
  const [user] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  if (user.status === input.status) return { status: input.status, changed: false };
  if (user.status !== 'active' && user.status !== 'suspended') {
    throw domainConflict(
      'player_status_unchangeable',
      'Only an active or blocked account can be blocked or unblocked.',
      { status: user.status },
    );
  }
  await tx.update(users).set({ status: input.status }).where(eq(users.id, input.userId));
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: input.status === 'suspended' ? PLAYER_SUSPENDED : PLAYER_REACTIVATED,
    targetType: 'user',
    targetId: input.userId,
    metadata: { reason, from: user.status, via: input.via },
    ip: input.ip ?? null,
  });
  return { status: input.status, changed: true };
}
