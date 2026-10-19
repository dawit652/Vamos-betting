import { randomUUID } from 'node:crypto';
import {
  balanceBody,
  betPlacedBody,
  betsBody,
  channelLocale,
  commandErrorBody,
  helpBody,
  jackpotBody,
  normalizeEthiopianMsisdn,
  notAvailableBody,
  optOutBody,
  optOutBodyBilingual,
  parseTextCommand,
  refusalBody,
  smsText,
  tooManyMessagesBody,
  type ChannelLocale,
  type ChannelRefusal,
  type TextCommand,
  type TextCommandKind,
} from '@vamos/core';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import type { UserBet } from '../betting/types';
import type { Database } from '../client';
import type { DbTransaction } from '../ledger/types';
import { enqueueOutbox } from '../platform/outbox';
import { withTxRetry, type TxRetryOptions } from '../retry';
import { lockUser } from '../rg/limits';
import { inboundMessages, type inboundMessageOutcome } from '../schema/channels';
import { outboxEvents } from '../schema/platform';
import { loadGameSettings, type GameSettings } from '../settings/index';
import { CHANNEL_REPLY_TEMPLATE, CHANNEL_SMS_REPLY, type ChannelSmsReplyPayload } from './events';
import { resolveTextBetLegs } from './games';
import { placeChannelBet, placedBetSummary, smsBetKey } from './place';
import {
  channelPhone,
  channelRequestsSince,
  findChannelPlayer,
  lockChannelPhone,
  setSmsMarketingOptOut,
  type ChannelPlayer,
} from './players';
import { channelBalances, openJackpotSummaries, recentBetLines } from './summaries';

export type InboundMessageOutcome = (typeof inboundMessageOutcome.enumValues)[number];

/** Longest text stored (and read) from an inbound SMS. */
export const MAX_INBOUND_TEXT_LENGTH = 1_600;
/** Longest aggregator message id accepted. */
export const MAX_MESSAGE_ID_LENGTH = 128;
/** A redelivery queues the reply again only this long after the last send… */
export const SMS_REPLY_RESEND_INTERVAL_MS = 60_000;
/** …and never more than this many sends in all. */
export const SMS_MAX_REPLY_SENDS = 3;

/**
 * At most `max` requests per number within `windowMs`: texts and USSD
 * sessions started both count (channelRequestsSince), rate-limited ones too.
 */
export interface ChannelRateLimit {
  max: number;
  windowMs: number;
}

export const DEFAULT_SMS_RATE_LIMITS: readonly ChannelRateLimit[] = [
  { max: 10, windowMs: 60_000 },
  { max: 60, windowMs: 3_600_000 },
];

export interface InboundSmsInput {
  /** SMS_AGGREGATOR ('mock' in the demo). */
  aggregator: string;
  /** The aggregator's message id: the idempotency key. */
  messageId: string;
  /** The sender's number as the aggregator gives it (the network authenticates it). */
  from: string;
  /** Our short code, as received. */
  to?: string | null;
  text: string;
}

export interface InboundSmsOptions {
  now: Date;
  randomBytes: (size: number) => Uint8Array;
  /** Play-money mode: replies say DEMO. */
  demo: boolean;
  /** Default DEFAULT_SMS_RATE_LIMITS. */
  rateLimits?: readonly ChannelRateLimit[];
  /** The aggregator's address, for the audit log. */
  ip?: string | null;
  txRetry?: TxRetryOptions;
}

export interface InboundSmsResult {
  inboundMessageId: string;
  outcome: InboundMessageOutcome;
  /** The command the text was read as (null when it was not read or not a command). */
  command: TextCommandKind | null;
  /** The reply (prefix included), or null when none is sent. */
  reply: string | null;
  /** The message id had been handled already: nothing was handled again. */
  replayed: boolean;
  /** This call queued the reply in the outbox (first handling, or a due re-send). */
  replyQueued: boolean;
  /** A redelivery whose sender or text differs from the stored message: ignored. */
  conflict: boolean;
  betId: string | null;
  /** The bet placed by this call (null on a replay). */
  bet: UserBet | null;
}

interface Handled {
  outcome: InboundMessageOutcome;
  command: TextCommandKind | null;
  refusalCode: string | null;
  userId: string | null;
  bet: UserBet | null;
  /** The body (without the prefix), or null for no reply. */
  body: string | null;
}

