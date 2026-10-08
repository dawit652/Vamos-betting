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
/** Minimum time between two challenges for the same (phone, purpose). */
export const OTP_RESEND_COOLDOWN_MS = 60_000;
/** Maximum challenges per phone (all purposes) in a rolling hour. */
export const OTP_HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60_000;

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

/**
 * Creates a challenge for (phone, purpose) inside `tx`, enforcing the resend
 * cooldown and the hourly cap (429 `otp_cooldown` / `otp_limit`), and retires
 * any older unconsumed challenge for the same purpose. Challenges for one
 * phone are serialised with a transaction-scoped advisory lock. The SMS is
 * sent by the caller after commit (see `sendOtpSms`).
 */
export async function createOtpChallenge(
  tx: DbTransaction,
  params: { secret: string; phone: string; purpose: OtpPurpose; now: Date },
): Promise<IssuedOtp> {
  const { secret, phone, purpose, now } = params;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${phone}`}, 0))`);

  const [latest] = await tx
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(and(eq(otpChallenges.phone, phone), eq(otpChallenges.purpose, purpose)))
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
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        gt(otpChallenges.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    )
    .orderBy(asc(otpChallenges.createdAt));
  const oldest = recent[0];
  if (oldest && recent.length >= OTP_HOURLY_LIMIT) {
    const retryAfter = retryAfterSeconds(oldest.createdAt.getTime() + HOUR_MS, now);
    throw tooManyRequests(
      'otp_limit',
      'Too many codes requested for this phone number. Please try again later.',
      { retryAfterSeconds: retryAfter },
    );
  }

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
 * - no live challenge (missing, consumed, expired or out of attempts):
 *   400 `otp_expired`;
 * - wrong code: the attempt is recorded (and committed) and 400 `otp_invalid`
 *   is thrown with `details.attemptsLeft`. At zero the challenge is dead.
 */
export async function consumeOtp<T>(
  db: Database,
  params: { secret: string; phone: string; purpose: OtpPurpose; code: string; now: Date },
  onValid: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const { secret, phone, purpose, code, now } = params;
  const outcome = await db.transaction(async (tx) => {
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
      challenge.attempts >= challenge.maxAttempts
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

/** True when codes may be echoed to the client: demo mode with the mock SMS gateway only. */
export function exposesDemoOtp(deps: Pick<AppDeps, 'config' | 'sms'>): boolean {
  return deps.config.mode === 'demo' && deps.sms.name === 'mock';
}

/**
 * The `OtpSentResponse` body. `demoOtp` is included only when a code was
 * actually sent and the deployment is demo + mock SMS.
 */
export function otpSentBody(
  deps: Pick<AppDeps, 'config' | 'sms'>,
  phone: string,
  otp: Pick<IssuedOtp, 'code' | 'expiresAt'>,
  sent: boolean,
): OtpSentResponse {
  return {
    otpSentTo: maskMsisdn(phone),
    otpExpiresAt: otp.expiresAt.toISOString(),
    ...(sent && exposesDemoOtp(deps) ? { demoOtp: otp.code } : {}),
  };
}
