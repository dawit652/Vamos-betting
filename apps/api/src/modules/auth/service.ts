import {
  DEFAULT_RESPONSIBLE_GAMBLING,
  isOfAge,
  maskMsisdn,
  normalizeEthiopianMsisdn,
  parseIsoDate,
} from '@vamos/core';
import type {
  ChangePasswordRequest,
  ForgotPasswordRequest,
  LoginRequest,
  OtpSentResponse,
  PlayerSessionsResponse,
  RegisterRequest,
  RegisterResponse,
  ResendOtpRequest,
  ResetPasswordRequest,
  RevokeSessionsRequest,
  RevokeSessionsResponse,
  VerifyOtpRequest,
} from '@vamos/contracts';
import { writeAudit, type DbExecutor } from '@vamos/db';
import { sessions, users } from '@vamos/db/schema';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../../deps';
import { clientAddressKey } from '../../lib/client-address';
import { randomToken, safeEqualHex, sha256Hex } from '../../lib/crypto';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from '../../lib/errors';
import { toLocale, type Locale } from '../../lib/locale';
import {
  consumeOtp,
  createOtpChallenge,
  TELEGRAM_REQUESTER_PREFIX,
  otpExpired,
  otpSentBody,
  sendOtpSms,
  type IssuedOtp,
} from '../../lib/otp';
import {
  assertPasswordAcceptable,
  dummyVerifyPassword,
  hashPassword,
  meetsPasswordPolicy,
  passwordNeedsRehash,
  verifyPassword,
} from '../../lib/passwords';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
  playerSessionLifetime,
  type PlayerSessionLifetime,
  type IssuedSession,
  type SessionUser,
} from '../../plugins/session';
import { securityNoticeSmsBody, type SecurityNotice } from '../../providers/sms';
import { exclusionError, getActiveExclusion } from '../rg/guard';
import { announceSessionRevoked } from '../stream/control';

/** Who is calling; recorded on sessions and in the audit log. */
export interface RequestMeta {
  ip: string;
  userAgent: string | null;
  log?: FastifyBaseLogger;
  /**
   * Counts one PIN check against the player's number (the sign-in limits of POST /auth/login),
   * throwing 429 when the number has none left. Called right before a signed-in player's
   * current PIN is compared, so only requests that actually test a PIN use the budget.
   */
  countPinCheck?: () => Promise<void>;
}

type UserRow = typeof users.$inferSelect;

export interface AuthenticatedUser {
  user: Pick<UserRow, 'id' | 'phone' | 'status' | 'locale'>;
  session: IssuedSession;
  /** Sends the "new device signed in" SMS after the answer; null when none is due. */
  deliver?: (() => Promise<void>) | null;
}

/**
 * Whether no session of the player (kept 90 days after it ended) came from
 * this browser (its user agent): a sign-in from an unknown device, which the
 * player is told about by SMS (ASVS 2.2.3). No user agent counts as unknown.
 */
async function isNewDevice(
  exec: DbExecutor,
  userId: string,
  userAgent: string | null,
): Promise<boolean> {
  if (userAgent === null || userAgent.trim() === '') return true;
  const [seen] = await exec
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.userAgent, userAgent.slice(0, 512))))
    .limit(1);
  return seen === undefined;
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

/**
 * The registration token does not belong to a pending registration of the
 * number: the number was registered again since (which replaces the token),
 * is already verified, or was never registered. Deliberately the same answer
 * in every case.
 */
const registrationExpired = () =>
  badRequest(
    'registration_expired',
    'This sign-up is no longer valid. It was completed, or the number was registered again. ' +
      'Register again to get a new code.',
  );

/** True when `token` is the registration token of `user`, a pending account. */
function holdsRegistration(
  user: Pick<UserRow, 'status' | 'registrationTokenHash'> | null | undefined,
  token: string,
): boolean {
  if (!user || user.status !== 'pending_verification' || user.registrationTokenHash === null) {
    return false;
  }
  return safeEqualHex(sha256Hex(token), user.registrationTokenHash);
}

/**
 * The OtpSentResponse of a request, plus the SMS still to send. The route
 * sends it after answering, so the response time is the same whether or not
 * an SMS is due (and does not reveal whether the number has an account).
 */
export interface OtpDispatch {
  response: OtpSentResponse;
  /** Sends the SMS (never throws; failures are logged). null when no SMS is due. */
  deliver: (() => Promise<void>) | null;
}

