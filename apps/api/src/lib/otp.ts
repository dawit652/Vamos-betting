import { randomInt } from 'node:crypto';
import { maskMsisdn } from '@vamos/core';
import type { OtpSentResponse } from '@vamos/contracts';
import type { Database, DbTransaction } from '@vamos/db';
import { otpChallenges, type otpPurpose } from '@vamos/db/schema';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../deps';
import { otpSmsBody } from '../providers/sms';
import { hmacSha256Hex, safeEqualHex } from './crypto';
import { badRequest, serviceUnavailable, tooManyRequests } from './errors';
import type { Locale } from './locale';

export type OtpPurpose = (typeof otpPurpose.enumValues)[number];

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum time between two challenges for the same (phone, purpose) from one client address. */
export const OTP_RESEND_COOLDOWN_MS = 60_000;
/**
 * Maximum challenges per (phone, purpose, client address) in a rolling hour.
 * Per purpose, so that password-reset requests for a number (which anyone
 * can make, and which send nothing when the number has no account) cannot
 * block its registration; per address, so that a stranger cannot use up the
 * owner's codes (Phase 12 review A3).
 */
export const OTP_HOURLY_LIMIT = 5;
/**
 * Maximum challenges per (phone, purpose) in a rolling hour from all
 * addresses together: bounds the SMS sent to one number and the codes a
 * group of addresses can guess at.
 */
export const OTP_HOURLY_PHONE_CEILING = 15;
/**
 * Wrong codes accepted per (phone, purpose) in a rolling 24 hours. Once
 * used up no code of that purpose is issued or checked (not even the right
 * one) until the oldest failures age out: 429 `otp_limit`. Only password
 * reset has one; registration codes can only be tried by the holder of the
 * registration token. 10 a day keeps a targeted guesser near 1 in 270 a
 * year (Phase 12 review A1). The price: a stranger who spends it delays the
 * owner's reset by up to a day (the password still works).
 */
export const OTP_DAILY_FAILURE_BUDGET: Readonly<Partial<Record<OtpPurpose, number>>> = {
  password_reset: 10,
  // A stolen session guessing the code that confirms the thief's own bank account.
  payout_account: 10,
};
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface IssuedOtp {
  challengeId: string;
  /** The plain code; only ever sent by SMS (or shown on screen in demo mode). */
  code: string;
  expiresAt: Date;
}

/** A uniformly random 6-digit code. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Only this keyed hash of the code is stored. */
export function hashOtpCode(
  secret: string,
  phone: string,
  purpose: OtpPurpose,
  code: string,
): string {
  return hmacSha256Hex(secret, `${phone}:${purpose}:${code}`);
}

const retryAfterSeconds = (until: number, now: Date) =>
  Math.max(1, Math.ceil((until - now.getTime()) / 1000));

const otpLimit = (retryAfter: number) =>
  tooManyRequests(
    'otp_limit',
    'Too many codes requested for this phone number. Please try again later.',
    { retryAfterSeconds: retryAfter },
  );

/** Serialises the challenges and code checks of one phone number (transaction-scoped). */
async function lockPhone(tx: DbTransaction, phone: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${phone}`}, 0))`);
}

/**
 * When `purpose` has a daily failure budget (OTP_DAILY_FAILURE_BUDGET) and
 * the wrong codes for (phone, purpose) over the last 24 hours (the attempts
 * of the challenges created in that window) have used it up: the seconds
 * until enough of them age out. Otherwise null.
 */
async function failureBudgetExhausted(
  tx: DbTransaction,
  phone: string,
  purpose: OtpPurpose,
  now: Date,
): Promise<number | null> {
  const budget = OTP_DAILY_FAILURE_BUDGET[purpose];
  if (budget === undefined) return null;
  const rows = await tx
    .select({ createdAt: otpChallenges.createdAt, attempts: otpChallenges.attempts })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        eq(otpChallenges.purpose, purpose),
        gt(otpChallenges.createdAt, new Date(now.getTime() - DAY_MS)),
        gt(otpChallenges.attempts, 0),
      ),
    )
    .orderBy(asc(otpChallenges.createdAt));
  let failures = rows.reduce((sum, row) => sum + row.attempts, 0);
  if (failures < budget) return null;
  for (const row of rows) {
    failures -= row.attempts;
    if (failures < budget) return retryAfterSeconds(row.createdAt.getTime() + DAY_MS, now);
  }
  return retryAfterSeconds(now.getTime() + DAY_MS, now);
}