const PRINTABLE_ID = /^[\x21-\x7e]+$/;
const REPLACEMENT = String.fromCharCode(0xfffd);
const NUL = new RegExp(String.fromCharCode(0), 'g');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The text as stored and read: NUL characters (which PostgreSQL cannot store)
 * and lone surrogates replaced by U+FFFD, cut to MAX_INBOUND_TEXT_LENGTH
 * code points, so a redelivery compares equal to what was stored.
 */
export function inboundText(text: string): string {
  const clean = text.replace(NUL, REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT);
  const chars = Array.from(clean);
  return chars.length <= MAX_INBOUND_TEXT_LENGTH
    ? clean
    : chars.slice(0, MAX_INBOUND_TEXT_LENGTH).join('');
}

function assertInput(input: InboundSmsInput): void {
  if (typeof input.aggregator !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(input.aggregator)) {
    throw new RangeError('aggregator must be 1–32 lowercase letters, digits, - or _');
  }
  if (
    typeof input.messageId !== 'string' ||
    input.messageId.length > MAX_MESSAGE_ID_LENGTH ||
    !PRINTABLE_ID.test(input.messageId)
  ) {
    throw new RangeError(`messageId must be 1–${MAX_MESSAGE_ID_LENGTH} printable ASCII characters`);
  }
  if (typeof input.from !== 'string' || input.from.length > 64) {
    throw new RangeError('from must be a string of at most 64 characters');
  }
  if (typeof input.text !== 'string') throw new RangeError('text must be a string');
}

async function rateLimitHit(
  tx: DbTransaction,
  phone: string,
  now: Date,
  limits: readonly ChannelRateLimit[],
): Promise<ChannelRateLimit | null> {
  for (const limit of limits) {
    const since = new Date(now.getTime() - limit.windowMs);
    if ((await channelRequestsSince(tx, phone, since)) >= limit.max) return limit;
  }
  return null;
}

/** Whether the "too many messages" reply already went to this number in the window. */
async function rateLimitReplySent(
  tx: DbTransaction,
  phone: string,
  now: Date,
  windowMs: number,
): Promise<boolean> {
  const since = new Date(now.getTime() - windowMs);
  const [row] = await tx
    .select({ id: inboundMessages.id })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.phone, phone),
        eq(inboundMessages.outcome, 'rate_limited'),
        isNotNull(inboundMessages.reply),
        gt(inboundMessages.receivedAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
}

const refused = (
  refusal: ChannelRefusal,
  player: ChannelPlayer,
  locale: ChannelLocale,
): Handled => ({
  outcome: 'bet_refused',
  command: 'bet',
  refusalCode: refusal.code,
  userId: player.id,
  bet: null,
  body: refusalBody(refusal, locale),
});

async function handleBet(
  tx: DbTransaction,
  command: Extract<TextCommand, { kind: 'bet' }>,
  player: ChannelPlayer,
  locale: ChannelLocale,
  input: InboundSmsInput,
  options: InboundSmsOptions,
  settings: GameSettings,
): Promise<Handled> {
  // The player's lock first, then the selections (FOR SHARE), as placeBet
  // takes them: the prices read here cannot move before the bet commits, so
  // policy 'none' at these odds is the price at receipt.
  await lockUser(tx, player.id);
  const resolution = await resolveTextBetLegs(tx, command.legs, options.now, { lock: 'share' });
  if (!resolution.ok) return refused(resolution.refusal, player, locale);
  const placed = await placeChannelBet(tx, {
    userId: player.id,
    channel: 'sms',
    legs: resolution.legs,
    stake: command.stake,
    idempotencyKey: smsBetKey(input.aggregator, input.messageId),
    now: options.now,
    settings,
    randomBytes: options.randomBytes,
    ip: options.ip ?? null,
  });
  if (!placed.ok) return refused(placed.refusal, player, locale);
  return {
    outcome: 'bet_placed',
    command: 'bet',
    refusalCode: null,
    userId: player.id,
    bet: placed.bet,
    body: betPlacedBody(placedBetSummary(placed.bet), locale),
  };
}

