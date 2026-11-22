import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  businessDateOf,
  businessDayWindow,
  DEFAULT_RETAIL_TICKET_LIMITS,
  parseRetailTicketLimits,
  resolveRetailTicketLimits,
  retailBetRules,
  retailCancelRefusal,
  serializeRetailTicketLimits,
  toWire,
  type OddsChangePolicy,
  type RetailCancelRole,
} from '@vamos/core';
import { and, desc, eq, gte, min, sql } from 'drizzle-orm';
import { bookingCodeForTicket } from '../betting/booking';
import { placeBet, type GameSettingsForBets, type SlipLegInput } from '../betting/place';
import type { UserBet } from '../betting/types';
import { assertShopOperates, getShop, lockOwnOpenShift, type ShopWithAgent } from '../cashier/desk';
import { domainConflict, domainNotFound } from '../errors';
import { postTransaction } from '../ledger/post';
import type { AccountRef, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { lockUser } from '../rg/limits';
import { adminUsers, users } from '../schema/accounts';
import { betLegs, bets } from '../schema/betting';
import { events } from '../schema/catalog';
import { agents } from '../schema/retail';
import { retailTickets } from '../schema/retail-tickets';

/**
 * Tickets sold at a shop's counter (docs/plans/agent-shops.md, "Phase 3 design"). A ticket is a
 * bet of the agent's counter bettor, placed by placeBet with retail funding: every online check
 * applies, the stake comes from the agent's balance (HQ: its retail cash), and only matches that
 * have not kicked off are taken. Settlement sends what it wins to `house:retail_payable`
 * (retailSettlementPosting), for the shop to pay the holder (phase 4).
 *
 * | Event            | Type                   | Entries                                         |
 * | ---------------- | ---------------------- | ----------------------------------------------- |
 * | Sold (agent)     | `bet_stake`            | agent:<id>:balance −stake, house:stakes +stake |
 * | Sold (HQ)        | `bet_stake`            | house:retail_cash −stake, house:stakes +stake   |
 * | Cancelled        | `retail_ticket_cancel` | house:stakes −stake, the same account +stake    |
 */

export type RetailTicket = typeof retailTickets.$inferSelect;

export const RETAIL_TICKET_SOLD = 'retail.ticket_sold';
export const RETAIL_TICKET_CANCELLED = 'retail.ticket_cancelled';

/** The ledger key of a ticket's cancel: one per bet, ever. */
export const retailCancelLedgerKey = (betId: string) => `retail-cancel:${betId}`;

/** Where a shop's ticket stakes come from: the agent's balance, or HQ's own retail cash. */
export function ticketCashAccount(
  shop: Pick<ShopWithAgent, 'agentId' | 'agentIsHouse'>,
): AccountRef {
  return shop.agentIsHouse
    ? { kind: 'house_retail_cash' }
    : { kind: 'agent_balance', agentId: shop.agentId };
}

/**
 * The agent's counter bettor (made with its first ticket, under the agent's row lock): a `users`
 * row that is never a player. Its phone `shop:<number>` is no number a person can type, and its
 * password hash matches no password, so nobody signs in as it.
 */
export async function ensureCounterBettor(tx: DbTransaction, agentId: string, now: Date) {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
  if (!agent) throw domainNotFound('Agent');
  if (agent.counterUserId !== null) return agent.counterUserId;
  const [user] = await tx
    .insert(users)
    .values({
      phone: `shop:${agent.number}`,
      passwordHash: '!counter-bettor:no-password',
      fullName: `Shop tickets of agent ${agent.number}`,
      locale: 'en',
      status: 'active',
      termsAcceptedAt: now,
    })
    .returning({ id: users.id });
  if (!user) throw new Error('counter bettor insert returned no row');
  await tx
    .update(agents)
    .set({ counterUserId: user.id, updatedAt: now })
    .where(eq(agents.id, agent.id));
  return user.id;
}

/** The limits an agent's tickets are sold under (its overrides over the defaults). */
export function agentTicketLimits(
  agent: { ticketLimits: unknown },
  betRules: GameSettingsForBets['betRules'],
) {
  return resolveRetailTicketLimits(betRules, parseRetailTicketLimits(agent.ticketLimits));
}

async function soldToday(tx: DbTransaction, agentId: string, now: Date): Promise<bigint> {
  const { start } = businessDayWindow(businessDateOf(now));
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(sum(${retailTickets.stake}), 0)::text` })
    .from(retailTickets)
    .where(
      and(
        eq(retailTickets.agentId, agentId),
        eq(retailTickets.status, 'sold'),
        gte(retailTickets.soldAt, start),
      ),
    );
  return BigInt(row?.total ?? '0');
}

/**
 * Sells a ticket at the cashier's own open shift (404 `Shift` otherwise, 409 `shift_not_open`), at
 * an operating shop of an active agent (409 `shop_inactive`, `agent_blocked`). The agent's limits
 * become the bet rules (stake, max win, matches, odds) and its sales per day are checked (409
 * `daily_sales_limit`); then placeBet with retail funding (409 `selection_unavailable` for a
 * started match, `odds_changed`, 422 `slip_invalid`, 409 `agent_balance_low`). A booking code
 * given is stored to be printed only when the ticket has exactly its matches (else the ticket shows
 * none). The same idempotency key again answers with the same ticket. Audited, with an outbox event.
 */
export async function sellRetailTicket(
  tx: DbTransaction,
  input: {
    staffId: string;
    shiftId: string;
    legs: readonly SlipLegInput[];
    stake: bigint;
    policy: OddsChangePolicy;
    customerPhone?: string | null;
    /** The booking code the player brought, printed on the ticket (bookingCodeForTicket). */
    bookingCode?: string | null;
    idempotencyKey: string;
    settings: GameSettingsForBets;
    now: Date;
    randomBytes?: (size: number) => Uint8Array;
    ip?: string | null;
  },
): Promise<{ ticket: RetailTicket; bet: UserBet; replayed: boolean }> {
  const shift = await lockOwnOpenShift(tx, input.shiftId, input.staffId);
  const shop = await getShop(tx, shift.shopId);
  if (shop === null) throw domainNotFound('Shop');
  assertShopOperates(shop);
  const bettorId = await ensureCounterBettor(tx, shop.agentId, input.now);
  // One agent's tickets queue here, so the day's sales are read under the same lock as the sale.
  await lockUser(tx, bettorId);
  const [agent] = await tx.select().from(agents).where(eq(agents.id, shop.agentId));
  if (!agent) throw domainNotFound('Agent');
  const limits = agentTicketLimits(agent, input.settings.betRules);
  const bookingCode =
    input.bookingCode === undefined || input.bookingCode === null || input.bookingCode.trim() === ''
      ? null
      : await bookingCodeForTicket(
          tx,
          input.bookingCode,
          input.legs.map((leg) => leg.selectionId),
        );

  const [existing] = await tx
    .select({ id: bets.id })
    .from(bets)
    .where(and(eq(bets.userId, bettorId), eq(bets.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing === undefined && limits.dailySales !== null) {
    const sold = await soldToday(tx, agent.id, input.now);
    if (sold + input.stake > limits.dailySales) {
      throw domainConflict(
        'daily_sales_limit',
        "This ticket is above the agent's sales limit for today.",
        { limit: toWire(limits.dailySales), soldToday: toWire(sold), stake: toWire(input.stake) },
      );
    }
  }

  const { bet, replayed } = await placeBet(tx, {
    userId: bettorId,
    funding: { kind: 'retail', account: ticketCashAccount(shop), staffId: input.staffId },
    legs: input.legs,
    stake: input.stake,
    policy: input.policy,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
    settings: { ...input.settings, betRules: retailBetRules(input.settings.betRules, limits) },
    randomBytes: input.randomBytes ?? nodeRandomBytes,
    ip: input.ip ?? null,
  });

  if (replayed) {
    const [ticket] = await tx.select().from(retailTickets).where(eq(retailTickets.betId, bet.id));
    if (!ticket) throw new Error(`shop ticket of bet ${bet.id} is missing`);
    if (ticket.staffId !== input.staffId) {
      throw domainConflict(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for another ticket.',
      );
    }
    return { ticket, bet, replayed: true };
  }

  const [ticket] = await tx
    .insert(retailTickets)
    .values({
      betId: bet.id,
      agentId: agent.id,
      shopId: shop.id,
      staffId: input.staffId,
      shiftId: shift.id,
      customerPhone: input.customerPhone?.trim() || null,
      bookingCode,
      stake: input.stake,
      soldAt: input.now,
    })
    .returning();
  if (!ticket) throw new Error('shop ticket insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: RETAIL_TICKET_SOLD,
    targetType: 'retail_ticket',
    targetId: ticket.id,
    metadata: {
      betId: bet.id,
      shortId: bet.shortId,
      agentId: agent.id,
      shopId: shop.id,
      stake: ticket.stake,
      legs: bet.legs.length,
    },
    ip: input.ip ?? null,
  });
  await enqueueOutbox(tx, {
    type: RETAIL_TICKET_SOLD,
    aggregateType: 'retail_ticket',
    aggregateId: ticket.id,
    payload: {
      ticketId: ticket.id,
      betId: bet.id,
      shortId: bet.shortId,
      agentId: agent.id,
      shopId: shop.id,
      staffId: input.staffId,
      stake: ticket.stake,
      potentialNetPayout: bet.potentialNetPayout,
    },
  });
  return { ticket, bet, replayed: false };
}

/** Who cancels: the selling cashier, the agent's owner, or an admin (back office). */
export interface RetailCancelActor {
  staffId: string;
  role: RetailCancelRole;
}

const CANCEL_REFUSALS = {
  not_open: ['ticket_not_open', 'This ticket is no longer open.'],
  match_started: ['ticket_match_started', 'A match on this ticket has started: it stands.'],
  cancel_window_passed: [
    'cancel_window_passed',
    'The time to cancel at the counter has passed. The agent owner or head office can still cancel it before kick-off.',
  ],
} as const;

/**
 * Cancels a ticket and posts its stake back where it came from. The selling cashier within the
 * cancel window, the agent's owner or an admin later; never once a match on it has kicked off or
 * once the bet is no longer open (409 `ticket_match_started`, `ticket_not_open`,
 * `cancel_window_passed`). A ticket another cashier sold, or of another agent for an owner, is
 * 404. Cancelling again changes nothing. Audited, with an outbox event.
 */
export async function cancelRetailTicket(
  tx: DbTransaction,
  input: {
    ticketId: string;
    actor: RetailCancelActor;
    reason?: string | null;
    now: Date;
    ip?: string | null;
  },
): Promise<{ ticket: RetailTicket; changed: boolean }> {
  const [current] = await tx
    .select()
    .from(retailTickets)
    .where(eq(retailTickets.id, input.ticketId))
    .for('update');
  if (!current) throw domainNotFound('Ticket');
  const [agent] = await tx.select().from(agents).where(eq(agents.id, current.agentId));
  if (!agent) throw domainNotFound('Ticket');
  const { actor } = input;
  if (
    (actor.role === 'cashier' && current.staffId !== actor.staffId) ||
    (actor.role === 'owner' && agent.ownerStaffId !== actor.staffId)
  ) {
    throw domainNotFound('Ticket');
  }
  if (current.status === 'cancelled') return { ticket: current, changed: false };

  // The bet row's lock orders this with settlement (which locks it too).
  const [bet] = await tx.select().from(bets).where(eq(bets.id, current.betId)).for('update');
  if (!bet) throw new Error(`bet ${current.betId} of ticket ${current.id} is missing`);
  // A match counts as started at its kick-off time, or as soon as it is no longer scheduled
  // (live early, suspended, finished): either way the ticket stands.
  const [kickoff] = await tx
    .select({
      first: min(events.startTime),
      started: sql<boolean>`COALESCE(bool_or(${events.status}::text <> 'scheduled'), false)`,
    })
    .from(betLegs)
    .innerJoin(events, eq(events.id, betLegs.eventId))
    .where(eq(betLegs.betId, bet.id));
  const firstKickoff =
    kickoff === undefined || kickoff.started || kickoff.first === null ? input.now : kickoff.first;
  const overrides = parseRetailTicketLimits(agent.ticketLimits);
  const refusal = retailCancelRefusal({
    role: actor.role,
    open: bet.status === 'open',
    soldAt: current.soldAt,
    firstKickoff,
    now: input.now,
    cancelMinutes: overrides.cancelMinutes ?? DEFAULT_RETAIL_TICKET_LIMITS.cancelMinutes,
  });
  if (refusal !== null) {
    const [code, message] = CANCEL_REFUSALS[refusal];
    throw domainConflict(code, message);
  }

  const shop = await getShop(tx, current.shopId);
  if (shop === null) throw new Error(`shop ${current.shopId} of ticket ${current.id} is missing`);
  const account = ticketCashAccount(shop);
  await postTransaction(tx, {
    type: 'retail_ticket_cancel',
    idempotencyKey: retailCancelLedgerKey(bet.id),
    refType: 'bet',
    refId: bet.id,
    description: `Shop ticket ${bet.shortId} cancelled`,
    actor: { type: 'admin', id: actor.staffId },
    createdAt: input.now,
    entries: [
      { account: { kind: 'house_stakes' }, amount: -current.stake },
      { account, amount: current.stake },
    ],
  });
  await tx
    .update(bets)
    .set({ status: 'cancelled', updatedAt: input.now })
    .where(and(eq(bets.id, bet.id), eq(bets.status, 'open')));
  const [ticket] = await tx
    .update(retailTickets)
    .set({
      status: 'cancelled',
      cancelledAt: input.now,
      cancelledBy: actor.staffId,
      cancelReason: input.reason?.trim() || null,
    })
    .where(eq(retailTickets.id, current.id))
    .returning();
  if (!ticket) throw new Error('shop ticket update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.staffId,
    action: RETAIL_TICKET_CANCELLED,
    targetType: 'retail_ticket',
    targetId: ticket.id,
    metadata: {
      betId: bet.id,
      shortId: bet.shortId,
      role: actor.role,
      stake: ticket.stake,
      reason: ticket.cancelReason,
    },
    ip: input.ip ?? null,
  });
  await enqueueOutbox(tx, {
    type: RETAIL_TICKET_CANCELLED,
    aggregateType: 'retail_ticket',
    aggregateId: ticket.id,
    payload: { ticketId: ticket.id, betId: bet.id, agentId: ticket.agentId, stake: ticket.stake },
  });
  return { ticket, changed: true };
}

/** A ticket with where it was sold and who sold it (the ticket's view and print). */
export type RetailTicketRow = RetailTicket & {
  shop: ShopWithAgent;
  staffName: string;
};

/** A ticket by id with its shop and cashier, or null. */
export async function getRetailTicket(
  exec: DbExecutor,
  ticketId: string,
): Promise<RetailTicketRow | null> {
  const [row] = await exec
    .select({ ticket: retailTickets, staffName: adminUsers.displayName })
    .from(retailTickets)
    .innerJoin(adminUsers, eq(adminUsers.id, retailTickets.staffId))
    .where(eq(retailTickets.id, ticketId))
    .limit(1);
  if (!row) return null;
  const shop = await getShop(exec, row.ticket.shopId);
  if (shop === null) return null;
  return { ...row.ticket, shop, staffName: row.staffName };
}

/** A shift's tickets with their numbers (the bets' short ids), newest first. */
export async function listShiftTickets(
  exec: DbExecutor,
  shiftId: string,
): Promise<Array<RetailTicket & { number: string }>> {
  const rows = await exec
    .select({ ticket: retailTickets, number: bets.shortId })
    .from(retailTickets)
    .innerJoin(bets, eq(bets.id, retailTickets.betId))
    .where(eq(retailTickets.shiftId, shiftId))
    .orderBy(desc(retailTickets.soldAt), desc(retailTickets.id));
  return rows.map((row) => ({ ...row.ticket, number: row.number }));
}

/**
 * Sets an agent's ticket limits (an admin; agents.manage): the overrides replace the previous ones
 * whole, validated (RangeError for anything malformed). Audited with before and after.
 */
export async function setAgentTicketLimits(
  tx: DbTransaction,
  input: { agentId: string; limits: unknown; adminId: string; now: Date; ip?: string | null },
) {
  const parsed = parseRetailTicketLimits(input.limits);
  const [before] = await tx.select().from(agents).where(eq(agents.id, input.agentId)).for('update');
  if (!before) throw domainNotFound('Agent');
  const stored = serializeRetailTicketLimits(parsed);
  const [agent] = await tx
    .update(agents)
    .set({ ticketLimits: stored, updatedAt: input.now })
    .where(eq(agents.id, before.id))
    .returning();
  if (!agent) throw new Error('agent update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'agent.ticket_limits_set',
    targetType: 'agent',
    targetId: agent.id,
    metadata: { before: before.ticketLimits, after: stored },
    ip: input.ip ?? null,
  });
  return agent;
}

/**
 * Records a print of a ticket by the cashier who sold it (404 for anyone else): the first is the
 * original, every later one a counted copy. A cancelled ticket is never printed (409
 * `ticket_cancelled`). Audited.
 */
export async function printRetailTicket(
  tx: DbTransaction,
  input: { ticketId: string; staffId: string; now: Date; ip?: string | null },
): Promise<{ ticket: RetailTicket; copy: boolean }> {
  const [current] = await tx
    .select()
    .from(retailTickets)
    .where(eq(retailTickets.id, input.ticketId))
    .for('update');
  if (!current || current.staffId !== input.staffId) throw domainNotFound('Ticket');
  if (current.status === 'cancelled') {
    throw domainConflict('ticket_cancelled', 'This ticket was cancelled: it is not printed.');
  }
  const copy = current.originalPrintedAt !== null;
  const [ticket] = await tx
    .update(retailTickets)
    .set(copy ? { reprints: sql`${retailTickets.reprints} + 1` } : { originalPrintedAt: input.now })
    .where(eq(retailTickets.id, current.id))
    .returning();
  if (!ticket) throw new Error('shop ticket update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: copy ? 'retail.ticket_reprinted' : 'retail.ticket_printed',
    targetType: 'retail_ticket',
    targetId: ticket.id,
    metadata: { reprints: ticket.reprints },
    ip: input.ip ?? null,
  });
  return { ticket, copy };
}
