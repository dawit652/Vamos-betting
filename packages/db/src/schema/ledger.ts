import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { actorType, ledgerAccountKind, ledgerOwnerType, ledgerTransactionType } from './enums';

/**
 * Double-entry ledger accounts. `balance` is a cache of SUM(ledger_entries.amount)
 * and is only ever changed in the same database transaction that inserts the
 * entries. `key` is the stable identity: 'user:<uuid>:cash', 'house:stakes',
 * 'house:psp:telebirr', …
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    ownerType: ledgerOwnerType('owner_type').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    kind: ledgerAccountKind('kind').notNull(),
    /** Payment provider for house_psp_clearing accounts. */
    provider: text('provider'),
    currency: text('currency').notNull().default('ETB'),
    balance: bigint('balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    allowNegative: boolean('allow_negative').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_accounts_user_idx').on(t.userId),
    check('ledger_accounts_non_negative', sql`${t.allowNegative} OR ${t.balance} >= 0`),
    check(
      'ledger_accounts_owner',
      sql`(${t.ownerType} = 'user' AND ${t.userId} IS NOT NULL) OR (${t.ownerType} = 'house' AND ${t.userId} IS NULL)`,
    ),
  ],
);

/** One business-level money movement. Its entries must sum to zero (enforced by a deferred trigger). */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: ledgerTransactionType('type').notNull(),
    /** What caused it, e.g. ('bet', <bet id>) or ('payment_intent', <id>). */
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    description: text('description'),
    actorType: actorType('actor_type').notNull().default('system'),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_transactions_ref_idx').on(t.refType, t.refId),
    // Postings of one kind of reference by time (the dashboard's bet settlements in a window).
    index('ledger_transactions_ref_created_idx').on(t.refType, t.createdAt),
    // Every posting of a business day (the regulator's daily summary).
    index('ledger_transactions_created_idx').on(t.createdAt),
  ],
);

/** Append-only entries (UPDATE/DELETE are rejected by a trigger). Positive = credit. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.accountId, t.id),
    index('ledger_entries_transaction_idx').on(t.transactionId),
    check('ledger_entries_non_zero', sql`${t.amount} <> 0`),
  ],
);
