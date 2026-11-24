import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './accounts';
import { agentCommissionKind, agents } from './retail';

/**
 * Agents' weekly statements (docs/plans/agent-shops.md, "Phase 5 design"): one row per independent
 * agent and business week (Monday to Sunday, Addis Ababa time), made by the worker once the week
 * closed. The figures and the commission are fixed when the row is made; the admin pays the
 * commission outside the system and records it once (paid_at, paid_by, paid_reference). A trigger
 * refuses any other change; rows are never deleted.
 */
export const agentStatements = pgTable(
  'agent_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    /** The Monday the week starts on (Addis Ababa calendar). */
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    ticketsSold: integer('tickets_sold').notNull(),
    soldStakes: bigint('sold_stakes', { mode: 'bigint' }).notNull(),
    ticketsCancelled: integer('tickets_cancelled').notNull(),
    cancelledStakes: bigint('cancelled_stakes', { mode: 'bigint' }).notNull(),
    /** Tickets whose bet settled in the week (won or lost; voids and cancels left out). */
    ticketsSettled: integer('tickets_settled').notNull(),
    settledStakes: bigint('settled_stakes', { mode: 'bigint' }).notNull(),
    settledPayouts: bigint('settled_payouts', { mode: 'bigint' }).notNull(),
    /** Settled stakes - settled gross payouts (negative in a losing week). */
    ggr: bigint('ggr', { mode: 'bigint' }).notNull(),
    ticketsPaid: integer('tickets_paid').notNull(),
    paidAmount: bigint('paid_amount', { mode: 'bigint' }).notNull(),
    ticketsExpired: integer('tickets_expired').notNull(),
    expiredAmount: bigint('expired_amount', { mode: 'bigint' }).notNull(),
    playerDeposits: integer('player_deposits').notNull(),
    playerCashIn: bigint('player_cash_in', { mode: 'bigint' }).notNull(),
    playerWithdrawals: integer('player_withdrawals').notNull(),
    playerCashOut: bigint('player_cash_out', { mode: 'bigint' }).notNull(),
    balanceStart: bigint('balance_start', { mode: 'bigint' }).notNull(),
    balanceEnd: bigint('balance_end', { mode: 'bigint' }).notNull(),
    commissionKind: agentCommissionKind('commission_kind').notNull(),
    commissionBps: integer('commission_bps').notNull(),
    commission: bigint('commission', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    paidReference: text('paid_reference'),
  },
  (t) => [
    uniqueIndex('agent_statements_agent_week_uq').on(t.agentId, t.weekStart),
    check('agent_statements_monday', sql`EXTRACT(ISODOW FROM ${t.weekStart}) = 1`),
    check(
      'agent_statements_counts',
      sql`${t.ticketsSold} >= 0 AND ${t.ticketsCancelled} >= 0 AND ${t.ticketsSettled} >= 0 AND ${t.ticketsPaid} >= 0 AND ${t.ticketsExpired} >= 0 AND ${t.playerDeposits} >= 0 AND ${t.playerWithdrawals} >= 0`,
    ),
    check(
      'agent_statements_amounts',
      sql`${t.soldStakes} >= 0 AND ${t.cancelledStakes} >= 0 AND ${t.settledStakes} >= 0 AND ${t.settledPayouts} >= 0 AND ${t.paidAmount} >= 0 AND ${t.expiredAmount} >= 0 AND ${t.playerCashIn} >= 0 AND ${t.playerCashOut} >= 0 AND ${t.commission} >= 0`,
    ),
    check('agent_statements_ggr', sql`${t.ggr} = ${t.settledStakes} - ${t.settledPayouts}`),
    check('agent_statements_bps', sql`${t.commissionBps} BETWEEN 0 AND 10000`),
    check(
      'agent_statements_paid',
      sql`(${t.paidAt} IS NULL) = (${t.paidBy} IS NULL) AND (${t.paidAt} IS NULL) = (${t.paidReference} IS NULL)`,
    ),
  ],
);
