import { eq } from 'drizzle-orm';
import type {
  AccountRef,
  DbTransaction,
  LedgerTransactionType,
  PostingEntry,
} from '../ledger/types';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';

/** Ledger idempotency key of a bet's stake (scoped by player, like every client key). */
export const stakeLedgerKey = (userId: string, idempotencyKey: string) =>
  `bet:${userId}:${idempotencyKey}`;
/** Ledger idempotency key of settlement number `version` of a bet. */
export const settlementLedgerKey = (betId: string, version: number) => `settle:${betId}:${version}`;
/** Ledger idempotency key of the reversal of settlement number `version`. */
export const reversalLedgerKey = (betId: string, version: number) => `reverse:${betId}:${version}`;
/** Ledger idempotency key of the refund of a bet rejected after the live delay. */
export const rejectionLedgerKey = (betId: string) => `reject:${betId}`;

const cash = (userId: string): AccountRef => ({ kind: 'player_cash', userId });

/** Stake: player_cash −stake, house_stakes +stake. */
export function stakeEntries(userId: string, stake: bigint): PostingEntry[] {
  return [
    { account: cash(userId), amount: -stake },
    { account: { kind: 'house_stakes' }, amount: stake },
  ];
}

/** Refund of a rejected (or all-void) bet: house_stakes −stake, player_cash +stake. */
export function refundEntries(userId: string, stake: bigint): PostingEntry[] {
  return [
    { account: { kind: 'house_stakes' }, amount: -stake },
    { account: cash(userId), amount: stake },
  ];
}

export interface SettlementAmounts {
  status: 'won' | 'lost' | 'void';
  /** Capped gross payout (return + bonus) of a won bet; the stake for a void bet; 0 when lost. */
  grossPayout: bigint;
  taxAmount: bigint;
  netPayout: bigint;
}

export interface SettlementPosting {
  type: Extract<LedgerTransactionType, 'bet_payout' | 'bet_refund'>;
  entries: PostingEntry[];
}

/**
 * The ledger posting that settles a bet (pure). Entries with a zero amount
 * are left out (postTransaction rejects them).
 * - won (`bet_payout`): player_cash +net, house_tax_payable +tax,
 *   house_stakes −stake, house_revenue −(gross − stake);
 * - lost (`bet_payout`): house_stakes −stake, house_revenue +stake. The lost
 *   stake is posted as a bet_payout of nothing to the player, so every
 *   settlement has the same type and reverses the same way; `adjustment`
 *   stays reserved for manual back-office corrections;
 * - void (`bet_refund`): house_stakes −stake, player_cash +stake.
 * Throws RangeError on amounts that do not add up.
 */
export function settlementPosting(
  userId: string,
  stake: bigint,
  settlement: SettlementAmounts,
): SettlementPosting {
  const { status, grossPayout, taxAmount, netPayout } = settlement;
  if (stake <= 0n) throw new RangeError('stake must be positive');
  if (grossPayout < 0n || taxAmount < 0n || netPayout < 0n) {
    throw new RangeError('settlement amounts must not be negative');
  }
  if (grossPayout !== netPayout + taxAmount) {
    throw new RangeError('gross payout must equal net payout plus tax');
  }
  switch (status) {
    case 'won': {
      if (grossPayout < stake) throw new RangeError('a won bet pays at least its stake');
      const entries: PostingEntry[] = [
        { account: cash(userId), amount: netPayout },
        { account: { kind: 'house_tax_payable' }, amount: taxAmount },
        { account: { kind: 'house_stakes' }, amount: -stake },
        { account: { kind: 'house_revenue' }, amount: -(grossPayout - stake) },
      ];
      return { type: 'bet_payout', entries: entries.filter((entry) => entry.amount !== 0n) };
    }
    case 'lost':
      if (grossPayout !== 0n) throw new RangeError('a lost bet pays nothing');
      return {
        type: 'bet_payout',
        entries: [
          { account: { kind: 'house_stakes' }, amount: -stake },
          { account: { kind: 'house_revenue' }, amount: stake },
        ],
      };
    case 'void':
      if (grossPayout !== stake || taxAmount !== 0n) {
        throw new RangeError('a void bet refunds exactly its stake');
      }
      return { type: 'bet_refund', entries: refundEntries(userId, stake) };
  }
}

/**
 * The entries of the ledger transaction with this idempotency key, as
 * AccountRefs (so they can be negated into a reversal), or null when there
 * is none.
 */
export async function loadPostingEntries(
  tx: DbTransaction,
  idempotencyKey: string,
): Promise<{ type: LedgerTransactionType; entries: PostingEntry[] } | null> {
  const rows = await tx
    .select({
      type: ledgerTransactions.type,
      kind: ledgerAccounts.kind,
      userId: ledgerAccounts.userId,
      provider: ledgerAccounts.provider,
      amount: ledgerEntries.amount,
    })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
    .orderBy(ledgerEntries.id);
  const [first] = rows;
  if (first === undefined) return null;
  const entries = rows.map((row): PostingEntry => {
    let account: AccountRef;
    if (row.kind === 'player_cash' || row.kind === 'player_bonus') {
      if (row.userId === null) throw new Error(`player account without a user (${idempotencyKey})`);
      account = { kind: row.kind, userId: row.userId };
    } else if (row.kind === 'house_psp_clearing') {
      if (row.provider === null)
        throw new Error(`PSP account without a provider (${idempotencyKey})`);
      account = { kind: row.kind, provider: row.provider };
    } else {
      account = { kind: row.kind };
    }
    return { account, amount: row.amount };
  });
  return { type: first.type, entries };
}

/** The exact negation of a posting's entries. */
export function negateEntries(entries: readonly PostingEntry[]): PostingEntry[] {
  return entries.map((entry) => ({ account: entry.account, amount: -entry.amount }));
}
