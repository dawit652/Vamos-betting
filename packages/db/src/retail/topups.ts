import { toWire } from '@vamos/core';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isUniqueViolation } from '../catalog/errors';
import { domainConflict, domainNotFound } from '../errors';
import { InsufficientFundsError } from '../ledger/errors';
import { postTransaction } from '../ledger/post';
import { getBalance } from '../ledger/queries';
import type { AccountRef, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { adminUsers } from '../schema/accounts';
import { ledgerAccounts } from '../schema/ledger';
import { agents, agentTopups } from '../schema/retail';

/**
 * An agent's balance (docs/plans/agent-shops.md, phase 2): what Nahubet owes the agent, prepaid
 * and never below zero (`agent:<id>:balance`, allowNegative false). Money comes in with a top-up
 * (the agent paid Nahubet in cash or by bank at HQ) and goes back with a take-back (closing, or
 * too much prepaid). Each is recorded by one admin and approved or rejected by another person
 * (four eyes); the approval posts in the same transaction:
 *
 * | Event              | Type              | Entries                                                  |
 * | ------------------ | ----------------- | -------------------------------------------------------- |
 * | Top-up approved    | `agent_topup`     | house:agent_funding −amount, agent:<id>:balance +amount  |
 * | Take-back approved | `agent_take_back` | agent:<id>:balance −amount, house:agent_funding +amount  |
 *
 * `house:agent_funding` (not `house:psp:cash`) holds the money agents paid: the PSP clearing
 * accounts reconcile against player deposits and payouts only. Nahubet HQ (agent 1000) has no
 * balance: its shops' cash is Nahubet's.
 */

export type AgentTopup = typeof agentTopups.$inferSelect;
export type AgentTopupDirection = AgentTopup['direction'];
export type AgentTopupMethod = AgentTopup['method'];

/** Audit actions and the outbox event of top-ups and take-backs. */
export const AGENT_TOPUP_AUDIT = {
  recorded: 'agent.topup_recorded',
  approved: 'agent.topup_approved',
  rejected: 'agent.topup_rejected',
} as const;
export const AGENT_TOPUP_APPROVED = 'retail.agent_topup_approved';

export const agentBalanceAccount = (agentId: string): AccountRef => ({
  kind: 'agent_balance',
  agentId,
});
const FUNDING: AccountRef = { kind: 'house_agent_funding' };
const BANK_REFERENCE_RE = /^[A-Za-z0-9/_.-]{3,64}$/;

/** The agent's balance in santim (0 before its first top-up). */
export async function getAgentBalance(exec: DbExecutor, agentId: string): Promise<bigint> {
  return getBalance(exec, agentBalanceAccount(agentId));
}

async function agentForMoney(exec: DbExecutor, agentId: string) {
  const [agent] = await exec.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw domainNotFound('Agent');
  if (agent.isHouse) {
    throw domainConflict(
      'agent_is_house',
      "Nahubet HQ has no balance: its shops' cash belongs to Nahubet.",
    );
  }
  return agent;
}

const balanceLow = (balance: bigint, amount: bigint) =>
  domainConflict('agent_balance_low', "This is more than the agent's balance.", {
    balance: toWire(balance),
    amount: toWire(amount),
  });

/**
 * Records a top-up (`in`) or a take-back (`out`) waiting for a second person's approval. A bank
 * transfer needs its reference, and one reference is never recorded twice (409
 * `bank_reference_used`, until the earlier one is rejected). A take-back above the balance is
 * refused now (409 `agent_balance_low`) and checked again by the approval's posting. Audited.
 */
export async function recordAgentTopup(
  tx: DbTransaction,
  input: {
    agentId: string;
    direction: AgentTopupDirection;
    amount: bigint;
    method: AgentTopupMethod;
    bankReference?: string | null;
    note?: string | null;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<AgentTopup> {
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new RangeError('amount must be a positive bigint');
  }
  const reference = input.method === 'bank' ? (input.bankReference ?? '').trim() : null;
  if (reference !== null && !BANK_REFERENCE_RE.test(reference)) {
    throw new RangeError('a bank top-up needs its transfer reference (3 to 64 characters)');
  }
  const agent = await agentForMoney(tx, input.agentId);
  if (input.direction === 'out') {
    const balance = await getAgentBalance(tx, agent.id);
    if (input.amount > balance) throw balanceLow(balance, input.amount);
  }
  let row: AgentTopup | undefined;
  try {
    [row] = await tx.transaction((sp) =>
      sp
        .insert(agentTopups)
        .values({
          agentId: agent.id,
          direction: input.direction,
          amount: input.amount,
          method: input.method,
          bankReference: reference,
          note: input.note?.trim() || null,
          requestedBy: input.adminId,
          requestedAt: input.now,
        })
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'agent_topups_bank_reference_uq')) {
      throw domainConflict(
        'bank_reference_used',
        'This bank transfer reference is recorded already.',
      );
    }
    throw error;
  }
  if (!row) throw new Error('top-up insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: AGENT_TOPUP_AUDIT.recorded,
    targetType: 'agent_topup',
    targetId: row.id,
    metadata: {
      agentId: agent.id,
      direction: row.direction,
      amount: row.amount,
      method: row.method,
      bankReference: row.bankReference,
    },
    ip: input.ip ?? null,
  });
  return row;
}

