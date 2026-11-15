import { normalizePayoutDestination, payoutDestination, personNamesMatch } from '@vamos/core';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { DomainError, domainForbidden, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { lockUser } from '../rg/limits';
import { kycProfiles, users } from '../schema/accounts';
import { payoutAccounts } from '../schema/smsrail';

/**
 * Saved payout destinations for manual (SMS rail) payouts. A withdrawal
 * names one of these, never a typed account, and every one belongs to the
 * player (Vamos never pays a third party):
 * - a wallet (telebirr, M-PESA…) must be the player's registered phone,
 *   which was verified at sign-up, so it is verified at once;
 * - a bank account must carry the player's KYC-verified name and is
 *   confirmed by an OTP to the registered phone (bound to this account, so a
 *   code captured while adding one account cannot confirm another); the
 *   operator also confirms the bank shows that holder name before paying.
 */

export type PayoutAccount = typeof payoutAccounts.$inferSelect;

/** Active payout accounts per player. */
export const MAX_PAYOUT_ACCOUNTS = 5;

/** The OTP binding that confirms a payout account (otp_challenges.binding). */
export function payoutAccountOtpBinding(payoutAccountId: string): string {
  return `payout_account:${payoutAccountId}`;
}

async function verifiedHolder(
  exec: DbExecutor,
  userId: string,
): Promise<{ phone: string; verifiedName: string }> {
  const [user] = await exec
    .select({
      phone: users.phone,
      status: users.status,
      kycStatus: kycProfiles.status,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  if (user.status !== 'active') {
    throw domainForbidden('account_disabled', 'This account is disabled. Please contact support.', {
      status: user.status,
    });
  }
  const verifiedName = user.verifiedName?.trim() ?? '';
  if (user.kycStatus !== 'verified' || verifiedName.length === 0) {
    throw domainForbidden('kyc_required', 'Verify your identity before adding a payout account.', {
      kycStatus: user.kycStatus ?? 'unverified',
    });
  }
  return { phone: user.phone, verifiedName };
}

export interface AddPayoutAccountResult {
  account: PayoutAccount;
  /** false when this destination was saved already (nothing was written). */
  created: boolean;
  /** true while the account still needs its OTP (bank accounts). */
  needsOtp: boolean;
}

/**
 * Saves a payout account in the caller's transaction:
 * - 403 `kyc_required` / `account_disabled`;
 * - 422 `invalid_payout_account` for an unknown institution or an account
 *   that does not fit it (a phone for a wallet, an account number for a bank);
 * - 422 `payout_account_not_own` for a wallet number other than the
 *   registered phone;
 * - 422 `payout_account_name_mismatch` for a bank account whose holder
 *   name is not the KYC name;
 * - 422 `too_many_payout_accounts` past MAX_PAYOUT_ACCOUNTS.
 * Saving the same destination again returns it unchanged. Wallets are
 * verified at once; a bank account waits for verifyPayoutAccount (after
 * the OTP bound by payoutAccountOtpBinding).
 */
export async function addPayoutAccount(
  tx: DbTransaction,
  input: {
    userId: string;
    institution: string;
    account: string;
    accountName?: string;
    now: Date;
    ip?: string | null;
  },
): Promise<AddPayoutAccountResult> {
  const { userId, now } = input;
  await lockUser(tx, userId);
  const holder = await verifiedHolder(tx, userId);
  const normalized = normalizePayoutDestination(input.institution, input.account);
  if (normalized === null) {
    throw domainUnprocessable(
      'invalid_payout_account',
      'Check the bank or wallet and the account number.',
    );
  }
  const { destination, account } = normalized;
  let accountName: string;
  if (destination.accountKind === 'phone') {
    if (account !== holder.phone) {
      throw domainUnprocessable(
        'payout_account_not_own',
        'Wallet withdrawals are only paid to your registered phone number.',
      );
    }
    accountName = holder.verifiedName;
  } else {
    accountName = (input.accountName ?? '').trim().slice(0, 120);
    if (!personNamesMatch(accountName, holder.verifiedName)) {
      throw domainUnprocessable(
        'payout_account_name_mismatch',
        'The account holder must be you: enter the name on your ID as it appears on the account.',
      );
    }
  }

  const [existing] = await tx
    .select()
    .from(payoutAccounts)
    .where(
      and(
        eq(payoutAccounts.userId, userId),
        eq(payoutAccounts.institution, destination.id),
        eq(payoutAccounts.account, account),
        isNull(payoutAccounts.removedAt),
      ),
    )
    .limit(1);
  if (existing)
    return { account: existing, created: false, needsOtp: existing.verifiedAt === null };

  const [active] = await tx
    .select({ n: count() })
    .from(payoutAccounts)
    .where(and(eq(payoutAccounts.userId, userId), isNull(payoutAccounts.removedAt)));
  if ((active?.n ?? 0) >= MAX_PAYOUT_ACCOUNTS) {
    throw domainUnprocessable(
      'too_many_payout_accounts',
      `You can save up to ${MAX_PAYOUT_ACCOUNTS} payout accounts. Remove one first.`,
    );
  }

  const verifiedAt = destination.accountKind === 'phone' ? now : null;
  const [row] = await tx
    .insert(payoutAccounts)
    .values({
      userId,
      institution: destination.id,
      account,
      accountName,
      verifiedAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('payout account insert returned no row');
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: 'payment.payout_account_added',
    targetType: 'payout_account',
    targetId: row.id,
    metadata: {
      institution: row.institution,
      kind: destination.kind,
      verified: verifiedAt !== null,
    },
    ip: input.ip ?? null,
  });
  return { account: row, created: true, needsOtp: verifiedAt === null };
}

/**
 * Marks the player's payout account verified (call it inside the OTP's
 * consume transaction). Already verified: unchanged. 404 for another
 * player's or a removed account.
 */
export async function verifyPayoutAccount(
  tx: DbTransaction,
  input: { userId: string; payoutAccountId: string; now: Date; ip?: string | null },
): Promise<PayoutAccount> {
  const account = await getActivePayoutAccount(tx, input.userId, input.payoutAccountId);
  if (!account) throw domainNotFound('Payout account');
  if (account.verifiedAt !== null) return account;
  const [row] = await tx
    .update(payoutAccounts)
    .set({ verifiedAt: input.now, updatedAt: input.now })
    .where(eq(payoutAccounts.id, account.id))
    .returning();
  if (!row) throw new Error(`payout account ${account.id} vanished`);
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: 'payment.payout_account_verified',
    targetType: 'payout_account',
    targetId: row.id,
    metadata: { institution: row.institution },
    ip: input.ip ?? null,
  });
  return row;
}

/**
 * Removes one of the player's payout accounts. Payouts already requested
 * keep the destination they copied. Removing a removed account is a no-op
 * (404 for another player's).
 */
export async function removePayoutAccount(
  tx: DbTransaction,
  input: { userId: string; payoutAccountId: string; now: Date; ip?: string | null },
): Promise<void> {
  const account = await getActivePayoutAccount(tx, input.userId, input.payoutAccountId);
  if (!account) return;
  await tx
    .update(payoutAccounts)
    .set({ removedAt: input.now, updatedAt: input.now })
    .where(eq(payoutAccounts.id, account.id));
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: 'payment.payout_account_removed',
    targetType: 'payout_account',
    targetId: account.id,
    metadata: { institution: account.institution },
    ip: input.ip ?? null,
  });
}

