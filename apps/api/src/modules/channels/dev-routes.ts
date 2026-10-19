import {
  type ChannelFlagsResponse,
  DevSmsSendRequest,
  DevSmsSendResponse,
  DevUssdRequest,
  DevUssdResponse,
} from '@vamos/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../deps';
import { notFound, parseInput } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { SMS_SIGNATURE_HEADER, signSmsBody, USSD_SECRET_HEADER } from './auth';
import {
  channelFlags,
  receiveInboundSms,
  receiveUssdCallback,
  smsChannelEnabled,
  ussdChannelEnabled,
} from './service';

/**
 * The channel simulator exists only for local development, tests and e2e:
 * demo mode and NODE_ENV other than production, like the other /dev tools.
 * A public deployment never has it, and licensed mode never does.
 */
export function devChannelsEnabled(deps: Pick<AppDeps, 'config'>): boolean {
  return deps.config.mode === 'demo' && deps.config.nodeEnv !== 'production';
}

/**
 * DEV ONLY – not part of the product. The SMS / USSD simulator behind the
 * web page /dev/channels, for the signed-in player's own registered phone
 * (session required, CSRF for cookies):
 *
 * - GET /dev/channels: which channels are on, the short code and USSD code;
 * - POST /dev/channels/sms: builds the aggregator's webhook for a text from
 *   the player's phone, signs it with SMS_WEBHOOK_SECRET and feeds it
 *   through the same verification and handling as POST /channels/sms/inbound.
 *   The reply goes out through the outbox (worker) and shows in the dev SMS
 *   inbox (GET /dev/sms); it is also returned here. A repeated messageId
 *   simulates a redelivery;
 * - POST /dev/channels/ussd: one callback of the phone emulator, with the
 *   shared secret, through the same path as POST /channels/ussd.
 *
 * Each POST answers 404 while its channel is off, like the inbound route.
 */
export default async function devChannelRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!devChannelsEnabled(deps)) return;

  app.get('/dev/channels', async (): Promise<ChannelFlagsResponse> => channelFlags(deps));

  app.post(
    '/dev/channels/sms',
    { preHandler: app.requireAuth },
    async (request): Promise<DevSmsSendResponse> => {
      const user = requireUser(request);
      if (!smsChannelEnabled(deps)) throw notFound('SMS channel');
      const input = parseInput(DevSmsSendRequest, request.body);
      const messageId = input.messageId ?? `dev_${deps.randomBytes(12).toString('hex')}`;
      const { sms } = deps.config.channels;
      // Ids are namespaced per player, so a player can neither see another
      // player's outcome nor take ids that player will use.
      const externalId = `dev_${user.id}_${messageId}`;
      const rawBody = Buffer.from(
        JSON.stringify({
          messageId: externalId,
          from: user.phone,
          to: sms.shortCode,
          text: input.text,
        }),
        'utf8',
      );
      const ack = await receiveInboundSms(
        { ...deps, log: request.log },
        {
          headers: {
            'content-type': 'application/json',
            [SMS_SIGNATURE_HEADER]: signSmsBody(sms.webhookSecret, rawBody, deps.clock()),
          },
          rawBody,
          ip: request.ip,
        },
      );
      return DevSmsSendResponse.parse({
        messageId,
        outcome: ack.outcome,
        replayed: ack.replayed,
        reply: ack.reply,
      });
    },
  );

  app.post(
    '/dev/channels/ussd',
    { preHandler: app.requireAuth },
    async (request): Promise<DevUssdResponse> => {
      const user = requireUser(request);
      if (!ussdChannelEnabled(deps)) throw notFound('USSD channel');
      const input = parseInput(DevUssdRequest, request.body);
      const { ussd } = deps.config.channels;
      const result = await receiveUssdCallback(
        { ...deps, log: request.log },
        {
          headers: { [USSD_SECRET_HEADER]: ussd.sharedSecret },
          body: {
            sessionId: input.sessionId,
            serviceCode: ussd.serviceCode,
            phoneNumber: user.phone,
            text: input.text,
          },
          ip: request.ip,
        },
      );
      return DevUssdResponse.parse({
        sessionId: input.sessionId,
        response: result.response,
        ended: result.ended,
      });
    },
  );
}
