import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { accountKey, ensureAccount } from './accounts';
import { InsufficientFundsError, LedgerError, UnbalancedTransactionError } from './errors';
import type { AccountRef, DbTransaction, PostingInput, PostingResult } from './types';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

interface MergedEntry {
  key: string;
  ref: AccountRef;
  amount: bigint;
}

/**
 * Validates a posting and merges entries that hit the same account. Pure;
 * throws LedgerError / UnbalancedTransactionError.
 */
export function normalizePosting(input: PostingInput): MergedEntry[] {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new LedgerError('idempotency key is required');
  }
  if (input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new LedgerError(
      `idempotency key is longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (!Array.isArray(input.entries)) {
    throw new UnbalancedTransactionError('a ledger transaction needs entries');
  }

  const merged = new Map<string, MergedEntry>();
  for (const entry of input.entries) {
    if (typeof entry.amount !== 'bigint') {
      throw new LedgerError('ledger amounts must be bigint santim');
    }
    const key = accountKey(entry.account);
    const current = merged.get(key);
    if (current) {
      current.amount += entry.amount;
    } else {
      merged.set(key, { key, ref: entry.account, amount: entry.amount });
    }
  }

  const entries = [...merged.values()];
  for (const entry of entries) {
    if (entry.amount === 0n) {
      throw new LedgerError(`ledger entry for ${entry.key} has a zero amount`);
    }
  }
  if (entries.length < 2) {
    throw new UnbalancedTransactionError(
      `a ledger transaction needs at least 2 accounts (got ${entries.length})`,
    );
  }
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0n);
  if (total !== 0n) {
    throw new UnbalancedTransactionError(`ledger entries sum to ${total}, expected 0`);
  }
  return entries;
}

async function loadReplay(tx: DbTransaction, input: PostingInput): Promise<PostingResult> {
  const [existing] = await tx
    .select({ id: ledgerTransactions.id, type: ledgerTransactions.type })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    // The conflicting row was rolled back between our INSERT and SELECT; this
    // cannot happen under READ COMMITTED once ON CONFLICT has waited for it.
    throw new LedgerError(`idempotency key ${input.idempotencyKey} conflicted but was not found`);
  }
  if (existing.type !== input.type) {
    throw new LedgerError('idempotency key reused for a different transaction');
  }

  const rows = await tx
    .select({ key: ledgerAccounts.key, balanceAfter: ledgerEntries.balanceAfter })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerEntries.transactionId, existing.id))
    .orderBy(ledgerEntries.id);

  const balances: Record<string, bigint> = {};
  for (const row of rows) balances[row.key] = row.balanceAfter;
  return { transactionId: existing.id, created: false, balances };
}

/**
 * Posts one double-entry ledger transaction. Must run inside `db.transaction`
 * together with the business row and its outbox events. The posting itself
 * runs in a savepoint, so a thrown error (e.g. InsufficientFundsError) leaves
 * no partial ledger writes even if the caller catches it and carries on.
 *
 * Replaying an idempotency key returns the original transaction with
 * `created: false` and does not touch any balance.
 */
export async function postTransaction(
  tx: DbTransaction,
  input: PostingInput,
): Promise<PostingResult> {
  const entries = normalizePosting(input);

  return tx.transaction(async (sp) => {
    const [created] = await sp
      .insert(ledgerTransactions)
      .values({
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        description: input.description ?? null,
        actorType: input.actor?.type ?? 'system',
        actorId: input.actor?.id ?? null,
      })
      .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
      .returning({ id: ledgerTransactions.id });

    if (!created) return loadReplay(sp, input);

    // Create missing accounts in key order so concurrent first-time postings
    // contend on the unique index in a consistent order.
    const byKey = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const resolved: Array<MergedEntry & { id: string }> = [];
    for (const entry of byKey) {
      const account = await ensureAccount(sp, entry.ref);
      resolved.push({ ...entry, id: account.id });
    }

    // Lock (via the guarded UPDATE) in ascending account id order so that
    // postings touching the same accounts in any order cannot deadlock.
    resolved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const balances: Record<string, bigint> = {};
    const rows: Array<typeof ledgerEntries.$inferInsert> = [];
    for (const entry of resolved) {
      const [updated] = await sp
        .update(ledgerAccounts)
        .set({
          balance: sql`${ledgerAccounts.balance} + ${entry.amount}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(ledgerAccounts.id, entry.id),
            sql`(${ledgerAccounts.allowNegative} OR ${ledgerAccounts.balance} + ${entry.amount} >= 0)`,
          ),
        )
        .returning({ balance: ledgerAccounts.balance });

      if (!updated) {
        const [current] = await sp
          .select({ balance: ledgerAccounts.balance })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.id, entry.id));
        throw new InsufficientFundsError(entry.key, -entry.amount, current?.balance ?? 0n);
      }

      balances[entry.key] = updated.balance;
      rows.push({
        transactionId: created.id,
        accountId: entry.id,
        amount: entry.amount,
        balanceAfter: updated.balance,
      });
    }

    await sp.insert(ledgerEntries).values(rows);

    return { transactionId: created.id, created: true, balances };
  });
}

/** Thin wrapper over `db.transaction` for call sites that only need the ledger. */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
