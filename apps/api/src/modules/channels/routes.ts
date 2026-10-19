import type { SmsInboundAck } from '@vamos/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import {
  receiveInboundSms,
  receiveUssdCallback,
  smsChannelEnabled,
  ussdChannelEnabled,
} from './service';

const MINUTE_MS = 60_000;

/** Largest inbound body accepted (an SMS is at most a few KB of JSON). */
export const CHANNEL_BODY_LIMIT = 16 * 1024;

/**
 * Per aggregator address, per minute. The per-number limits (exact, in the
 * database, shared by SMS and USSD) are in @vamos/db.
 */
export const CHANNEL_RATE_LIMITS = { sms: 600, ussd: 1200 } as const;

function perAddress(name: string, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: MINUTE_MS,
      keyGenerator: (request: FastifyRequest) => `${name}|${clientAddressKey(request.ip)}`,
    },
  };
}

/**
 * POST /channels/sms/inbound in its own context: every content type is read
 * as a raw Buffer, so the HMAC is checked over the exact bytes received.
 * No session or CSRF: the signature is the authentication.
 */
async function smsInboundRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: CHANNEL_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/channels/sms/inbound',
    { bodyLimit: CHANNEL_BODY_LIMIT, config: perAddress('channel-sms', CHANNEL_RATE_LIMITS.sms) },
    async (request, reply): Promise<SmsInboundAck> => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const ack = await receiveInboundSms(
        { ...deps, log: request.log },
        { headers: request.headers, rawBody, ip: request.ip },
      );
      void reply.header('cache-control', 'no-store');
      return ack;
    },
  );
}

/**
 * POST /channels/ussd: JSON or form-encoded (the usual aggregator shape),
 * answered as text/plain `CON …` / `END …`.
 */
async function ussdRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: CHANNEL_BODY_LIMIT },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  app.post(
    '/channels/ussd',
    { bodyLimit: CHANNEL_BODY_LIMIT, config: perAddress('channel-ussd', CHANNEL_RATE_LIMITS.ussd) },
    async (request, reply): Promise<string> => {
      const result = await receiveUssdCallback(
        { ...deps, log: request.log },
        { headers: request.headers, body: request.body, ip: request.ip },
      );
      void reply.header('cache-control', 'no-store');
      void reply.type('text/plain; charset=utf-8');
      return result.response;
    },
  );
}

/**
 * The SMS / USSD aggregator routes (Phase 11). Each exists only while its
 * channel is on (SMS_BETTING_ENABLED, USSD_ENABLED; off until the regulator
 * approves): otherwise it is simply not registered, so it answers the
 * ordinary 404 and nothing else changes.
 */
export default async function channelRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (smsChannelEnabled(deps)) await app.register(smsInboundRoutes);
  if (ussdChannelEnabled(deps)) await app.register(ussdRoutes);
}
