import { formatShopLabel } from '@vamos/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { adminUsers } from '../schema/accounts';
import { bets } from '../schema/betting';
import { cashierShops } from '../schema/cashier';
import { agents } from '../schema/retail';
import { retailTickets } from '../schema/retail-tickets';

/**
 * The back office's live monitor of the agent shops (docs/plans/agent-shops.md, "Phase 5 design",
 * step 3): the newest tickets of every shop and each agent's day. Read-only, on the indexes of
 * `retail_tickets` (agent, sold_at) and (shop, sold_at).
 */

/** A ticket as the monitor lists it. */
export interface MonitorTicket {
  id: string;
  number: string;
  agentId: string;
  agentNumber: number;
  agentName: string;
  shopId: string;
  shopLabel: string;
  shopName: string;
  staffId: string;
  staffName: string;
  stake: bigint;
  /** The ticket's possible net payout (after tax), as printed. */
  possibleWin: bigint;
  status: 'sold' | 'cancelled' | 'paid' | 'expired';
  betStatus: string;
  soldAt: Date;
  paidAmount: bigint | null;
}

/** The newest tickets (at most `limit`, newest first), filtered by agent, shop or cashier. */
export async function listMonitorTickets(
  exec: DbExecutor,
  filter: { agentId?: string; shopId?: string; staffId?: string; limit: number },
): Promise<MonitorTicket[]> {
  const rows = await exec
    .select({
      id: retailTickets.id,
      number: bets.shortId,
      agentId: retailTickets.agentId,
      agentNumber: agents.number,
      agentName: agents.name,
      shopId: retailTickets.shopId,
      shopNumber: cashierShops.number,
      shopName: cashierShops.name,
      staffId: retailTickets.staffId,
      staffName: adminUsers.displayName,
      stake: retailTickets.stake,
      possibleWin: bets.potentialNetPayout,
      status: retailTickets.status,
      betStatus: bets.status,
      soldAt: retailTickets.soldAt,
      paidAmount: retailTickets.paidAmount,
    })
    .from(retailTickets)
    .innerJoin(bets, eq(bets.id, retailTickets.betId))
    .innerJoin(agents, eq(agents.id, retailTickets.agentId))
    .innerJoin(cashierShops, eq(cashierShops.id, retailTickets.shopId))
    .innerJoin(adminUsers, eq(adminUsers.id, retailTickets.staffId))
    .where(
      and(
        filter.agentId === undefined ? undefined : eq(retailTickets.agentId, filter.agentId),
        filter.shopId === undefined ? undefined : eq(retailTickets.shopId, filter.shopId),
        filter.staffId === undefined ? undefined : eq(retailTickets.staffId, filter.staffId),
      ),
    )
    .orderBy(desc(retailTickets.soldAt), desc(retailTickets.id))
    .limit(filter.limit);
  return rows.map(({ shopNumber, ...row }) => ({
    ...row,
    shopLabel: formatShopLabel(row.agentNumber, shopNumber),
  }));
}

/** One agent's day at the counters: tickets sold, cancelled and paid (santim). */
export interface MonitorAgentDay {
  agentId: string;
  ticketsSold: number;
  soldStakes: bigint;
  ticketsCancelled: number;
  cancelledStakes: bigint;
  ticketsPaid: number;
  paidAmount: bigint;
}

interface DayRow {
  agent_id: string;
  sold: string | number;
  sold_stakes: string | null;
  cancelled: string | number;
  cancelled_stakes: string | null;
  paid: string | number;
  paid_amount: string | null;
}

/** Every agent's counters in [start, end) (agents without a ticket in it are absent). */
export async function listMonitorAgentDays(
  exec: DbExecutor,
  window: { start: Date; end: Date },
): Promise<MonitorAgentDay[]> {
  const { start, end } = window;
  const result = await exec.execute(sql`
    SELECT agent_id,
      count(*) FILTER (WHERE sold_at >= ${start} AND sold_at < ${end}) AS sold,
      sum(stake) FILTER (WHERE sold_at >= ${start} AND sold_at < ${end})::text AS sold_stakes,
      count(*) FILTER (WHERE cancelled_at >= ${start} AND cancelled_at < ${end}) AS cancelled,
      sum(stake) FILTER (WHERE cancelled_at >= ${start} AND cancelled_at < ${end})::text
        AS cancelled_stakes,
      count(*) FILTER (WHERE paid_at >= ${start} AND paid_at < ${end}) AS paid,
      sum(paid_amount) FILTER (WHERE paid_at >= ${start} AND paid_at < ${end})::text AS paid_amount
    FROM retail_tickets
    WHERE (sold_at >= ${start} AND sold_at < ${end})
       OR (cancelled_at >= ${start} AND cancelled_at < ${end})
       OR (paid_at >= ${start} AND paid_at < ${end})
    GROUP BY agent_id`);
  return (result.rows as unknown as DayRow[]).map((row) => ({
    agentId: row.agent_id,
    ticketsSold: Number(row.sold),
    soldStakes: BigInt(row.sold_stakes ?? '0'),
    ticketsCancelled: Number(row.cancelled),
    cancelledStakes: BigInt(row.cancelled_stakes ?? '0'),
    ticketsPaid: Number(row.paid),
    paidAmount: BigInt(row.paid_amount ?? '0'),
  }));
}
