import {
  DEFAULT_RESPONSIBLE_GAMBLING,
  isOfAge,
  maskMsisdn,
  normalizeEthiopianMsisdn,
  parseIsoDate,
} from '@vamos/core';
import type {
  ForgotPasswordRequest,
  LoginRequest,
  OtpSentResponse,
  RegisterRequest,
  ResendOtpRequest,
  ResetPasswordRequest,
  VerifyOtpRequest,
} from '@vamos/contracts';
import { writeAudit, type DbExecutor } from '@vamos/db';
import { users } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../../deps';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from '../../lib/errors';
import { toLocale } from '../../lib/locale';
import {
  consumeOtp,
  createOtpChallenge,
  otpExpired,
  otpSentBody,
  sendOtpSms,
  type IssuedOtp,
} from '../../lib/otp';
import {
  assertPasswordAcceptable,
  dummyVerifyPassword,
  hashPassword,
  verifyPassword,
} from '../../lib/passwords';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
  type IssuedSession,
  type SessionUser,
} from '../../plugins/session';
import { exclusionError, getActiveExclusion } from '../rg/guard';

/** Who is calling; recorded on sessions and in the audit log. */
export interface RequestMeta {
  ip: string;
  userAgent: string | null;
  log?: FastifyBaseLogger;
}

type UserRow = typeof users.$inferSelect;

export interface AuthenticatedUser {
  user: Pick<UserRow, 'id' | 'phone' | 'status' | 'locale'>;
  session: IssuedSession;
}

/** E.164 phone or 400 `invalid_phone`. */
export function requirePhone(input: string): string {
  const phone = normalizeEthiopianMsisdn(input);
  if (phone === null) {
    throw badRequest(
      'invalid_phone',
      'Enter a valid Ethiopian mobile number, e.g. 0911 234 567 or 0711 234 567.',
    );
  }
  return phone;
}

const phoneTaken = () =>
  conflict('phone_taken', 'An account with this phone number already exists. Log in instead.');

const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'Incorrect phone number or password.');

async function findUserByPhone(exec: DbExecutor, phone: string): Promise<UserRow | null> {
  const [user] = await exec.select().from(users).where(eq(users.phone, phone)).limit(1);
  return user ?? null;
}

/**
 * Creates a pending account (or refreshes an unverified one) and sends the
 * registration code. Nothing is written for an underage applicant.
 */
export async function registerUser(
  deps: AppDeps,
  input: RegisterRequest,
  meta: RequestMeta,
): Promise<{ userId: string; response: OtpSentResponse }> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  const { minAge } = DEFAULT_RESPONSIBLE_GAMBLING;
  if (parseIsoDate(input.dateOfBirth) === null) {
    throw badRequest('invalid_date_of_birth', 'Enter a real date of birth (YYYY-MM-DD).');
  }
  if (!isOfAge(input.dateOfBirth, minAge, now)) {
    throw unprocessable('underage', `You must be at least ${minAge} years old to use Vamos.`, {
      minAge,
    });
  }
  assertPasswordAcceptable(input.password, phone);

  // Cheap pre-check so a taken number does not cost an Argon2 hash.
  const existing = await findUserByPhone(deps.db, phone);
  if (existing !== null && existing.status !== 'pending_verification') {
    throw phoneTaken();
  }
  const passwordHash = await hashPassword(input.password);

  const { userId, otp } = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.phone, phone))
      .for('update');
    const details = {
      passwordHash,
      dateOfBirth: input.dateOfBirth,
      fullName: input.fullName ?? null,
      locale: input.locale,
      termsAcceptedAt: now,
    };
    let id: string;
    if (current) {
      if (current.status !== 'pending_verification') throw phoneTaken();
      await tx
        .update(users)
        .set({ ...details, updatedAt: now })
        .where(eq(users.id, current.id));
      id = current.id;
    } else {
      const [inserted] = await tx
        .insert(users)
        .values({
          ...details,
          phone,
          status: 'pending_verification',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: users.phone })
        .returning({ id: users.id });
      // Lost a race with a concurrent registration for the same number.
      if (!inserted) throw phoneTaken();
      id = inserted.id;
    }
    const issued = await createOtpChallenge(tx, {
      secret: deps.config.sessionSecret,
      phone,
      purpose: 'register',
      now,
    });
    await writeAudit(tx, {
      actorType: 'user',
      actorId: id,
      action: 'user.registered',
      targetType: 'user',
      targetId: id,
      metadata: { reregistration: current !== undefined, locale: input.locale },
      ip: meta.ip,
    });
    return { userId: id, otp: issued };
  });

  await sendOtpSms(
    deps,
    { phone, purpose: 'register', code: otp.code, locale: input.locale },
    meta.log,
  );
  return { userId, response: otpSentBody(deps, phone, otp, true) };
}