async function findUserByPhone(exec: DbExecutor, phone: string): Promise<UserRow | null> {
  const [user] = await exec.select().from(users).where(eq(users.phone, phone)).limit(1);
  return user ?? null;
}

/**
 * Creates a pending account (or refreshes an unverified one) and sends the
 * registration code. Nothing is written for an underage applicant.
 *
 * The response carries a fresh registration token; only its hash is stored.
 * Verifying the code requires it. A new registration of a pending number
 * replaces the password, the details and the token, so the earlier
 * registrant's token stops working. Whoever activates the account is the
 * person who chose its password and also received the SMS. The user id is
 * not returned.
 */
export async function registerUser(
  deps: AppDeps,
  input: RegisterRequest,
  meta: RequestMeta,
): Promise<{ userId: string; response: RegisterResponse }> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  const { minAge } = DEFAULT_RESPONSIBLE_GAMBLING;
  // The date of birth is optional (the player confirms 21+ with acceptTerms and KYC checks
  // the age on the ID); one that is sent is still checked, so an underage date is refused.
  if (input.dateOfBirth !== undefined) {
    if (parseIsoDate(input.dateOfBirth) === null) {
      throw badRequest('invalid_date_of_birth', 'Enter a real date of birth (YYYY-MM-DD).');
    }
    if (!isOfAge(input.dateOfBirth, minAge, now)) {
      throw unprocessable('underage', `You must be at least ${minAge} years old to use Nahubet.`, {
        minAge,
      });
    }
  }
  assertPasswordAcceptable(input.password, phone);

  // Cheap pre-check so a taken number does not cost an Argon2 hash.
  const existing = await findUserByPhone(deps.db, phone);
  if (existing !== null && existing.status !== 'pending_verification') {
    throw phoneTaken();
  }
  const passwordHash = await hashPassword(input.password, deps.config.passwordPepper);
  const registrationToken = randomToken(deps.randomBytes);

  const { userId, otp } = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.phone, phone))
      .for('update');
    const details = {
      passwordHash,
      dateOfBirth: input.dateOfBirth ?? null,
      fullName: input.fullName ?? null,
      locale: input.locale,
      termsAcceptedAt: now,
      registrationTokenHash: sha256Hex(registrationToken),
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
      requesterKey: clientAddressKey(meta.ip),
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
  return {
    userId,
    response: { ...otpSentBody(deps, phone, otp, 'register'), registrationToken },
  };
}

/**
 * Confirms the registration code: activates the account and opens a session.
 * The registration token must belong to the pending registration (400
 * `registration_expired` otherwise). It is checked before the code, so
 * nobody without it can use up the code's attempts.
 */
export async function verifyRegistration(
  deps: AppDeps,
  input: VerifyOtpRequest,
  meta: RequestMeta,
): Promise<AuthenticatedUser> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  if (!holdsRegistration(await findUserByPhone(deps.db, phone), input.registrationToken)) {
    throw registrationExpired();
  }
  return consumeOtp(
    deps.db,
    { secret: deps.config.sessionSecret, phone, purpose: input.purpose, code: input.code, now },
    async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.phone, phone)).for('update');
      // Again under the row lock: a concurrent registration may have replaced the token.
      // Throwing rolls back the consumption of the code.
      if (!user || !holdsRegistration(user, input.registrationToken)) {
        throw registrationExpired();
      }
      const [activated] = await tx
        .update(users)
        .set({
          status: 'active',
          phoneVerifiedAt: now,
          registrationTokenHash: null,
          updatedAt: now,
        })
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
    await dummyVerifyPassword(input.password, deps.config.passwordPepper);
    await auditLoginFailure(deps, meta, 'unknown_phone', null, phone);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(user.passwordHash, input.password, deps.config.passwordPepper))) {
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
  // A password set under an older rule (shorter, or now on the common list) must be replaced,
  // through the SMS reset, which also proves the player still holds the number (ASVS 2.1.7).
  if (!meetsPasswordPolicy(input.password, user.phone)) {
    await auditLoginFailure(deps, meta, 'password_policy', user, phone);
    throw forbidden(
      'password_reset_required',
      'Your password no longer meets our security rules. Reset it with an SMS code to continue.',
    );
  }

  // A hash made before the pepper was set is replaced now that the password is known (only if
  // it did not change meanwhile).
  const rehashed = passwordNeedsRehash(user.passwordHash, deps.config.passwordPepper)
    ? await hashPassword(input.password, deps.config.passwordPepper)
    : null;
  const newDevice = await isNewDevice(deps.db, user.id, meta.userAgent);
  const session = await deps.db.transaction(async (tx) => {
    if (rehashed !== null) {
      await tx
        .update(users)
        .set({ passwordHash: rehashed, updatedAt: now })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)));
    }
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
      ...(newDevice ? { metadata: { newDevice: true } } : {}),
      ip: meta.ip,
    });
    return created;
  });
  const deliver = newDevice
    ? () => notifySecurityEvent(deps, user.phone, 'new_sign_in', toLocale(user.locale), meta.log)
    : null;
  return { user, session, deliver };
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
  // Committed: end the session's open push streams now.
  await announceSessionRevoked(deps, user.id, user.sessionId);
}

