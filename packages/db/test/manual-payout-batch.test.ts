import { birr } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import {
  addPayoutAccount,
  approveWithdrawal,
  claimManualPayoutBatch,
  getPayout,
  listIdleManualClaims,
  listManualPayoutQueue,
  requestWithdrawal,
} from '../src/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import {
  auditCount,
  createPlayer,
  depositViaMock,
  expectBooksBalanced,
  idemKey,
  NOW,
  rules,
} from './payments-fixtures';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
let approvedAtMinute = 10;

/** A manual payout approved by `approver`, each one a minute after the one before. */
async function approvedPayout(approver: string, options: { auto?: boolean } = {}): Promise<string> {
  const player = await createPlayer(db);
  await depositViaMock(db, player.userId, birr(9000));
  const wallet = await db.transaction((tx) =>
    addPayoutAccount(tx, {
      userId: player.userId,
      institution: 'telebirr',
      account: player.phone,
      now: NOW,
    }),
  );
  const { payout } = await db.transaction((tx) =>
    requestWithdrawal(tx, {
      userId: player.userId,
      amount: birr(6000),
      phone: player.phone,
      provider: 'sms',
      manual: true,
      payoutAccountId: wallet.account.id,
      idempotencyKey: idemKey('batch'),
      now: at(5),
      // Below the auto-approval limit the system approves it itself ('system:auto').
      rules: rules(options.auto === true ? { autoApproveBelow: birr(7000) } : {}),
    }),
  );
  approvedAtMinute += 1;
  if (options.auto !== true) {
    await db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: payout.id, adminId: approver, now: at(approvedAtMinute) }),
    );
  }
  return payout.id;
}

/** An approved payout of the mock provider: paid by the worker, never by hand. */
async function approvedProviderPayout(): Promise<string> {
  const player = await createPlayer(db);
  await depositViaMock(db, player.userId, birr(9000));
  const { payout } = await db.transaction((tx) =>
    requestWithdrawal(tx, {
      userId: player.userId,
      amount: birr(6000),
      phone: player.phone,
      provider: 'mock',
      idempotencyKey: idemKey('provider'),
      now: at(5),
      rules: rules({ autoApproveBelow: birr(7000) }),
    }),
  );
  return payout.id;
}

const statusOf = async (id: string) => (await getPayout(db, id))?.status;
const holderOf = async (id: string) => (await getPayout(db, id))?.payingBy;

