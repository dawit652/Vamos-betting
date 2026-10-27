import { and, asc, inArray, isNotNull, lt, or } from 'drizzle-orm';
import type { Database } from '../client';
import { adminSessions, otpChallenges, sessions } from '../schema/accounts';

/**
 * Retention of short-lived security records (ASVS 8.3.8): they carry personal
 * data (phone numbers, IP addresses, user agents) and are deleted once they
 * are of no more use, by the worker's retention-prune task.
 *
 * - Player and staff sessions: kept SESSION_RETENTION_MS after they ended
 *   (expired or revoked), for security investigations; sign-ins and sign-outs
 *   stay in the audit log.
 * - One-time SMS codes: kept OTP_RETENTION_MS after they were issued (the
 *   hourly and daily abuse limits look back 24 hours at most).
 *
 * The ledger, the audit log, bets and payments follow the 7-year retention of
 * docs/compliance.md and are never pruned here.
 */
const DAY_MS = 24 * 3_600_000;
export const SESSION_RETENTION_MS = 90 * DAY_MS;
export const OTP_RETENTION_MS = 30 * DAY_MS;
/** Rows deleted per table and call at most. */
export const RETENTION_BATCH_SIZE = 1_000;

export interface RetentionOptions {
  now: Date;
  sessionRetentionMs?: number;
  otpRetentionMs?: number;
  batchSize?: number;
}

export interface RetentionResult {
  sessions: number;
  staffSessions: number;
  otpChallenges: number;
}

/**
 * Deletes one batch (at most `batchSize` rows per table) of the records past
 * their retention; returns how many went from each table.
 */
export async function pruneExpiredSecurityRecords(
  db: Database,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const sessionsBefore = new Date(
    options.now.getTime() - (options.sessionRetentionMs ?? SESSION_RETENTION_MS),
  );
  const otpBefore = new Date(options.now.getTime() - (options.otpRetentionMs ?? OTP_RETENTION_MS));

  const endedSessions = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      or(
        lt(sessions.expiresAt, sessionsBefore),
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, sessionsBefore)),
      ),
    )
    .orderBy(asc(sessions.expiresAt))
    .limit(batchSize);
  const deletedSessions = await db
    .delete(sessions)
    .where(inArray(sessions.id, endedSessions))
    .returning({ id: sessions.id });

  const endedStaffSessions = db
    .select({ id: adminSessions.id })
    .from(adminSessions)
    .where(
      or(
        lt(adminSessions.expiresAt, sessionsBefore),
        and(isNotNull(adminSessions.revokedAt), lt(adminSessions.revokedAt, sessionsBefore)),
      ),
    )
    .orderBy(asc(adminSessions.expiresAt))
    .limit(batchSize);
  const deletedStaffSessions = await db
    .delete(adminSessions)
    .where(inArray(adminSessions.id, endedStaffSessions))
    .returning({ id: adminSessions.id });

  const oldChallenges = db
    .select({ id: otpChallenges.id })
    .from(otpChallenges)
    .where(lt(otpChallenges.createdAt, otpBefore))
    .orderBy(asc(otpChallenges.createdAt))
    .limit(batchSize);
  const deletedChallenges = await db
    .delete(otpChallenges)
    .where(inArray(otpChallenges.id, oldChallenges))
    .returning({ id: otpChallenges.id });

  return {
    sessions: deletedSessions.length,
    staffSessions: deletedStaffSessions.length,
    otpChallenges: deletedChallenges.length,
  };
}
