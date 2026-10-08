import type { Database } from '../client';
import type { actorType, ledgerAccountKind, ledgerTransactionType } from '../schema/enums';

/** The `tx` handed to the callback of `db.transaction(...)`. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run a query: the pooled database or an open transaction. */
export type DbExecutor = Database | DbTransaction;

export type LedgerAccountKind = (typeof ledgerAccountKind.enumValues)[number];
export type LedgerTransactionType = (typeof ledgerTransactionType.enumValues)[number];
export type ActorType = (typeof actorType.enumValues)[number];

export type HouseAccountKind =
  | 'house_stakes'
  | 'house_revenue'
  | 'house_tax_payable'
  | 'house_demo_funding'
  | 'house_promotions'
  | 'house_jackpot';

/** Identifies a ledger account independently of its database id. */
export type AccountRef =
  | { kind: 'player_cash' | 'player_bonus'; userId: string }
  | { kind: HouseAccountKind }
  | { kind: 'house_psp_clearing'; provider: string };

export interface PostingEntry {
  account: AccountRef;
  /** Santim. Positive = credit (increases the balance), negative = debit. */
  amount: bigint;
}

export interface PostingInput {
  type: LedgerTransactionType;
  /** Unique per business operation (max 200 characters). Replays return the original posting. */
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  description?: string;
  actor?: { type: ActorType; id?: string };
  entries: PostingEntry[];
}

export interface PostingResult {
  transactionId: string;
  /** false when the idempotency key had already been posted (nothing changed). */
  created: boolean;
  /**
   * accountKey -> balance after this transaction. For replays these are the
   * `balance_after` values stored on the original transaction's entries.
   */
  balances: Record<string, bigint>;
}

export interface AccountEntry {
  entryId: bigint;
  transactionId: string;
  type: LedgerTransactionType;
  amount: bigint;
  balanceAfter: bigint;
  refType: string | null;
  refId: string | null;
  description: string | null;
  createdAt: Date;
}
