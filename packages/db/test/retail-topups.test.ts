import { randomUUID } from 'node:crypto';
import { birr, businessDateOf } from '@vamos/core';
import fc from 'fast-check';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReconciliationChecks } from '../src/compliance/index';
import { DomainError } from '../src/errors';
import { getBalance } from '../src/ledger/index';
import {
  AGENT_TOPUP_APPROVED,
  createAgent,
  decideAgentTopup,
  getAgentBalance,
  listAgentTopups,
  recordAgentTopup,
} from '../src/retail/index';
import { adminUsers, agents, ledgerAccounts, outboxEvents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { NOW } from './payments-fixtures';

/** Agent balance top-ups and take-backs (docs/plans/agent-shops.md, phase 2). */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let recorder: string;
let approver: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  recorder = await staff('admin');
  approver = await staff('finance');
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: 'admin' | 'finance'): Promise<string> {
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `${role}-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `Test ${role}`,
      role,
    })
    .returning({ id: adminUsers.id });
  return row!.id;
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

const newAgent = (name: string) =>
  handle.db.transaction((tx) =>
    createAgent(tx, {
      name,
      ownerName: 'Owner Name',
      ownerPhone: '0911223344',
      commissionKind: 'ggr',
      commissionBps: 1_000,
      adminId: recorder,
      now: NOW,
    }),
  );

const record = (
  agentId: string,
  direction: 'in' | 'out',
  amount: bigint,
  options: { method?: 'cash' | 'bank'; bankReference?: string } = {},
) =>
  handle.db.transaction((tx) =>
    recordAgentTopup(tx, {
      agentId,
      direction,
      amount,
      method: options.method ?? 'cash',
      ...(options.bankReference === undefined ? {} : { bankReference: options.bankReference }),
      adminId: recorder,
      now: NOW,
    }),
  );

const decide = (topupId: string, decision: 'approve' | 'reject', adminId = approver) =>
  handle.db.transaction((tx) => decideAgentTopup(tx, { topupId, decision, adminId, now: NOW }));

async function ledgerTotal(): Promise<bigint> {
  const [row] = await handle.db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
    .from(ledgerAccounts);
  return BigInt(row?.total ?? '0');
}

describe('agent top-ups', () => {
  it('a top-up credits the balance only once a second person approves it', async () => {
    const agent = await newAgent('Topup Bets');
    const topup = await record(agent.id, 'in', birr(5_000));
    expect(topup).toMatchObject({ status: 'requested', direction: 'in', method: 'cash' });
    expect(await getAgentBalance(handle.db, agent.id)).toBe(0n);

    // Four eyes: the recorder cannot approve.
    expect(await refusal(decide(topup.id, 'approve', recorder))).toEqual({
      status: 409,
      code: 'four_eyes',
    });
    const approved = await decide(topup.id, 'approve');
    expect(approved).toMatchObject({ changed: true, topup: { status: 'approved' } });
    expect(approved.topup.ledgerTransactionId).not.toBeNull();
    expect(await getAgentBalance(handle.db, agent.id)).toBe(birr(5_000));
    expect(await getBalance(handle.db, { kind: 'house_agent_funding' })).toBe(
      -(await getAgentBalanceSum()),
    );
    expect(await ledgerTotal()).toBe(0n);

    // Approving again changes nothing; rejecting now is refused.
    expect((await decide(topup.id, 'approve')).changed).toBe(false);
    expect(await getAgentBalance(handle.db, agent.id)).toBe(birr(5_000));
    expect(await refusal(decide(topup.id, 'reject'))).toEqual({
      status: 409,
      code: 'topup_already_decided',
    });
    const events = await handle.db
      .select({ type: outboxEvents.type })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, topup.id));
    expect(events.map((e) => e.type)).toEqual([AGENT_TOPUP_APPROVED]);
    const listed = await listAgentTopups(handle.db, { agentId: agent.id, limit: 10 });
    expect(listed[0]).toMatchObject({
      id: topup.id,
      requestedByName: 'Test admin',
      decidedByName: 'Test finance',
    });
  });

  it('a rejected one posts nothing; a bank transfer needs its reference, used once', async () => {
    const agent = await newAgent('Bank Bets');
    const rejected = await record(agent.id, 'in', birr(1_000));
    expect((await decide(rejected.id, 'reject')).topup.status).toBe('rejected');
    expect(await getAgentBalance(handle.db, agent.id)).toBe(0n);

    await expect(record(agent.id, 'in', birr(1_000), { method: 'bank' })).rejects.toBeInstanceOf(
      RangeError,
    );
    const reference = `TT${randomUUID().slice(0, 8)}`;
    const bank = await record(agent.id, 'in', birr(2_000), {
      method: 'bank',
      bankReference: reference,
    });
    expect(
      await refusal(
        record(agent.id, 'in', birr(2_000), { method: 'bank', bankReference: reference }),
      ),
    ).toEqual({ status: 409, code: 'bank_reference_used' });
    // Once that one is rejected, the reference may be recorded again (a corrected amount).
    await decide(bank.id, 'reject');
    expect(
      (await record(agent.id, 'in', birr(2_500), { method: 'bank', bankReference: reference }))
        .status,
    ).toBe('requested');
  });

  it('a take-back never takes the balance below zero', async () => {
    const agent = await newAgent('Take Back Bets');
    await decide((await record(agent.id, 'in', birr(3_000))).id, 'approve');
    expect(await refusal(record(agent.id, 'out', birr(3_001)))).toEqual({
      status: 409,
      code: 'agent_balance_low',
    });
    const first = await record(agent.id, 'out', birr(2_000));
    const second = await record(agent.id, 'out', birr(2_000));
    await decide(first.id, 'approve');
    expect(await getAgentBalance(handle.db, agent.id)).toBe(birr(1_000));
    // The second was fine when recorded; the balance is too low now: refused, nothing changes.
    expect(await refusal(decide(second.id, 'approve'))).toEqual({
      status: 409,
      code: 'agent_balance_low',
    });
    expect(await getAgentBalance(handle.db, agent.id)).toBe(birr(1_000));
    expect((await handle.db.select().from(agents).where(eq(agents.id, agent.id)))[0]?.status).toBe(
      'active',
    );
    expect(await ledgerTotal()).toBe(0n);
  });

  it('Nahubet HQ has no balance', async () => {
    const [hq] = await handle.db.select().from(agents).where(eq(agents.isHouse, true));
    expect(await refusal(record(hq!.id, 'in', birr(100)))).toEqual({
      status: 409,
      code: 'agent_is_house',
    });
  });

  it('any order of approved top-ups and take-backs keeps the balance at their sum, never below zero', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ out: fc.boolean(), birr: fc.integer({ min: 1, max: 500 }) }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (steps) => {
          const agent = await newAgent(`Prop ${randomUUID().slice(0, 8)}`);
          let expected = 0n;
          for (const step of steps) {
            const amount = birr(step.birr);
            if (step.out && amount > expected) {
              expect((await refusal(record(agent.id, 'out', amount))).code).toBe(
                'agent_balance_low',
              );
              continue;
            }
            const topup = await record(agent.id, step.out ? 'out' : 'in', amount);
            await decide(topup.id, 'approve');
            expected += step.out ? -amount : amount;
            const balance = await getAgentBalance(handle.db, agent.id);
            expect(balance).toBe(expected);
            expect(balance >= 0n).toBe(true);
          }
        },
      ),
      { numRuns: 12 },
    );
    expect(await ledgerTotal()).toBe(0n);
  });
});

describe('reconciliation', () => {
  it('is clean after a day of agent top-ups and take-backs', async () => {
    const result = await runReconciliationChecks(handle.db, {
      businessDate: businessDateOf(NOW),
      balanceAfterGraceMs: 0,
    });
    expect(result.mismatches).toEqual([]);
  });
});

async function getAgentBalanceSum(): Promise<bigint> {
  const [row] = await handle.db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
    .from(ledgerAccounts)
    .where(sql`${ledgerAccounts.kind}::text = 'agent_balance'`);
  return BigInt(row?.total ?? '0');
}
