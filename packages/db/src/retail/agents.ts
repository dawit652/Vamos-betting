import { formatShopLabel, nextAgentNumber, normalizeEthiopianMsisdn } from '@vamos/core';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../catalog/errors';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { adminUsers } from '../schema/accounts';
import { cashierShops, cashierStaffShops } from '../schema/cashier';
import { agents } from '../schema/retail';

/**
 * Agents (docs/plans/agent-shops.md, phase 1): independent businesses that run shops. Each has a
 * number (1001 up; 1000 is Nahubet HQ), a name, its owner's name and mobile number, a commission
 * (kind and basis points, paid from phase 5) and a status: an admin blocks or unblocks an agent at
 * any time, and a blocked agent's shops cannot work (assertShopOperates). Every change is audited.
 */

export type Agent = typeof agents.$inferSelect;
export type AgentCommissionKind = Agent['commissionKind'];

export const AGENT_AUDIT = {
  created: 'agent.created',
  updated: 'agent.updated',
  blocked: 'agent.blocked',
  unblocked: 'agent.unblocked',
} as const;

/** An agent with the size of its network. */
export type AgentSummary = Agent & { shops: number; openShops: number; cashiers: number };

/** A cashier assigned to one of an agent's shops. */
export interface AgentCashier {
  staffId: string;
  displayName: string;
  email: string;
  phone: string | null;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  shopId: string;
  shopLabel: string;
  shopName: string;
}

function checkedName(value: string, code: 'invalid_agent_name' | 'invalid_owner_name'): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 100) {
    throw domainUnprocessable(
      code,
      code === 'invalid_agent_name'
        ? "The agent's name must have 2 to 100 characters."
        : "The owner's name must have 2 to 100 characters.",
    );
  }
  return trimmed;
}

function checkedPhone(value: string): string {
  const normalised = normalizeEthiopianMsisdn(value);
  if (normalised === null) {
    throw domainUnprocessable(
      'invalid_owner_phone',
      'Use an Ethiopian mobile number (09… or 07…).',
    );
  }
  return normalised;
}

function checkedBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw domainUnprocessable('invalid_commission', 'The commission must be between 0% and 100%.');
  }
  return bps;
}

/** The fields an audit line keeps of an agent (before and after a change). */
function auditFields(agent: Agent) {
  return {
    number: agent.number,
    name: agent.name,
    ownerName: agent.ownerName,
    ownerPhone: agent.ownerPhone,
    commissionKind: agent.commissionKind,
    commissionBps: agent.commissionBps,
    status: agent.status,
  };
}

/**
 * Adds an agent with the next number (1001 up). 422 for a bad name, owner name, phone or
 * commission. Audited as `agent.created`.
 */
export async function createAgent(
  tx: DbTransaction,
  input: {
    name: string;
    ownerName: string;
    ownerPhone: string;
    commissionKind: AgentCommissionKind;
    commissionBps: number;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<Agent> {
  const values = {
    name: checkedName(input.name, 'invalid_agent_name'),
    ownerName: checkedName(input.ownerName, 'invalid_owner_name'),
    ownerPhone: checkedPhone(input.ownerPhone),
    commissionKind: input.commissionKind,
    commissionBps: checkedBps(input.commissionBps),
  };
  for (let attempt = 0; ; attempt += 1) {
    const [highest] = await tx
      .select({ number: sql<number | null>`max(${agents.number})` })
      .from(agents);
    const number = nextAgentNumber(
      highest?.number === null || highest?.number === undefined ? null : Number(highest.number),
    );
    try {
      // A savepoint: an agent added at the same moment took the number, so draw the next one.
      const [created] = await tx.transaction((sp) =>
        sp
          .insert(agents)
          .values({ ...values, number, createdAt: input.now, updatedAt: input.now })
          .returning(),
      );
      if (!created) throw new Error('agents insert returned no row');
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.adminId,
        action: AGENT_AUDIT.created,
        targetType: 'agent',
        targetId: created.id,
        metadata: auditFields(created),
        ip: input.ip ?? null,
      });
      return created;
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error, 'agents_number_uq')) continue;
      throw error;
    }
  }
}

