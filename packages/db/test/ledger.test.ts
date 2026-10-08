import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountKey,
  depositTotalSince,
  ensureAccount,
  getBalance,
  getPlayerBalances,
  InsufficientFundsError,
  LedgerError,
  listAccountEntries,
  netLossSince,
  postTransaction,
  sumPlayerFlows,
  UnbalancedTransactionError,
  withTransaction,
  type AccountRef,
  type PostingInput,
} from '../src/index';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import {
  bonus,
  cash,
  createUser,
  dropTestDatabase,
  errorText,
  fund,
  pgCode,
  sleep,
  uniqueKey,
} from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const stakes: AccountRef = { kind: 'house_stakes' };
const revenue: AccountRef = { kind: 'house_revenue' };

function stake(userId: string, amount: bigint, key = uniqueKey('stake')): PostingInput {
  return {
    type: 'bet_stake',
    idempotencyKey: key,
    refType: 'bet',
    refId: key,
    entries: [
      { account: cash(userId), amount: -amount },
      { account: stakes, amount },
    ],
  };
}

async function countRows(): Promise<{ transactions: number; entries: number }> {
  const result = await handle.db.execute<{ transactions: number; entries: number }>(sql`
    SELECT (SELECT count(*)::int FROM ledger_transactions) AS transactions,
           (SELECT count(*)::int FROM ledger_entries) AS entries`);
  return result.rows[0]!;
}

describe('accountKey', () => {
  const userId = '0b8f3c1e-8f7a-4d3b-9a51-2c4b6f8e9d10';

  it('builds stable keys for every account kind', () => {
    expect(accountKey({ kind: 'player_cash', userId })).toBe(`user:${userId}:cash`);
    expect(accountKey({ kind: 'player_bonus', userId })).toBe(`user:${userId}:bonus`);
    expect(accountKey({ kind: 'player_cash', userId: userId.toUpperCase() })).toBe(
      `user:${userId}:cash`,
    );
    expect(accountKey({ kind: 'house_stakes' })).toBe('house:stakes');
    expect(accountKey({ kind: 'house_revenue' })).toBe('house:revenue');
    expect(accountKey({ kind: 'house_tax_payable' })).toBe('house:tax_payable');
    expect(accountKey({ kind: 'house_demo_funding' })).toBe('house:demo_funding');
    expect(accountKey({ kind: 'house_promotions' })).toBe('house:promotions');
    expect(accountKey({ kind: 'house_jackpot' })).toBe('house:jackpot');
    expect(accountKey({ kind: 'house_psp_clearing', provider: 'telebirr' })).toBe(
      'house:psp:telebirr',
    );
  });

  it('rejects malformed user ids and provider names', () => {
    expect(() => accountKey({ kind: 'player_cash', userId: 'nope' })).toThrow(LedgerError);
    expect(() => accountKey({ kind: 'house_psp_clearing', provider: 'Tele Birr' })).toThrow(
      LedgerError,
    );
    expect(() => accountKey({ kind: 'house_psp_clearing', provider: 'x' })).toThrow(LedgerError);
    expect(() => accountKey({ kind: 'house_psp_clearing', provider: 'a'.repeat(33) })).toThrow(
      LedgerError,
    );
  });
});

