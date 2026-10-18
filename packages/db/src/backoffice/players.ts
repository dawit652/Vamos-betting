import { DEFAULT_RESPONSIBLE_GAMBLING, isOfAge, normalizeEthiopianMsisdn } from '@vamos/core';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import { accountKey } from '../ledger/accounts';
import { listAccountEntries } from '../ledger/queries';
import type { AccountEntry, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { getRemainingWagering } from '../payments/wagering';
import { getActiveExclusion, type ActiveExclusion } from '../rg/exclusions';
import { getLimitStates, type LimitShape, type LimitSlotState } from '../rg/limits';
import { kycProfiles, rgExclusions, users } from '../schema/accounts';
import { bets } from '../schema/betting';
import { ledgerAccounts } from '../schema/ledger';
import { paymentIntents, payouts } from '../schema/payments';
import type { kycStatus, userStatus } from '../schema/enums';
import { loadGameSettings } from '../settings/index';
import {
  afterCursor,
  cursorTime,
  decodeCursor,
  encodeCursor,
  pageLimit,
  type Page,
  type StaffActor,
} from './common';

/**
 * Players and the KYC review queue in the back office (users.view,
 * kyc.review). Reads only, except reviewKyc, which records the staff
 * member in the audit log in the caller's transaction.
 */

export type PlayerStatus = (typeof userStatus.enumValues)[number];
export type KycStatus = (typeof kycStatus.enumValues)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A player in the back-office search. */
export interface PlayerSummary {
  id: string;
  phone: string;
  fullName: string | null;
  status: PlayerStatus;
  kycStatus: KycStatus;
  createdAt: Date;
  /** Santim. */
  cash: bigint;
  bonus: bigint;
}

export interface PlayerFilter {
  /** A phone number (any form, or its last digits), a name, or a user id. */
  q?: string;
  status?: PlayerStatus;
  kycStatus?: KycStatus;
  limit?: number;
  cursor?: string;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Cash and bonus balances of the given players (0 when an account was never opened). */
async function balancesOf(
  exec: DbExecutor,
  userIds: readonly string[],
): Promise<Map<string, { cash: bigint; bonus: bigint }>> {
  const result = new Map<string, { cash: bigint; bonus: bigint }>();
  for (const id of userIds) result.set(id, { cash: 0n, bonus: 0n });
  if (userIds.length === 0) return result;
  const keys = userIds.flatMap((userId) => [
    accountKey({ kind: 'player_cash', userId }),
    accountKey({ kind: 'player_bonus', userId }),
  ]);
  const rows = await exec
    .select({
      userId: ledgerAccounts.userId,
      kind: ledgerAccounts.kind,
      balance: ledgerAccounts.balance,
    })
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.key, keys));
  for (const row of rows) {
    if (row.userId === null) continue;
    const entry = result.get(row.userId);
    if (entry === undefined) continue;
    if (row.kind === 'player_cash') entry.cash = row.balance;
    else if (row.kind === 'player_bonus') entry.bonus = row.balance;
  }
  return result;
}

/** Players, newest first (cursor paging), with their KYC status and balances. */
export async function searchPlayers(
  exec: DbExecutor,
  filter: PlayerFilter = {},
): Promise<Page<PlayerSummary>> {
  const limit = pageLimit(filter.limit, 25, 100);
  const conditions: SQL[] = [];
  const q = filter.q?.trim();
  if (q !== undefined && q.length > 0) {
    if (UUID_RE.test(q)) {
      conditions.push(eq(users.id, q.toLowerCase()));
    } else {
      const msisdn = normalizeEthiopianMsisdn(q);
      const digits = q.replace(/[\s()+-]/g, '');
      const options: SQL[] = [ilike(users.fullName, likePattern(q))];
      if (msisdn !== null) options.push(eq(users.phone, msisdn));
      if (/^\d{4,12}$/.test(digits)) options.push(ilike(users.phone, likePattern(digits)));
      conditions.push(or(...options)!);
    }
  }
  if (filter.status !== undefined) conditions.push(eq(users.status, filter.status));
  if (filter.kycStatus !== undefined) {
    conditions.push(
      filter.kycStatus === 'unverified'
        ? sql`COALESCE(${kycProfiles.status}, 'unverified') = 'unverified'`
        : eq(kycProfiles.status, filter.kycStatus),
    );
  }
  if (filter.cursor !== undefined) {
    conditions.push(afterCursor(users.createdAt, users.id, decodeCursor(filter.cursor), 'desc'));
  }
  const rows = await exec
    .select({
      cursorAt: cursorTime(users.createdAt),
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      status: users.status,
      kycStatus: sql<KycStatus>`COALESCE(${kycProfiles.status}, 'unverified')`,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const balances = await balancesOf(
    exec,
    page.map((row) => row.id),
  );
  const last = page.at(-1);
  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => ({
      ...row,
      cash: balances.get(row.id)?.cash ?? 0n,
      bonus: balances.get(row.id)?.bonus ?? 0n,
    })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.cursorAt, id: last.id })
        : null,
  };
}

