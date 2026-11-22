import {
  BET_SHORT_ID_LENGTH,
  isValidCode,
  normalizeCode,
  parsePayoutCode,
  toWire,
} from '@vamos/core';
import { and, eq, sql } from 'drizzle-orm';
import { assertShopOperates, getShop, lockOwnOpenShift } from '../cashier/desk';
import { domainConflict, domainNotFound } from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { betLegs, bets } from '../schema/betting';
import { events } from '../schema/catalog';
import { agents } from '../schema/retail';
import { retailTickets } from '../schema/retail-tickets';
import { checkPayoutCode } from './payout-code';
import { ticketCashAccount, type RetailTicket } from './tickets';

/**
 * Paying shop tickets (docs/plans/agent-shops.md, "Phase 4 design"). Settlement put what a won or
 * void ticket owes in `house:retail_payable`; the shop that sold it pays the holder in cash and the
 * money moves to that shop's cash account:
 *
 * | Event              | Type                   | Entries                                            |
 * | ------------------ | ---------------------- | -------------------------------------------------- |
 * | Paid (agent shop)  | `retail_ticket_payout` | house:retail_payable −net, agent:<id>:balance +net |
 * | Paid (HQ shop)     | `retail_ticket_payout` | house:retail_payable −net, house:retail_cash +net  |
 * | Expired unpaid     | `retail_ticket_expiry` | house:retail_payable −net, house:revenue +net      |
 */

export const RETAIL_TICKET_PAID = 'retail.ticket_paid';
export const RETAIL_TICKET_EXPIRED = 'retail.ticket_expired';

export const retailPayoutLedgerKey = (betId: string) => `retail-payout:${betId}`;
export const retailExpiryLedgerKey = (betId: string) => `retail-expiry:${betId}`;

/** What the pay screen shows for a ticket. */
export type TicketPayState = 'open' | 'lost' | 'payable' | 'paid' | 'expired' | 'cancelled';

export interface TicketForPayment {
  ticket: RetailTicket;
  number: string;
  betStatus: string;
  /** What it pays (won: the net payout; void: the stake); 0 otherwise. */
  amount: bigint;
  state: TicketPayState;
}

function stateOf(ticket: RetailTicket, betStatus: string): TicketPayState {
  if (ticket.status === 'cancelled') return 'cancelled';
  if (ticket.status === 'paid') return 'paid';
  if (ticket.status === 'expired') return 'expired';
  // Any won or void ticket is paid by the cashier alone (owner, 21 Nov 2026: no HQ approval, also
  // for big wins; an approval asked for before then no longer holds the ticket back).
  if (betStatus === 'won' || betStatus === 'void') return 'payable';
  if (betStatus === 'lost') return 'lost';
  return 'open';
}

/** A ticket by its number (the bet's short id; case and spaces ignored), or null. */
export async function findTicketByNumber(
  exec: DbExecutor,
  number: string,
): Promise<TicketForPayment | null> {
  const code = normalizeCode(number);
  if (!isValidCode(code, BET_SHORT_ID_LENGTH)) return null;
  const [row] = await exec
    .select({
      ticket: retailTickets,
      number: bets.shortId,
      betStatus: bets.status,
      net: bets.settledNetPayout,
    })
    .from(retailTickets)
    .innerJoin(bets, eq(bets.id, retailTickets.betId))
    .where(eq(bets.shortId, code))
    .limit(1);
  if (!row) return null;
  const state = stateOf(row.ticket, row.betStatus);
  const amount =
    state === 'payable' ? (row.net ?? 0n) : state === 'paid' ? (row.ticket.paidAmount ?? 0n) : 0n;
  return { ticket: row.ticket, number: row.number, betStatus: row.betStatus, amount, state };
}

export type PayRetailTicketResult =
  | {
      outcome: 'paid';
      ticket: RetailTicket;
      amount: bigint;
      replayed: boolean;
    }
  /**
   * The payout code was wrong: counted (and the ticket locked at five). Not thrown, so the caller's
   * transaction commits the count; answer the cashier from this (409 `payout_code_wrong`).
   */
  | { outcome: 'payout_code_wrong'; attemptsLeft: number; locked: boolean };