describe('ensureAccount', () => {
  it('creates accounts once with the right attributes', async () => {
    const userId = await createUser(handle.db);
    const first = await ensureAccount(handle.db, cash(userId));
    const again = await ensureAccount(handle.db, cash(userId));
    expect(again).toEqual(first);
    expect(first.key).toBe(`user:${userId}:cash`);

    const psp = await ensureAccount(handle.db, { kind: 'house_psp_clearing', provider: 'chapa' });
    const rows = await handle.db
      .select()
      .from(ledgerAccounts)
      .where(sql`${ledgerAccounts.id} IN (${first.id}, ${psp.id})`);
    const player = rows.find((r) => r.id === first.id)!;
    const house = rows.find((r) => r.id === psp.id)!;
    expect(player).toMatchObject({
      ownerType: 'user',
      userId,
      kind: 'player_cash',
      provider: null,
      allowNegative: false,
      balance: 0n,
      currency: 'ETB',
    });
    expect(house).toMatchObject({
      key: 'house:psp:chapa',
      ownerType: 'house',
      userId: null,
      kind: 'house_psp_clearing',
      provider: 'chapa',
      allowNegative: true,
    });
  });

  it('is safe when many transactions open the same account at once', async () => {
    const userId = await createUser(handle.db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        handle.db.transaction((tx) => ensureAccount(tx, bonus(userId))),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it('refuses to open a player account for an unknown user', async () => {
    await expect(ensureAccount(handle.db, cash(randomUUID()))).rejects.toThrow(LedgerError);
  });
});

describe('postTransaction', () => {
  it('posts a balanced transaction and updates cached balances', async () => {
    const userId = await createUser(handle.db);
    const topup = await fund(handle.db, userId, 10_000n);
    expect(topup.created).toBe(true);
    expect(topup.balances[accountKey(cash(userId))]).toBe(10_000n);

    const result = await withTransaction(handle.db, (tx) =>
      postTransaction(tx, {
        ...stake(userId, 2_500n),
        description: 'Single on Saint George v Fasil Kenema',
        actor: { type: 'user', id: userId },
      }),
    );
    expect(result.created).toBe(true);
    expect(result.balances[accountKey(cash(userId))]).toBe(7_500n);
    expect(await getBalance(handle.db, cash(userId))).toBe(7_500n);
    expect(await getPlayerBalances(handle.db, userId)).toEqual({ cash: 7_500n, bonus: 0n });

    const [txRow] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, result.transactionId));
    expect(txRow).toMatchObject({
      type: 'bet_stake',
      actorType: 'user',
      actorId: userId,
      refType: 'bet',
      description: 'Single on Saint George v Fasil Kenema',
    });

    const entries = await handle.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, result.transactionId));
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, e) => sum + e.amount, 0n)).toBe(0n);
  });

  it('merges entries for the same account', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const result = await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'bet_stake',
        idempotencyKey: uniqueKey('merge'),
        entries: [
          { account: cash(userId), amount: -300n },
          { account: cash(userId), amount: -200n },
          { account: stakes, amount: 500n },
        ],
      }),
    );
    const entries = await handle.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, result.transactionId));
    expect(entries).toHaveLength(2);
    expect(result.balances[accountKey(cash(userId))]).toBe(500n);
  });

  it('keeps every transaction balanced and every cached balance reconciled', async () => {
    const unbalanced = await handle.db.execute(sql`
      SELECT transaction_id FROM ledger_entries
      GROUP BY transaction_id HAVING SUM(amount) <> 0 OR COUNT(*) < 2`);
    expect(unbalanced.rows).toHaveLength(0);

    const drift = await handle.db.execute(sql`
      SELECT a.key FROM ledger_accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.key, a.balance
      HAVING a.balance <> COALESCE(SUM(e.amount), 0)`);
    expect(drift.rows).toHaveLength(0);
  });

  it('rejects invalid postings before touching the database', async () => {
    const userId = await createUser(handle.db);
    const before = await countRows();
    const attempt = (input: PostingInput) =>
      handle.db.transaction((tx) => postTransaction(tx, input));

    await expect(
      attempt({
        type: 'adjustment',
        idempotencyKey: uniqueKey('bad'),
        entries: [
          { account: cash(userId), amount: 100n },
          { account: revenue, amount: -99n },
        ],
      }),
    ).rejects.toThrow(UnbalancedTransactionError);
    await expect(
      attempt({
        type: 'adjustment',
        idempotencyKey: uniqueKey('bad'),
        entries: [
          { account: revenue, amount: 100n },
          { account: revenue, amount: -100n },
        ],
      }),
    ).rejects.toThrow(LedgerError);
    await expect(
      attempt({ type: 'adjustment', idempotencyKey: uniqueKey('bad'), entries: [] }),
    ).rejects.toThrow(UnbalancedTransactionError);
    await expect(
      attempt({
        type: 'adjustment',
        idempotencyKey: uniqueKey('bad'),
        entries: [
          { account: cash(userId), amount: 0n },
          { account: revenue, amount: 0n },
        ],
      }),
    ).rejects.toThrow(/zero amount/);
    await expect(attempt({ ...stake(userId, 1n), idempotencyKey: '' })).rejects.toThrow(
      /idempotency key/,
    );
    await expect(
      attempt({ ...stake(userId, 1n), idempotencyKey: 'k'.repeat(201) }),
    ).rejects.toThrow(/idempotency key/);
    await expect(
      attempt({
        type: 'adjustment',
        idempotencyKey: uniqueKey('bad'),
        entries: [
          { account: cash(userId), amount: 1.5 as unknown as bigint },
          { account: revenue, amount: -1.5 as unknown as bigint },
        ],
      }),
    ).rejects.toThrow(/bigint/);

    expect(await countRows()).toEqual(before);
  });

  it('throws InsufficientFundsError and leaves no partial writes', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const stakesBefore = await getBalance(handle.db, stakes);
    const before = await countRows();
    const key = uniqueKey('too-much');

    const error = await handle.db
      .transaction((tx) => postTransaction(tx, stake(userId, 1_001n, key)))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({
      accountKey: accountKey(cash(userId)),
      amount: 1_001n,
      available: 1_000n,
    });

    expect(await getBalance(handle.db, cash(userId))).toBe(1_000n);
    expect(await getBalance(handle.db, stakes)).toBe(stakesBefore);
    expect(await countRows()).toEqual(before);
    const leftovers = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(leftovers).toHaveLength(0);
  });

  it('rolls back only the posting when the caller catches the error and commits', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 500n);
    const before = await countRows();

    const outcome = await handle.db.transaction(async (tx) => {
      try {
        await postTransaction(tx, stake(userId, 600n));
        return 'posted';
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
      }
      // The transaction is still usable and a smaller posting succeeds.
      await postTransaction(tx, stake(userId, 200n));
      return 'fallback';
    });

    expect(outcome).toBe('fallback');
    expect(await getBalance(handle.db, cash(userId))).toBe(300n);
    const after = await countRows();
    expect(after.transactions - before.transactions).toBe(1);
    expect(after.entries - before.entries).toBe(2);
  });

  it('allows house accounts to go negative', async () => {
    const result = await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'adjustment',
        idempotencyKey: uniqueKey('house'),
        entries: [
          { account: { kind: 'house_promotions' }, amount: -5_000n },
          { account: { kind: 'house_jackpot' }, amount: 5_000n },
        ],
      }),
    );
    expect(result.balances['house:promotions']).toBeLessThan(0n);
  });

  it('replays an idempotency key without posting twice', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const input = stake(userId, 400n);

    const first = await handle.db.transaction((tx) => postTransaction(tx, input));
    await handle.db.transaction((tx) => postTransaction(tx, stake(userId, 100n)));
    const replay = await handle.db.transaction((tx) => postTransaction(tx, input));

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.transactionId).toBe(first.transactionId);
    // Balances as of the original posting, not the current ones.
    expect(replay.balances).toEqual(first.balances);
    expect(replay.balances[accountKey(cash(userId))]).toBe(600n);
    expect(await getBalance(handle.db, cash(userId))).toBe(500n);

    const rows = await handle.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, first.transactionId));
    expect(rows).toHaveLength(2);
  });

  it('settles concurrent replays of one key exactly once', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const input = stake(userId, 250n);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => handle.db.transaction((tx) => postTransaction(tx, input))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await getBalance(handle.db, cash(userId))).toBe(750n);
  });

  it('rejects an idempotency key reused for a different transaction type', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const key = uniqueKey('reuse');
    await handle.db.transaction((tx) => postTransaction(tx, stake(userId, 100n, key)));

    await expect(
      handle.db.transaction((tx) =>
        postTransaction(tx, {
          type: 'bet_refund',
          idempotencyKey: key,
          entries: [
            { account: stakes, amount: -100n },
            { account: cash(userId), amount: 100n },
          ],
        }),
      ),
    ).rejects.toThrow('idempotency key reused for a different transaction');
    expect(await getBalance(handle.db, cash(userId))).toBe(900n);
  });

  it('lets exactly 20 of 50 concurrent 100-santim debits through a 2,000-santim balance', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 2_000n);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        handle.db.transaction((tx) => postTransaction(tx, stake(userId, 100n))),
      ),
    );

    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(20);
    expect(failed).toHaveLength(30);
    for (const failure of failed) {
      expect(failure.reason).toBeInstanceOf(InsufficientFundsError);
    }
    expect(await getBalance(handle.db, cash(userId))).toBe(0n);

    const account = await ensureAccount(handle.db, cash(userId));
    const history = await handle.db
      .select({ balanceAfter: ledgerEntries.balanceAfter })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(history).toHaveLength(21);
    expect(history.every((h) => h.balanceAfter >= 0n)).toBe(true);
  });

  it('does not deadlock when concurrent postings touch two accounts in opposite order', async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    await fund(handle.db, alice, 5_000n);
    await fund(handle.db, bob, 5_000n);

    const transfer = (from: string, to: string) =>
      handle.db.transaction(async (tx) => {
        const result = await postTransaction(tx, {
          type: 'adjustment',
          idempotencyKey: uniqueKey('swap'),
          entries: [
            { account: cash(from), amount: -10n },
            { account: cash(to), amount: 10n },
          ],
        });
        // Hold the row locks briefly so that transactions overlap.
        await tx.execute(sql`SELECT pg_sleep(0.005)`);
        return result;
      });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? transfer(alice, bob) : transfer(bob, alice),
      ),
    );
    const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(failures.map((f) => pgCode(f.reason) ?? errorText(f.reason))).toEqual([]);
    expect(await getBalance(handle.db, cash(alice))).toBe(5_000n);
    expect(await getBalance(handle.db, cash(bob))).toBe(5_000n);
  });
});