/**
 * Approves or rejects a recorded top-up or take-back. Four eyes: 409 `four_eyes` for the person
 * who recorded it (the database refuses it too). The approval posts the balance (idempotency key
 * `agent-topup:<id>`) with an outbox event; a take-back above the balance now is refused (409
 * `agent_balance_low`, nothing changes). The same decision again changes nothing; another one is
 * 409 `topup_already_decided`. Audited.
 */
export async function decideAgentTopup(
  tx: DbTransaction,
  input: {
    topupId: string;
    decision: 'approve' | 'reject';
    note?: string | null;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<{ topup: AgentTopup; changed: boolean }> {
  const [current] = await tx
    .select()
    .from(agentTopups)
    .where(eq(agentTopups.id, input.topupId))
    .for('update');
  if (!current) throw domainNotFound('Top-up');
  const target = input.decision === 'approve' ? 'approved' : 'rejected';
  if (current.status !== 'requested') {
    if (current.status === target) return { topup: current, changed: false };
    throw domainConflict('topup_already_decided', 'This was decided already.', {
      status: current.status,
    });
  }
  if (current.requestedBy === input.adminId) {
    throw domainConflict('four_eyes', 'Another person must approve or reject what you recorded.');
  }
  let ledgerTransactionId: string | null = null;
  if (input.decision === 'approve') {
    const agentAccount = agentBalanceAccount(current.agentId);
    try {
      const posting = await postTransaction(tx, {
        type: current.direction === 'in' ? 'agent_topup' : 'agent_take_back',
        idempotencyKey: `agent-topup:${current.id}`,
        refType: 'agent_topup',
        refId: current.id,
        description:
          current.direction === 'in'
            ? `Agent top-up (${current.method})`
            : `Agent take-back (${current.method})`,
        actor: { type: 'admin', id: input.adminId },
        createdAt: input.now,
        entries:
          current.direction === 'in'
            ? [
                { account: FUNDING, amount: -current.amount },
                { account: agentAccount, amount: current.amount },
              ]
            : [
                { account: agentAccount, amount: -current.amount },
                { account: FUNDING, amount: current.amount },
              ],
      });
      ledgerTransactionId = posting.transactionId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw balanceLow(error.available, current.amount);
      }
      throw error;
    }
  }
  const [topup] = await tx
    .update(agentTopups)
    .set({
      status: target,
      decidedBy: input.adminId,
      decidedAt: input.now,
      decisionNote: input.note?.trim() || null,
      ledgerTransactionId,
    })
    .where(and(eq(agentTopups.id, current.id), eq(agentTopups.status, 'requested')))
    .returning();
  if (!topup) throw new Error('top-up update returned no row');
  if (input.decision === 'approve') {
    await enqueueOutbox(tx, {
      type: AGENT_TOPUP_APPROVED,
      aggregateType: 'agent_topup',
      aggregateId: topup.id,
      payload: {
        topupId: topup.id,
        agentId: topup.agentId,
        direction: topup.direction,
        amount: topup.amount,
      },
    });
  }
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: input.decision === 'approve' ? AGENT_TOPUP_AUDIT.approved : AGENT_TOPUP_AUDIT.rejected,
    targetType: 'agent_topup',
    targetId: topup.id,
    metadata: {
      agentId: topup.agentId,
      direction: topup.direction,
      amount: topup.amount,
      note: topup.decisionNote,
    },
    ip: input.ip ?? null,
  });
  return { topup, changed: true };
}

export type AgentTopupRow = AgentTopup & { requestedByName: string; decidedByName: string | null };

/** An agent's top-ups and take-backs, newest first, with the names of the two people. */
export async function listAgentTopups(
  exec: DbExecutor,
  input: { agentId: string; limit: number },
): Promise<AgentTopupRow[]> {
  const requester = alias(adminUsers, 'topup_requester');
  const decider = alias(adminUsers, 'topup_decider');
  const rows = await exec
    .select({
      topup: agentTopups,
      requestedByName: requester.displayName,
      decidedByName: decider.displayName,
    })
    .from(agentTopups)
    .innerJoin(requester, eq(requester.id, agentTopups.requestedBy))
    .leftJoin(decider, eq(decider.id, agentTopups.decidedBy))
    .where(eq(agentTopups.agentId, input.agentId))
    .orderBy(desc(agentTopups.requestedAt), desc(agentTopups.id))
    .limit(input.limit);
  return rows.map((row) => ({
    ...row.topup,
    requestedByName: row.requestedByName,
    decidedByName: row.decidedByName ?? null,
  }));
}

/** Every agent's balance (agents without a balance account yet are absent: 0). */
export async function listAgentBalances(exec: DbExecutor): Promise<Map<string, bigint>> {
  const rows = await exec
    .select({ agentId: ledgerAccounts.agentId, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(isNotNull(ledgerAccounts.agentId));
  const balances = new Map<string, bigint>();
  for (const row of rows) if (row.agentId !== null) balances.set(row.agentId, row.balance);
  return balances;
}
