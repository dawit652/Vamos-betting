import type { AppConfig } from '@vamos/config';
import {
  WalletTransactionType,
  type WalletResponse,
  type WalletTransactionsResponse,
} from '@vamos/contracts';
import { CURRENCY, birr, formatBirr, maxSantim, toWire, type Santim } from '@vamos/core';
import {
  accountKey,
  enqueueOutbox,
  getPlayerBalances,
  listAccountEntries,
  postTransaction,
  writeAudit,
  type AccountRef,
  type DbExecutor,
} from '@vamos/db';
import { ledgerAccounts, ledgerEntries } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { assertCanGamble } from '../rg/guard';

/** Play money credited by a demo top-up when no amount is given (1,000 ETB). */
export const DEMO_TOPUP_DEFAULT: Santim = birr(1_000);
/** Smallest demo top-up (1 ETB). */
export const DEMO_TOPUP_MIN: Santim = birr(1);
/** Largest single demo top-up (5,000 ETB). */
export const DEMO_TOPUP_MAX: Santim = birr(5_000);
/** A demo top-up may not take the cash balance above this (20,000 ETB). */
export const DEMO_BALANCE_CAP: Santim = birr(20_000);

/** Largest ledger_entries.id (bigserial = int8). */
const MAX_ENTRY_ID = 9_223_372_036_854_775_807n;
const CURSOR_RE = /^[1-9]\d{0,18}$/;

const cashAccount = (userId: string): AccountRef => ({ kind: 'player_cash', userId });

/** Ledger idempotency key of a demo top-up: namespaced by player so keys cannot collide. */
export function demoTopUpLedgerKey(userId: string, idempotencyKey: string): string {
  return `demo_topup:${userId}:${idempotencyKey}`;
}

function walletBody(config: Pick<AppConfig, 'mode'>, cash: Santim, bonus: Santim): WalletResponse {
  return {
    currency: CURRENCY,
    demo: config.mode === 'demo',
    cash: toWire(cash),
    bonus: toWire(bonus),
  };
}

/** The player's cash and bonus balances. */
export async function getWallet(
  deps: Pick<AppDeps, 'config' | 'db'>,
  userId: string,
): Promise<WalletResponse> {
  const { cash, bonus } = await getPlayerBalances(deps.db, userId);
  return walletBody(deps.config, cash, bonus);
}

/**
 * Parses a transactions page cursor (a ledger entry id). Undefined stays
 * undefined; anything but a positive int8 is a 400 `invalid_cursor`.
 */
export function parseEntryCursor(cursor: string | undefined): bigint | undefined {
  if (cursor === undefined) return undefined;
  if (CURSOR_RE.test(cursor)) {
    const id = BigInt(cursor);
    if (id <= MAX_ENTRY_ID) return id;
  }
  throw badRequest(
    'invalid_cursor',
    'The page cursor is not valid. Start again from the first page.',
  );
}

/**
 * Statement of the player's cash account, newest first. `nextCursor` is the
 * id of the last returned entry when older entries exist, else null.
 */
