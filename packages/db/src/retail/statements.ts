import {
  addBusinessDays,
  agentCommission,
  businessWeekStartOf,
  businessWeekWindow,
  isBusinessWeekStart,
} from '@vamos/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import { accountKey } from '../ledger/accounts';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { agentStatements } from '../schema/retail-statements';
import { agents } from '../schema/retail';

/**
 * Agents' weekly statements (docs/plans/agent-shops.md, "Phase 5 design", step 1). The worker makes
 * last week's statement for every independent agent once the week closed (one per agent and week:
 * a second run adds nothing); the figures and the commission are fixed then. The admin pays the
 * commission outside the system and records it here once (audited). Nahubet HQ has none.
 */

export type AgentStatement = typeof agentStatements.$inferSelect;

export const STATEMENT_AUDIT = { paid: 'agent.statement_paid' } as const;

/** Statements are made this long after the week closed (Monday 01:00 Addis Ababa time). */
export const STATEMENT_DELAY_MS = 3_600_000;

/** One week's figures for one agent (santim; counts of tickets and operations). */
export interface AgentWeekFigures {
  ticketsSold: number;
  soldStakes: bigint;
  ticketsCancelled: number;
  cancelledStakes: bigint;
  ticketsSettled: number;
  settledStakes: bigint;
  settledPayouts: bigint;
  ggr: bigint;
  ticketsPaid: number;
  paidAmount: bigint;
  ticketsExpired: number;
  expiredAmount: bigint;
  playerDeposits: number;
  playerCashIn: bigint;
  playerWithdrawals: number;
  playerCashOut: bigint;
  balanceStart: bigint;
  balanceEnd: bigint;
}

interface CountSum {
  n: string | number;
  total: string | null;
}

const asCount = (row: CountSum | undefined) => Number(row?.n ?? 0);
const asSum = (row: CountSum | undefined) => BigInt(row?.total ?? '0');

/**
 * The figures of the agent's shops in the business week starting on Monday `weekStart`: tickets
 * sold and cancelled, settled (won or lost) with the week's GGR, paid at the counter, expired;
 * player cash in and out; the agent balance at the week's start and end. Any week, open or closed.
 */
export async function computeAgentWeek(
  exec: DbExecutor,
  agentId: string,
  weekStart: string,
): Promise<AgentWeekFigures> {
  const { start, end } = businessWeekWindow(weekStart);
  const one = async (query: ReturnType<typeof sql>): Promise<CountSum | undefined> => {
    const result = await exec.execute(query);
    return (result.rows as unknown as CountSum[])[0];
  };
  const sold = await one(sql`
    SELECT count(*) AS n, sum(stake)::text AS total FROM retail_tickets
    WHERE agent_id = ${agentId} AND sold_at >= ${start} AND sold_at < ${end}`);
  const cancelled = await one(sql`
    SELECT count(*) AS n, sum(stake)::text AS total FROM retail_tickets
    WHERE agent_id = ${agentId} AND cancelled_at >= ${start} AND cancelled_at < ${end}`);
  const settledStakes = await one(sql`
    SELECT count(*) AS n, sum(t.stake)::text AS total
    FROM retail_tickets t JOIN bets b ON b.id = t.bet_id
    WHERE t.agent_id = ${agentId} AND t.status <> 'cancelled' AND b.status IN ('won', 'lost')
      AND b.settled_at >= ${start} AND b.settled_at < ${end}`);
  const settledPayouts = await one(sql`
    SELECT count(*) AS n, sum(b.settled_gross_payout)::text AS total
    FROM retail_tickets t JOIN bets b ON b.id = t.bet_id
    WHERE t.agent_id = ${agentId} AND t.status <> 'cancelled' AND b.status = 'won'
      AND b.settled_at >= ${start} AND b.settled_at < ${end}`);
  const paid = await one(sql`
    SELECT count(*) AS n, sum(paid_amount)::text AS total FROM retail_tickets
    WHERE agent_id = ${agentId} AND paid_at >= ${start} AND paid_at < ${end}`);
  const expired = await one(sql`
    SELECT count(*) AS n, sum(b.settled_net_payout)::text AS total
    FROM retail_tickets t JOIN bets b ON b.id = t.bet_id
    WHERE t.agent_id = ${agentId} AND t.expired_at >= ${start} AND t.expired_at < ${end}`);
  const cash = async (kind: 'deposit' | 'withdrawal') =>
    one(sql`
      SELECT count(*) AS n, sum(o.amount)::text AS total
      FROM cash_operations o JOIN cashier_shops s ON s.id = o.shop_id
      WHERE s.agent_id = ${agentId} AND o.kind = ${kind}
        AND o.created_at >= ${start} AND o.created_at < ${end}`);
  const deposits = await cash('deposit');
  const withdrawals = await cash('withdrawal');
  const key = accountKey({ kind: 'agent_balance', agentId });
  const balanceAt = async (instant: Date) =>
    asSum(
      await one(sql`
        SELECT 0 AS n, sum(e.amount)::text AS total
        FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.key = ${key} AND e.created_at < ${instant}`),
    );
  const stakes = asSum(settledStakes);
  const payouts = asSum(settledPayouts);
  return {
    ticketsSold: asCount(sold),
    soldStakes: asSum(sold),
    ticketsCancelled: asCount(cancelled),
    cancelledStakes: asSum(cancelled),
    ticketsSettled: asCount(settledStakes),
    settledStakes: stakes,
    settledPayouts: payouts,
    ggr: stakes - payouts,
    ticketsPaid: asCount(paid),
    paidAmount: asSum(paid),
    ticketsExpired: asCount(expired),
    expiredAmount: asSum(expired),
    playerDeposits: asCount(deposits),
    playerCashIn: asSum(deposits),
    playerWithdrawals: asCount(withdrawals),
    playerCashOut: asSum(withdrawals),
    balanceStart: await balanceAt(start),
    balanceEnd: await balanceAt(end),
  };
}