async function handleText(
  tx: DbTransaction,
  input: InboundSmsInput,
  phone: { key: string; e164: string | null },
  text: string,
  options: InboundSmsOptions,
): Promise<Handled> {
  const { now } = options;
  const none = { refusalCode: null, userId: null, bet: null };

  const limit = await rateLimitHit(
    tx,
    phone.key,
    now,
    options.rateLimits ?? DEFAULT_SMS_RATE_LIMITS,
  );
  if (limit !== null) {
    const told = await rateLimitReplySent(tx, phone.key, now, limit.windowMs);
    return {
      ...none,
      outcome: 'rate_limited',
      command: null,
      body: told ? null : tooManyMessagesBody(),
    };
  }

  const player = phone.e164 === null ? null : await findChannelPlayer(tx, phone.e164);
  const settings = await loadGameSettings(tx);
  const parsed = parseTextCommand(text, { maxLegs: settings.betRules.maxLegs });
  const kind = parsed.ok ? parsed.command.kind : null;

  if (player === null) {
    // STOP / START are honoured for any number; everything else gets the one
    // generic reply, whether the number is unknown, unverified, suspended or
    // closed, so a reply never tells whether a number is registered.
    if (kind === 'stop' || kind === 'start') {
      const optedOut = kind === 'stop';
      if (phone.e164 !== null) {
        await setSmsMarketingOptOut(tx, {
          phone: phone.e164,
          optedOut,
          now,
          ip: options.ip ?? null,
        });
      }
      return {
        ...none,
        outcome: optedOut ? 'opt_out' : 'opt_in',
        command: kind,
        body: optOutBodyBilingual(optedOut),
      };
    }
    return { ...none, outcome: 'not_available', command: kind, body: notAvailableBody() };
  }

  const locale = channelLocale(player.locale);
  const info = (body: string): Handled => ({
    ...none,
    outcome: 'info',
    command: kind,
    userId: player.id,
    body,
  });
  if (!parsed.ok) {
    return {
      ...none,
      outcome: 'invalid_command',
      command: null,
      refusalCode: parsed.error.code,
      userId: player.id,
      body: commandErrorBody(parsed.error, locale, { maxStake: settings.betRules.maxStake }),
    };
  }
  const { command } = parsed;
  switch (command.kind) {
    case 'balance':
      return info(balanceBody(await channelBalances(tx, player.id), locale));
    case 'bets':
      return info(betsBody(await recentBetLines(tx, player.id), locale));
    case 'jackpot':
      return info(jackpotBody(await openJackpotSummaries(tx, now, locale), locale));
    case 'help':
      return info(helpBody(locale));
    case 'stop':
    case 'start': {
      const optedOut = command.kind === 'stop';
      await setSmsMarketingOptOut(tx, {
        phone: player.phone,
        optedOut,
        now,
        ip: options.ip ?? null,
      });
      return {
        ...none,
        outcome: optedOut ? 'opt_out' : 'opt_in',
        command: command.kind,
        userId: player.id,
        body: optOutBody(optedOut, locale),
      };
    }
    case 'bet':
      return handleBet(tx, command, player, locale, input, options, settings);
  }
}

async function queueReply(tx: DbTransaction, payload: ChannelSmsReplyPayload): Promise<void> {
  await enqueueOutbox(tx, {
    type: CHANNEL_SMS_REPLY,
    aggregateType: 'inbound_message',
    aggregateId: payload.inboundMessageId,
    payload: { ...payload },
  });
}

/** A message id seen before: nothing is handled again; the same reply may be queued again. */
async function redelivered(
  tx: DbTransaction,
  row: typeof inboundMessages.$inferSelect,
  received: { phone: string; text: string },
  now: Date,
): Promise<InboundSmsResult> {
  const result: InboundSmsResult = {
    inboundMessageId: row.id,
    outcome: row.outcome,
    command: row.command as TextCommandKind | null,
    reply: row.reply,
    replayed: true,
    replyQueued: false,
    conflict: false,
    betId: row.betId,
    bet: null,
  };
  if (row.phone !== received.phone || row.text !== received.text) {
    // Not the message we handled under this id: answer nothing, change nothing.
    return { ...result, reply: null, conflict: true };
  }
  const to = normalizeEthiopianMsisdn(row.phone);
  const longAgo = (at: Date | null) =>
    at === null || now.getTime() - at.getTime() >= SMS_REPLY_RESEND_INTERVAL_MS;
  const due =
    row.reply !== null &&
    to !== null &&
    row.replyCount < SMS_MAX_REPLY_SENDS &&
    longAgo(row.lastReplyAt);
  if (!due || row.reply === null || to === null) return result;
  // A redelivery only shows the aggregator missed our HTTP answer, not that
  // the reply was lost: while the last send still waits in the outbox, or was
  // handed to the queue less than the interval ago, it is not queued again.
  const [last] = await tx
    .select({ publishedAt: outboxEvents.publishedAt })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateType, 'inbound_message'),
        eq(outboxEvents.aggregateId, row.id),
        eq(outboxEvents.type, CHANNEL_SMS_REPLY),
      ),
    )
    .orderBy(desc(outboxEvents.id))
    .limit(1);
  if (last !== undefined && (last.publishedAt === null || !longAgo(last.publishedAt))) {
    return result;
  }
  const send = row.replyCount + 1;
  await tx
    .update(inboundMessages)
    .set({ replyCount: send, lastReplyAt: now })
    .where(eq(inboundMessages.id, row.id));
  await queueReply(tx, {
    inboundMessageId: row.id,
    to,
    body: row.reply,
    template: CHANNEL_REPLY_TEMPLATE,
    userId: row.userId,
    send,
  });
  return { ...result, replyQueued: true };
}