const NOT_PAYABLE: Record<Exclude<TicketPayState, 'payable'>, string> = {
  open: 'This ticket is not settled yet.',
  lost: 'This ticket lost: it pays nothing.',
  paid: 'This ticket was paid already.',
  expired: 'This ticket expired unpaid.',
  cancelled: 'This ticket was cancelled.',
};

/**
 * Pays a won or void ticket at the counter of the shop that sold it, in the cashier's own open
 * shift (404 `Shift`, 409 `shift_not_open`; 409 `ticket_other_shop` at another shop). A ticket that
 * is open, lost, paid, expired or cancelled is 409 `ticket_not_payable` (its state in the details);
 * the same idempotency key again answers with the same payout. The cashier pays any amount alone
 * (owner, 21 Nov 2026: no HQ approval, also for big wins). The posting moves the bet's net payout
 * from retail payable to the shop's cash account; audited, with an outbox event.
 *
 * A ticket with a payout code (printed at sale, docs/plans/counter-codes-and-deposit-recovery.md,
 * G3) is paid only against it: 409 `payout_code_required` without it, 409 `payout_code_locked`
 * once five wrong ones locked the ticket (HQ unlocks it), and a wrong one is returned as
 * `payout_code_wrong` (see PayRetailTicketResult). Checked only for a ticket that is payable, so
 * the code of a lost, paid or open ticket is never tested.
 */
export async function payRetailTicket(
  tx: DbTransaction,
  input: {
    number: string;
    staffId: string;
    shiftId: string;
    idempotencyKey: string;
    /** The payout code the customer said (any spacing); needed for a ticket that has one. */
    payoutCode?: string | null;
    now: Date;
    ip?: string | null;
  },
): Promise<PayRetailTicketResult> {
  const shift = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const shop = await getShop(tx, shift.shopId);
  if (shop === null) throw domainNotFound('Shop');
  assertShopOperates(shop);
  const found = await findTicketByNumber(tx, input.number);
  if (found === null) throw domainNotFound('Ticket');
  // The ticket's row lock, then the bet's (the order cancel and settlement use).
  const [ticket] = await tx
    .select()
    .from(retailTickets)
    .where(eq(retailTickets.id, found.ticket.id))
    .for('update');
  if (!ticket) throw domainNotFound('Ticket');
  if (ticket.shopId !== shop.id) {
    throw domainConflict('ticket_other_shop', 'A ticket is paid at the shop that sold it.');
  }
  if (ticket.status === 'paid' && ticket.payoutIdempotencyKey === input.idempotencyKey) {
    return { outcome: 'paid', ticket, amount: ticket.paidAmount ?? 0n, replayed: true };
  }
  const [bet] = await tx.select().from(bets).where(eq(bets.id, ticket.betId)).for('update');
  if (!bet) throw new Error(`bet ${ticket.betId} of ticket ${ticket.id} is missing`);
  const state = stateOf(ticket, bet.status);
  if (state !== 'payable') {
    throw domainConflict('ticket_not_payable', NOT_PAYABLE[state], { state });
  }
  const amount = bet.settledNetPayout ?? 0n;
  if (amount <= 0n) {
    throw domainConflict('ticket_not_payable', 'This ticket pays nothing.', { state });
  }
  const typed =
    input.payoutCode === undefined || input.payoutCode === null
      ? null
      : parsePayoutCode(input.payoutCode);
  const check = await checkPayoutCode(tx, ticket, typed, input.now);
  if (!check.ok) {
    if (check.reason === 'required') {
      throw domainConflict(
        'payout_code_required',
        'Ask the customer for the payout code printed on the ticket.',
      );
    }
    if (check.reason === 'locked') {
      throw domainConflict(
        'payout_code_locked',
        'This ticket is locked after wrong payout codes. HQ unlocks it.',
      );
    }
    return { outcome: 'payout_code_wrong', attemptsLeft: check.attemptsLeft, locked: check.locked };
  }

  const posting = await postTransaction(tx, {
    type: 'retail_ticket_payout',
    idempotencyKey: retailPayoutLedgerKey(bet.id),
    refType: 'bet',
    refId: bet.id,
    description: `Shop ticket ${bet.shortId} paid`,
    actor: { type: 'admin', id: input.staffId },
    createdAt: input.now,
    entries: [
      { account: { kind: 'house_retail_payable' }, amount: -amount },
      { account: ticketCashAccount(shop), amount },
    ],
  });
  const [paid] = await tx
    .update(retailTickets)
    .set({
      status: 'paid',
      paidAt: input.now,
      paidBy: input.staffId,
      paidShiftId: shift.id,
      paidAmount: amount,
      payoutTransactionId: posting.transactionId,
      payoutIdempotencyKey: input.idempotencyKey,
    })
    .where(eq(retailTickets.id, ticket.id))
    .returning();
  if (!paid) throw new Error('shop ticket update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: RETAIL_TICKET_PAID,
    targetType: 'retail_ticket',
    targetId: paid.id,
    metadata: { betId: bet.id, shortId: bet.shortId, amount, shopId: shop.id },
    ip: input.ip ?? null,
  });
  await enqueueOutbox(tx, {
    type: RETAIL_TICKET_PAID,
    aggregateType: 'retail_ticket',
    aggregateId: paid.id,
    payload: { ticketId: paid.id, betId: bet.id, agentId: paid.agentId, amount },
  });
  return { outcome: 'paid', ticket: paid, amount, replayed: false };
}