/** A player's KYC profile as staff see it (never the ID number or its hash). */
export interface StaffKycView {
  status: KycStatus;
  provider: string | null;
  idNumberLast4: string | null;
  verifiedName: string | null;
  verifiedDateOfBirth: string | null;
  providerReference: string | null;
  rejectionReason: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}

export interface PlayerExclusionView {
  kind: 'cool_off' | 'self_exclusion';
  startsAt: Date;
  endsAt: Date | null;
  reason: string | null;
  createdAt: Date;
}

export interface PlayerBetSummary {
  id: string;
  shortId: string;
  betType: 'single' | 'multi';
  status: string;
  stake: bigint;
  totalOddsMilli: bigint;
  potentialNetPayout: bigint;
  settledNetPayout: bigint | null;
  placedAt: Date;
  settledAt: Date | null;
}

export interface PlayerPaymentSummary {
  id: string;
  kind: 'deposit' | 'withdrawal';
  provider: string;
  amount: bigint;
  status: string;
  flagged: boolean;
  createdAt: Date;
  completedAt: Date | null;
}

export interface PlayerDetail {
  id: string;
  phone: string;
  fullName: string | null;
  dateOfBirth: string;
  locale: string;
  status: PlayerStatus;
  phoneVerifiedAt: Date | null;
  termsAcceptedAt: Date;
  createdAt: Date;
  balances: { cash: bigint; bonus: bigint };
  kyc: StaffKycView;
  /** Responsible-gambling limits: in force and requested raises (santim). */
  limits: LimitShape<LimitSlotState>;
  /** The exclusion in force now, if any, and every exclusion (newest first). */
  activeExclusion: ActiveExclusion | null;
  exclusions: PlayerExclusionView[];
  /** Deposits that still have to be wagered before a withdrawal (santim). */
  remainingWagering: bigint;
  openBets: { count: number; stake: bigint };
  /** The 10 latest bets, deposits and withdrawals, and 20 latest cash statement lines. */
  recentBets: PlayerBetSummary[];
  recentPayments: PlayerPaymentSummary[];
  recentTransactions: AccountEntry[];
}

const UNVERIFIED: StaffKycView = {
  status: 'unverified',
  provider: null,
  idNumberLast4: null,
  verifiedName: null,
  verifiedDateOfBirth: null,
  providerReference: null,
  rejectionReason: null,
  submittedAt: null,
  reviewedAt: null,
};

const kycFields = {
  status: kycProfiles.status,
  provider: kycProfiles.provider,
  idNumberLast4: kycProfiles.idNumberLast4,
  verifiedName: kycProfiles.verifiedName,
  verifiedDateOfBirth: kycProfiles.verifiedDateOfBirth,
  providerReference: kycProfiles.providerReference,
  rejectionReason: kycProfiles.rejectionReason,
  submittedAt: kycProfiles.submittedAt,
  reviewedAt: kycProfiles.reviewedAt,
};