/**
 * Handles an SMS from the aggregator (POST /channels/sms/inbound, after its
 * signature was checked), in one transaction retried on deadlock:
 *
 * 1. the number's channel lock (SMS and USSD of one number run one at a time);
 * 2. a message id seen before is a redelivery: nothing is handled again; the
 *    stored reply is returned and queued again when the last send was queued
 *    and handed to the job queue at least SMS_REPLY_RESEND_INTERVAL_MS ago
 *    (at most SMS_MAX_REPLY_SENDS sends), so neither a quick retry by the
 *    aggregator nor a send still waiting in the outbox texts the player twice;
 * 3. per-number rate limits (DEFAULT_SMS_RATE_LIMITS, shared with USSD
 *    sessions): over a limit the text
 *    is not read, and "too many messages" is sent once per window;
 * 4. the sender must be an active player with a verified phone; any other
 *    number gets one generic bilingual reply (STOP / START still work);
 * 5. the text is read as a command (parseTextCommand with the current bet
 *    rules) and answered in the player's language: BAL, BETS (last 3), JP,
 *    HELP, STOP / START (users.sms_marketing_opt_out_at), or a bet: Game IDs
 *    and picks resolved to selections at the current odds under the
 *    player's lock, then placeChannelBet (placeBet, channel 'sms', policy
 *    'none' at those odds: the price at receipt, since the player cannot see
 *    odds) with the idempotency key smsBetKey(aggregator, messageId);
 * 6. the inbound_messages row (with the bet and the reply) and, when there
 *    is a reply, its `channel.sms_reply` outbox event: sending never blocks
 *    the transaction, and nothing is sent unless it commits.
 *
 * A number that is not an Ethiopian mobile number is never a player and gets
 * no reply. Invalid input (an unsigned or malformed request) must be refused
 * by the caller; this throws RangeError for it.
 */
export async function handleInboundSms(
  db: Database,
  input: InboundSmsInput,
  options: InboundSmsOptions,
): Promise<InboundSmsResult> {
  assertInput(input);
  const phone = channelPhone(input.from);
  const text = inboundText(input.text);
  const shortCode = typeof input.to === 'string' ? input.to.slice(0, 32) : null;
  return withTxRetry(
    db,
    async (tx) => {
      await lockChannelPhone(tx, phone.key);
      const [existing] = await tx
        .select()
        .from(inboundMessages)
        .where(
          and(
            eq(inboundMessages.aggregator, input.aggregator),
            eq(inboundMessages.externalId, input.messageId),
          ),
        )
        .limit(1)
        .for('update');
      if (existing !== undefined) {
        return redelivered(tx, existing, { phone: phone.key, text }, options.now);
      }

      const handled = await handleText(tx, input, phone, text, options);
      const reply =
        handled.body === null || phone.e164 === null ? null : smsText(handled.body, options);
      const id = randomUUID();
      await tx.insert(inboundMessages).values({
        id,
        aggregator: input.aggregator,
        externalId: input.messageId,
        phone: phone.key,
        shortCode,
        userId: handled.userId,
        text,
        command: handled.command,
        outcome: handled.outcome,
        refusalCode: handled.refusalCode,
        betId: handled.bet?.id ?? null,
        reply,
        replyCount: reply === null ? 0 : 1,
        lastReplyAt: reply === null ? null : options.now,
        receivedAt: options.now,
      });
      if (reply !== null && phone.e164 !== null) {
        await queueReply(tx, {
          inboundMessageId: id,
          to: phone.e164,
          body: reply,
          template: CHANNEL_REPLY_TEMPLATE,
          userId: handled.userId,
          send: 1,
        });
      }
      return {
        inboundMessageId: id,
        outcome: handled.outcome,
        command: handled.command,
        reply,
        replayed: false,
        replyQueued: reply !== null,
        conflict: false,
        betId: handled.bet?.id ?? null,
        bet: handled.bet,
      };
    },
    options.txRetry,
  );
}