/**
 * Expires won and void tickets not paid within their agent's expiry days after their last match:
 * what they owed goes from retail payable to house revenue. At most `limit` per call (the worker's
 * daily task loops). Returns how many expired.
 */
export async function expireRetailTickets(
  tx: DbTransaction,
  input: { now: Date; limit?: number },
): Promise<number> {
  const due = await tx
    .select({
      ticket: retailTickets,
      net: bets.settledNetPayout,
      shortId: bets.shortId,
      expiryDays: sql<number>`COALESCE((${agents.ticketLimits}->>'expiryDays')::int, 30)`,
      lastMatch: sql<Date>`(SELECT max(${events.startTime}) FROM ${betLegs} JOIN ${events} ON ${events.id} = ${betLegs.eventId} WHERE ${betLegs.betId} = ${retailTickets.betId})`,
    })
    .from(retailTickets)
    .innerJoin(bets, eq(bets.id, retailTickets.betId))
    .innerJoin(agents, eq(agents.id, retailTickets.agentId))
    .where(
      and(
        eq(retailTickets.status, 'sold'),
        sql`${bets.status} IN ('won', 'void')`,
        // Due: its last match kicked off more than the agent's expiry days ago.
        sql`(SELECT max(${events.startTime}) FROM ${betLegs} JOIN ${events} ON ${events.id} = ${betLegs.eventId} WHERE ${betLegs.betId} = ${retailTickets.betId}) + make_interval(days => COALESCE((${agents.ticketLimits}->>'expiryDays')::int, 30)) <= ${input.now.toISOString()}::timestamptz`,
      ),
    )
    .limit(input.limit ?? 200)
    .for('update', { of: retailTickets, skipLocked: true });
  let expired = 0;
  for (const row of due) {
    const last = new Date(row.lastMatch);
    if (last.getTime() + row.expiryDays * 86_400_000 > input.now.getTime()) continue;
    const net = row.net ?? 0n;
    let transactionId: string | null = null;
    if (net > 0n) {
      const posting = await postTransaction(tx, {
        type: 'retail_ticket_expiry',
        idempotencyKey: retailExpiryLedgerKey(row.ticket.betId),
        refType: 'bet',
        refId: row.ticket.betId,
        description: `Shop ticket ${row.shortId} expired unpaid`,
        createdAt: input.now,
        entries: [
          { account: { kind: 'house_retail_payable' }, amount: -net },
          { account: { kind: 'house_revenue' }, amount: net },
        ],
      });
      transactionId = posting.transactionId;
    }
    await tx
      .update(retailTickets)
      .set({ status: 'expired', expiredAt: input.now })
      .where(eq(retailTickets.id, row.ticket.id));
    await writeAudit(tx, {
      actorType: 'system',
      action: RETAIL_TICKET_EXPIRED,
      targetType: 'retail_ticket',
      targetId: row.ticket.id,
      metadata: { betId: row.ticket.betId, amount: toWire(net), transactionId },
    });
    expired += 1;
  }
  return expired;
}

/** Whether a shop ticket's bet was paid at the counter (settlement never takes it back then). */
export async function retailTicketPaid(exec: DbExecutor, betId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: retailTickets.id })
    .from(retailTickets)
    .where(and(eq(retailTickets.betId, betId), eq(retailTickets.status, 'paid')))
    .limit(1);
  return row !== undefined;
}