/** Everything the back office shows about one player, or null. */
export async function getPlayerDetail(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<PlayerDetail | null> {
  if (!UUID_RE.test(userId)) return null;
  const [user] = await exec
    .select({
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      dateOfBirth: users.dateOfBirth,
      locale: users.locale,
      status: users.status,
      phoneVerifiedAt: users.phoneVerifiedAt,
      termsAcceptedAt: users.termsAcceptedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined) return null;
  const [kyc] = await exec
    .select(kycFields)
    .from(kycProfiles)
    .where(eq(kycProfiles.userId, userId));
  const settings = await loadGameSettings(exec);
  const exclusions = await exec
    .select({
      kind: rgExclusions.kind,
      startsAt: rgExclusions.startsAt,
      endsAt: rgExclusions.endsAt,
      reason: rgExclusions.reason,
      createdAt: rgExclusions.createdAt,
    })
    .from(rgExclusions)
    .where(eq(rgExclusions.userId, userId))
    .orderBy(desc(rgExclusions.startsAt), desc(rgExclusions.createdAt));
  const [open] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      stake: sql<string>`COALESCE(sum(${bets.stake}), 0)::text`,
    })
    .from(bets)
    .where(and(eq(bets.userId, userId), inArray(bets.status, ['open', 'pending_acceptance'])));
  const recentBets = await exec
    .select({
      id: bets.id,
      shortId: bets.shortId,
      betType: bets.betType,
      status: bets.status,
      stake: bets.stake,
      totalOddsMilli: bets.totalOddsMilli,
      potentialNetPayout: bets.potentialNetPayout,
      settledNetPayout: bets.settledNetPayout,
      placedAt: bets.placedAt,
      settledAt: bets.settledAt,
    })
    .from(bets)
    .where(eq(bets.userId, userId))
    .orderBy(desc(bets.placedAt), desc(bets.id))
    .limit(10);
  const deposits = await exec
    .select({
      id: paymentIntents.id,
      provider: paymentIntents.provider,
      amount: paymentIntents.amount,
      status: paymentIntents.status,
      flaggedAt: paymentIntents.flaggedAt,
      createdAt: paymentIntents.createdAt,
      completedAt: paymentIntents.completedAt,
    })
    .from(paymentIntents)
    .where(eq(paymentIntents.userId, userId))
    .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
    .limit(10);
  const withdrawals = await exec
    .select({
      id: payouts.id,
      provider: payouts.provider,
      amount: payouts.amount,
      status: payouts.status,
      flaggedAt: payouts.flaggedAt,
      createdAt: payouts.requestedAt,
      completedAt: payouts.completedAt,
    })
    .from(payouts)
    .where(eq(payouts.userId, userId))
    .orderBy(desc(payouts.requestedAt), desc(payouts.id))
    .limit(10);
  const recentPayments: PlayerPaymentSummary[] = [
    ...deposits.map(({ flaggedAt, ...row }) => ({
      ...row,
      kind: 'deposit' as const,
      flagged: flaggedAt !== null,
    })),
    ...withdrawals.map(({ flaggedAt, ...row }) => ({
      ...row,
      kind: 'withdrawal' as const,
      flagged: flaggedAt !== null,
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 10);
  const balances = (await balancesOf(exec, [userId])).get(userId) ?? { cash: 0n, bonus: 0n };
  return {
    ...user,
    balances,
    kyc: kyc ?? UNVERIFIED,
    limits: await getLimitStates(exec, userId, now),
    activeExclusion: await getActiveExclusion(exec, userId, now),
    exclusions,
    remainingWagering: await getRemainingWagering(
      exec,
      userId,
      settings.payments.wageringMultiplierBps,
    ),
    openBets: { count: open?.count ?? 0, stake: BigInt(open?.stake ?? '0') },
    recentBets,
    recentPayments,
    recentTransactions: await listAccountEntries(exec, {
      account: { kind: 'player_cash', userId },
      limit: 20,
    }),
  };
}

/** A KYC profile in the review queue, with the player it belongs to. */
export interface KycQueueItem extends StaffKycView {
  userId: string;
  phone: string;
  fullName: string | null;
  dateOfBirth: string;
  userStatus: PlayerStatus;
}

/**
 * KYC profiles by status (default: pending, the review queue), oldest
 * submission first (cursor paging).
 */
export async function listKycQueue(
  exec: DbExecutor,
  options: { status?: Exclude<KycStatus, 'unverified'>; limit?: number; cursor?: string } = {},
): Promise<Page<KycQueueItem>> {
  const limit = pageLimit(options.limit, 25, 100);
  const status = options.status ?? 'pending';
  const submitted = sql<Date>`COALESCE(${kycProfiles.submittedAt}, ${kycProfiles.createdAt})`;
  const conditions: SQL[] = [eq(kycProfiles.status, status)];
  if (options.cursor !== undefined) {
    conditions.push(
      afterCursor(submitted, kycProfiles.userId, decodeCursor(options.cursor), 'asc'),
    );
  }
  const rows = await exec
    .select({
      ...kycFields,
      userId: kycProfiles.userId,
      phone: users.phone,
      fullName: users.fullName,
      dateOfBirth: users.dateOfBirth,
      userStatus: users.status,
      queuedAt: cursorTime(submitted),
    })
    .from(kycProfiles)
    .innerJoin(users, eq(users.id, kycProfiles.userId))
    .where(and(...conditions))
    .orderBy(asc(submitted), asc(kycProfiles.userId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ queuedAt: _queuedAt, ...row }) => row),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.queuedAt, id: last.userId })
        : null,
  };
}

/** Audit actions and the outbox event of a staff KYC decision. */
export const KYC_APPROVED_BY_STAFF = 'kyc.approved';
export const KYC_REJECTED_BY_STAFF = 'kyc.rejected';
export const KYC_STATUS_CHANGED = 'kyc.status_changed';

