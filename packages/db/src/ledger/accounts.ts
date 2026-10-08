import { eq } from 'drizzle-orm';
import { ledgerAccounts } from '../schema/ledger';
import { LedgerError } from './errors';
import type { AccountRef, DbExecutor, LedgerAccountKind } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^[a-z0-9_-]{2,32}$/;

const HOUSE_KEYS = {
  house_stakes: 'house:stakes',
  house_revenue: 'house:revenue',
  house_tax_payable: 'house:tax_payable',
  house_demo_funding: 'house:demo_funding',
  house_promotions: 'house:promotions',
  house_jackpot: 'house:jackpot',
} as const;

/**
 * Stable identity of a ledger account: 'user:<uuid>:cash', 'user:<uuid>:bonus',
 * 'house:stakes', …, 'house:psp:<provider>'. Throws LedgerError on a malformed
 * user id or provider name.
 */
export function accountKey(ref: AccountRef): string {
  switch (ref.kind) {
    case 'player_cash':
    case 'player_bonus': {
      if (typeof ref.userId !== 'string' || !UUID_RE.test(ref.userId)) {
        throw new LedgerError(`invalid user id for ledger account: ${String(ref.userId)}`);
      }
      const suffix = ref.kind === 'player_cash' ? 'cash' : 'bonus';
      return `user:${ref.userId.toLowerCase()}:${suffix}`;
    }
    case 'house_psp_clearing': {
      if (typeof ref.provider !== 'string' || !PROVIDER_RE.test(ref.provider)) {
        throw new LedgerError(`invalid payment provider name: ${String(ref.provider)}`);
      }
      return `house:psp:${ref.provider}`;
    }
    default: {
      const key = (HOUSE_KEYS as Record<string, string | undefined>)[ref.kind];
      if (key === undefined) {
        throw new LedgerError(`unknown ledger account kind: ${String((ref as AccountRef).kind)}`);
      }
      return key;
    }
  }
}

interface AccountAttributes {
  key: string;
  ownerType: 'user' | 'house';
  userId: string | null;
  kind: LedgerAccountKind;
  provider: string | null;
  allowNegative: boolean;
}

function accountAttributes(ref: AccountRef): AccountAttributes {
  const key = accountKey(ref);
  if (ref.kind === 'player_cash' || ref.kind === 'player_bonus') {
    return {
      key,
      ownerType: 'user',
      userId: ref.userId.toLowerCase(),
      kind: ref.kind,
      provider: null,
      allowNegative: false,
    };
  }
  return {
    key,
    ownerType: 'house',
    userId: null,
    kind: ref.kind,
    provider: ref.kind === 'house_psp_clearing' ? ref.provider : null,
    allowNegative: true,
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '23503') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Returns the account for `ref`, creating it on first use. House accounts may
 * go negative; player accounts may not. Safe under concurrency (the unique
 * key arbitrates; INSERT … ON CONFLICT DO NOTHING then SELECT).
 */
export async function ensureAccount(
  exec: DbExecutor,
  ref: AccountRef,
): Promise<{ id: string; key: string }> {
  const attrs = accountAttributes(ref);

  const [existing] = await exec
    .select({ id: ledgerAccounts.id, key: ledgerAccounts.key })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.key, attrs.key))
    .limit(1);
  if (existing) return existing;

  let inserted: { id: string; key: string } | undefined;
  try {
    [inserted] = await exec
      .insert(ledgerAccounts)
      .values(attrs)
      .onConflictDoNothing({ target: ledgerAccounts.key })
      .returning({ id: ledgerAccounts.id, key: ledgerAccounts.key });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new LedgerError(`cannot open ${attrs.key}: user does not exist`, { cause: error });
    }
    throw error;
  }
  if (inserted) return inserted;

  const [raced] = await exec
    .select({ id: ledgerAccounts.id, key: ledgerAccounts.key })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.key, attrs.key))
    .limit(1);
  if (!raced) {
    throw new LedgerError(`ledger account ${attrs.key} could not be created`);
  }
  return raced;
}
