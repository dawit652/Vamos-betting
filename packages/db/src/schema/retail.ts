import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_number_uq').on(t.number),
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
  ],
);