/**
 * Creates a challenge for (phone, purpose) inside `tx` and retires any older
 * unconsumed challenge for the same purpose. Enforced first (429):
 * - `otp_cooldown`: a code for (phone, purpose) went to the same client
 *   address (`requesterKey`, see clientAddressKey) less than
 *   OTP_RESEND_COOLDOWN_MS ago;
 * - `otp_limit`: OTP_HOURLY_LIMIT codes for (phone, purpose) went to that
 *   address in the last hour, OTP_HOURLY_PHONE_CEILING went to any
 *   address, or the purpose's daily failure budget is used up.
 * Challenges for one phone are serialised with a transaction-scoped
 * advisory lock. The SMS is sent by the caller after commit (see `sendOtpSms`).
 */
export async function createOtpChallenge(
  tx: DbTransaction,
  params: {
    secret: string;
    phone: string;
    purpose: OtpPurpose;
    now: Date;
    requesterKey: string;
    /** What this code authorises beyond the phone (otp_challenges.binding; consumeOtp compares it). */
    binding?: string;
  },
): Promise<IssuedOtp> {
  const { secret, phone, purpose, now, requesterKey } = params;
  await lockPhone(tx, phone);

  const [latest] = await tx
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        eq(otpChallenges.purpose, purpose),
        eq(otpChallenges.requesterKey, requesterKey),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (latest && now.getTime() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    const retryAfter = retryAfterSeconds(latest.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS, now);
    throw tooManyRequests(
      'otp_cooldown',
      `Please wait ${retryAfter} seconds before requesting another code.`,
      { retryAfterSeconds: retryAfter },
    );
  }

  const recent = await tx
    .select({ createdAt: otpChallenges.createdAt, requesterKey: otpChallenges.requesterKey })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        eq(otpChallenges.purpose, purpose),
        gt(otpChallenges.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    )
    .orderBy(asc(otpChallenges.createdAt));
  const mine = recent.filter((row) => row.requesterKey === requesterKey);
  for (const [rows, cap] of [
    [mine, OTP_HOURLY_LIMIT],
    [recent, OTP_HOURLY_PHONE_CEILING],
  ] as const) {
    const oldest = rows[0];
    if (oldest && rows.length >= cap) {
      throw otpLimit(retryAfterSeconds(oldest.createdAt.getTime() + HOUR_MS, now));
    }
  }
  const exhausted = await failureBudgetExhausted(tx, phone, purpose, now);
  if (exhausted !== null) throw otpLimit(exhausted);

  await tx
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(
      and(
        eq(otpChallenges.phone, phone),
        eq(otpChallenges.purpose, purpose),
        isNull(otpChallenges.consumedAt),
      ),
    );

  const code = generateOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const [row] = await tx
    .insert(otpChallenges)
    .values({
      phone,
      purpose,
      codeHash: hashOtpCode(secret, phone, purpose, code),
      maxAttempts: OTP_MAX_ATTEMPTS,
      expiresAt,
      createdAt: now,
      requesterKey,
      binding: params.binding ?? null,
    })
    .returning({ id: otpChallenges.id });
  if (!row) throw new Error('otp_challenges insert returned no row');
  return { challengeId: row.id, code, expiresAt };
}

/**
 * Checks `code` against the latest unconsumed challenge for (phone, purpose)
 * and, when it matches, consumes it and runs `onValid` in the same
 * transaction (so the challenge is only spent if `onValid` commits).
 *
 * - the purpose's daily failure budget is used up (OTP_DAILY_FAILURE_BUDGET):
 *   429 `otp_limit`, before any code is compared (even the right one);
 * - no live challenge (missing, consumed, expired or out of attempts):
 *   400 `otp_expired`;
 * - wrong code: the attempt is recorded (and committed) and 400 `otp_invalid`
 *   is thrown with `details.attemptsLeft`. At zero the challenge is dead.
 */
