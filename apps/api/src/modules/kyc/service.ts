import { DEFAULT_RESPONSIBLE_GAMBLING, isOfAge, parseIsoDate } from '@vamos/core';
import type { KycResponse, SubmitKycRequest } from '@vamos/contracts';
import { enqueueOutbox, writeAudit, type DbExecutor } from '@vamos/db';
import { kycProfiles, users, type kycStatus } from '@vamos/db/schema';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { hmacSha256Hex } from '../../lib/crypto';
import { badRequest, conflict, serviceUnavailable, unprocessable } from '../../lib/errors';
import { revokeAllUserSessions } from '../../plugins/session';
import { announceSessionRevoked } from '../stream/control';
import type { KycVerificationResult } from '../../providers/kyc';
import type { RequestMeta } from '../auth/service';

export type KycStatus = (typeof kycStatus.enumValues)[number];

const ID_HASH_UNIQUE_INDEX = 'kyc_id_number_hash_uq';

/**
 * Keyed hash of a Fayda ID number (digits only). It lets us enforce one
 * account per person without storing the number itself.
 */
export function idNumberHash(secret: string, idNumber: string): string {
  return hmacSha256Hex(secret, `fayda:${idNumber}`);
}

/**
 * Loose comparison key for names: Unicode-normalised, case-insensitive and
 * ignoring whitespace (including the Ethiopic word space ፡).
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s፡]+/gu, '');
}

export function namesMatch(submitted: string, verified: string): boolean {
  return nameKey(submitted) === nameKey(verified);
}

/** GET /me/kyc body; `unverified` when the player never submitted an ID. */
export async function getKyc(exec: DbExecutor, userId: string): Promise<KycResponse> {
  const [row] = await exec
    .select({
      status: kycProfiles.status,
      idNumberLast4: kycProfiles.idNumberLast4,
      rejectionReason: kycProfiles.rejectionReason,
    })
    .from(kycProfiles)
    .where(eq(kycProfiles.userId, userId))
    .limit(1);
  return row ?? { status: 'unverified', idNumberLast4: null, rejectionReason: null };
}

const alreadyVerified = () =>
  conflict('kyc_already_verified', 'Your identity is already verified.');

const idAlreadyUsed = () =>
  conflict(
    'id_already_used',
    'This ID is already linked to another Nahubet account. Contact support if this is a mistake.',
  );

const providerUnavailable = () =>
  serviceUnavailable(
    'kyc_unavailable',
    'Identity verification is temporarily unavailable. Please try again later.',
  );

/** 409s for a player who is verified already, or an ID verified / under review for someone else. */
async function assertSubmissionAllowed(
  exec: DbExecutor,
  userId: string,
  hash: string,
  currentStatus: KycStatus | undefined,
): Promise<void> {
  if (currentStatus === 'verified') throw alreadyVerified();
  const [holder] = await exec
    .select({ userId: kycProfiles.userId })
    .from(kycProfiles)
    .where(
      and(
        eq(kycProfiles.idNumberHash, hash),
        ne(kycProfiles.userId, userId),
        inArray(kycProfiles.status, ['verified', 'pending']),
      ),
    )
    .limit(1);
  if (holder) throw idAlreadyUsed();
}

async function currentKycStatus(exec: DbExecutor, userId: string): Promise<KycStatus | undefined> {
  const [row] = await exec
    .select({ status: kycProfiles.status })
    .from(kycProfiles)
    .where(eq(kycProfiles.userId, userId))
    .limit(1);
  return row?.status;
}

interface KycDecision {
  status: Exclude<KycStatus, 'unverified'>;
  reference: string | null;
  verifiedName: string | null;
  verifiedDateOfBirth: string | null;
  rejectionReason: string | null;
}

/**
 * Turns the provider's answer into our decision: a verified identity must
 * also be of age (else rejected `underage`) and carry the submitted name
 * (else rejected `name_mismatch`).
 */