export interface ReviewKycInput {
  userId: string;
  decision: 'approve' | 'reject';
  /** Required to reject (shown to the player); optional note when approving. */
  reason?: string;
  actor: StaffActor;
  now: Date;
}

export interface ReviewKycResult {
  /** false when the profile already had this outcome: nothing was written. */
  changed: boolean;
  profile: KycQueueItem;
}

/**
 * Staff decide a KYC profile waiting for review (kyc.review), in the
 * caller's transaction: approve (verified; the verified name and date of
 * birth are the ones on record) or reject with a reason. Only a pending
 * profile can be decided: 409 `kyc_not_pending` otherwise (repeating the
 * same decision is a no-op, `changed: false`). Approving a player under
 * the minimum age is refused (409 `kyc_underage`): reject instead. 422
 * `reason_required` for a rejection without a reason. Audited as
 * `kyc.approved` / `kyc.rejected` with the staff actor, and published as
 * `kyc.status_changed` like a provider decision.
 */
export async function reviewKyc(
  tx: DbTransaction,
  input: ReviewKycInput,
): Promise<ReviewKycResult> {
  const { actor, now } = input;
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a KYC review needs the admin id');
  }
  if (!UUID_RE.test(input.userId)) throw domainNotFound('KYC profile');
  const reason = input.reason?.trim().slice(0, 500) ?? '';
  if (input.decision === 'reject' && reason.length === 0) {
    throw domainUnprocessable('reason_required', 'Say why the identity check is rejected.');
  }
  // The player first, then the profile: the order the player's own submission locks them in.
  const [user] = await tx
    .select({
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      dateOfBirth: users.dateOfBirth,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('no key update');
  if (user === undefined) throw domainNotFound('KYC profile');
  const [profile] = await tx
    .select(kycFields)
    .from(kycProfiles)
    .where(eq(kycProfiles.userId, input.userId))
    .for('update');
  if (profile === undefined) throw domainNotFound('KYC profile');
  const target: KycStatus = input.decision === 'approve' ? 'verified' : 'rejected';
  const view = (row: StaffKycView): KycQueueItem => ({
    ...row,
    userId: user.id,
    phone: user.phone,
    fullName: user.fullName,
    dateOfBirth: user.dateOfBirth,
    userStatus: user.status,
  });
  if (profile.status === target && profile.reviewedAt !== null) {
    return { changed: false, profile: view(profile) };
  }
  if (profile.status !== 'pending') {
    throw domainConflict('kyc_not_pending', 'This identity check is not waiting for review.', {
      status: profile.status,
    });
  }
  const verifiedDateOfBirth = profile.verifiedDateOfBirth ?? user.dateOfBirth;
  if (
    input.decision === 'approve' &&
    !isOfAge(verifiedDateOfBirth, DEFAULT_RESPONSIBLE_GAMBLING.minAge, now)
  ) {
    throw domainConflict(
      'kyc_underage',
      `The player is under ${DEFAULT_RESPONSIBLE_GAMBLING.minAge}: reject the check instead.`,
    );
  }
  const values =
    input.decision === 'approve'
      ? {
          status: 'verified' as const,
          verifiedName: profile.verifiedName ?? user.fullName,
          verifiedDateOfBirth,
          rejectionReason: null,
          reviewedAt: now,
          updatedAt: now,
        }
      : {
          status: 'rejected' as const,
          rejectionReason: reason,
          reviewedAt: now,
          updatedAt: now,
        };
  const [updated] = await tx
    .update(kycProfiles)
    .set(values)
    .where(eq(kycProfiles.userId, input.userId))
    .returning(kycFields);
  if (updated === undefined) throw new Error(`kyc profile ${input.userId} vanished`);
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action: input.decision === 'approve' ? KYC_APPROVED_BY_STAFF : KYC_REJECTED_BY_STAFF,
    targetType: 'user',
    targetId: input.userId,
    metadata: {
      previousStatus: profile.status,
      provider: profile.provider,
      reference: profile.providerReference,
      ...(reason.length === 0 ? {} : { reason }),
    },
    ip: actor.ip ?? null,
  });
  await enqueueOutbox(tx, {
    type: KYC_STATUS_CHANGED,
    aggregateType: 'user',
    aggregateId: input.userId,
    payload: {
      userId: input.userId,
      status: updated.status,
      previousStatus: profile.status,
      provider: profile.provider,
      reference: profile.providerReference,
      reason: input.decision === 'reject' ? reason : null,
      reviewedBy: actor.adminId,
    },
  });
  return { changed: true, profile: view(updated) };
}
