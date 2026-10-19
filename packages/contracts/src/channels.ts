import { z } from 'zod';

/**
 * SMS and USSD betting (Phase 11). Both channels are off unless
 * SMS_BETTING_ENABLED / USSD_ENABLED are set (they stay off until the
 * regulator approves the channel); while off, their inbound routes answer 404.
 *
 * - POST /channels/sms/inbound: the SMS aggregator delivers a player's text
 *   (raw body signed with HMAC-SHA256, like the payment webhooks). The
 *   aggregator's message id is the idempotency key. Answered with
 *   SmsInboundAck; the reply itself is sent through the SMS provider.
 * - POST /channels/ussd: the USSD aggregator's callback (shared secret in a
 *   header); answered as text/plain with `CON <menu>` or `END <text>`.
 */

/** An aggregator id (message or session): 1–128 printable ASCII characters. */
const AggregatorId = z
  .string()
  .regex(/^[\x21-\x7e]{1,128}$/, 'must be 1–128 printable ASCII characters');

/** A sender number as the aggregator gives it (normalised by the server). */
const AggregatorPhone = z.string().trim().min(3).max(64);

/** Body of an inbound SMS from the (demo: mock) aggregator. */
export const SmsInboundWebhook = z.object({
  /** The aggregator's message id (redeliveries repeat it). */
  messageId: AggregatorId,
  /** The sender's number. */
  from: AggregatorPhone,
  /** The short code the text was sent to. */
  to: z.string().trim().max(32).optional(),
  /** The text as typed (empty texts are answered with the syntax). */
  text: z.string().max(1_600),
  /** When the aggregator received it (informational; the server's time is used). */
  receivedAt: z.iso.datetime({ offset: true }).optional(),
});
export type SmsInboundWebhook = z.infer<typeof SmsInboundWebhook>;

/** What handling an inbound SMS did (inbound_messages.outcome). */
export const ChannelOutcomeSchema = z.enum([
  'bet_placed',
  'bet_refused',
  'info',
  'opt_out',
  'opt_in',
  'invalid_command',
  'not_available',
  'rate_limited',
]);
export type ChannelOutcome = z.infer<typeof ChannelOutcomeSchema>;

/** Body of the 200 answer to an inbound SMS. */
export const SmsInboundAck = z.object({
  received: z.literal(true),
  outcome: ChannelOutcomeSchema,
  /** The message id had been handled before: nothing was done again. */
  replayed: z.boolean(),
  /** The reply sent to the sender (null when none is sent). */
  reply: z.string().nullable(),
});
export type SmsInboundAck = z.infer<typeof SmsInboundAck>;

/**
 * A USSD aggregator callback (the usual Africa's Talking shape, JSON or
 * form-encoded): `text` is everything typed in the session, '*'-joined, and
 * empty on the first callback.
 */
export const UssdCallbackRequest = z.object({
  sessionId: AggregatorId,
  serviceCode: z.string().trim().min(1).max(32),
  phoneNumber: AggregatorPhone,
  text: z.string().max(500).default(''),
  networkCode: z.string().max(16).optional(),
});
export type UssdCallbackRequest = z.infer<typeof UssdCallbackRequest>;

/** Most characters a USSD response may have (CON / END prefix included). */
export const USSD_RESPONSE_MAX_LENGTH = 182;

/** The text/plain answer to a USSD callback. */
export const UssdResponseText = z
  .string()
  .max(USSD_RESPONSE_MAX_LENGTH)
  .regex(/^(CON|END) /, 'must start with "CON " or "END "');
export type UssdResponseText = z.infer<typeof UssdResponseText>;

// ---------------------------------------------------------------- dev only

/**
 * DEV ONLY (demo mode, NODE_ENV not production, channel enabled): POST
 * /dev/channels/sms – sends a text as the signed-in player's own phone: the
 * server signs it like the aggregator and hands it to the inbound route.
 * Replies appear in the dev SMS inbox (GET /dev/sms). Repeating a
 * `messageId` simulates a redelivery.
 */
export const DevSmsSendRequest = z.object({
  text: z.string().max(640),
  messageId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});
export type DevSmsSendRequest = z.infer<typeof DevSmsSendRequest>;

export const DevSmsSendResponse = z.object({
  messageId: z.string(),
  outcome: ChannelOutcomeSchema,
  replayed: z.boolean(),
  reply: z.string().nullable(),
});
export type DevSmsSendResponse = z.infer<typeof DevSmsSendResponse>;

/**
 * DEV ONLY: POST /dev/channels/ussd – one callback of the phone emulator,
 * dialled from the signed-in player's own phone. The emulator keeps the
 * session id and the '*'-joined history (`text`, '' to dial).
 */
export const DevUssdRequest = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  text: z.string().max(500),
});
export type DevUssdRequest = z.infer<typeof DevUssdRequest>;

export const DevUssdResponse = z.object({
  sessionId: z.string(),
  /** 'CON …' (waiting for input) or 'END …' (session over). */
  response: UssdResponseText,
  ended: z.boolean(),
});
export type DevUssdResponse = z.infer<typeof DevUssdResponse>;

// ---------------------------------------------------------------- back office

/**
 * Read-only view of the channel switches for the back office. They live in
 * the environment (SMS_BETTING_ENABLED, USSD_ENABLED), not in settings:
 * changing one is a deployment, made only once the regulator approves.
 */
export const ChannelFlagsResponse = z.object({
  sms: z.object({
    enabled: z.boolean(),
    aggregator: z.string(),
    shortCode: z.string(),
  }),
  ussd: z.object({
    enabled: z.boolean(),
    aggregator: z.string(),
    serviceCode: z.string(),
  }),
  source: z.literal('environment'),
});
export type ChannelFlagsResponse = z.infer<typeof ChannelFlagsResponse>;
