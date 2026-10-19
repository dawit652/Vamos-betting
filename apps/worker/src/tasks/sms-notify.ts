import { channelLocale, liveBetOutcomeBody, smsText } from '@vamos/core';
import {
  BET_ACCEPTED,
  BET_REJECTED,
  CHANNEL_SMS_REPLY,
  DEPOSIT_SUCCEEDED,
  schema,
  WITHDRAWAL_FAILED,
  WITHDRAWAL_PAID,
} from '@vamos/db';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { paymentSmsBody, type PaymentSmsTemplate } from '../lib/sms';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { ChannelReplySmsJobData, LiveBetSmsJobData, SmsJobData } from './outbox-dispatch';

/**
 * SMS notifications: a BullMQ worker on the `sms` queue, fed by the outbox
 * dispatcher with payment outcomes (deposit credited, withdrawal paid,
 * withdrawal failed). Each job sends one SMS to the player's registered
 * phone through the SMS gateway (the mock one in demo mode, which records it
 * in sms_messages for the dev inbox). The job id is the outbox row's, so a
 * row dispatched twice does not send twice; a send that fails is retried by
 * BullMQ.
 *
 * It also sends the replies to inbound SMS (channel.sms_reply, Phase 11):
 * the text was built when the SMS was handled, so it is sent as it is; and
 * the outcome of live bets placed by SMS or USSD (bet.accepted / rejected).
 */

const TEMPLATES: Readonly<Record<string, PaymentSmsTemplate>> = {
  [DEPOSIT_SUCCEEDED]: 'deposit_succeeded',
  [WITHDRAWAL_PAID]: 'withdrawal_paid',
  [WITHDRAWAL_FAILED]: 'withdrawal_failed',
};

export interface SmsNotifyOptions {
  /** Jobs handled in parallel (default 4). */
  concurrency?: number;
}

/** Template of the live bet outcome texts (sms_messages.template). */
export const LIVE_BET_OUTCOME_TEMPLATE = 'channel_live_bet';

export type SmsJobResult =
  | {
      sent: true;
      template:
        PaymentSmsTemplate | ChannelReplySmsJobData['template'] | typeof LIVE_BET_OUTCOME_TEMPLATE;
      messageId: string;
    }
  | { sent: false; reason: 'unknown_type' | 'unknown_user' | 'not_channel_bet' };

function isChannelReply(data: SmsJobData): data is ChannelReplySmsJobData {
  return data.type === CHANNEL_SMS_REPLY;
}

function isLiveBetOutcome(data: SmsJobData): data is LiveBetSmsJobData {
  return data.type === BET_ACCEPTED || data.type === BET_REJECTED;
}

async function playerContact(ctx: TaskContext, userId: string) {
  const [user] = await ctx.db
    .select({ phone: schema.users.phone, locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user;
}

/**
 * A live bet placed by SMS or USSD, accepted or rejected after its delay:
 * the player cannot see it in an app, so it is texted (liveBetOutcomeBody,
 * in the player's language). Bets from the web are skipped.
 */
async function sendLiveBetOutcome(
  ctx: TaskContext,
  data: LiveBetSmsJobData,
): Promise<SmsJobResult> {
  const [bet] = await ctx.db
    .select({ channel: schema.bets.channel })
    .from(schema.bets)
    .where(eq(schema.bets.id, data.betId))
    .limit(1);
  if (bet === undefined || (bet.channel !== 'sms' && bet.channel !== 'ussd')) {
    return { sent: false, reason: 'not_channel_bet' };
  }
  const user = await playerContact(ctx, data.userId);
  if (user === undefined) {
    ctx.logger.warn({ userId: data.userId, outboxId: data.outboxId }, 'SMS for an unknown user');
    return { sent: false, reason: 'unknown_user' };
  }
  const locale = channelLocale(user.locale);
  const body =
    data.type === BET_ACCEPTED
      ? liveBetOutcomeBody({ shortId: data.shortId, accepted: true }, locale)
      : liveBetOutcomeBody(
          {
            shortId: data.shortId,
            accepted: false,
            reason: data.reason ?? 'selection_unavailable',
            refund: BigInt(data.refund ?? '0'),
          },
          locale,
        );
  const { id } = await ctx.sms.send({
    to: user.phone,
    body: smsText(body, { demo: ctx.demo ?? true }),
    template: LIVE_BET_OUTCOME_TEMPLATE,
  });
  return { sent: true, template: LIVE_BET_OUTCOME_TEMPLATE, messageId: id };
}

/** Sends the notification, channel reply or live bet outcome of one `sms` job. */
export async function processSmsJob(ctx: TaskContext, data: SmsJobData): Promise<SmsJobResult> {
  if (isChannelReply(data)) {
    // The reply was built (and stored) when the SMS was handled: sent as it is.
    const { id } = await ctx.sms.send({ to: data.to, body: data.body, template: data.template });
    return { sent: true, template: data.template, messageId: id };
  }
  if (isLiveBetOutcome(data)) return sendLiveBetOutcome(ctx, data);
  const template = TEMPLATES[data.type];
  if (template === undefined) {
    ctx.logger.warn({ type: data.type, outboxId: data.outboxId }, 'no SMS template for this type');
    return { sent: false, reason: 'unknown_type' };
  }
  const user = await playerContact(ctx, data.userId);
  if (user === undefined) {
    ctx.logger.warn({ userId: data.userId, outboxId: data.outboxId }, 'SMS for an unknown user');
    return { sent: false, reason: 'unknown_user' };
  }
  const { id } = await ctx.sms.send({
    to: user.phone,
    body: paymentSmsBody(template, BigInt(data.amount), user.locale),
    template,
  });
  return { sent: true, template, messageId: id };
}

/** The `sms` queue consumer as a WorkerTask. */
export function smsNotifyTask(ctx: TaskContext, options: SmsNotifyOptions = {}): WorkerTask {
  let consumer: QueueWorker<SmsJobData, SmsJobResult> | null = null;
  return {
    name: 'sms-notify',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.sms,
        (job: Job<SmsJobData>) => processSmsJob(ctx, job.data),
        ctx.logger,
        { concurrency: options.concurrency ?? 4 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}
