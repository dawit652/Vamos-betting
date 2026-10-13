import { z } from 'zod';
import { Santim } from './common';

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
 * The Redis channel of one player: `vamos:user:<userId>` with the user id
 * (a UUID) in lower case. Throws a RangeError for anything that is not a
 * UUID, so a malformed id can never name another channel or a pattern.
 */
export function userChannel(userId: string): string {
  const id = typeof userId === 'string' ? userId.toLowerCase() : '';
  if (!USER_ID_PATTERN.test(id)) {
    throw new RangeError(`userChannel: not a user id: ${String(userId)}`);
  }
  return `${USER_CHANNEL_PREFIX}${id}`;
}

/** The user id of a player channel (as built by userChannel), or null for any other channel. */
export function userIdOfChannel(channel: string): string | null {
  if (typeof channel !== 'string' || !channel.startsWith(USER_CHANNEL_PREFIX)) return null;
  const id = channel.slice(USER_CHANNEL_PREFIX.length);
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
  'wallet.changed',
] as const satisfies readonly UserMessageType[];