/**
 * Starts a password reset. Every valid number gets the same answer after the
 * same work: a challenge (so the cooldown and the hourly cap apply alike), an
 * audit record and an identical body (reset codes are never echoed, even in
 * demo mode). Only an active account is sent the SMS, by `deliver` after the
 * response, so neither the body nor the response time tells numbers with an
 * account apart. (Registration still answers 409 `phone_taken` for a taken
 * number; that is deliberate UX.)
 */
export async function requestPasswordReset(
  deps: AppDeps,
  input: ForgotPasswordRequest,
  meta: RequestMeta,
): Promise<OtpDispatch> {
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
      requesterKey: clientAddressKey(meta.ip),
    });
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user?.id ?? null,
      action: 'user.password_reset_requested',
      targetType: 'user',
      ...(user ? { targetId: user.id } : {}),
      metadata: { phone: maskMsisdn(phone), smsSent: eligible },
      ip: meta.ip,
    });
    return issued;
  });

  const locale = toLocale(user?.locale);
  const deliver = eligible
    ? async () => {
        // sendOtpSms logs a gateway failure; the requester can simply ask again.
        await sendOtpSms(
          deps,
          { phone, purpose: 'password_reset', code: otp.code, locale },
          meta.log,
        ).catch(() => undefined);
      }
    : null;
  return { response: otpSentBody(deps, phone, otp, 'password_reset'), deliver };
}

/** What the Telegram bot gets when it asks for a reset code for a proven number. */
export type TelegramResetCode =
  { status: 'sent'; code: string; expiresAt: Date } | { status: 'no_account' };

/**
 * A PIN reset code for a number the Telegram bot has proven (the person shared their own contact,
 * which Telegram verified), to be sent in that chat instead of by SMS (owner, 17 Nov 2026: the live
 * server has no SMS gateway). The same challenge, limits and expiry as the SMS reset
 * (createOtpChallenge; the chat is the requester), confirmed on the reset page as usual.
 * "no_account" tells the owner of that number only, so it leaks nothing.
 */
export async function issueTelegramResetCode(
  deps: AppDeps,
  input: { phone: string; chatId: number },
  meta: RequestMeta,
): Promise<TelegramResetCode> {
  const phone = requirePhone(input.phone);
  const now = deps.clock();
  const user = await findUserByPhone(deps.db, phone);
  if (user === null || user.status !== 'active') return { status: 'no_account' };
  const issued = await deps.db.transaction(async (tx) => {
    const otp = await createOtpChallenge(tx, {
      secret: deps.config.sessionSecret,
      phone,
      purpose: 'password_reset',
      now,
      requesterKey: `${TELEGRAM_REQUESTER_PREFIX}${input.chatId}`,
    });
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: 'user.password_reset_requested',
      targetType: 'user',
      targetId: user.id,
      metadata: { phone: maskMsisdn(phone), channel: 'telegram' },
      ip: meta.ip,
    });
    return otp;
  });
  return { status: 'sent', code: issued.code, expiresAt: issued.expiresAt };
}

/** A committed password change: `deliver` sends the player's notice (never throws). */
export interface PasswordChanged {
  deliver: () => Promise<void>;
}

/**
 * Sends a security notice by SMS (ASVS 2.2.3, 2.5.5): the password changed, or
 * a new device signed in. A gateway failure is logged, never thrown: what it
 * reports has already happened.
 */
export async function notifySecurityEvent(
  deps: Pick<AppDeps, 'sms'>,
  phone: string,
  event: SecurityNotice,
  locale: Locale,
  log?: Pick<FastifyBaseLogger, 'error'>,
): Promise<void> {
  try {
    await deps.sms.send({ to: phone, body: securityNoticeSmsBody(event, locale), template: event });
  } catch (error) {
    log?.error({ err: error, provider: deps.sms.name, event }, 'security notice SMS not sent');
  }
}