export async function listWalletTransactions(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  page: { limit: number; cursor?: bigint },
): Promise<WalletTransactionsResponse> {
  const rows = await listAccountEntries(deps.db, {
    account: cashAccount(userId),
    // One extra row tells whether another page exists.
    limit: page.limit + 1,
    ...(page.cursor === undefined ? {} : { beforeEntryId: page.cursor }),
  });
  const items = rows.slice(0, page.limit).map((row) => ({
    id: row.entryId.toString(),
    type: playerType(row.type),
    amount: toWire(row.amount),
    balanceAfter: toWire(row.balanceAfter),
    refType: row.refType,
    refId: row.refId,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > page.limit && last !== undefined ? last.id : null,
  };
}

/**
 * A player's statement only ever has player movements; an agent's top-up or take-back
 * (agent-shops.md phase 2) posts to agent and house accounts, never to a player's.
 */
type WalletTransactionKind = (typeof WalletTransactionType.options)[number];
const PLAYER_TYPES: ReadonlySet<string> = new Set(WalletTransactionType.options);
function playerType(type: string): WalletTransactionKind {
  if (!PLAYER_TYPES.has(type)) throw new Error(`ledger type ${type} on a player account`);
  return type as WalletTransactionKind;
}

export interface DemoTopUpInput {
  userId: string;
  /** The client's Idempotency-Key header (already validated). */
  idempotencyKey: string;
  /** Santim; defaults to DEMO_TOPUP_DEFAULT. */
  amount?: Santim;
  ip?: string | null;
}

export interface DemoTopUpResult {
  wallet: WalletResponse;
  transactionId: string;
  /** True when the idempotency key had already been used (nothing was credited this time). */
  replayed: boolean;
}

/** Amount the given ledger transaction posted to one account (0n when it did not touch it). */
async function postedAmount(exec: DbExecutor, transactionId: string, key: string): Promise<Santim> {
  const rows = await exec
    .select({ amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerEntries.transactionId, transactionId), eq(ledgerAccounts.key, key)));
  return rows.reduce((sum, row) => sum + row.amount, 0n);
}

/**
 * Credits play money (demo mode only; 404 otherwise): house_demo_funding →
 * player_cash in one `demo_topup` ledger transaction, with its outbox event and
 * audit record. Refused for self-excluded / cooling-off players (403), for
 * amounts outside 1–5,000 ETB (400 `invalid_amount`) and when the cash balance
 * would exceed 20,000 ETB (409 `demo_balance_cap`).
 *
 * Idempotent per player and key: a replay credits nothing and returns the
 * original result (`cash` as it was right after the original top-up). Reusing
 * a key for a different amount is a 422 `idempotency_key_reused`.
 *
 * The cap is checked on the balance returned by the ledger's row-locking
 * UPDATE and a refusal rolls the whole transaction back, so concurrent
 * top-ups can never take the balance over the cap.
 */
export async function demoTopUp(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock'>,
  input: DemoTopUpInput,
): Promise<DemoTopUpResult> {
  if (deps.config.mode !== 'demo') {
    throw notFound('Demo top-up');
  }
  const amount = input.amount ?? DEMO_TOPUP_DEFAULT;
  if (amount < DEMO_TOPUP_MIN || amount > DEMO_TOPUP_MAX) {
    throw badRequest(
      'invalid_amount',
      `A demo top-up must be between ${formatBirr(DEMO_TOPUP_MIN, { currency: true })} and ${formatBirr(DEMO_TOPUP_MAX, { currency: true })}.`,
      { min: toWire(DEMO_TOPUP_MIN), max: toWire(DEMO_TOPUP_MAX) },
    );
  }

  const { userId } = input;
  const now = deps.clock();
  const cash = cashAccount(userId);
  const cashKey = accountKey(cash);

  return deps.db.transaction(async (tx) => {
    await assertCanGamble(tx, userId, now);

    const posting = await postTransaction(tx, {
      type: 'demo_topup',
      idempotencyKey: demoTopUpLedgerKey(userId, input.idempotencyKey),
      description: 'Demo top-up (play money)',
      actor: { type: 'user', id: userId },
      entries: [
        { account: { kind: 'house_demo_funding' }, amount: -amount },
        { account: cash, amount },
      ],
    });
    const cashAfter = posting.balances[cashKey];
    if (cashAfter === undefined) {
      throw new Error(`demo top-up ${posting.transactionId} has no entry for ${cashKey}`);
    }

    if (posting.created) {
      if (cashAfter > DEMO_BALANCE_CAP) {
        const balance = cashAfter - amount;
        // Throwing rolls back the posting together with the rest of the transaction.
        throw conflict(
          'demo_balance_cap',
          `Demo balances are capped at ${formatBirr(DEMO_BALANCE_CAP, { currency: true })}.`,
          {
            cap: toWire(DEMO_BALANCE_CAP),
            balance: toWire(balance),
            maxTopUp: toWire(maxSantim(DEMO_BALANCE_CAP - balance, 0n)),
          },
        );
      }
      await enqueueOutbox(tx, {
        type: 'wallet.demo_topup',
        aggregateType: 'user',
        aggregateId: userId,
        payload: {
          userId,
          transactionId: posting.transactionId,
          amount,
          balanceAfter: cashAfter,
        },
      });
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'wallet.demo_topup',
        targetType: 'ledger_transaction',
        targetId: posting.transactionId,
        metadata: { amount, balanceAfter: cashAfter },
        ip: input.ip ?? null,
      });
    } else {
      const original = await postedAmount(tx, posting.transactionId, cashKey);
      if (original !== amount) {
        throw unprocessable(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a top-up of a different amount.',
          { amount: toWire(original) },
        );
      }
    }

    const { bonus } = await getPlayerBalances(tx, userId);
    return {
      wallet: walletBody(deps.config, cashAfter, bonus),
      transactionId: posting.transactionId,
      replayed: !posting.created,
    };
  });
}
