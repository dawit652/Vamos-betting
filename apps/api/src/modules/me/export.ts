import { writeAudit } from '@vamos/db';
import { kycProfiles, rgExclusions, sessions } from '@vamos/db/schema';
import { asc, desc, eq } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import type { SessionUser } from '../../plugins/session';
import { listMyBets } from '../betting/service';
import { listMyJackpotEntries } from '../jackpots/service';
import { listPlayerDeposits, listPlayerWithdrawals } from '../payments/service';
import { getLimits } from '../rg/service';
import { listWalletTransactions, parseEntryCursor } from '../wallet/service';
import { getMe } from './service';

/** Version of the export document (bump on an incompatible change). */
export const DATA_EXPORT_FORMAT = 'vamos-data-export/1';
/** Rows of each long list in one export at most; a longer list is marked truncated. */
export const DATA_EXPORT_MAX_ROWS = 5_000;
/** Sessions, deposits and withdrawals listed, newest first. */
const RECENT_ROWS = 1_000;
const PAGE_SIZE = 100;

interface Collected<T> {
  items: T[];
  /** More rows exist than DATA_EXPORT_MAX_ROWS. */
  truncated: boolean;
}

/** Follows a cursor-paged list (newest first) up to DATA_EXPORT_MAX_ROWS rows. */
async function collect<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<Collected<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const next = await page(cursor);
    items.push(...next.items);
    if (next.nextCursor === null) return { items, truncated: false };
    if (items.length >= DATA_EXPORT_MAX_ROWS) {
      return { items: items.slice(0, DATA_EXPORT_MAX_ROWS), truncated: true };
    }
    cursor = next.nextCursor;
  }
}

/**
 * GET /me/data-export: everything the platform keeps about the signed-in
 * player, as one JSON document they can download (ASVS 8.3.2; PDPP access
 * right): profile, identity check (never the ID number, which is not stored),
 * responsible-gambling limits and breaks, sign-in sessions, the wallet
 * statement, bets, jackpot entries, deposits and withdrawals. Audited as
 * `user.data_exported`. Correction and erasure go through support, within
 * the retention duties (7 years for money and bets).
 */
export async function exportMyData(
  deps: AppDeps,
  user: SessionUser,
  meta: { ip: string },
): Promise<Record<string, unknown>> {
  const now = deps.clock();
  const [profile, limits, identity, exclusions, signIns] = await Promise.all([
    getMe(deps.db, user.id, now),
    getLimits(deps.db, user.id, now),
    deps.db
      .select({
        status: kycProfiles.status,
        provider: kycProfiles.provider,
        idNumberLast4: kycProfiles.idNumberLast4,
        verifiedName: kycProfiles.verifiedName,
        verifiedDateOfBirth: kycProfiles.verifiedDateOfBirth,
        rejectionReason: kycProfiles.rejectionReason,
        submittedAt: kycProfiles.submittedAt,
        reviewedAt: kycProfiles.reviewedAt,
      })
      .from(kycProfiles)
      .where(eq(kycProfiles.userId, user.id))
      .limit(1),
    deps.db
      .select({
        kind: rgExclusions.kind,
        startsAt: rgExclusions.startsAt,
        endsAt: rgExclusions.endsAt,
        reason: rgExclusions.reason,
        createdAt: rgExclusions.createdAt,
      })
      .from(rgExclusions)
      .where(eq(rgExclusions.userId, user.id))
      .orderBy(asc(rgExclusions.startsAt)),
    deps.db
      .select({
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, user.id))
      .orderBy(desc(sessions.createdAt))
      .limit(RECENT_ROWS),
  ]);
  const walletTransactions = await collect((cursor) =>
    listWalletTransactions(deps, user.id, {
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: parseEntryCursor(cursor) }),
    }),
  );
  const openBets = await collect((cursor) =>
    listMyBets(deps, user.id, {
      status: 'open',
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const settledBets = await collect((cursor) =>
    listMyBets(deps, user.id, {
      status: 'settled',
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const jackpotEntries = await collect((cursor) =>
    listMyJackpotEntries(deps, user.id, {
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const [deposits, withdrawals] = await Promise.all([
    listPlayerDeposits(deps, user.id, RECENT_ROWS),
    listPlayerWithdrawals(deps, user.id, RECENT_ROWS),
  ]);

  await writeAudit(deps.db, {
    actorType: 'user',
    actorId: user.id,
    action: 'user.data_exported',
    targetType: 'user',
    targetId: user.id,
    ip: meta.ip,
  });

  const iso = (date: Date | null) => (date === null ? null : date.toISOString());
  return {
    format: DATA_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    notes:
      'Amounts are in santim (100 santim = 1 ETB). Your password is stored only as a secure hash and your ID number is not stored; neither can be exported.',
    profile,
    identity:
      identity[0] === undefined
        ? null
        : {
            ...identity[0],
            submittedAt: iso(identity[0].submittedAt),
            reviewedAt: iso(identity[0].reviewedAt),
          },
    limits,
    exclusions: exclusions.map((row) => ({
      ...row,
      startsAt: row.startsAt.toISOString(),
      endsAt: iso(row.endsAt),
      createdAt: row.createdAt.toISOString(),
    })),
    sessions: signIns.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
    })),
    walletTransactions,
    bets: { open: openBets, settled: settledBets },
    jackpotEntries,
    deposits: deposits.items,
    withdrawals: withdrawals.items,
  };
}
