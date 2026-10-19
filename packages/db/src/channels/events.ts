/**
 * Outbox event types written by the SMS / USSD channel services (Phase 11).
 *
 * `channel.sms_reply` (aggregate 'inbound_message', id = inbound_messages.id):
 * the reply to an inbound SMS, to be sent through the SMS provider. Payload
 * ChannelSmsReplyPayload. Written in the transaction that handled the text,
 * so a reply is sent if and only if that handling committed, and sending it
 * never blocks (or rolls back) the bet.
 */
export const CHANNEL_SMS_REPLY = 'channel.sms_reply';

/** Template id of channel replies in sms_messages and the dev inbox. */
export const CHANNEL_REPLY_TEMPLATE = 'channel_reply';

export interface ChannelSmsReplyPayload {
  inboundMessageId: string;
  /** E.164 recipient: the number the text came from. */
  to: string;
  /** The full reply text (prefix included, at most MAX_SMS_SEGMENTS parts). */
  body: string;
  template: typeof CHANNEL_REPLY_TEMPLATE;
  /** The player, when the number is an active player with a verified phone. */
  userId: string | null;
  /** 1 for the first send, 2 or more when a redelivery queued it again. */
  send: number;
}