/** The Monday of the last business week that closed at least STATEMENT_DELAY_MS before `now`. */
export function lastStatementWeek(now: Date): string {
  return addBusinessDays(businessWeekStartOf(new Date(now.getTime() - STATEMENT_DELAY_MS)), -7);
}

/**
 * Makes the statements of the business week starting on `weekStart` (a closed week) for every
 * independent agent that existed before the week ended, blocked ones too. Statements that exist are
 * kept as they are. Returns how many were made.
 */
export async function generateAgentStatements(
  tx: DbTransaction,
  input: { weekStart: string; now: Date },
): Promise<{ created: number }> {
  if (!isBusinessWeekStart(input.weekStart)) {
    throw domainUnprocessable('invalid_week', 'A week starts on a Monday (YYYY-MM-DD).');
  }
  const { end } = businessWeekWindow(input.weekStart);
  if (end.getTime() > input.now.getTime()) {
    throw domainConflict('week_not_closed', 'This week has not ended yet.');
  }
  const candidates = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.isHouse, false), sql`${agents.createdAt} < ${end}`))
    .orderBy(asc(agents.number));
  let created = 0;
  for (const agent of candidates) {
    const figures = await computeAgentWeek(tx, agent.id, input.weekStart);
    const commission = agentCommission({
      kind: agent.commissionKind,
      bps: agent.commissionBps,
      soldStakes: figures.soldStakes,
      cancelledStakes: figures.cancelledStakes,
      ggr: figures.ggr,
    });
    const inserted = await tx
      .insert(agentStatements)
      .values({
        agentId: agent.id,
        weekStart: input.weekStart,
        ...figures,
        commissionKind: agent.commissionKind,
        commissionBps: agent.commissionBps,
        commission,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: [agentStatements.agentId, agentStatements.weekStart] })
      .returning({ id: agentStatements.id });
    created += inserted.length;
  }
  return { created };
}

/** A statement with its agent's number and name. */
export type AgentStatementRow = AgentStatement & { agentNumber: number; agentName: string };

/** Statements of one week (by agent number) or of one agent (newest week first). */
export async function listAgentStatements(
  exec: DbExecutor,
  filter: { weekStart?: string; agentId?: string; limit: number },
): Promise<AgentStatementRow[]> {
  const rows = await exec
    .select({ statement: agentStatements, agentNumber: agents.number, agentName: agents.name })
    .from(agentStatements)
    .innerJoin(agents, eq(agents.id, agentStatements.agentId))
    .where(
      and(
        filter.weekStart === undefined
          ? undefined
          : eq(agentStatements.weekStart, filter.weekStart),
        filter.agentId === undefined ? undefined : eq(agentStatements.agentId, filter.agentId),
      ),
    )
    .orderBy(desc(agentStatements.weekStart), asc(agents.number))
    .limit(filter.limit);
  return rows.map((row) => ({
    ...row.statement,
    agentNumber: row.agentNumber,
    agentName: row.agentName,
  }));
}

/**
 * Records that the admin paid a statement's commission outside the system, with the payment's
 * reference (3 to 100 characters): once (409 `statement_already_paid`). Audited.
 */
export async function markAgentStatementPaid(
  tx: DbTransaction,
  input: { statementId: string; reference: string; adminId: string; now: Date; ip?: string | null },
): Promise<AgentStatement> {
  const reference = input.reference.trim();
  if (reference.length < 3 || reference.length > 100) {
    throw domainUnprocessable(
      'invalid_reference',
      'Give the payment reference (3 to 100 characters).',
    );
  }
  const [statement] = await tx
    .select()
    .from(agentStatements)
    .where(eq(agentStatements.id, input.statementId))
    .for('update');
  if (!statement) throw domainNotFound('Statement');
  if (statement.paidAt !== null) {
    throw domainConflict(
      'statement_already_paid',
      "This statement's commission is already recorded as paid.",
    );
  }
  const [after] = await tx
    .update(agentStatements)
    .set({ paidAt: input.now, paidBy: input.adminId, paidReference: reference })
    .where(eq(agentStatements.id, statement.id))
    .returning();
  if (!after) throw domainNotFound('Statement');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: STATEMENT_AUDIT.paid,
    targetType: 'agent',
    targetId: statement.agentId,
    metadata: {
      statementId: statement.id,
      weekStart: statement.weekStart,
      commission: statement.commission.toString(),
      reference,
    },
    ip: input.ip ?? null,
  });
  return after;
}
