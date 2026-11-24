import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { encodePayoutCode, PAYOUT_CODE_ATTEMPTS } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { retailTickets } from '../schema/retail-tickets';
import type { RetailTicket } from './tickets';

/**
 * The payout code of a shop ticket (owner, 21 Nov 2026, decision O1; docs/plans/
 * counter-codes-and-deposit-recovery.md, G3). A ticket is sold with a random 6-digit code that is
 * printed once, on the customer's ticket, and kept only as a salted hash: the cashier's screen never
 * shows it, a reprint does not print it, and paying the ticket asks for it. Only the person holding
 * the paper can collect, so a cashier cannot pay an unclaimed winning ticket to themselves.
 *
 * A wrong code counts; PAYOUT_CODE_ATTEMPTS wrong codes lock the ticket until HQ unlocks it. A
 * ticket with no hash (sold before the code existed, or waived by HQ for a lost paper) needs none.
 */

export const RETAIL_PAYOUT_CODE_UNLOCKED = 'retail.payout_code_unlocked';
export const RETAIL_PAYOUT_CODE_WAIVED = 'retail.payout_code_waived';

const SALT_BYTES = 16;

/** `<salt hex>:<sha256(salt hex : code) hex>` for a code, with a fresh salt unless one is given. */
export function hashPayoutCode(code: string, saltHex?: string): string {
  const salt = saltHex ?? nodeRandomBytes(SALT_BYTES).toString('hex');
  const hash = createHash('sha256').update(`vamos:payout-code:v1:${salt}:${code}`).digest('hex');
  return `${salt}:${hash}`;
}

/** True when `code` is the one `stored` was made from (constant time). */
export function verifyPayoutCode(stored: string, code: string): boolean {
  const [salt] = stored.split(':');
  if (salt === undefined || salt === '') return false;
  const expected = Buffer.from(stored);
  const given = Buffer.from(hashPayoutCode(code, salt));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * A new code and its hash for a ticket being sold. `randomBytes` is the sale's random source (tests
 * make it fixed); the salt always comes from the system's random source.
 */
export function newPayoutCode(randomBytes: (size: number) => Uint8Array): {
  code: string;
  hash: string;
} {
  const code = encodePayoutCode(randomBytes(6));
  return { code, hash: hashPayoutCode(code) };
}

export type PayoutCodeCheck =
  | { ok: true }
  | { ok: false; reason: 'required' }
  | { ok: false; reason: 'locked' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number; locked: boolean };

/**
 * Checks the code a cashier typed against a ticket (which must be row-locked by the caller): a
 * wrong code is counted here, and the ticket is locked at PAYOUT_CODE_ATTEMPTS. The caller must
 * COMMIT after a `wrong` answer (so the count holds): answer the cashier from the returned value,
 * do not throw inside the transaction. A missing or malformed code is `required` and not counted.
 */
export async function checkPayoutCode(
  tx: DbTransaction,
  ticket: RetailTicket,
  code: string | null,
  now: Date,
): Promise<PayoutCodeCheck> {
  if (ticket.payoutCodeHash === null) return { ok: true };
  if (ticket.payoutCodeLockedAt !== null) return { ok: false, reason: 'locked' };
  if (code === null) return { ok: false, reason: 'required' };
  if (verifyPayoutCode(ticket.payoutCodeHash, code)) return { ok: true };
  const attempts = ticket.payoutCodeAttempts + 1;
  const locked = attempts >= PAYOUT_CODE_ATTEMPTS;
  await tx
    .update(retailTickets)
    .set({ payoutCodeAttempts: attempts, payoutCodeLockedAt: locked ? now : null })
    .where(eq(retailTickets.id, ticket.id));
  if (locked) {
    await writeAudit(tx, {
      actorType: 'system',
      actorId: null,
      action: 'retail.payout_code_locked',
      targetType: 'retail_ticket',
      targetId: ticket.id,
      metadata: { shopId: ticket.shopId, attempts },
    });
  }
  return {
    ok: false,
    reason: 'wrong',
    attemptsLeft: Math.max(0, PAYOUT_CODE_ATTEMPTS - attempts),
    locked,
  };
}

/**
 * HQ's answer to a locked ticket or a lost paper (back office, agents.manage), with the reason
 * written down and audited:
 * - `unlock`: the count starts again; the code is still asked for;
 * - `waive`: the ticket needs no code any more (the holder showed their ID to HQ).
 * Not for a paid ticket (409 `ticket_not_payable`); a ticket with no code needs neither (422).
 */
export async function resolvePayoutCode(
  tx: DbTransaction,
  input: {
    ticketId: string;
    action: 'unlock' | 'waive';
    reason: string;
    staffId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<RetailTicket> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw domainUnprocessable('reason_required', 'Write down why (at least 3 characters).');
  }
  const [ticket] = await tx
    .select()
    .from(retailTickets)
    .where(eq(retailTickets.id, input.ticketId))
    .for('update');
  if (!ticket) throw domainNotFound('Ticket');
  if (ticket.status === 'paid') {
    throw domainConflict('ticket_not_payable', 'This ticket was paid already.', { state: 'paid' });
  }
  if (ticket.payoutCodeHash === null) {
    throw domainUnprocessable('no_payout_code', 'This ticket has no payout code to unlock.');
  }
  const [updated] = await tx
    .update(retailTickets)
    .set(
      input.action === 'waive'
        ? { payoutCodeHash: null, payoutCodeAttempts: 0, payoutCodeLockedAt: null }
        : { payoutCodeAttempts: 0, payoutCodeLockedAt: null },
    )
    .where(eq(retailTickets.id, ticket.id))
    .returning();
  if (!updated) throw new Error('shop ticket update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: input.action === 'waive' ? RETAIL_PAYOUT_CODE_WAIVED : RETAIL_PAYOUT_CODE_UNLOCKED,
    targetType: 'retail_ticket',
    targetId: ticket.id,
    metadata: { reason, shopId: ticket.shopId, wasLocked: ticket.payoutCodeLockedAt !== null },
    ip: input.ip ?? null,
  });
  return updated;
}