/** Confirms the registration code: activates the account and opens a session. */
export async function verifyRegistration(
  deps: AppDeps,
  input: VerifyOtpRequest,
  meta: RequestMeta,
): Promise<AuthenticatedUser> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  return consumeOtp(
    deps.db,
    { secret: deps.config.sessionSecret, phone, purpose: input.purpose, code: input.code, now },
    async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.phone, phone)).for('update');
      if (!user) throw otpExpired();
      if (user.status !== 'pending_verification') {
        throw conflict(
          'already_verified',
          'This phone number is already verified. Log in instead.',
        );
      }
      const [activated] = await tx
        .update(users)
        .set({ status: 'active', phoneVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, user.id))
        .returning();
      if (!activated) throw new Error('user activation returned no row');
      const session = await createSession(tx, deps, {
        userId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await writeAudit(tx, {
        actorType: 'user',
        actorId: user.id,
        action: 'user.phone_verified',
        targetType: 'user',
        targetId: user.id,
        ip: meta.ip,
      });
      return { user: activated, session };
    },
  );
}

async function auditLoginFailure(
  deps: AppDeps,
  meta: RequestMeta,
  reason: string,
  user: { id: string } | null,
  phone: string | null,
): Promise<void> {
  await writeAudit(deps.db, {
    actorType: 'user',
    actorId: user?.id ?? null,
    action: 'user.login_failed',
    targetType: 'user',
    ...(user ? { targetId: user.id } : {}),
    metadata: { reason, phone: phone === null ? null : maskMsisdn(phone) },
    ip: meta.ip,
  });
}

/**
 * Password login. Unknown numbers and wrong passwords get the same 401 after
 * the same Argon2 work; account state is only revealed to the password holder.
 */
export async function login(
  deps: AppDeps,
  input: LoginRequest,
  meta: RequestMeta,
): Promise<AuthenticatedUser> {
  const now = deps.clock();
  const phone = normalizeEthiopianMsisdn(input.phone);
  const user = phone === null ? null : await findUserByPhone(deps.db, phone);
  if (user === null) {
    await dummyVerifyPassword(input.password);
    await auditLoginFailure(deps, meta, 'unknown_phone', null, phone);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await auditLoginFailure(deps, meta, 'wrong_password', user, phone);
    throw invalidCredentials();
  }
  if (user.status === 'pending_verification') {
    await auditLoginFailure(deps, meta, 'phone_not_verified', user, phone);
    throw forbidden(
      'phone_not_verified',
      'Verify your phone number first. You can request a new code.',
    );
  }
  if (user.status !== 'active') {
    await auditLoginFailure(deps, meta, 'account_disabled', user, phone);
    throw forbidden('account_disabled', 'This account is disabled. Please contact support.');
  }
  // A cool-off still allows login (to see bets and history); self-exclusion does not.
  const exclusion = await getActiveExclusion(deps.db, user.id, now, { kind: 'self_exclusion' });
  if (exclusion !== null) {
    await auditLoginFailure(deps, meta, 'self_excluded', user, phone);
    throw exclusionError(exclusion);
  }

  const session = await deps.db.transaction(async (tx) => {
    const created = await createSession(tx, deps, {
      userId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: 'user.login',
      targetType: 'session',
      targetId: created.id,
      ip: meta.ip,
    });
    return created;
  });
  return { user, session };
}