describe('database integrity triggers', () => {
  it('reject UPDATE and DELETE of ledger entries', async () => {
    const userId = await createUser(handle.db);
    const { transactionId } = await fund(handle.db, userId, 100n);

    const update = await handle.db
      .execute(
        sql`UPDATE ledger_entries SET amount = amount * 2 WHERE transaction_id = ${transactionId}`,
      )
      .catch((e: unknown) => e);
    expect(errorText(update)).toMatch(/append-only/);
    expect(pgCode(update)).toBe('23001');

    const del = await handle.db
      .execute(sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`)
      .catch((e: unknown) => e);
    expect(errorText(del)).toMatch(/append-only/);

    expect(await getBalance(handle.db, cash(userId))).toBe(100n);
  });

  it('reject unbalanced entries and stale cached balances at commit', async () => {
    const userId = await createUser(handle.db);
    const account = await ensureAccount(handle.db, cash(userId));
    const house = await ensureAccount(handle.db, revenue);

    const unbalanced = await handle.db
      .transaction(async (tx) => {
        const [row] = await tx
          .insert(ledgerTransactions)
          .values({ type: 'adjustment', idempotencyKey: uniqueKey('raw') })
          .returning({ id: ledgerTransactions.id });
        await tx.execute(
          sql`UPDATE ledger_accounts SET balance = balance + 100 WHERE id = ${account.id}`,
        );
        await tx.insert(ledgerEntries).values({
          transactionId: row!.id,
          accountId: account.id,
          amount: 100n,
          balanceAfter: 100n,
        });
      })
      .catch((e: unknown) => e);
    expect(errorText(unbalanced)).toMatch(/at least 2 are required|unbalanced/);

    const stale = await handle.db
      .transaction(async (tx) => {
        const [row] = await tx
          .insert(ledgerTransactions)
          .values({ type: 'adjustment', idempotencyKey: uniqueKey('raw') })
          .returning({ id: ledgerTransactions.id });
        // Entries are balanced but the cached balances were never updated.
        await tx.insert(ledgerEntries).values([
          { transactionId: row!.id, accountId: account.id, amount: 100n, balanceAfter: 100n },
          { transactionId: row!.id, accountId: house.id, amount: -100n, balanceAfter: -100n },
        ]);
      })
      .catch((e: unknown) => e);
    expect(errorText(stale)).toMatch(/cached balance/);
    expect(await getBalance(handle.db, cash(userId))).toBe(0n);
  });
});

describe('ledger queries', () => {
  it('returns 0n balances for accounts that were never opened', async () => {
    const userId = await createUser(handle.db);
    expect(await getBalance(handle.db, cash(userId))).toBe(0n);
    expect(await getPlayerBalances(handle.db, userId)).toEqual({ cash: 0n, bonus: 0n });
    expect(await listAccountEntries(handle.db, { account: cash(userId), limit: 10 })).toEqual([]);
  });

  it('lists account entries newest first with keyset paging', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 1_000n);
    const s1 = await handle.db.transaction((tx) => postTransaction(tx, stake(userId, 100n)));
    const s2 = await handle.db.transaction((tx) =>
      postTransaction(tx, { ...stake(userId, 200n), description: 'second' }),
    );

    const page1 = await listAccountEntries(handle.db, { account: cash(userId), limit: 2 });
    expect(page1.map((e) => e.transactionId)).toEqual([s2.transactionId, s1.transactionId]);
    expect(page1[0]).toMatchObject({
      type: 'bet_stake',
      amount: -200n,
      balanceAfter: 700n,
      refType: 'bet',
      description: 'second',
    });
    expect(typeof page1[0]!.entryId).toBe('bigint');
    expect(page1[0]!.createdAt).toBeInstanceOf(Date);

    const page2 = await listAccountEntries(handle.db, {
      account: cash(userId),
      limit: 2,
      beforeEntryId: page1[1]!.entryId,
    });
    expect(page2).toHaveLength(1);
    expect(page2[0]).toMatchObject({ type: 'demo_topup', amount: 1_000n, balanceAfter: 1_000n });

    await expect(
      listAccountEntries(handle.db, { account: cash(userId), limit: 0 }),
    ).rejects.toThrow(LedgerError);
  });

  it('sums player cash flows for net loss and deposit limits', async () => {
    const userId = await createUser(handle.db);
    const telebirr: AccountRef = { kind: 'house_psp_clearing', provider: 'telebirr' };
    const post = (input: PostingInput) => handle.db.transaction((tx) => postTransaction(tx, input));

    await post({
      type: 'deposit',
      idempotencyKey: uniqueKey('dep'),
      entries: [
        { account: telebirr, amount: -1_000n },
        { account: cash(userId), amount: 1_000n },
      ],
    });
    // A bonus credit must not count towards cash flows.
    await post({
      type: 'bonus',
      idempotencyKey: uniqueKey('bonus'),
      entries: [
        { account: { kind: 'house_promotions' }, amount: -500n },
        { account: bonus(userId), amount: 500n },
      ],
    });
    await post(stake(userId, 300n));
    // A bonus-funded stake does not touch cash.
    await post({
      type: 'bet_stake',
      idempotencyKey: uniqueKey('bstake'),
      entries: [
        { account: bonus(userId), amount: -200n },
        { account: stakes, amount: 200n },
      ],
    });

    await sleep(20);
    // Raw queries return timestamptz as text (drizzle leaves the mapping to columns).
    const nowRows = await handle.db.execute<{ now: string }>(sql`SELECT now()::text AS now`);
    const since = new Date(nowRows.rows[0]!.now);
    await sleep(20);

    await post({
      type: 'bet_payout',
      idempotencyKey: uniqueKey('payout'),
      entries: [
        { account: stakes, amount: -100n },
        { account: cash(userId), amount: 100n },
      ],
    });
    await post({
      type: 'deposit',
      idempotencyKey: uniqueKey('dep'),
      entries: [
        { account: telebirr, amount: -250n },
        { account: cash(userId), amount: 250n },
      ],
    });
    await post(stake(userId, 50n));

    const epoch = new Date(0);
    const future = new Date(Date.now() + 60_000);

    expect(await depositTotalSince(handle.db, userId, epoch)).toBe(1_250n);
    expect(await depositTotalSince(handle.db, userId, since)).toBe(250n);
    expect(await depositTotalSince(handle.db, userId, future)).toBe(0n);

    // Lost 300 + 50 in stakes, won back 100.
    expect(await netLossSince(handle.db, userId, epoch)).toBe(250n);
    // Since the midpoint: staked 50, won 100 -> net win of 50.
    expect(await netLossSince(handle.db, userId, since)).toBe(-50n);
    expect(await netLossSince(handle.db, userId, future)).toBe(0n);

    expect(await sumPlayerFlows(handle.db, { userId, since: epoch, types: ['bet_stake'] })).toBe(
      -350n,
    );
    expect(
      await sumPlayerFlows(handle.db, { userId, since: epoch, types: ['deposit', 'bet_payout'] }),
    ).toBe(1_350n);
    expect(await sumPlayerFlows(handle.db, { userId, since: epoch, types: [] })).toBe(0n);
    expect(await getPlayerBalances(handle.db, userId)).toEqual({ cash: 1_000n, bonus: 300n });
  });
});
