import { z } from 'zod';
import { Santim } from './common';
import { JackpotTemplateCodeSchema } from './jackpots';

/**
 * The per-player push channel (Phase 7).
 *
 * The worker publishes a player's private events on the Redis channel
 * `vamos:user:<userId>` (userChannel), only after the change has committed
 * (from the outbox-fed consumers, or publishAfterCommit where the transaction
 * lives). The API relays the player's own channel, and only that one, on the
 * authenticated SSE stream GET /me/stream (cookie or bearer), framed like
 * /live/stream: `event: <type>` with `data` as JSON.
 *
 * Delivery is best effort (pub/sub has no replay): a client that reconnects
 * re-fetches what it shows (GET /me/bets, GET /wallet) instead of relying on
 * having seen every message. Messages are small hints: show a toast, update
 * a status, and re-fetch the bet for its full view.
 */

/** Prefix of every player channel. */
export const USER_CHANNEL_PREFIX = 'vamos:user:';

/** Pattern matching every player channel, for one shared PSUBSCRIBE. */
export const USER_CHANNEL_PATTERN = `${USER_CHANNEL_PREFIX}*`;

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A channel prefix: up to 64 letters, digits and `_ . : -`, ending in ':'.
 * No glob characters, so the PSUBSCRIBE pattern built from it matches
 * nothing but its own player channels.
 */
const PREFIX_PATTERN = /^[A-Za-z0-9_.:-]{0,63}:$/;

function checkedPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    throw new RangeError(`not a user channel prefix: ${String(prefix)}`);
  }
  return prefix;
}

/**
 * The Redis channel of one player: `vamos:user:<userId>` with the user id
 * (a UUID) in lower case. Throws a RangeError for anything that is not a
 * UUID, so a malformed id can never name another channel or a pattern.
 *
 * `prefix` replaces `vamos:user:` where a process must not share the
 * production channels (tests use their own, as they do for the live
 * channel); the publisher and the SSE relay must use the same one.
 */
export function userChannel(userId: string, prefix: string = USER_CHANNEL_PREFIX): string {
  const id = typeof userId === 'string' ? userId.toLowerCase() : '';
  if (!USER_ID_PATTERN.test(id)) {
    throw new RangeError(`userChannel: not a user id: ${String(userId)}`);
  }
  return `${checkedPrefix(prefix)}${id}`;
}

/** The PSUBSCRIBE pattern of every player channel under `prefix` (USER_CHANNEL_PATTERN by default). */
export function userChannelPattern(prefix: string = USER_CHANNEL_PREFIX): string {
  return `${checkedPrefix(prefix)}*`;
}

/** The user id of a player channel (as built by userChannel), or null for any other channel. */
export function userIdOfChannel(
  channel: string,
  prefix: string = USER_CHANNEL_PREFIX,
): string | null {
  const start = checkedPrefix(prefix);
  if (typeof channel !== 'string' || !channel.startsWith(start)) return null;
  const id = channel.slice(start.length);
  return USER_ID_PATTERN.test(id) ? id : null;
}

const BetRef = {
  betId: z.string(),
  /** The bet's short id, shown to the player. */
  shortId: z.string(),
};

/** A bet that waited for live acceptance was accepted; re-fetch it for the odds it got. */
export const BetAcceptedMessage = z.object({
  type: z.literal('bet.accepted'),
  data: z.object({
    ...BetRef,
    /** Some live odds moved within the bet's odds-change policy and were taken. */
    oddsChanged: z.boolean(),
  }),
});

/** A bet that waited for live acceptance was refused; its stake went back to the balance. */
export const BetRejectedMessage = z.object({
  type: z.literal('bet.rejected'),
  data: z.object({
    ...BetRef,
    /** 'selection_unavailable' | 'odds_changed' | 'slip_invalid' (BetView.rejectReason). */
    reason: z.string(),
    /** The stake refunded. */
    refund: Santim,
  }),
});

/** A bet was settled, or settled again after a result correction (`corrected`). */
export const BetSettledMessage = z.object({
  type: z.literal('bet.settled'),
  data: z.object({
    ...BetRef,
    status: z.enum(['won', 'lost', 'void']),
    gross: Santim,
    tax: Santim,
    /** Paid to the balance ("0" for a lost bet; the stake for a void one). */
    net: Santim,
    corrected: z.boolean(),
  }),
});

/** A bet was cashed out; `net` went to the balance. */
export const BetCashedOutMessage = z.object({
  type: z.literal('bet.cashed_out'),
  data: z.object({
    ...BetRef,
    gross: Santim,
    tax: Santim,
    net: Santim,
  }),
});

/** A result correction re-opened a settled bet (its settlement was reversed). */
export const BetReopenedMessage = z.object({
  type: z.literal('bet.reopened'),
  data: z.object({ ...BetRef }),
});

/**
 * One of the player's jackpot entries was settled (won or lost) or refunded
 * (void round): re-fetch it (GET /me/jackpot-entries/:id). The balance went
 * up by net + refund.
 */
export const JackpotSettledMessage = z.object({
  type: z.literal('jackpot.settled'),
  data: z.object({
    entryId: z.string(),
    roundId: z.string(),
    templateCode: JackpotTemplateCodeSchema,
    status: z.enum(['won', 'lost', 'void']),
    /** The prize before tax ("0" when lost or void). */
    gross: Santim,
    tax: Santim,
    /** The prize paid to the balance ("0" when lost or void). */
    net: Santim,
    /** The cost refunded when the round was void, else "0". */
    refund: Santim,
    /** The most correct predictions of the entry's combinations (null when void). */
    bestCorrect: z.number().int().nullable(),
  }),
});

/** The player's balances changed (deposit, withdrawal, bet, settlement, cash-out…). */
export const WalletChangedMessage = z.object({
  type: z.literal('wallet.changed'),
  data: z.object({
    /** Cash balance in santim. */
    cash: Santim,
    /** Bonus balance in santim. */
    bonus: Santim,
  }),
});

/** Envelope published on a player's channel and sent on GET /me/stream. */
export const UserMessage = z.discriminatedUnion('type', [
  BetAcceptedMessage,
  BetRejectedMessage,
  BetSettledMessage,
  BetCashedOutMessage,
  BetReopenedMessage,
  JackpotSettledMessage,
  WalletChangedMessage,
]);
export type UserMessage = z.infer<typeof UserMessage>;
export type UserMessageType = UserMessage['type'];

/** Every UserMessage type, for SSE listeners (`EventSource.addEventListener`). */
export const USER_MESSAGE_TYPES = [
  'bet.accepted',
  'bet.rejected',
  'bet.settled',
  'bet.cashed_out',
  'bet.reopened',
  'jackpot.settled',
  'wallet.changed',
] as const satisfies readonly UserMessageType[];