export async function consumeOtp<T>(
  db: Database,
  params: {
    secret: string;
    phone: string;
    purpose: OtpPurpose;
    code: string;
    now: Date;
    /** The challenge must have been issued for exactly this (else 400 `otp_expired`). */
    binding?: string;
  },
  onValid: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const { secret, phone, purpose, code, now } = params;
  const outcome = await db.transaction(async (tx) => {
    if (OTP_DAILY_FAILURE_BUDGET[purpose] !== undefined) {
      // Serialised with the number's other checks and new challenges, so the budget is exact.
      await lockPhone(tx, phone);
      const exhausted = await failureBudgetExhausted(tx, phone, purpose, now);
      if (exhausted !== null) return { kind: 'exhausted', retryAfter: exhausted } as const;
    }
    const [challenge] = await tx
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phone, phone),
          eq(otpChallenges.purpose, purpose),
          isNull(otpChallenges.consumedAt),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1)
      .for('update');
    if (
      !challenge ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attempts >= challenge.maxAttempts ||
      (params.binding !== undefined && challenge.binding !== params.binding)
    ) {
      return { kind: 'expired' } as const;
    }

    if (!safeEqualHex(hashOtpCode(secret, phone, purpose, code), challenge.codeHash)) {
      const attempts = challenge.attempts + 1;
      await tx.update(otpChallenges).set({ attempts }).where(eq(otpChallenges.id, challenge.id));
      return {
        kind: 'invalid',
        attemptsLeft: Math.max(0, challenge.maxAttempts - attempts),
      } as const;
    }

    await tx
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(eq(otpChallenges.id, challenge.id));
    return { kind: 'valid', value: await onValid(tx) } as const;
  });

  switch (outcome.kind) {
    case 'exhausted':
      throw tooManyRequests(
        'otp_limit',
        'Too many wrong codes for this phone number. Please try again later.',
        { retryAfterSeconds: outcome.retryAfter },
      );
    case 'expired':
      throw otpExpired();
    case 'invalid':
      throw badRequest(
        'otp_invalid',
        outcome.attemptsLeft > 0
          ? 'That code is not correct. Please check the SMS and try again.'
          : 'That code is not correct and no attempts are left. Request a new code.',
        { attemptsLeft: outcome.attemptsLeft },
      );
    case 'valid':
      return outcome.value;
  }
}

export const otpExpired = () =>
  badRequest('otp_expired', 'This code has expired or was already used. Request a new code.');

/** Sends the code by SMS. Gateway failures are logged and surface as 503 `sms_unavailable`. */
export async function sendOtpSms(
  deps: Pick<AppDeps, 'sms'>,
  params: { phone: string; purpose: OtpPurpose; code: string; locale: Locale },
  log?: Pick<FastifyBaseLogger, 'error'>,
): Promise<void> {
  try {
    await deps.sms.send({
      to: params.phone,
      body: otpSmsBody(params.code, params.locale),
      template: `otp_${params.purpose}`,
    });
  } catch (error) {
    log?.error({ err: error, provider: deps.sms.name }, 'OTP SMS could not be sent');
    throw serviceUnavailable(
      'sms_unavailable',
      'We could not send the SMS right now. Please try again in a minute.',
    );
  }
}

/** True when registration codes are handed to the client instead of sent (REGISTRATION_SMS_VERIFICATION=off). */
function registrationWithoutSms(deps: Pick<AppDeps, 'config'>, purpose: OtpPurpose): boolean {
  return purpose === 'register' && deps.config.registration.smsVerification === 'off';
}

/**
 * True when the code of `purpose` may be echoed to the client: demo mode with the mock SMS gateway, or
 * a registration code while REGISTRATION_SMS_VERIFICATION=off. Only the purposes of ECHOED_PURPOSES
 * ever qualify, and a password-reset or payout-account code is never echoed outside demo mode.
 */
export function exposesDemoOtp(
  deps: Pick<AppDeps, 'config' | 'sms'>,
  purpose: OtpPurpose = 'register',
): boolean {
  if (!ECHOED_PURPOSES.has(purpose)) return false;
  if (deps.config.mode === 'demo' && deps.sms.name === 'mock') return true;
  return registrationWithoutSms(deps, purpose);
}

/**
 * Purposes whose code may be shown on screen (demo + mock SMS only):
 * registration, where the requester has just chosen the password and holds
 * the registration token, and confirming a payout account, which only the
 * signed-in player can ask for. A password-reset code would hand any account
 * to whoever asks, so it is never echoed.
 */
const ECHOED_PURPOSES: ReadonlySet<OtpPurpose> = new Set<OtpPurpose>([
  'register',
  'payout_account',
]);

/**
 * The `OtpSentResponse` body for a code of `purpose`. `demoOtp` is included
 * only for registration codes on a demo + mock SMS deployment, so the body is
 * the same for every number a password-reset code is requested for.
 */
export function otpSentBody(
  deps: Pick<AppDeps, 'config' | 'sms'>,
  phone: string,
  otp: Pick<IssuedOtp, 'code' | 'expiresAt'>,
  purpose: OtpPurpose,
): OtpSentResponse {
  return {
    otpSentTo: maskMsisdn(phone),
    otpExpiresAt: otp.expiresAt.toISOString(),
    ...(exposesDemoOtp(deps, purpose) ? { demoOtp: otp.code } : {}),
    ...(registrationWithoutSms(deps, purpose) ? { registrationWithoutSms: true } : {}),
  };
}