/** One of the player's active payout accounts, or null. */
export async function getActivePayoutAccount(
  exec: DbExecutor,
  userId: string,
  payoutAccountId: string,
): Promise<PayoutAccount | null> {
  const [row] = await exec
    .select()
    .from(payoutAccounts)
    .where(
      and(
        eq(payoutAccounts.id, payoutAccountId),
        eq(payoutAccounts.userId, userId),
        isNull(payoutAccounts.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The player's active payout accounts, oldest first. */
export async function listPayoutAccounts(
  exec: DbExecutor,
  userId: string,
): Promise<PayoutAccount[]> {
  return exec
    .select()
    .from(payoutAccounts)
    .where(and(eq(payoutAccounts.userId, userId), isNull(payoutAccounts.removedAt)))
    .orderBy(asc(payoutAccounts.createdAt), asc(payoutAccounts.id));
}

/**
 * Makes sure the player's own wallet (their registered phone: telebirr for
 * an Ethio Telecom number, M-PESA for a Safaricom one) is saved, so the
 * common case needs no setup. Null when the player is not KYC-verified yet.
 */
export async function ensureOwnWalletPayoutAccount(
  tx: DbTransaction,
  input: { userId: string; now: Date },
): Promise<PayoutAccount | null> {
  const [user] = await tx
    .select({
      phone: users.phone,
      kycStatus: kycProfiles.status,
      verifiedName: kycProfiles.verifiedName,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user || user.kycStatus !== 'verified' || !user.verifiedName?.trim()) return null;
  const institution = user.phone.startsWith('+2517') ? 'mpesa' : 'telebirr';
  if (payoutDestination(institution) === null) return null;
  const existing = await tx
    .select()
    .from(payoutAccounts)
    .where(
      and(
        eq(payoutAccounts.userId, input.userId),
        eq(payoutAccounts.institution, institution),
        eq(payoutAccounts.account, user.phone),
        isNull(payoutAccounts.removedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  try {
    const result = await addPayoutAccount(tx, {
      userId: input.userId,
      institution,
      account: user.phone,
      now: input.now,
    });
    return result.account;
  } catch (error) {
    // Five accounts saved already: the player chose; leave it.
    if (error instanceof DomainError && error.code === 'too_many_payout_accounts') return null;
    throw error;
  }
}