/** Every agent by number (HQ first), with its shops, open shops and cashiers counted. */
export async function listAgents(exec: DbExecutor): Promise<AgentSummary[]> {
  return exec
    .select({
      ...getTableColumns(agents),
      // Raw names: in a subquery drizzle may print a column without its table, which then
      // points at the subquery's own table.
      shops:
        sql<number>`(SELECT count(*) FROM "cashier_shops" s WHERE s."agent_id" = "agents"."id")`.mapWith(
          Number,
        ),
      openShops:
        sql<number>`(SELECT count(*) FROM "cashier_shops" s WHERE s."agent_id" = "agents"."id" AND s."active")`.mapWith(
          Number,
        ),
      cashiers:
        sql<number>`(SELECT count(*) FROM "cashier_staff_shops" a JOIN "cashier_shops" s ON s."id" = a."shop_id" WHERE s."agent_id" = "agents"."id")`.mapWith(
          Number,
        ),
    })
    .from(agents)
    .orderBy(asc(agents.number));
}

export async function getAgent(exec: DbExecutor, agentId: string): Promise<Agent | null> {
  const [row] = await exec.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return row ?? null;
}

/** The cashiers assigned to an agent's shops, by shop number then name. */
export async function listAgentCashiers(
  exec: DbExecutor,
  agentId: string,
): Promise<AgentCashier[]> {
  const rows = await exec
    .select({
      staffId: adminUsers.id,
      displayName: adminUsers.displayName,
      email: adminUsers.email,
      phone: adminUsers.phone,
      disabledAt: adminUsers.disabledAt,
      lastLoginAt: adminUsers.lastLoginAt,
      shopId: cashierShops.id,
      shopNumber: cashierShops.number,
      shopName: cashierShops.name,
      agentNumber: agents.number,
    })
    .from(cashierStaffShops)
    .innerJoin(adminUsers, eq(adminUsers.id, cashierStaffShops.staffId))
    .innerJoin(cashierShops, eq(cashierShops.id, cashierStaffShops.shopId))
    .innerJoin(agents, eq(agents.id, cashierShops.agentId))
    .where(eq(cashierShops.agentId, agentId))
    .orderBy(asc(cashierShops.number), asc(adminUsers.displayName));
  return rows.map(({ shopNumber, agentNumber, ...row }) => ({
    ...row,
    shopLabel: formatShopLabel(agentNumber, shopNumber),
  }));
}

async function lockAgent(tx: DbTransaction, agentId: string): Promise<Agent> {
  const [row] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
  if (!row) throw domainNotFound('Agent');
  return row;
}

/**
 * Changes an agent's name, owner, phone or commission. Nahubet HQ (agent 1000) only changes its
 * name (409 `house_agent`). Nothing changed: no write and no audit line. Audited as
 * `agent.updated` with the values before and after.
 */
export async function updateAgent(
  tx: DbTransaction,
  input: {
    agentId: string;
    name?: string;
    ownerName?: string;
    ownerPhone?: string;
    commissionKind?: AgentCommissionKind;
    commissionBps?: number;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<Agent> {
  const agent = await lockAgent(tx, input.agentId);
  const changes: Partial<
    Pick<Agent, 'name' | 'ownerName' | 'ownerPhone' | 'commissionKind' | 'commissionBps'>
  > = {};
  if (input.name !== undefined) changes.name = checkedName(input.name, 'invalid_agent_name');
  if (input.ownerName !== undefined) {
    changes.ownerName = checkedName(input.ownerName, 'invalid_owner_name');
  }
  if (input.ownerPhone !== undefined) changes.ownerPhone = checkedPhone(input.ownerPhone);
  if (input.commissionKind !== undefined) changes.commissionKind = input.commissionKind;
  if (input.commissionBps !== undefined) changes.commissionBps = checkedBps(input.commissionBps);
  const changed = (Object.keys(changes) as Array<keyof typeof changes>).filter(
    (key) => changes[key] !== agent[key],
  );
  if (changed.length === 0) return agent;
  if (agent.isHouse && changed.some((key) => key !== 'name')) {
    throw domainConflict('house_agent', 'Nahubet HQ only changes its name.');
  }
  const [after] = await tx
    .update(agents)
    .set({ ...changes, updatedAt: input.now })
    .where(eq(agents.id, agent.id))
    .returning();
  if (!after) throw domainNotFound('Agent');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: AGENT_AUDIT.updated,
    targetType: 'agent',
    targetId: agent.id,
    metadata: { before: auditFields(agent), after: auditFields(after) },
    ip: input.ip ?? null,
  });
  return after;
}

