import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { bets } from './betting';

/**
 * SMS and USSD betting (Phase 11, feature-flagged, off until the regulator
 * approves the channel). See packages/db/src/channels.
 */

/**
 * What handling an inbound SMS did:
 * - bet_placed: a bet was placed (bet_id is set; a live bet waits for acceptance);
 * - bet_refused: a bet command was refused (refusal_code: the ChannelRefusal code);
 * - info: BAL, BETS, JP or HELP was answered;
 * - opt_out / opt_in: STOP / START (marketing SMS) was recorded;
 * - invalid_command: the text is not a command (refusal_code: the TextCommandError code);
 * - not_available: the sender is not an active player with a verified phone
 *   (one generic reply, whatever the reason);
 * - rate_limited: too many messages from the number (the text was not read).
 */
export const inboundMessageOutcome = pgEnum('inbound_message_outcome', [
  'bet_placed',
  'bet_refused',
  'info',
  'opt_out',
  'opt_in',
  'invalid_command',
  'not_available',
  'rate_limited',
]);

/**
 * Every SMS received from the aggregator, written once in the transaction
 * that handles it (with the bet it placed and the reply queued in the
 * outbox). The aggregator's message id is the idempotency key: a redelivery
 * never handles the text again and gets the same reply.
 */
export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The SMS aggregator that delivered it (SMS_AGGREGATOR, e.g. 'mock'). */
    aggregator: text('aggregator').notNull(),
    /** The aggregator's message id (idempotency key, unique per aggregator). */
    externalId: text('external_id').notNull(),
    /** Sender in E.164 when it is an Ethiopian mobile number, else as received (≤ 32 chars). */
    phone: text('phone').notNull(),
    /** The short code the text was sent to, as received. */
    shortCode: text('short_code'),
    /** The player the number belongs to, when it is an active player with a verified phone. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The text as received (NUL characters replaced, at most 1,600 characters). */
    text: text('text').notNull(),
    /** TextCommandKind ('bet', 'balance', …) when the text was a command. */
    command: text('command'),
    outcome: inboundMessageOutcome('outcome').notNull(),
    /** Why a bet was refused or the text could not be read (see the outcome). */
    refusalCode: text('refusal_code'),
    betId: uuid('bet_id').references(() => bets.id),
    /** The reply sent back (null when none is sent). */
    reply: text('reply'),
    /** How many times the reply was queued (a redelivery can queue it again, see channels/sms.ts). */
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
    /** Server time the text was handled (rate limits count these). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inbound_messages_external_uq').on(t.aggregator, t.externalId),
    // Per-number rate limits.
    index('inbound_messages_phone_idx').on(t.phone, t.receivedAt),
    index('inbound_messages_user_idx').on(t.userId, t.receivedAt),
    index('inbound_messages_bet_idx')
      .on(t.betId)
      .where(sql`${t.betId} IS NOT NULL`),
    check(
      'inbound_messages_bet_placed',
      sql`(${t.outcome} = 'bet_placed') = (${t.betId} IS NOT NULL)`,
    ),
    check(
      'inbound_messages_reply_count',
      sql`${t.replyCount} >= 0 AND (${t.reply} IS NOT NULL OR ${t.replyCount} = 0)`,
    ),
  ],
);

/**
 * USSD sessions: the menu state machine (@vamos/core ussd.ts) reached after
 * each aggregator callback, so the next input is applied to exactly what the
 * player was shown. The last callback's text and response are kept so a
 * redelivered callback gets the same response without being handled again.
 */
export const ussdSessions = pgTable(
  'ussd_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The USSD aggregator (USSD_AGGREGATOR, e.g. 'mock'). */
    aggregator: text('aggregator').notNull(),
    /** The aggregator's session id (unique per aggregator). */
    sessionId: text('session_id').notNull(),
    /** Caller in E.164 when it is an Ethiopian mobile number, else as received (≤ 32 chars). */
    phone: text('phone').notNull(),
    /** The code dialled, as received. */
    serviceCode: text('service_code').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** serializeUssdState of the screen shown last. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    /** The `text` (input history) of the last callback handled. */
    lastText: text('last_text').notNull(),
    /** The response to that callback ('CON …' / 'END …'). */
    lastResponse: text('last_response').notNull(),
    /** Callbacks handled so far (part of the idempotency key of a bet placed in the session). */
    callbacks: integer('callbacks').notNull().default(1),
    /** The bet placed in this session, if any. */
    betId: uuid('bet_id').references(() => bets.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    /** No callback is handled after this (the aggregator has timed the session out). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ussd_sessions_session_uq').on(t.aggregator, t.sessionId),
    // Per-number rate limit on new sessions.
    index('ussd_sessions_phone_idx').on(t.phone, t.createdAt),
    // Pruning of expired sessions without a bet (pruneUssdSessions).
    index('ussd_sessions_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.betId} IS NULL`),
    check('ussd_sessions_callbacks', sql`${t.callbacks} >= 1`),
  ],
);