export async function logout(deps: AppDeps, user: SessionUser, meta: RequestMeta): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction(async (tx) => {
    await revokeSession(tx, user.sessionId, now);
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: 'user.logout',
      targetType: 'session',
      targetId: user.sessionId,
      ip: meta.ip,
    });
  });
}

/**
 * Starts a password reset. The response (and the cooldown / hourly limits)
 * are the same whether or not the number belongs to an active account, so
 * the endpoint cannot be used to discover accounts; the SMS is only sent to
 * active accounts.
 */
export async function requestPasswordReset(
  deps: AppDeps,
  input: ForgotPasswordRequest,
  meta: RequestMeta,
): Promise<OtpSentResponse> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  const user = await findUserByPhone(deps.db, phone);
  const eligible = user !== null && user.status === 'active';

  const otp: IssuedOtp = await deps.db.transaction(async (tx) => {
    const issued = await createOtpChallenge(tx, {
      secret: deps.config.sessionSecret,
      phone,
      purpose: 'password_reset',
      now,
    });
    if (eligible) {
      await writeAudit(tx, {
        actorType: 'user',
        actorId: user.id,
        action: 'user.password_reset_requested',
        targetType: 'user',
        targetId: user.id,
        ip: meta.ip,
      });
    }
    return issued;
  });

  if (eligible) {
    await sendOtpSms(
      deps,
      { phone, purpose: 'password_reset', code: otp.code, locale: toLocale(user.locale) },
      meta.log,
    );
  }
  return otpSentBody(deps, phone, otp, eligible);
}

/** Sets a new password with a reset code and revokes every session of the account. */
export async function resetPassword(
  deps: AppDeps,
  input: ResetPasswordRequest,
  meta: RequestMeta,
): Promise<void> {
  const phone = requirePhone(input.phone);
  assertPasswordAcceptable(input.newPassword, phone);
  const passwordHash = await hashPassword(input.newPassword);
  const now = deps.clock();
  await consumeOtp(
    deps.db,
    { secret: deps.config.sessionSecret, phone, purpose: 'password_reset', code: input.code, now },
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.phone, phone))
        .for('update');
      // Codes are only sent to active accounts; anything else is a dead code.
      if (!user || user.status !== 'active') throw otpExpired();
      await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id));
      const revokedSessions = await revokeAllUserSessions(tx, user.id, now);
      await writeAudit(tx, {
        actorType: 'user',
        actorId: user.id,
        action: 'user.password_reset',
        targetType: 'user',
        targetId: user.id,
        metadata: { revokedSessions },
        ip: meta.ip,
      });
    },
  );
}

/** Re-sends a registration or password-reset code. */
export async function resendOtp(
  deps: AppDeps,
  input: ResendOtpRequest,
  meta: RequestMeta,
): Promise<OtpSentResponse> {
  switch (input.purpose) {
    case 'register': {
      const phone = requirePhone(input.phone);
      const now = deps.clock();
      const user = await findUserByPhone(deps.db, phone);
      if (user === null || user.status !== 'pending_verification') {
        throw notFound('Pending registration for this phone number');
      }
      const otp = await deps.db.transaction((tx) =>
        createOtpChallenge(tx, {
          secret: deps.config.sessionSecret,
          phone,
          purpose: 'register',
          now,
        }),
      );
      await sendOtpSms(
        deps,
        { phone, purpose: 'register', code: otp.code, locale: toLocale(user.locale) },
        meta.log,
      );
      return otpSentBody(deps, phone, otp, true);
    }
    case 'password_reset':
      return requestPasswordReset(deps, { phone: input.phone }, meta);
    default:
      throw badRequest('unsupported_purpose', `Codes for "${input.purpose}" cannot be resent.`);
  }
}
