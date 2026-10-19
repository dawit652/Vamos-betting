import { isDemo } from '@vamos/config';
import {
  ChannelFlagsResponse,
  SmsInboundAck,
  SmsInboundWebhook,
  UssdCallbackRequest,
} from '@vamos/contracts';
import { handleInboundSms, handleUssdCallback, type UssdCallbackResult } from '@vamos/db';
import type { FastifyBaseLogger } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { AppDeps } from '../../deps';
import { AppError, badRequest, parseInput } from '../../lib/errors';
import {
  SMS_SIGNATURE_HEADER,
  USSD_SECRET_HEADER,
  verifySmsSignature,
  verifyUssdSecret,
} from './auth';

/**
 * The inbound SMS / USSD paths (Phase 11), shared by the aggregator routes
 * and the dev simulator (which signs like the aggregator and comes through
 * here, so it exercises the same checks). The money work is in @vamos/db
 * (handleInboundSms / handleUssdCallback): idempotency, the per-number rate
 * limits and lock, the player checks, placeBet and the reply outbox event.
 * The feature flags are checked by the callers (routes answer 404 while a
 * channel is off).
 */

type ChannelDeps = Pick<AppDeps, 'config' | 'db' | 'clock' | 'randomBytes'> & {
  log?: FastifyBaseLogger;
};

export interface SignedSmsRequest {
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  ip: string | null;
}

/** Whether the inbound SMS route is on (SMS_BETTING_ENABLED). */
export const smsChannelEnabled = (deps: Pick<AppDeps, 'config'>): boolean =>
  deps.config.channels.sms.enabled;

/** Whether the USSD route is on (USSD_ENABLED). */
export const ussdChannelEnabled = (deps: Pick<AppDeps, 'config'>): boolean =>
  deps.config.channels.ussd.enabled;

/** The channel switches as the back office and the simulator show them (read-only). */
export function channelFlags(deps: Pick<AppDeps, 'config'>): ChannelFlagsResponse {
  const { sms, ussd } = deps.config.channels;
  return ChannelFlagsResponse.parse({
    sms: { enabled: sms.enabled, aggregator: sms.aggregator, shortCode: sms.shortCode },
    ussd: { enabled: ussd.enabled, aggregator: ussd.aggregator, serviceCode: ussd.serviceCode },
    source: 'environment',
  });
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw badRequest('malformed_payload', 'The body is not JSON.');
  }
}

/** The service refuses input the contract let through (e.g. a number it cannot key) with RangeError. */
function invalidInput(error: unknown): never {
  if (error instanceof RangeError) throw badRequest('invalid_message', error.message);
  throw error;
}

/**
 * One inbound SMS: signature (401 `missing_signature` / `bad_signature` /
 * `stale_timestamp`, nothing recorded), then the body (400), then
 * handleInboundSms. A redelivered message id is answered from the stored
 * row (`replayed: true`) and never handled twice.
 */
export async function receiveInboundSms(
  deps: ChannelDeps,
  request: SignedSmsRequest,
): Promise<SmsInboundAck> {
  const { sms } = deps.config.channels;
  const now = deps.clock();
  const failure = verifySmsSignature(
    sms.webhookSecret,
    request.headers[SMS_SIGNATURE_HEADER],
    request.rawBody,
    now,
  );
  if (failure !== null) {
    deps.log?.warn({ reason: failure, ip: request.ip }, 'inbound SMS refused');
    throw new AppError(401, failure, 'The SMS webhook signature is missing, wrong or stale.');
  }
  const body = parseInput(SmsInboundWebhook, parseJson(request.rawBody));
  const result = await handleInboundSms(
    deps.db,
    {
      aggregator: sms.aggregator,
      messageId: body.messageId,
      from: body.from,
      to: body.to ?? null,
      text: body.text,
    },
    {
      now,
      randomBytes: deps.randomBytes,
      demo: isDemo(deps.config),
      ip: request.ip,
    },
  ).catch(invalidInput);
  if (result.conflict) {
    deps.log?.warn(
      { messageId: body.messageId, inboundMessageId: result.inboundMessageId },
      'inbound SMS id reused with a different sender or text: ignored',
    );
  }
  return SmsInboundAck.parse({
    received: true,
    outcome: result.outcome,
    replayed: result.replayed,
    reply: result.conflict ? null : result.reply,
  });
}

export interface UssdRequest {
  headers: IncomingHttpHeaders;
  body: unknown;
  ip: string | null;
}

/**
 * One USSD callback: shared secret (401 `bad_secret`), then the body (400),
 * then handleUssdCallback. The answer is the text/plain `CON …` / `END …`.
 */
export async function receiveUssdCallback(
  deps: ChannelDeps,
  request: UssdRequest,
): Promise<UssdCallbackResult> {
  const { ussd } = deps.config.channels;
  if (!verifyUssdSecret(ussd.sharedSecret, request.headers[USSD_SECRET_HEADER])) {
    deps.log?.warn({ ip: request.ip }, 'USSD callback refused (shared secret)');
    throw new AppError(401, 'bad_secret', 'The USSD aggregator secret is missing or wrong.');
  }
  const body = parseInput(UssdCallbackRequest, request.body);
  return handleUssdCallback(
    deps.db,
    {
      aggregator: ussd.aggregator,
      sessionId: body.sessionId,
      serviceCode: body.serviceCode,
      phoneNumber: body.phoneNumber,
      text: body.text,
    },
    {
      now: deps.clock(),
      randomBytes: deps.randomBytes,
      demo: isDemo(deps.config),
      serviceCode: ussd.serviceCode,
      ip: request.ip,
    },
  ).catch(invalidInput);
}