/**
 * Sets a new password with a reset code and revokes every session of the
 * account. The caller sends the notice (`deliver`) after answering.
 */
export async function resetPassword(
  deps: AppDeps,
  input: ResetPasswordRequest,
  meta: RequestMeta,
): Promise<PasswordChanged> {
  const phone = requirePhone(input.phone);
  assertPasswordAcceptable(input.newPassword, phone);
  const passwordHash = await hashPassword(input.newPassword, deps.config.passwordPepper);
  const now = deps.clock();
  const reset = await consumeOtp(
    deps.db,
    { secret: deps.config.sessionSecret, phone, purpose: 'password_reset', code: input.code, now },
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id, status: users.status, locale: users.locale })
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
      return { userId: user.id, locale: toLocale(user.locale) };
    },
  );
  // Committed: end every open push stream of the account now.
  await announceSessionRevoked(deps, reset.userId, null);
  return {
    deliver: () => notifySecurityEvent(deps, phone, 'password_changed', reset.locale, meta.log),
  };
}

/** 403 `reauth_failed`: the password re-entered to confirm a change is not the account's. */
const reauthFailed = () =>
  forbidden('reauth_failed', 'The password you entered is not correct. Please try again.');

/**
 * Checks the password a signed-in player re-entered (argon2, outside any
 * transaction). A wrong one is audited as `user.reauth_failed` and answered
 * 403 `reauth_failed`. Returns the hash it matched, so the caller can make sure
 * it did not change before its own transaction.
 */
async function verifyCurrentPassword(
  deps: Pick<AppDeps, 'db' | 'config'>,
  user: SessionUser,
  password: string,
  purpose: 'password_change' | 'sessions_revoke',
  meta: RequestMeta,
): Promise<string> {
  // Before the comparison, so a number out of guesses learns nothing about this one.
  await meta.countPinCheck?.();
  const [row] = await deps.db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (
    row !== undefined &&
    (await verifyPassword(row.passwordHash, password, deps.config.passwordPepper))
  ) {
    return row.passwordHash;
  }
  await writeAudit(deps.db, {
    actorType: 'user',
    actorId: user.id,
    action: 'user.reauth_failed',
    targetType: 'user',
    targetId: user.id,
    metadata: { purpose },
    ip: meta.ip,
  });
  throw reauthFailed();
}

/**
 * POST /me/password: the signed-in player changes the password with the
 * current one (ASVS 2.1.5, 2.1.6). The new one must meet the rules and differ
 * from the current one (422 `password_unchanged`). Every other session of the
 * account ends (ASVS 3.3.3); this one stays. Audited as
 * `user.password_changed`; the caller sends the notice (`deliver`).
 */
export async function changePassword(
  deps: AppDeps,
  user: SessionUser,
  input: ChangePasswordRequest,
  meta: RequestMeta,
): Promise<PasswordChanged & { revokedSessions: number }> {
  assertPasswordAcceptable(input.newPassword, user.phone);
  if (input.newPassword === input.currentPassword) {
    throw unprocessable('password_unchanged', 'Choose a password different from the current one.');
  }
  const verifiedHash = await verifyCurrentPassword(
    deps,
    user,
    input.currentPassword,
    'password_change',
    meta,
  );
  const passwordHash = await hashPassword(input.newPassword, deps.config.passwordPepper);
  const now = deps.clock();
  const revoked = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .for('update');
    // Changed meanwhile (a reset, which also ended this session): the check no longer holds.
    if (row === undefined || row.passwordHash !== verifiedHash) throw reauthFailed();
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id));
    const ended = await revokeOtherUserSessions(tx, user, now);
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: 'user.password_changed',
      targetType: 'user',
      targetId: user.id,
      metadata: { revokedSessions: ended.length },
      ip: meta.ip,
    });
    return ended;
  });
  // Committed: end the other sessions' open push streams now.
  for (const sessionId of revoked) await announceSessionRevoked(deps, user.id, sessionId);
  return {
    revokedSessions: revoked.length,
    deliver: () => notifySecurityEvent(deps, user.phone, 'password_changed', user.locale, meta.log),
  };
}

/** Sessions used within the idle limit (none: every session counts). */
function seenWithinIdle(now: Date, lifetime: PlayerSessionLifetime) {
  return lifetime.idleMs === null
    ? undefined
    : gt(sessions.lastSeenAt, new Date(now.getTime() - lifetime.idleMs));
}

