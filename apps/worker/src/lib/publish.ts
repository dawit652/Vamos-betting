import { USER_CHANNEL_PREFIX, userChannel, type UserMessage } from '@vamos/contracts';
import { LIVE_CHANNEL, type LiveMessage } from '@vamos/db';
import type { Redis } from 'ioredis';

/**
 * Publishes live deltas (as returned by the @vamos/db catalogue functions) on
 * the Redis channel the API's SSE endpoint relays. Call it only after the
 * transaction that produced them has committed. One pipelined round trip;
 * returns the number of messages sent and throws if any PUBLISH failed.
 */
export async function publish(
  redis: Redis,
  messages: readonly LiveMessage[],
  channel: string = LIVE_CHANNEL,
): Promise<number> {
  if (messages.length === 0) return 0;
  const pipeline = redis.pipeline();
  for (const message of messages) pipeline.publish(channel, JSON.stringify(message));
  const results = await pipeline.exec();
  for (const [error] of results ?? []) {
    if (error) throw error;
  }
  return messages.length;
}

/**
 * publish() for after a COMMIT: a failure is logged, not thrown, because the
 * change itself is already durable (clients catch up on their next fetch).
 */
export async function publishAfterCommit(
  redis: Redis,
  messages: readonly LiveMessage[],
  channel: string,
  logger: { warn: (obj: object, msg: string) => void },
): Promise<number> {
  try {
    return await publish(redis, messages, channel);
  } catch (error) {
    logger.warn({ err: error, count: messages.length }, 'publishing live deltas failed');
    return 0;
  }
}

/**
 * Publishes push messages on one player's channel (userChannel of
 * @vamos/contracts under `prefix`, `vamos:user:` by default), relayed by the
 * API's GET /me/stream. Call it only after the change they describe has
 * committed. One pipelined round trip; throws if any PUBLISH failed.
 */
export async function publishToUser(
  redis: Redis,
  userId: string,
  messages: readonly UserMessage[],
  prefix: string = USER_CHANNEL_PREFIX,
): Promise<number> {
  if (messages.length === 0) return 0;
  const channel = userChannel(userId, prefix);
  const pipeline = redis.pipeline();
  for (const message of messages) pipeline.publish(channel, JSON.stringify(message));
  const results = await pipeline.exec();
  for (const [error] of results ?? []) {
    if (error) throw error;
  }
  return messages.length;
}
