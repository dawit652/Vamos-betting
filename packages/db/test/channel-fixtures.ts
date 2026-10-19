import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../src/client';
import {
  CHANNEL_SMS_REPLY,
  handleInboundSms,
  handleUssdCallback,
  type ChannelSmsReplyPayload,
  type InboundSmsInput,
  type InboundSmsOptions,
  type UssdCallbackOptions,
} from '../src/index';
import { events, outboxEvents, users } from '../src/schema/index';
import { fund } from './helpers';

let phoneCounter = 0;

export interface ChannelTestPlayer {
  userId: string;
  /** E.164. */
  phone: string;
}

/**
 * A player for the SMS / USSD tests: active with a verified phone unless told
 * otherwise, funded with `funds` (santim). Numbers are Safaricom-style
 * (+2517…) so they never collide with createUser's (+2519…).
 */
export async function channelPlayer(
  db: Database,
  options: {
    funds?: bigint;
    locale?: string;
    status?: 'pending_verification' | 'active' | 'suspended' | 'closed';
    verified?: boolean;
  } = {},
): Promise<ChannelTestPlayer> {
  phoneCounter += 1;
  const phone = `+2517${randomInt(1_000, 9_999)}${String(phoneCounter).padStart(4, '0')}`;
  const [row] = await db
    .insert(users)
    .values({
      phone,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      locale: options.locale ?? 'en',
      status: options.status ?? 'active',
      phoneVerifiedAt: options.verified === false ? null : new Date(),
      termsAcceptedAt: new Date(),
    })
    .returning({ id: users.id });
  const userId = row!.id;
  if (options.funds !== undefined && options.funds > 0n) await fund(db, userId, options.funds);
  return { userId, phone };
}

/** An Ethiopian mobile number no account uses. */
export function unknownPhone(): string {
  phoneCounter += 1;
  return `+2517${randomInt(1_000, 9_999)}${String(phoneCounter + 5_000).padStart(4, '0')}`;
}

export async function gameIdOf(db: Database, eventId: string): Promise<number> {
  const [row] = await db
    .select({ gameId: events.gameId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (row === undefined) throw new Error(`no event ${eventId}`);
  return row.gameId;
}

/** A Game ID no event has. */
export async function unusedGameId(db: Database): Promise<number> {
  const used = new Set(
    (await db.select({ gameId: events.gameId }).from(events)).map((r) => r.gameId),
  );
  for (let id = 999_999; id >= 100; id -= 1) if (!used.has(id)) return id;
  throw new Error('every Game ID is used');
}

let messageCounter = 0;

/** An inbound SMS from `from` with a fresh aggregator message id. */
export function smsFrom(from: string, text: string, overrides: Partial<InboundSmsInput> = {}) {
  messageCounter += 1;
  return {
    aggregator: 'mock',
    messageId: `msg-${messageCounter}-${randomUUID()}`,
    from,
    to: '8123',
    text,
    ...overrides,
  } satisfies InboundSmsInput;
}

/** handleInboundSms with test defaults (demo replies, real random bytes). */
export function receiveSms(
  db: Database,
  input: InboundSmsInput,
  now: Date = new Date(),
  options: Partial<InboundSmsOptions> = {},
) {
  return handleInboundSms(db, input, {
    now,
    randomBytes: (size) => randomBytes(size),
    demo: true,
    ...options,
  });
}

/** The channel.sms_reply outbox payloads of an inbound message, oldest first. */
export async function smsReplies(
  db: Database,
  inboundMessageId: string,
): Promise<ChannelSmsReplyPayload[]> {
  const rows = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(eq(outboxEvents.type, CHANNEL_SMS_REPLY), eq(outboxEvents.aggregateId, inboundMessageId)),
    )
    .orderBy(asc(outboxEvents.id));
  return rows.map((row) => row.payload as ChannelSmsReplyPayload);
}

let sessionCounter = 0;

/** A fresh aggregator session id. */
export function ussdSessionId(): string {
  sessionCounter += 1;
  return `ATUid_${sessionCounter}_${randomUUID().replace(/-/g, '')}`;
}

/** One USSD callback with test defaults. */
export function dialUssd(
  db: Database,
  input: { sessionId: string; phone: string; text: string },
  now: Date = new Date(),
  options: Partial<UssdCallbackOptions> = {},
) {
  return handleUssdCallback(
    db,
    {
      aggregator: 'mock',
      sessionId: input.sessionId,
      serviceCode: '*123#',
      phoneNumber: input.phone,
      text: input.text,
    },
    {
      now,
      randomBytes: (size) => randomBytes(size),
      demo: true,
      serviceCode: '*123#',
      ...options,
    },
  );
}
