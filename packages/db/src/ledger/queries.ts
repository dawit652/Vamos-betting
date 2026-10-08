import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { accountKey } from './accounts';
import { LedgerError } from './errors';
import type { AccountEntry, AccountRef, DbExecutor, LedgerTransactionType } from './types';

const MAX_PAGE_SIZE = 500;

/** Transaction types that make up a player's betting result (stakes in, winnings out). */
export const BETTING_FLOW_TYPES = [
  'bet_stake',
  'bet_payout',
  'bet_refund',
  'bet_cashout',
  'settlement_reversal',
  'jackpot_entry',
  'jackpot_prize',
] as const satisfies readonly LedgerTransactionType[];

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
  return 0n;
}

/** Cached balance of an account; 0n when the account has not been opened yet. */
export async function getBalance(exec: DbExecutor, ref: AccountRef): Promise<bigint> {
  const [row] = await exec
    .select({ balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.key, accountKey(ref)))
    .limit(1);
  return row?.balance ?? 0n;
}

/** Cash (withdrawable) and bonus balances of a player. */
export async function getPlayerBalances(
  exec: DbExecutor,
  userId: string,
): Promise<{ cash: bigint; bonus: bigint }> {
  const cashKey = accountKey({ kind: 'player_cash', userId });
  const bonusKey = accountKey({ kind: 'player_bonus', userId });
  const rows = await exec
    .select({ key: ledgerAccounts.key, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.key, [cashKey, bonusKey]));
  let cash = 0n;
  let bonus = 0n;
  for (const row of rows) {
    if (row.key === cashKey) cash = row.balance;
    else if (row.key === bonusKey) bonus = row.balance;
  }
  return { cash, bonus };
}

/**
 * Statement lines of one account, newest first. Page with `beforeEntryId`
 * (the smallest entryId of the previous page).
 */
export async function listAccountEntries(
  exec: DbExecutor,
  options: { account: AccountRef; limit: number; beforeEntryId?: bigint },
): Promise<AccountEntry[]> {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new LedgerError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  const key = accountKey(options.account);

  const conditions: SQL[] = [eq(ledgerAccounts.key, key)];
  if (options.beforeEntryId !== undefined) {
    conditions.push(lt(ledgerEntries.id, options.beforeEntryId));
  }

  return exec
    .select({
      entryId: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      type: ledgerTransactions.type,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
      refType: ledgerTransactions.refType,
      refId: ledgerTransactions.refId,
      description: ledgerTransactions.description,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(and(...conditions))
    .orderBy(desc(ledgerEntries.id))
    .limit(limit);
}

/**
 * Signed sum (santim) of the player's cash-account entries for transactions of
 * the given types created at or after `since`. Credits are positive.
 */
export async function sumPlayerFlows(
  exec: DbExecutor,
  options: { userId: string; since: Date; types: readonly LedgerTransactionType[] },
): Promise<bigint> {
  if (options.types.length === 0) return 0n;
  const key = accountKey({ kind: 'player_cash', userId: options.userId });

  const [row] = await exec
    .select({ total: sql<bigint | string>`COALESCE(SUM(${ledgerEntries.amount}), 0)::bigint` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerAccounts.key, key),
        inArray(ledgerTransactions.type, [...options.types]),
        gte(ledgerTransactions.createdAt, options.since),
      ),
    );
  return toBigInt(row?.total);
}

/**
 * Net betting loss of the player's cash account since `since` (positive =
 * money lost, negative = net winnings). Used for responsible-gambling loss limits.
 */
export async function netLossSince(exec: DbExecutor, userId: string, since: Date): Promise<bigint> {
  const net = await sumPlayerFlows(exec, { userId, since, types: BETTING_FLOW_TYPES });
  return -net;
}

/** Total deposited into the player's cash account since `since` (santim). */
export async function depositTotalSince(
  exec: DbExecutor,
  userId: string,
  since: Date,
): Promise<bigint> {
  return sumPlayerFlows(exec, { userId, since, types: ['deposit'] });
}
