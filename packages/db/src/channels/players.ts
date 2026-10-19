import { normalizeEthiopianMsisdn } from '@vamos/core';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { users } from '../schema/accounts';
import { inboundMessages, ussdSessions } from '../schema/channels';

/** Longest sender kept as received when it is not an Ethiopian mobile number. */
const MAX_RAW_PHONE_LENGTH = 32;

/** A player who may use the SMS / USSD channels. */
export interface ChannelPlayer {
  id: string;
  /** E.164. */
  phone: string;
  /** users.locale ('am', 'en', 'om', 'ti'); see channelLocale in @vamos/core. */
  locale: string;
}

/**
 * The sender as the channels key it: E.164 for an Ethiopian mobile number
 * (`e164` set), else the input with control characters removed, at most 32
 * characters (`e164` null: such a number is never a player and gets no reply).
 */
export function channelPhone(input: string): { key: string; e164: string | null } {
  const e164 = normalizeEthiopianMsisdn(input);
  if (e164 !== null) return { key: e164, e164 };
  const raw = typeof input === 'string' ? input : '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return { key: clean.slice(0, MAX_RAW_PHONE_LENGTH) || '?', e164: null };
}

/**
 * Serialises the SMS and USSD handling of one phone number for the rest of
 * the transaction (an advisory lock), so per-number rate limits count
 * exactly and two texts from one number are handled one after the other.
 * Take it first, before any row lock.
 */
export async function lockChannelPhone(tx: DbTransaction, phoneKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:channel:${phoneKey}`}))`);
}

/**
 * Requests from one number since `since` over both channels: inbound texts
 * plus USSD sessions started. The per-number rate limits of SMS and USSD
 * both count this, so the two channels share one budget per number.
 */
export async function channelRequestsSince(
  tx: DbTransaction,
  phoneKey: string,
  since: Date,
): Promise<number> {
  const [texts] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.phone, phoneKey), gt(inboundMessages.receivedAt, since)));
  const [sessions] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(ussdSessions)
    .where(and(eq(ussdSessions.phone, phoneKey), gt(ussdSessions.createdAt, since)));
  return (texts?.n ?? 0) + (sessions?.n ?? 0);
}

/**
 * The player registered with `phone` (E.164) when the account is active and
 * the phone verified; null otherwise (unknown, pending verification,
 * suspended or closed alike, so callers can answer them all the same way).
 * KYC is not required, as on the web; placeBet checks exclusions and limits.
 */
export async function findChannelPlayer(
  exec: DbExecutor,
  phone: string,
): Promise<ChannelPlayer | null> {
  const [row] = await exec
    .select({ id: users.id, phone: users.phone, locale: users.locale })
    .from(users)
    .where(
      and(eq(users.phone, phone), eq(users.status, 'active'), isNotNull(users.phoneVerifiedAt)),
    )
    .limit(1);
  return row ?? null;
}

export interface SmsOptOutResult {
  /** The account registered with the number (any status), or null when there is none. */
  userId: string | null;
  /** false when the account was already in that state (or there is no account). */
  changed: boolean;
}

/**
 * STOP (optedOut true) / START: records the marketing-SMS choice on the
 * account registered with `phone` (E.164), whatever its status, so a STOP is
 * honoured even for accounts that cannot bet. A number with no account
 * stores nothing (no marketing is ever sent to it). Writes an audit record
 * when the choice changes. Service messages are not affected.
 */
export async function setSmsMarketingOptOut(
  tx: DbTransaction,
  input: { phone: string; optedOut: boolean; now: Date; ip?: string | null },
): Promise<SmsOptOutResult> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, input.phone))
    .limit(1);
  if (user === undefined) return { userId: null, changed: false };
  const updated = await tx
    .update(users)
    .set({ smsMarketingOptOutAt: input.optedOut ? input.now : null, updatedAt: input.now })
    .where(
      and(
        eq(users.id, user.id),
        input.optedOut ? isNull(users.smsMarketingOptOutAt) : isNotNull(users.smsMarketingOptOutAt),
      ),
    )
    .returning({ id: users.id });
  const changed = updated.length > 0;
  if (changed) {
    await writeAudit(tx, {
      actorType: 'user',
      actorId: user.id,
      action: input.optedOut ? 'sms.marketing_opt_out' : 'sms.marketing_opt_in',
      targetType: 'user',
      targetId: user.id,
      metadata: { channel: 'sms' },
      ip: input.ip ?? null,
    });
  }
  return { userId: user.id, changed };
}

/** True when the player has opted out of marketing SMS (STOP). */
export async function isSmsMarketingOptedOut(exec: DbExecutor, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const [row] = await exec
    .select({ at: users.smsMarketingOptOutAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row !== undefined && row.at !== null;
}
