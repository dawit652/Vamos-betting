import { maskMsisdn } from '@vamos/core';
import type { MeResponse, UpdateMeRequest } from '@vamos/contracts';
import { writeAudit, type DbExecutor } from '@vamos/db';
import { kycProfiles, users } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { conflict, notFound } from '../../lib/errors';
import { toLocale } from '../../lib/locale';
import type { RequestMeta } from '../auth/service';
import { getActiveExclusion } from '../rg/guard';
import { exclusionBody } from '../rg/service';

/** The player's profile as of `now` (MeResponse). */
export async function getMe(exec: DbExecutor, userId: string, now: Date): Promise<MeResponse> {
  const [row] = await exec
    .select({
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      dateOfBirth: users.dateOfBirth,
      locale: users.locale,
      status: users.status,
      createdAt: users.createdAt,
      kycStatus: kycProfiles.status,
      idNumberLast4: kycProfiles.idNumberLast4,
    })
    .from(users)
    .leftJoin(kycProfiles, eq(kycProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw notFound('User');

  const exclusion = await getActiveExclusion(exec, userId, now);
  return {
    id: row.id,
    phone: row.phone,
    phoneMasked: maskMsisdn(row.phone),
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    locale: toLocale(row.locale),
    status: row.status,
    kyc: { status: row.kycStatus ?? 'unverified', idNumberLast4: row.idNumberLast4 ?? null },
    exclusion: exclusion === null ? null : exclusionBody(exclusion),
    canGamble: row.status === 'active' && exclusion === null,
    createdAt: row.createdAt.toISOString(),
  };
}

const nameLocked = () =>
  conflict(
    'name_locked',
    'Your name has been verified against your Fayda ID and can no longer be changed here. ' +
      'Contact support if it is wrong.',
  );

/**
 * PATCH /me: changes the locale and/or full name. The name is locked once
 * KYC is verified (it then comes from the ID registry). Audited as
 * `user.profile_updated` when something actually changes.
 */
export async function updateMe(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  input: UpdateMeRequest,
  meta: Pick<RequestMeta, 'ip'>,
): Promise<MeResponse> {
  const now = deps.clock();
  await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ fullName: users.fullName, locale: users.locale })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!current) throw notFound('User');

    const changes: { fullName?: string; locale?: string } = {};
    if (input.locale !== undefined && input.locale !== current.locale) {
      changes.locale = input.locale;
    }
    if (input.fullName !== undefined && input.fullName !== current.fullName) {
      const [kyc] = await tx
        .select({ status: kycProfiles.status })
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, userId));
      if (kyc?.status === 'verified') throw nameLocked();
      changes.fullName = input.fullName;
    }
    const fields = Object.keys(changes);
    if (fields.length === 0) return;

    await tx
      .update(users)
      .set({ ...changes, updatedAt: now })
      .where(eq(users.id, userId));
    await writeAudit(tx, {
      actorType: 'user',
      actorId: userId,
      action: 'user.profile_updated',
      targetType: 'user',
      targetId: userId,
      metadata: {
        fields,
        ...(changes.locale === undefined
          ? {}
          : { locale: { from: current.locale, to: changes.locale } }),
      },
      ip: meta.ip,
    });
  });
  return getMe(deps.db, userId, now);
}
