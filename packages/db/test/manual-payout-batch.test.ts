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
async function approvedPayout(approver: string): Promise<string> {
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
      rules: rules(),
    }),
  );
  approvedAtMinute += 1;
  await db.transaction((tx) =>
    approveWithdrawal(tx, { payoutId: payout.id, adminId: approver, now: at(approvedAtMinute) }),
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
    expect(results).toHaveLength(20);
    expect(results.filter((r) => r.claimed)).toHaveLength(18);
    for (const r of results.filter((x) => !x.claimed)) {
      expect(own).toContain(r.payoutId);
      expect(r.reason).toBe('manual_payout_approver_cannot_pay');
    }
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
    // A second batch finds nothing claimable except what the operator approved.
    const again = await claimManualPayoutBatch(db, { staffId: 'op-b', now: at(101), limit: 20 });
    expect(again.every((r) => !r.claimed)).toBe(true);
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
