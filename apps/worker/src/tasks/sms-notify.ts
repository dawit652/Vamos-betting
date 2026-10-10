import { DEPOSIT_SUCCEEDED, schema, WITHDRAWAL_FAILED, WITHDRAWAL_PAID } from '@vamos/db';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import { paymentSmsBody, type PaymentSmsTemplate } from '../lib/sms';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { SmsJobData } from './outbox-dispatch';

/**
 * SMS notifications: a BullMQ worker on the `sms` queue, fed by the outbox
 * dispatcher with payment outcomes (deposit credited, withdrawal paid,
 * withdrawal failed). Each job sends one SMS to the player's registered
 * phone through the SMS gateway (the mock one in demo mode, which records it
 * in sms_messages for the dev inbox). The job id is the outbox row's, so a
 * row dispatched twice does not send twice; a send that fails is retried by
 * BullMQ.
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

export type SmsJobResult =
  | { sent: true; template: PaymentSmsTemplate; messageId: string }
  | { sent: false; reason: 'unknown_type' | 'unknown_user' };

/** Sends the notification of one `sms` job. */
export async function processSmsJob(ctx: TaskContext, data: SmsJobData): Promise<SmsJobResult> {
  const template = TEMPLATES[data.type];
  if (template === undefined) {
    ctx.logger.warn({ type: data.type, outboxId: data.outboxId }, 'no SMS template for this type');
    return { sent: false, reason: 'unknown_type' };
  }
  const [user] = await ctx.db
    .select({ phone: schema.users.phone, locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, data.userId))
    .limit(1);
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