/**
 * The player's sessions other than `user`'s (optionally one of them) that are not revoked and
 * not past their absolute end as of `now`. Idle ones are included on purpose: an idle limit is
 * read from the configuration at every request, so a session idle today is live again the day
 * the limit is raised or switched off (as on 16 Nov 2026, from 30 minutes to none). Ending
 * sessions must not skip it.
 */
function otherUnendedSessions(user: SessionUser, now: Date, sessionId?: string) {
  return and(
    eq(sessions.userId, user.id),
    ne(sessions.id, user.sessionId),
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, now),
    ...(sessionId === undefined ? [] : [eq(sessions.id, sessionId)]),
  );
}

async function revokeOtherUserSessions(
  tx: DbExecutor,
  user: SessionUser,
  now: Date,
  sessionId?: string,
): Promise<string[]> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now })
    .where(otherUnendedSessions(user, now, sessionId))
    .returning({ id: sessions.id });
  return rows.map((row) => row.id);
}

/** GET /me/sessions: the player's live sessions, most recently used first (ASVS 3.3.4). */
export async function listSessions(
  deps: Pick<AppDeps, 'db' | 'clock' | 'config'>,
  user: SessionUser,
): Promise<PlayerSessionsResponse> {
  const now = deps.clock();
  const rows = await deps.db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        seenWithinIdle(now, playerSessionLifetime(deps.config)),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt))
    .limit(MAX_LISTED_SESSIONS);
  return {
    items: rows.map((row) => ({
      id: row.id,
      current: row.id === user.sessionId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ip: row.ip,
      userAgent: row.userAgent,
    })),
  };
}

/** Sessions GET /me/sessions lists at most. */
export const MAX_LISTED_SESSIONS = 50;

/**
 * POST /me/sessions/revoke: after the password is re-entered, ends one other
 * live session of the player (404 when it is not theirs or already over) or
 * every other one (ASVS 3.3.4). The current session is ended with log out
 * (400 `current_session`). Audited as `user.sessions_revoked`.
 */
export async function revokeSessions(
  deps: AppDeps,
  user: SessionUser,
  input: RevokeSessionsRequest,
  meta: RequestMeta,
): Promise<RevokeSessionsResponse> {
  if (input.sessionId === user.sessionId) {
    throw badRequest('current_session', 'Use log out to end the session you are using.');
  }
  await verifyCurrentPassword(deps, user, input.password, 'sessions_revoke', meta);
  const now = deps.clock();
  const revoked = await deps.db.transaction(async (tx) => {
    const ended = await revokeOtherUserSessions(tx, user, now, input.sessionId);
    if (input.sessionId !== undefined && ended.length === 0) throw notFound('Session');
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: 'user.sessions_revoked',
      targetType: 'user',
      targetId: user.id,
      metadata: { revoked: ended.length, scope: input.sessionId === undefined ? 'others' : 'one' },
      ip: meta.ip,
    });
    return ended;
  });
  for (const sessionId of revoked) await announceSessionRevoked(deps, user.id, sessionId);
  return { revoked: revoked.length };
}

/**
 * Re-sends a registration code (only to the holder of the registration
 * token: 400 `registration_expired` otherwise, whatever the number) or a
 * password-reset code (exactly like a new reset request).
 */
export async function resendOtp(
  deps: AppDeps,
  input: ResendOtpRequest,
  meta: RequestMeta,
): Promise<OtpDispatch> {
  switch (input.purpose) {
    case 'register': {
      const phone = requirePhone(input.phone);
      const now = deps.clock();
      const user = await findUserByPhone(deps.db, phone);
      if (
        input.registrationToken === undefined ||
        !holdsRegistration(user, input.registrationToken)
      ) {
        throw registrationExpired();
      }
      const otp = await deps.db.transaction((tx) =>
        createOtpChallenge(tx, {
          secret: deps.config.sessionSecret,
          phone,
          purpose: 'register',
          now,
          requesterKey: clientAddressKey(meta.ip),
        }),
      );
      await sendOtpSms(
        deps,
        { phone, purpose: 'register', code: otp.code, locale: toLocale(user?.locale) },
        meta.log,
      );
      return { response: otpSentBody(deps, phone, otp, 'register'), deliver: null };
    }
    case 'password_reset':
      return requestPasswordReset(deps, { phone: input.phone }, meta);
    default:
      throw badRequest('unsupported_purpose', `Codes for "${input.purpose}" cannot be resent.`);
  }
}
