import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers, users } from './accounts';

/**
 * Agent shops (owner, 19 Nov 2026; docs/plans/agent-shops.md). An agent is an independent business
 * that runs one or more shops; it prepays Nahubet and the cash in its shops is its own (the agent
 * balance arrives with phase 2). Agent 1000 is Nahubet HQ, the house: its shops' cash belongs to
 * Nahubet, as it did before agents existed.
 */
export const agentStatus = pgEnum('agent_status', ['active', 'blocked']);

/** An agent's commission: a percent of the stake sold, or of GGR (stake − winnings). */
export const agentCommissionKind = pgEnum('agent_commission_kind', ['stake', 'ggr']);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Printed on tickets and reports: 1000 is HQ, agents count up from 1001. */
    number: integer('number').notNull(),
    /** The business name. */
    name: text('name').notNull(),
    /** The person who owns the agent business, and their mobile number (E.164, `+2519…`). */
    ownerName: text('owner_name').notNull(),
    ownerPhone: text('owner_phone').notNull(),
    status: agentStatus('status').notNull().default('active'),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedReason: text('blocked_reason'),
    commissionKind: agentCommissionKind('commission_kind').notNull().default('ggr'),
    /** Commission in basis points of the base (10% = 1000). */
    commissionBps: integer('commission_bps').notNull().default(0),
    /** Cash deposits and withdrawals for online players at this agent's shops (phase 2). */
    playerCashEnabled: boolean('player_cash_enabled').notNull().default(false),
    /** Nahubet HQ (exactly one, number 1000). */
    isHouse: boolean('is_house').notNull().default(false),
    /** The owner's account (role `agent_owner`, shop app only); one per agent, never for HQ. */
    ownerStaffId: uuid('owner_staff_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
    /**
     * The agent's counter bettor (phase 3): the `users` row its shop tickets are bets of. Never a
     * player: phone `shop:<number>`, a password hash nothing matches. Made with the first ticket.
     */
    counterUserId: uuid('counter_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * An admin's ticket limits for this agent (RetailTicketLimits overrides in @vamos/core):
     * absent fields take the defaults.
     */
    ticketLimits: jsonb('ticket_limits').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_number_uq').on(t.number),
    uniqueIndex('agents_counter_user_uq')
      .on(t.counterUserId)
      .where(sql`${t.counterUserId} IS NOT NULL`),
    uniqueIndex('agents_house_uq')
      .on(t.isHouse)
      .where(sql`${t.isHouse}`),
    check('agents_number_range', sql`${t.number} BETWEEN 1000 AND 999999`),
    check('agents_house_number', sql`(${t.number} = 1000) = ${t.isHouse}`),
    check('agents_name_length', sql`char_length(${t.name}) BETWEEN 2 AND 100`),
    check('agents_owner_name_length', sql`char_length(${t.ownerName}) BETWEEN 2 AND 100`),
    check(
      'agents_owner_phone_format',
      sql`${t.isHouse} OR ${t.ownerPhone} ~ '^\\+251[79][0-9]{8}$'`,
    ),
    check('agents_commission_bps_range', sql`${t.commissionBps} BETWEEN 0 AND 10000`),
    check(
      'agents_blocked_consistent',
      sql`(${t.status} = 'blocked') = (${t.blockedAt} IS NOT NULL)`,
    ),
    check('agents_house_not_blocked', sql`NOT (${t.isHouse} AND ${t.status} = 'blocked')`),
    uniqueIndex('agents_owner_staff_uq')
      .on(t.ownerStaffId)
      .where(sql`${t.ownerStaffId} IS NOT NULL`),
    check('agents_house_no_owner', sql`NOT (${t.isHouse} AND ${t.ownerStaffId} IS NOT NULL)`),
  ],
);

/** A top-up: the agent paid Nahubet (`in`), or Nahubet paid the agent back (`out`, a take-back). */
export const agentTopupDirection = pgEnum('agent_topup_direction', ['in', 'out']);
export const agentTopupMethod = pgEnum('agent_topup_method', ['cash', 'bank']);
export const agentTopupStatus = pgEnum('agent_topup_status', ['requested', 'approved', 'rejected']);

/**
 * Money between an agent and Nahubet (docs/plans/agent-shops.md, phase 2): recorded by one admin,
 * approved or rejected by another person (four eyes). The approval posts the agent's balance in
 * the same transaction; a rejection posts nothing.
 */
export const agentTopups = pgTable(
  'agent_topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    direction: agentTopupDirection('direction').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    method: agentTopupMethod('method').notNull(),
    /** The bank's transfer reference (bank only): one transfer is never recorded twice. */
    bankReference: text('bank_reference'),
    note: text('note'),
    status: agentTopupStatus('status').notNull().default('requested'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    decidedBy: uuid('decided_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    /** The posting of an approved one. */
    ledgerTransactionId: uuid('ledger_transaction_id'),
  },
  (t) => [
    index('agent_topups_agent_idx').on(t.agentId, t.requestedAt),
    index('agent_topups_requested_idx')
      .on(t.requestedAt)
      .where(sql`${t.status} = 'requested'`),
    uniqueIndex('agent_topups_bank_reference_uq')
      .on(t.bankReference)
      .where(sql`${t.method} = 'bank' AND ${t.status} <> 'rejected'`),
    check('agent_topups_amount_positive', sql`${t.amount} > 0`),
    check(
      'agent_topups_bank_reference',
      sql`(${t.method} = 'bank') = (${t.bankReference} IS NOT NULL)`,
    ),
    check(
      'agent_topups_four_eyes',
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      'agent_topups_decided',
      sql`(${t.status} = 'requested') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    check(
      'agent_topups_posted',
      sql`(${t.status} = 'approved') = (${t.ledgerTransactionId} IS NOT NULL)`,
    ),
  ],
);
