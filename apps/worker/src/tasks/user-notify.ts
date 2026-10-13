import type { UserMessage } from '@vamos/contracts';
import { toWire } from '@vamos/core';
import { getPlayerBalances } from '@vamos/db';
import type { Job } from 'bullmq';
import { publishToUser } from '../lib/publish';
import { createQueueWorker, QUEUE_NAMES, type QueueWorker } from '../lib/queues';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';
import type { UserNotifyJobData } from './outbox-dispatch';

/**
 * Player push messages: a BullMQ worker on the `user-notify` queue, fed by
 * the outbox dispatcher with the bet and payment events that concern a
 * player (USER_NOTIFY_TYPES). Each job publishes the messages built from
 * the outbox row (bet accepted / rejected / settled / cashed out /
 * reopened), followed by `wallet.changed` with the player's balances as they
 * are now when the event changed them, on the player's channel
 * `vamos:user:<userId>` (ctx.userChannelPrefix in tests), which the API
 * relays on GET /me/stream. The outbox row is written in the transaction of
 * the change, so a message is only ever published after its COMMIT.
 *
 * Pub/sub has no replay: a player who is not connected misses the message
 * and sees the change on the next fetch. A failed PUBLISH fails the job and
 * BullMQ retries it (a retry may repeat a message; they are idempotent
 * hints).
 */

export interface UserNotifyOptions {
  /** Jobs handled in parallel (default 8). */
  concurrency?: number;
}

export interface UserNotifyResult {
  published: number;
}

/** Publishes the messages of one `user-notify` job. */
export async function processUserNotifyJob(
  ctx: TaskContext,
  data: UserNotifyJobData,
): Promise<UserNotifyResult> {
  const messages: UserMessage[] = [...data.messages];
  if (data.wallet) {
    const balances = await getPlayerBalances(ctx.db, data.userId);
    messages.push({
      type: 'wallet.changed',
      data: { cash: toWire(balances.cash), bonus: toWire(balances.bonus) },
    });
  }
  const published = await publishToUser(ctx.redis, data.userId, messages, ctx.userChannelPrefix);
  return { published };
}

/** The `user-notify` queue consumer as a WorkerTask. */
export function userNotifyTask(ctx: TaskContext, options: UserNotifyOptions = {}): WorkerTask {
  let consumer: QueueWorker<UserNotifyJobData, UserNotifyResult> | null = null;
  return {
    name: 'user-notify',
    start: async () => {
      if (consumer !== null) return;
      consumer = createQueueWorker(
        ctx.queues,
        QUEUE_NAMES.userNotify,
        (job: Job<UserNotifyJobData>) => processUserNotifyJob(ctx, job.data),
        ctx.logger,
        { concurrency: options.concurrency ?? 8 },
      );
    },
    stop: async () => {
      const current = consumer;
      consumer = null;
      await current?.close();
    },
  };
}