function decide(result: KycVerificationResult, input: SubmitKycRequest, now: Date): KycDecision {
  switch (result.status) {
    case 'rejected':
      return {
        status: 'rejected',
        reference: null,
        verifiedName: null,
        verifiedDateOfBirth: null,
        rejectionReason: result.reason.trim() === '' ? 'rejected_by_provider' : result.reason,
      };
    case 'pending':
      return {
        status: 'pending',
        reference: result.reference,
        verifiedName: null,
        verifiedDateOfBirth: null,
        rejectionReason: null,
      };
    case 'verified': {
      if (parseIsoDate(result.verifiedDateOfBirth) === null) {
        throw new Error('KYC provider returned an invalid date of birth');
      }
      const identity = {
        reference: result.reference,
        verifiedName: result.verifiedName,
        verifiedDateOfBirth: result.verifiedDateOfBirth,
      };
      if (!isOfAge(result.verifiedDateOfBirth, DEFAULT_RESPONSIBLE_GAMBLING.minAge, now)) {
        return { status: 'rejected', ...identity, rejectionReason: 'underage' };
      }
      if (!namesMatch(input.fullName, result.verifiedName)) {
        return { status: 'rejected', ...identity, rejectionReason: 'name_mismatch' };
      }
      return { status: 'verified', ...identity, rejectionReason: null };
    }
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === 'object') {
      const { code, constraint: name } = e as { code?: unknown; constraint?: unknown };
      if (code === '23505' && name === constraint) return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * POST /me/kyc: verifies a Fayda ID with `deps.kyc` and stores the outcome.
 * Throws 409 `kyc_already_verified` / `id_already_used`, 503 `kyc_unavailable`
 * when the provider fails, and 422 `underage` when the registry shows the
 * player is under 21. In that case, in the same transaction as the stored
 * rejection, the account is suspended (so it can no longer log in, bet or
 * deposit, and `canGamble` is false) and every session is revoked. That is
 * audited as `user.suspended` and published as `user.suspended` for review.
 * On success the profile's name and date of birth are replaced by the verified ones.
 */
export async function submitKyc(
  deps: Pick<AppDeps, 'db' | 'clock' | 'kyc' | 'config' | 'redis' | 'userChannelPrefix'>,
  userId: string,
  input: SubmitKycRequest,
  meta: Pick<RequestMeta, 'ip' | 'log'>,
): Promise<KycResponse> {
  if (parseIsoDate(input.dateOfBirth) === null) {
    throw badRequest('invalid_date_of_birth', 'Enter a real date of birth (YYYY-MM-DD).');
  }
  const now = deps.clock();
  const hash = idNumberHash(deps.config.sessionSecret, input.idNumber);
  const idNumberLast4 = input.idNumber.slice(-4);

  // Cheap checks first so a doomed submission does not reach the provider.
  await assertSubmissionAllowed(deps.db, userId, hash, await currentKycStatus(deps.db, userId));

  let decision: KycDecision;
  try {
    const result = await deps.kyc.verify({
      idNumber: input.idNumber,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth,
    });
    decision = decide(result, input, now);
  } catch (error) {
    meta.log?.error({ err: error, provider: deps.kyc.name }, 'KYC verification failed');
    throw providerUnavailable();
  }

  let suspended = false;
  try {
    await deps.db.transaction(async (tx) => {
      const [user] = await tx
        .select({
          fullName: users.fullName,
          dateOfBirth: users.dateOfBirth,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
      if (!user) throw new Error(`user ${userId} disappeared during KYC`);
      const previousStatus = (await currentKycStatus(tx, userId)) ?? 'unverified';
      await assertSubmissionAllowed(tx, userId, hash, previousStatus);

      const values = {
        status: decision.status,
        provider: deps.kyc.name,
        idNumberHash: hash,
        idNumberLast4,
        verifiedName: decision.verifiedName,
        verifiedDateOfBirth: decision.verifiedDateOfBirth,
        providerReference: decision.reference,
        rejectionReason: decision.rejectionReason,
        submittedAt: now,
        reviewedAt: decision.status === 'pending' ? null : now,
        updatedAt: now,
      };
      await tx
        .insert(kycProfiles)
        .values({ userId, ...values, createdAt: now })
        .onConflictDoUpdate({ target: kycProfiles.userId, set: values });

      let profileUpdated: Record<string, boolean> | undefined;
      if (
        decision.status === 'verified' &&
        decision.verifiedName !== null &&
        decision.verifiedDateOfBirth !== null
      ) {
        profileUpdated = {
          fullName: user.fullName !== decision.verifiedName,
          dateOfBirth: user.dateOfBirth !== decision.verifiedDateOfBirth,
        };
        await tx
          .update(users)
          .set({
            fullName: decision.verifiedName,
            dateOfBirth: decision.verifiedDateOfBirth,
            updatedAt: now,
          })
          .where(eq(users.id, userId));
      } else if (user.dateOfBirth === null) {
        // Registration asks for no date of birth: the one typed here becomes the declared date,
        // which a staff review of a pending check falls back on when the registry gave none.
        await tx
          .update(users)
          .set({ dateOfBirth: input.dateOfBirth, updatedAt: now })
          .where(eq(users.id, userId));
      }

      const audit = {
        actorType: 'user' as const,
        actorId: userId,
        targetType: 'user',
        targetId: userId,
        ip: meta.ip,
      };
      await writeAudit(tx, {
        ...audit,
        action: 'kyc.submitted',
        metadata: { provider: deps.kyc.name, idNumberLast4, previousStatus },
      });
      await writeAudit(tx, {
        ...audit,
        action: `kyc.${decision.status}`,
        metadata: {
          provider: deps.kyc.name,
          reference: decision.reference,
          reason: decision.rejectionReason,
          ...(profileUpdated === undefined ? {} : { profileUpdated }),
        },
      });
      await enqueueOutbox(tx, {
        type: 'kyc.status_changed',
        aggregateType: 'user',
        aggregateId: userId,
        payload: {
          userId,
          status: decision.status,
          previousStatus,
          provider: deps.kyc.name,
          reference: decision.reference,
          reason: decision.rejectionReason,
        },
      });

      // The registry says the player is under 21: stop all play until support reviews it.
      if (decision.rejectionReason === 'underage' && user.status === 'active') {
        await tx
          .update(users)
          .set({ status: 'suspended', updatedAt: now })
          .where(eq(users.id, userId));
        const revokedSessions = await revokeAllUserSessions(tx, userId, now);
        suspended = true;
        const suspension = {
          reason: 'kyc_underage',
          previousStatus: user.status,
          provider: deps.kyc.name,
          reference: decision.reference,
        };
        await writeAudit(tx, {
          actorType: 'system',
          action: 'user.suspended',
          targetType: 'user',
          targetId: userId,
          metadata: { ...suspension, revokedSessions },
          ip: meta.ip,
        });
        await enqueueOutbox(tx, {
          type: 'user.suspended',
          aggregateType: 'user',
          aggregateId: userId,
          payload: { userId, ...suspension },
        });
      }
    });
  } catch (error) {
    // Lost a race with another account submitting the same ID.
    if (isUniqueViolation(error, ID_HASH_UNIQUE_INDEX)) throw idAlreadyUsed();
    throw error;
  }
  // Committed: end the player's open push streams now.
  if (suspended) await announceSessionRevoked(deps, userId, null);

  if (decision.rejectionReason === 'underage') {
    const { minAge } = DEFAULT_RESPONSIBLE_GAMBLING;
    throw unprocessable(
      'underage',
      `You must be at least ${minAge} years old to use Nahubet. ` +
        'Your account has been suspended; contact support if this is a mistake.',
      { minAge, accountSuspended: true },
    );
  }
  return {
    status: decision.status,
    idNumberLast4,
    rejectionReason: decision.rejectionReason,
  };
}