describe('claiming manual payouts in a batch', () => {
  it('claims 18 of 20 and leaves the 2 the operator approved, every claim audited', async () => {
    const own: string[] = [];
    const others: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      // Two of them (the 3rd and the 12th) were approved by the claiming operator.
      const mine = i === 2 || i === 11;
      const id = await approvedPayout(mine ? 'op-b' : 'admin-a');
      (mine ? own : others).push(id);
    }
    const results = await claimManualPayoutBatch(db, {
      staffId: 'op-b',
      now: at(100),
      limit: 20,
    });
    // Without ids the operator's own approvals are not even tried.
    expect(results).toHaveLength(18);
    expect(results.every((r) => r.claimed)).toBe(true);
    // Asked for by id they are refused with the four-eyes code, and nothing is written.
    const asked = await claimManualPayoutBatch(db, { staffId: 'op-b', now: at(100), ids: own });
    expect(asked.map((r) => [r.claimed, r.reason])).toEqual([
      [false, 'manual_payout_approver_cannot_pay'],
      [false, 'manual_payout_approver_cannot_pay'],
    ]);
    for (const id of others) {
      expect(await statusOf(id)).toBe('processing');
      expect(await holderOf(id)).toBe('op-b');
      expect(await auditCount(db, id, 'payment.withdrawal_claimed')).toBe(1);
    }
    for (const id of own) {
      expect(await statusOf(id)).toBe('approved');
      expect(await holderOf(id)).toBeNull();
      expect(await auditCount(db, id, 'payment.withdrawal_claimed')).toBe(0);
    }
    // A second batch finds nothing: what is left is what the operator approved.
    const again = await claimManualPayoutBatch(db, { staffId: 'op-b', now: at(101), limit: 20 });
    expect(again).toEqual([]);
    // The idle-claim query sees exactly the claimed ones, once they are old enough.
    expect(await listIdleManualClaims(db, { claimedBefore: at(99) })).toHaveLength(0);
    const idle = await listIdleManualClaims(db, { claimedBefore: at(101) });
    expect(idle.map((c) => c.id).sort()).toEqual([...others].sort());
    await expectBooksBalanced(db);
  });

  it('takes the oldest approved payouts first and only as many as asked', async () => {
    // The two payouts the first test left approved are older than these.
    const leftovers = (await listManualPayoutQueue(db)).filter((p) => p.status === 'approved');
    expect(leftovers).toHaveLength(2);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await approvedPayout('admin-a'));
    const results = await claimManualPayoutBatch(db, { staffId: 'op-c', now: at(200), limit: 2 });
    expect(results.map((r) => r.payoutId)).toEqual(leftovers.map((p) => p.id));
    expect(results.every((r) => r.claimed)).toBe(true);
    for (const id of ids) expect(await statusOf(id)).toBe('approved');
  });

  it("is not starved by the operator's own approvals at the head of the queue", async () => {
    const own: string[] = [];
    for (let i = 0; i < 10; i += 1) own.push(await approvedPayout('op-s'));
    const others: string[] = [];
    for (let i = 0; i < 10; i += 1) others.push(await approvedPayout('admin-a'));
    const results = await claimManualPayoutBatch(db, { staffId: 'op-s', now: at(250), limit: 10 });
    // Older payouts that earlier tests left approved may come first; what matters is that the
    // operator's own ten at the head of the queue do not use up the batch.
    const claimed = results.filter((r) => r.claimed).map((r) => r.payoutId);
    expect(claimed).toHaveLength(10);
    expect(results).toHaveLength(10);
    for (const id of own) expect(claimed).not.toContain(id);
    for (const id of claimed) expect(await holderOf(id)).toBe('op-s');
    for (const id of own) expect(await statusOf(id)).toBe('approved');
    expect(others.filter((id) => claimed.includes(id)).length).toBeGreaterThan(0);
  });

  it('lets an operator claim what the system approved by itself', async () => {
    const auto = await approvedPayout('system:auto', { auto: true });
    expect((await getPayout(db, auto))?.approvedBy).toBe('system:auto');
    const results = await claimManualPayoutBatch(db, {
      staffId: 'op-g',
      now: at(260),
      ids: [auto],
    });
    expect(results).toEqual([{ payoutId: auto, claimed: true }]);
    expect(await holderOf(auto)).toBe('op-g');
  });

  it('refuses the id of a payout a provider pays, and leaves it as it was', async () => {
    const provider = await approvedProviderPayout();
    const before = await getPayout(db, provider);
    const results = await claimManualPayoutBatch(db, {
      staffId: 'op-h',
      now: at(270),
      ids: [provider],
    });
    expect(results).toEqual([
      { payoutId: provider, claimed: false, reason: 'not_a_manual_payout' },
    ]);
    expect(await getPayout(db, provider)).toEqual(before);
    expect(await auditCount(db, provider, 'payment.withdrawal_claimed')).toBe(0);
  });

  it('gives two operators asking at once work each, not one all and one none', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await approvedPayout('admin-a'));
    const [a, b] = await Promise.all([
      claimManualPayoutBatch(db, { staffId: 'op-i', now: at(280), limit: 5 }),
      claimManualPayoutBatch(db, { staffId: 'op-j', now: at(280), limit: 5 }),
    ]);
    // Each takes five; whoever loses a row to the other goes on to the next one.
    expect(a.filter((r) => r.claimed)).toHaveLength(5);
    expect(b.filter((r) => r.claimed)).toHaveLength(5);
    const taken = [...a, ...b].filter((r) => r.claimed).map((r) => r.payoutId);
    expect(new Set(taken).size).toBe(10);
    for (const r of a.filter((x) => x.claimed)) expect(await holderOf(r.payoutId)).toBe('op-i');
    for (const r of b.filter((x) => x.claimed)) expect(await holderOf(r.payoutId)).toBe('op-j');
    expect(ids.length).toBe(10);
  });

  it('claims exactly the given ids and reports each refusal with the single claim code', async () => {
    const free = await approvedPayout('admin-a');
    const taken = await approvedPayout('admin-a');
    await claimManualPayoutBatch(db, { staffId: 'op-d', now: at(300), ids: [taken] });
    const missing = '00000000-0000-4000-8000-000000000000';
    const results = await claimManualPayoutBatch(db, {
      staffId: 'op-c',
      now: at(301),
      ids: [taken, free, free, missing],
    });
    expect(results).toEqual([
      { payoutId: taken, claimed: false, reason: 'manual_payout_wrong_status' },
      { payoutId: free, claimed: true },
      { payoutId: missing, claimed: false, reason: 'not_found' },
    ]);
    expect(await holderOf(taken)).toBe('op-d');
    expect(await holderOf(free)).toBe('op-c');
  });

  it('never gives one payout to two operators claiming at the same moment', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await approvedPayout('admin-a'));
    const [first, second] = await Promise.all([
      claimManualPayoutBatch(db, { staffId: 'op-e', now: at(400), ids }),
      claimManualPayoutBatch(db, { staffId: 'op-f', now: at(400), ids }),
    ]);
    for (const id of ids) {
      const winners = [
        first.find((r) => r.payoutId === id)?.claimed === true ? 'op-e' : null,
        second.find((r) => r.payoutId === id)?.claimed === true ? 'op-f' : null,
      ].filter((w) => w !== null);
      expect(winners).toHaveLength(1);
      expect(await holderOf(id)).toBe(winners[0]);
      expect(await statusOf(id)).toBe('processing');
      // One claim, one audit line, one attempt.
      expect(await auditCount(db, id, 'payment.withdrawal_claimed')).toBe(1);
      expect((await getPayout(db, id))?.attempts).toBe(1);
    }
    const losses = [...first, ...second].filter((r) => !r.claimed);
    expect(losses).toHaveLength(ids.length);
    expect(losses.every((r) => r.reason === 'manual_payout_wrong_status')).toBe(true);
    // Racing without ids (the "claim next" button) never double-claims either.
    const more: string[] = [];
    for (let i = 0; i < 6; i += 1) more.push(await approvedPayout('admin-a'));
    await Promise.all([
      claimManualPayoutBatch(db, { staffId: 'op-e', now: at(401), limit: 20 }),
      claimManualPayoutBatch(db, { staffId: 'op-f', now: at(401), limit: 20 }),
    ]);
    for (const id of more) {
      expect(await statusOf(id)).toBe('processing');
      expect(await auditCount(db, id, 'payment.withdrawal_claimed')).toBe(1);
    }
    await expectBooksBalanced(db);
  });
});