/**
 * Blocks or unblocks an agent, with a reason (3 to 500 characters). A blocked agent's shops cannot
 * open shifts or take or pay cash (assertShopOperates). Nahubet HQ cannot be blocked (409
 * `house_agent`). Already in that state: returned as it is, no audit line. Audited as
 * `agent.blocked` / `agent.unblocked`.
 */
export async function setAgentBlocked(
  tx: DbTransaction,
  input: {
    agentId: string;
    blocked: boolean;
    reason: string;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<Agent> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw domainUnprocessable('invalid_reason', 'Give a reason of 3 to 500 characters.');
  }
  const agent = await lockAgent(tx, input.agentId);
  if (agent.isHouse) throw domainConflict('house_agent', 'Nahubet HQ cannot be blocked.');
  if ((agent.status === 'blocked') === input.blocked) return agent;
  const [after] = await tx
    .update(agents)
    .set(
      input.blocked
        ? { status: 'blocked', blockedAt: input.now, blockedReason: reason, updatedAt: input.now }
        : { status: 'active', blockedAt: null, blockedReason: null, updatedAt: input.now },
    )
    .where(eq(agents.id, agent.id))
    .returning();
  if (!after) throw domainNotFound('Agent');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: input.blocked ? AGENT_AUDIT.blocked : AGENT_AUDIT.unblocked,
    targetType: 'agent',
    targetId: agent.id,
    metadata: { number: agent.number, name: agent.name, reason },
    ip: input.ip ?? null,
  });
  return after;
}

/** The agent whose owner account this is (any status), or null. */
export async function getOwnerAgent(exec: DbExecutor, staffId: string): Promise<Agent | null> {
  const [row] = await exec.select().from(agents).where(eq(agents.ownerStaffId, staffId)).limit(1);
  return row ?? null;
}

/**
 * Whether an agent owner's shop-app session may work: the account owns an agent that is not
 * blocked (checked on every request, so blocking the agent signs its owner out at once).
 */
export async function isOwnerAgentActive(exec: DbExecutor, staffId: string): Promise<boolean> {
  const agent = await getOwnerAgent(exec, staffId);
  return agent !== null && agent.status === 'active' && !agent.isHouse;
}

/**
 * Switches player cash (deposits and withdrawals for online players) on or off at an agent's
 * shops (agents.manage; agent-shops.md phase 2 step 4): with it on, the agent's prepaid balance
 * pays player deposits and receives the cash withdrawals the shops pay out. Nahubet HQ always
 * has it (409 `agent_is_house`). Audited; the same setting again changes nothing.
 */
export async function setAgentPlayerCash(
  tx: DbTransaction,
  input: { agentId: string; enabled: boolean; adminId: string; now: Date; ip?: string | null },
): Promise<Agent> {
  const [current] = await tx
    .select()
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .for('update');
  if (!current) throw domainNotFound('Agent');
  if (current.isHouse) {
    throw domainConflict('agent_is_house', "Nahubet HQ's shops always take player cash.");
  }
  if (current.playerCashEnabled === input.enabled) return current;
  const [updated] = await tx
    .update(agents)
    .set({ playerCashEnabled: input.enabled, updatedAt: input.now })
    .where(eq(agents.id, current.id))
    .returning();
  if (!updated) throw new Error('agent update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'agent.player_cash_switched',
    targetType: 'agent',
    targetId: current.id,
    metadata: { enabled: input.enabled },
    ip: input.ip ?? null,
  });
  return updated;
}
